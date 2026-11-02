    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crate::terminal_broker::{TerminalGeometry, TerminalTransportKind};
    use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};
    use crossbeam_channel::{unbounded, Receiver};
    use std::sync::atomic::AtomicBool;

    fn native_probe_state_harness() -> (TerminalSessionBroker, Arc<TerminalCommandOperation>) {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        let (broker, _, _, _) = harness();
        for event in [
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::NativeInput { enabled: true },
            TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true },
            TerminalIntegrationControlEvent::NativePrivateControl { enabled: true },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("transport-1", "integration-1", event)
                .unwrap();
        }
        broker
            .acquire_agent_lease("transport-1", "agent", "task", "operation")
            .unwrap();
        let operation = broker
            .begin_command("transport-1", "operation", "approved\nsource")
            .unwrap();
        operation.begin_native_read_only_probe().unwrap();
        broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent".into(),
                    task_id: "task".into(),
                    operation_id: "operation".into(),
                },
                TerminalInputKind::Text,
                b"\x18\x01",
                || Ok(()),
            )
            .unwrap();
        (broker, operation)
    }

    #[test]
    fn read_only_probe_refreshes_after_real_prompt_and_drains_its_old_ack() {
        // Admission-state regression only; native Windows separately exercises
        // the actual takeover, ClearScreen, PSReadLine and ConPTY sequence.
        for acknowledged_before_prompt in [false, true] {
            let (broker, operation) = native_probe_state_harness();
            let emit = |event| {
                broker
                    .accept_integration_event("transport-1", "integration-1", event)
                    .unwrap()
            };
            if acknowledged_before_prompt {
                emit(TerminalIntegrationControlEvent::NativeCheckpoint {
                    buffer: String::new(),
                });
                assert!(operation.wait_native_checkpoint(Duration::ZERO).unwrap());
            }
            emit(TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() });
            assert_eq!(
                operation.snapshot().unwrap().state,
                TerminalCommandState::Submitted
            );
            if !acknowledged_before_prompt {
                emit(TerminalIntegrationControlEvent::NativeCheckpoint {
                    buffer: String::new(),
                });
            }
            assert!(!operation.finish_native_read_only_probe().unwrap());
            assert!(
                !operation.refresh_native_read_only_probe().unwrap(),
                "P alone must not authorize another probe"
            );
            for event in [
                TerminalIntegrationControlEvent::NativeInput { enabled: true },
                TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true },
                TerminalIntegrationControlEvent::PromptEnd,
            ] {
                emit(event);
            }
            assert!(!operation.wait_native_checkpoint(Duration::ZERO).unwrap());
            assert!(!operation.finish_native_read_only_probe().unwrap());
            assert!(operation.refresh_native_read_only_probe().unwrap());
            assert!(
                !operation.wait_native_checkpoint(Duration::ZERO).unwrap(),
                "Old empty A authorized the refreshed probe"
            );
            emit(TerminalIntegrationControlEvent::NativeCheckpoint {
                buffer: String::new(),
            });
            assert!(operation.wait_native_checkpoint(Duration::ZERO).unwrap());
            assert!(operation.finish_native_read_only_probe().unwrap());
        }
    }

    #[test]
    fn queued_source_and_ambiguous_enqueue_keep_prompt_changes_quarantined() {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        for phase in [
            "first-payload",
            "later-payload",
            "waiting-start",
            "enqueue-error",
        ] {
            let (broker, operation) = native_probe_state_harness();
            broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::NativeCheckpoint {
                        buffer: String::new(),
                    },
                )
                .unwrap();
            assert!(operation.finish_native_read_only_probe().unwrap());
            let admit = |bytes: &[u8], fail: bool| {
                broker.admit_terminal_input(
                    "transport-1",
                    TerminalBrokerInputSource::Agent {
                        agent_session_id: "agent".into(),
                        task_id: "task".into(),
                        operation_id: "operation".into(),
                    },
                    TerminalInputKind::Text,
                    bytes,
                    || {
                        if fail {
                            Err("ambiguous transport enqueue".into())
                        } else {
                            Ok(())
                        }
                    },
                )
            };
            operation.expect_native_checkpoint("approved").unwrap();
            let first = admit(b"YXBwcm92ZWQ=\x18\x06", phase == "enqueue-error");
            assert_eq!(first.is_err(), phase == "enqueue-error");
            if matches!(phase, "later-payload" | "waiting-start") {
                broker
                    .accept_integration_event(
                        "transport-1",
                        "integration-1",
                        TerminalIntegrationControlEvent::NativeCheckpoint {
                            buffer: "approved".into(),
                        },
                    )
                    .unwrap();
                if phase == "later-payload" {
                    operation
                        .expect_native_checkpoint("approved\nsource")
                        .unwrap();
                    admit(b"CnNvdXJjZQ==\x18\x06", false).unwrap();
                } else {
                    admit(b"\x18\x05", false).unwrap();
                }
            }
            assert!(
                operation.begin_native_read_only_probe().is_err(),
                "Source could be relabelled as a read-only probe: {phase}"
            );
            let error = broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
                )
                .unwrap_err();
            assert!(error.contains("RECOVERY_REQUIRED"), "{phase}: {error}");
            assert_eq!(
                operation.snapshot().unwrap().state,
                TerminalCommandState::Uncertain
            );
            for late in [
                TerminalIntegrationControlEvent::NativeCheckpoint {
                    buffer: String::new(),
                },
                TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
                TerminalIntegrationControlEvent::PromptEnd,
            ] {
                assert!(broker
                    .accept_integration_event("transport-1", "integration-1", late)
                    .is_err());
            }
            assert!(!broker.native_input_enabled("transport-1").unwrap());
            assert!(operation.snapshot().unwrap().no_auto_replay);
            broker
                .release_agent_lease("transport-1", "agent", "task", "operation")
                .unwrap();
            assert!(broker
                .admit_terminal_input(
                    "transport-1",
                    TerminalBrokerInputSource::User,
                    TerminalInputKind::Text,
                    b"\r",
                    || panic!("Sticky gate forwarded Enter")
                )
                .unwrap_err()
                .contains("RECOVERY_REQUIRED"));
        }
    }

    #[test]
    fn native_checkpoint_mismatch_cannot_be_cleared_by_prompts_or_unsolicited_empty_ack() {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        let (broker, _, _, _) = harness();
        assert!(broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true }
            )
            .is_err());
        let advertise = |id: &str| {
            for event in [
                TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
                TerminalIntegrationControlEvent::NativeInput { enabled: true },
                TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true },
                TerminalIntegrationControlEvent::PromptEnd,
            ] {
                broker
                    .accept_integration_event("transport-1", id, event)
                    .unwrap();
            }
        };
        advertise("integration-1");
        broker
            .acquire_agent_lease("transport-1", "agent", "task", "operation")
            .unwrap();
        let operation = broker
            .begin_command("transport-1", "operation", "approved\nsource")
            .unwrap();
        operation.expect_native_checkpoint("approved").unwrap();
        assert!(broker
            .accept_integration_event(
                "transport-1",
                "old-integration",
                TerminalIntegrationControlEvent::NativeCheckpoint {
                    buffer: "approved".into()
                }
            )
            .is_err());
        assert!(!operation.wait_native_checkpoint(Duration::ZERO).unwrap());
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::NativeCheckpoint {
                    buffer: "changed".into(),
                },
            )
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        broker
            .retire_command("transport-1", &operation.command_id().unwrap())
            .unwrap();
        broker
            .release_agent_lease("transport-1", "agent", "task", "operation")
            .unwrap();
        advertise("integration-1");
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::NativeCheckpoint {
                    buffer: String::new(),
                },
            )
            .unwrap();
        assert!(!broker.native_input_enabled("transport-1").unwrap());
        let blocked = broker.admit_terminal_input(
            "transport-1",
            TerminalBrokerInputSource::User,
            TerminalInputKind::Text,
            b"\n",
            || panic!("quarantined input forwarded"),
        );
        assert!(blocked
            .unwrap_err()
            .contains("TERMINAL_INPUT_RECOVERY_REQUIRED"));
        broker
            .register_integration_channel("transport-1", "new-integration", TerminalShellKind::Zsh)
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "new-integration",
                TerminalIntegrationControlEvent::Ready {
                    shell: TerminalShellKind::Zsh,
                },
            )
            .unwrap();
        advertise("new-integration");
        assert!(broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                b"\n",
                || panic!("same-generation integration reset released quarantine")
            )
            .is_err());
        broker
            .attach_transport(
                "new-generation",
                Some("transport-1"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        assert!(broker
            .accept_integration_event(
                "new-generation",
                "integration-1",
                TerminalIntegrationControlEvent::NativeCheckpoint {
                    buffer: "approved".into()
                }
            )
            .is_err());
        // Admission state only; this unit test does not pretend to execute a shell.
        assert!(broker
            .admit_terminal_input(
                "new-generation",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                b"\n",
                || Ok(())
            )
            .is_ok());
    }

    #[test]
    fn native_clear_requires_empty_probe_enqueue_epoch_and_original_binding() {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        let (broker, _, _, _) = harness();
        broker
            .register_integration_channel(
                "transport-1",
                "bash-integration",
                TerminalShellKind::Bash,
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "bash-integration",
                TerminalIntegrationControlEvent::Ready {
                    shell: TerminalShellKind::Bash,
                },
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::NativeInput { enabled: true },
            TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("transport-1", "bash-integration", event)
                .unwrap();
        }
        let prepare = |id: &str| {
            broker
                .acquire_agent_lease("transport-1", "agent", "task", id)
                .unwrap();
            let operation = broker
                .begin_command("transport-1", id, "approved\nsource")
                .unwrap();
            assert!(
                broker.expect_native_clear("transport-1", id).is_err(),
                "clear accepted without proving an empty editor"
            );
            operation.expect_native_checkpoint("").unwrap();
            broker
                .accept_integration_event(
                    "transport-1",
                    "bash-integration",
                    TerminalIntegrationControlEvent::NativeCheckpoint {
                        buffer: String::new(),
                    },
                )
                .unwrap();
            operation
                .request_settlement(TerminalCommandRequestedSettlement::Cancelled)
                .unwrap();
            operation.settle_unsubmitted().unwrap();
            broker
                .retire_command("transport-1", &operation.command_id().unwrap())
                .unwrap();
            broker.expect_native_clear("transport-1", id).unwrap();
        };
        let acknowledge = |sequence, buffer: &str| {
            broker
                .accept_integration_event(
                    "transport-1",
                    "bash-integration",
                    TerminalIntegrationControlEvent::NativeCleared {
                        sequence,
                        buffer: buffer.into(),
                    },
                )
                .unwrap()
        };
        let enqueue = |id: &str| {
            broker
                .admit_terminal_input(
                    "transport-1",
                    TerminalBrokerInputSource::System {
                        operation_id: id.into(),
                    },
                    TerminalInputKind::SystemControl,
                    b"\x18\x04",
                    || Ok(()),
                )
                .unwrap()
        };
        prepare("clear-one");
        acknowledge(1, "");
        assert!(
            !broker
                .wait_native_clear("transport-1", "clear-one", Duration::ZERO)
                .unwrap(),
            "a merely prepared clear was confirmed"
        );
        enqueue("clear-one");
        acknowledge(1, "");
        assert!(broker
            .wait_native_clear("transport-1", "clear-one", Duration::ZERO)
            .unwrap());
        broker
            .release_agent_lease("transport-1", "agent", "task", "clear-one")
            .unwrap();
        prepare("clear-two");
        acknowledge(1, "");
        enqueue("clear-two");
        acknowledge(1, "");
        assert!(
            !broker
                .wait_native_clear("transport-1", "clear-two", Duration::ZERO)
                .unwrap(),
            "old L confirmed a later clear"
        );
        broker
            .require_native_input_recovery("transport-1", "clear-two")
            .unwrap();
        broker
            .release_agent_lease("transport-1", "agent", "task", "clear-two")
            .unwrap();
        assert!(
            broker
                .acquire_agent_lease("transport-1", "agent", "task", "clear-three")
                .is_err(),
            "an unfinished clear allowed a replacement lease"
        );
        broker
            .register_integration_channel(
                "transport-1",
                "new-bash-integration",
                TerminalShellKind::Bash,
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "new-bash-integration",
                TerminalIntegrationControlEvent::Ready {
                    shell: TerminalShellKind::Bash,
                },
            )
            .unwrap();
        assert!(broker
            .accept_integration_event(
                "transport-1",
                "new-bash-integration",
                TerminalIntegrationControlEvent::NativeCleared {
                    sequence: 2,
                    buffer: String::new()
                }
            )
            .is_err());
        assert!(!broker
            .wait_native_clear("transport-1", "clear-two", Duration::ZERO)
            .unwrap());
        assert!(broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                b"\n",
                || panic!("late clear released quarantined input")
            )
            .is_err());
    }

    #[test]
    fn admitted_accept_key_revokes_native_clear_before_command_start() {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        let (broker, _, _, _) = harness();
        broker
            .register_integration_channel("transport-1", "bash", TerminalShellKind::Bash)
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Bash,
            },
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::NativeInput { enabled: true },
            TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("transport-1", "bash", event)
                .unwrap();
        }
        broker
            .acquire_agent_lease("transport-1", "agent", "task", "operation")
            .unwrap();
        let operation = broker
            .begin_command("transport-1", "operation", "approved")
            .unwrap();
        operation.expect_native_checkpoint("").unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "bash",
                TerminalIntegrationControlEvent::NativeCheckpoint {
                    buffer: String::new(),
                },
            )
            .unwrap();
        broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent".into(),
                    task_id: "task".into(),
                    operation_id: "operation".into(),
                },
                TerminalInputKind::Text,
                b"\x18\x05",
                || Ok(()),
            )
            .unwrap();
        assert!(broker
            .expect_native_clear("transport-1", "operation")
            .is_err());
        assert!(broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::System {
                    operation_id: "operation".into()
                },
                TerminalInputKind::SystemControl,
                b"\x18\x04",
                || panic!("clear shortcut reached an accepted foreground program")
            )
            .is_err());
    }

    #[test]
    fn private_control_checkpoint_rejects_mismatch_and_ignores_retired_nonce() {
        for user_buffer in ["", "user draft"] {
            let (broker, _, _, _) = harness();
            let emit = |event| {
                broker
                    .accept_integration_event("transport-1", "integration-1", event)
                    .unwrap()
            };
            for event in [
                TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
                TerminalIntegrationControlEvent::NativeInput { enabled: true },
                TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true },
                TerminalIntegrationControlEvent::NativePrivateControl { enabled: true },
                TerminalIntegrationControlEvent::PromptEnd,
            ] {
                emit(event);
            }
            broker
                .acquire_agent_lease("transport-1", "agent", "task", "operation")
                .unwrap();
            let operation = broker
                .begin_command("transport-1", "operation", "approved")
                .unwrap();
            operation.expect_native_checkpoint("").unwrap();
            emit(TerminalIntegrationControlEvent::NativeCheckpoint {
                buffer: String::new(),
            });
            let descriptor = format!("p{}{}", "1".repeat(32), "2".repeat(32));
            operation
                .expect_native_private_checkpoint(&descriptor)
                .unwrap();
            emit(TerminalIntegrationControlEvent::NativePrivateCheckpoint {
                descriptor: format!("p{}{}", "1".repeat(32), "3".repeat(32)),
                buffer: String::new(),
            });
            assert!(!operation
                .wait_native_private_checkpoint(Duration::ZERO)
                .unwrap());
            emit(TerminalIntegrationControlEvent::NativePrivateCheckpoint {
                descriptor: descriptor.clone(),
                buffer: String::new(),
            });
            assert!(operation
                .wait_native_private_checkpoint(Duration::ZERO)
                .unwrap());
            emit(TerminalIntegrationControlEvent::NativePrivateCheckpoint {
                descriptor: format!("p{}{}", "1".repeat(32), "3".repeat(32)),
                buffer: String::new(),
            });
            assert!(operation
                .wait_native_private_checkpoint(Duration::ZERO)
                .unwrap());
            emit(TerminalIntegrationControlEvent::NativePrivateCheckpoint {
                descriptor: if user_buffer.is_empty() {
                    format!("s{}{}", "1".repeat(32), "2".repeat(32))
                } else {
                    descriptor
                },
                buffer: user_buffer.into(),
            });
            assert!(!operation
                .wait_native_private_checkpoint(Duration::ZERO)
                .unwrap());
            assert!(!broker.native_input_enabled("transport-1").unwrap());
            assert_eq!(
                operation.snapshot().unwrap().state,
                TerminalCommandState::Uncertain
            );
        }
    }

    #[test]
    fn uncertain_job_observation_requires_the_new_control_command_exact_start() {
        let (broker, _, _, _) = harness();
        let prompt = || {
            for event in [
                TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
                TerminalIntegrationControlEvent::NativeInput { enabled: true },
                TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true },
                TerminalIntegrationControlEvent::NativePrivateControl { enabled: true },
                TerminalIntegrationControlEvent::NativeJobs { enabled: true },
                TerminalIntegrationControlEvent::PromptEnd,
            ] {
                broker
                    .accept_integration_event("transport-1", "integration-1", event)
                    .unwrap();
            }
        };
        prompt();
        let target = crate::agent_runtime::AgentToolTargetNative::Local {
            target_id: "owner".into(),
            session_id: "transport-1".into(),
            cwd: None,
        };
        let job = broker
            .prepare_shell_job(
                "transport-1",
                &target,
                "agent",
                "task",
                "launch",
                "sleep 60",
            )
            .unwrap();
        broker
            .acquire_agent_lease("transport-1", "agent", "task", "launch")
            .unwrap();
        let launch = broker
            .begin_command_with_submission(
                "transport-1",
                "launch",
                "sleep 60",
                Some(&job.submitted_command_line),
            )
            .unwrap();
        let running = || {
            broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::Job {
                        handle: job.process_handle.clone(),
                        state: "running".into(),
                        exit_code: None,
                    },
                )
                .unwrap()
        };
        running();
        assert!(
            !broker
                .shell_job(&job.process_handle, "owner", "agent", "task")
                .unwrap()
                .launch_confirmed,
            "a prepared launch was treated as already accepted"
        );
        command_start(&broker, &job.submitted_command_line);
        running();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code: 0,
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
        broker
            .retire_command("transport-1", &launch.command_id().unwrap())
            .unwrap();
        broker
            .release_agent_lease("transport-1", "agent", "task", "launch")
            .unwrap();
        prompt();
        broker
            .mark_shell_job_uncertain(&job.process_handle)
            .unwrap();
        let unknown = broker
            .shell_job(&job.process_handle, "owner", "agent", "task")
            .unwrap();
        let line = broker
            .prepare_shell_job_control(&unknown, "fresh-control", false)
            .unwrap();
        broker
            .acquire_agent_lease("transport-1", "agent", "task", "fresh-control")
            .unwrap();
        let control = broker
            .begin_command_with_submission("transport-1", "fresh-control", &line, Some(&line))
            .unwrap();
        running();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::Job {
                    handle: job.process_handle.clone(),
                    state: "finished".into(),
                    exit_code: Some(7),
                },
            )
            .unwrap();
        let stale = broker
            .shell_job(&job.process_handle, "owner", "agent", "task")
            .unwrap();
        assert_eq!(stale.state, "uncertain");
        assert_eq!(stale.exit_code, None);
        assert_eq!(stale.observation_revision, unknown.observation_revision);
        assert_eq!(stale.observed_at_unix_ms, unknown.observed_at_unix_ms);
        command_start(&broker, &line);
        running();
        let observed = broker
            .shell_job(&job.process_handle, "owner", "agent", "task")
            .unwrap();
        assert_eq!(observed.state, "running");
        assert!(observed.observation_revision > unknown.observation_revision);
        assert_eq!(
            observed.accepted_command_line,
            Some(job.submitted_command_line.clone())
        );
        assert_eq!(
            control.snapshot().unwrap().state,
            TerminalCommandState::Running
        );
        broker
            .close_transport(
                "transport-1",
                crate::terminal_broker::TerminalGenerationCloseReason::TransportDisconnected,
            )
            .unwrap();
        let lost = broker
            .shell_job(&job.process_handle, "owner", "agent", "task")
            .unwrap();
        assert!(lost.control_lost);
        assert_eq!(lost.state, "uncertain");
        assert!(broker
            .prepare_shell_job_control(&lost, "invalid-control", true)
            .is_err());
    }

    fn harness() -> (
        TerminalSessionBroker,
        TerminalExecuteRegistry,
        SessionManager,
        Receiver<SessionCommand>,
    ) {
        let broker = TerminalSessionBroker::phase3_enabled_for_test(128);
        broker
            .attach_transport(
                "transport-1",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        broker
            .register_integration_channel("transport-1", "integration-1", TerminalShellKind::Zsh)
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Zsh,
            },
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("transport-1", "integration-1", event)
                .unwrap();
        }
        let leases = TerminalLeaseManager::new(broker.clone());
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let registry = TerminalExecuteRegistry::new(leases, broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                "transport-1".into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: "transport-1".into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "zsh".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        (broker, registry, sessions, receiver)
    }

    fn command_start(broker: &TerminalSessionBroker, command: &str) {
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: command.into(),
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
    }

    #[test]
    fn native_capability_and_rejection_obey_control_identity_order_and_exact_line() {
        let (broker, _, _, _) = harness();
        let enabled = TerminalIntegrationControlEvent::NativeInput { enabled: true };
        assert!(broker
            .accept_integration_event("transport-1", "integration-1", enabled.clone())
            .is_err());
        assert!(!broker.native_input_enabled("transport-1").unwrap());
        assert!(broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::NativeComments { enabled: true }
            )
            .is_err());
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            )
            .unwrap();
        assert!(broker
            .accept_integration_event("transport-1", "old-integration", enabled.clone())
            .is_err());
        broker
            .accept_integration_event("transport-1", "integration-1", enabled.clone())
            .unwrap();
        assert!(
            !broker.native_input_enabled("transport-1").unwrap(),
            "legacy I alone must not enable unchecked input"
        );
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::NativeCheckpointMode { enabled: true },
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::NativeComments { enabled: true },
            )
            .unwrap();
        assert!(broker.native_comments_enabled("transport-1").unwrap());
        assert!(
            !broker.native_input_enabled("transport-1").unwrap(),
            "legacy Zsh I/H without a private source receiver must not authorize data"
        );
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::NativePrivateControl { enabled: true },
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::PromptEnd,
            )
            .unwrap();
        assert!(broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .integration_capabilities
            .contains(&"nativeScriptInput"));
        broker
            .acquire_agent_lease("transport-1", "agent", "task", "operation")
            .unwrap();
        let operation = broker
            .begin_command("transport-1", "operation", "printf first\nprintf second")
            .unwrap();
        assert!(broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::InputRejected {
                    command_line: "printf first\nprintf second".into(),
                    reason: "arbitrary".into()
                }
            )
            .is_err());
        assert!(broker
            .accept_integration_event(
                "transport-1",
                "old-integration",
                TerminalIntegrationControlEvent::InputRejected {
                    command_line: "printf first\nprintf second".into(),
                    reason: "TERMINAL_INPUT_UNSUPPORTED".into()
                }
            )
            .is_err());
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Submitted
        );
        assert!(broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::InputRejected {
                    command_line: "different script".into(),
                    reason: "TERMINAL_INPUT_UNSUPPORTED".into()
                }
            )
            .is_err());
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        assert!(!broker.native_input_enabled("transport-1").unwrap());
        broker
            .register_integration_channel(
                "transport-1",
                "replacement-integration",
                TerminalShellKind::Zsh,
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "replacement-integration",
                TerminalIntegrationControlEvent::Ready {
                    shell: TerminalShellKind::Zsh,
                },
            )
            .unwrap();
        assert!(!broker.native_input_enabled("transport-1").unwrap());
        assert!(broker
            .accept_integration_event("transport-1", "replacement-integration", enabled.clone())
            .is_err());
        broker
            .close_transport(
                "transport-1",
                crate::terminal_broker::TerminalGenerationCloseReason::TransportDisconnected,
            )
            .unwrap();
        broker
            .attach_transport(
                "replacement",
                Some("transport-1"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        assert!(!broker.native_input_enabled("replacement").unwrap());
        assert!(broker
            .accept_integration_event("transport-1", "integration-1", enabled)
            .is_err());
    }

    // Real Broker admission without an integration, transport or manufactured receipt.
    #[test]
    fn retired_source_is_rejected_before_lease_or_transport_access() {
        use crate::terminal_command::protocol::InputMode;
        for mode in [InputMode::Raw] {
            let broker = TerminalSessionBroker::phase3_enabled_for_test(128);
            broker
                .attach_transport_with_mode(
                    "unsupported",
                    None,
                    TerminalTransportKind::LocalPty,
                    TerminalGeometry::new(80, 24),
                    mode,
                )
                .unwrap();
            let before = broker
                .snapshot(Some("unsupported"))
                .unwrap()
                .session
                .unwrap();
            let registry = TerminalExecuteRegistry::new(
                TerminalLeaseManager::new(broker.clone()),
                broker.clone(),
            );
            for command in ["pwd", "printf '中文é👩‍💻'\nprintf done"] {
                let result = registry.start(
                    &SessionManager::default(),
                    "unsupported",
                    "agent",
                    "task",
                    "new-source",
                    command,
                    "\n",
                );
                assert!(
                    matches!(result, Err(error) if error.starts_with("TERMINAL_NATIVE_INPUT_REQUIRED"))
                );
                assert!(!registry.has_operation("unsupported").unwrap());
                let after = broker
                    .snapshot(Some("unsupported"))
                    .unwrap()
                    .session
                    .unwrap();
                assert_eq!(after.terminal_generation, before.terminal_generation);
                assert_eq!(after.input_mode, before.input_mode);
                assert_eq!(after.active_command_id, before.active_command_id);
                assert_eq!(after.input_observation, before.input_observation);
            }
        }
    }
