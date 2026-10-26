    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crate::terminal_broker::{TerminalGeometry, TerminalTransportKind};
    use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};
    use crossbeam_channel::{unbounded, Receiver};
    use std::sync::atomic::AtomicBool;
    use std::thread;

    #[test]
    #[cfg(target_os = "macos")]
    fn posix_source_frame_roundtrips_literal_utf8_and_control_bytes_with_native_printf() {
        let source = "printf '%s\\n' '$value `literal` \\c \\x41'\r\n# 字😀\tend\n";
        for (shell, executable) in [
            (TerminalShellKind::Zsh, "/bin/zsh"),
            (TerminalShellKind::Bash, "/bin/bash"),
        ] {
            let frames = native_editor_chunks(source, shell);
            assert_eq!(frames.len(), 1);
            let (wire, buffer) = &frames[0];
            assert_eq!(buffer, source);
            let wire = wire.as_str();
            assert!(!wire.contains(['\n', '\r', '\t', '\u{1b}', '\u{18}']));
            let output = std::process::Command::new(executable)
                .args(["-f", "-c", "builtin printf '%b' \"$1\"", "frame", wire])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, source.as_bytes());
        }
    }

    #[test]
    #[cfg(unix)]
    fn bash_background_frame_preserves_source_separately_from_its_eval_envelope() {
        let source =
            "alias ss_literal='printf \\\"中文🙂\\\"'\nss_literal\n# $value `literal` \\c\t\r\n";
        let line = crate::terminal_jobs::shell_submission(
            source,
            "job-0123456789abcdef0123456789abcdef",
            TerminalShellKind::Bash,
        )
        .unwrap();
        assert_eq!(
            crate::terminal_integration::bash_native_eval_source(&line).as_deref(),
            Some(source)
        );
        let frames = native_editor_chunks(&line, TerminalShellKind::Bash);
        assert_eq!(frames.len(), 1);
        let (wire, buffer) = &frames[0];
        assert_eq!(buffer, &line);
        let output = std::process::Command::new("/bin/bash")
            .args([
                "--noprofile",
                "--norc",
                "-c",
                "builtin printf '%b' \"$1\"",
                "frame",
                wire,
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, [source.as_bytes(), line.as_bytes()].concat());
        assert!(crate::terminal_integration::bash_native_eval_source(
            &line.replace("job-0123456789abcdef0123456789abcdef", "job-invalid")
        )
        .is_none());
    }

    #[test]
    fn powershell_editor_batches_are_bounded_utf8_data_with_exact_buffer_prefixes() {
        use base64::Engine;
        let command = format!(
            "$value = @'\n{}\nreal\tTab 'single' \"double\"\r\n'@\nWrite-Output $value",
            "字😀".repeat(1800)
        );
        for shell in [
            TerminalShellKind::WindowsPowerShell,
            TerminalShellKind::PowerShell7,
        ] {
            let batches = native_editor_chunks(&command, shell);
            assert!(batches.len() >= 2);
            let limit = POWERSHELL_EDITOR_BATCH_BYTES;
            let mut actual = String::new();
            for (wire, prefix) in batches {
                let encoded = wire
                    .strip_suffix("\u{18}\u{6}")
                    .expect("non-submitting bounded data fence");
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap();
                assert!(!bytes.is_empty() && bytes.len() <= limit);
                actual.push_str(std::str::from_utf8(&bytes).unwrap());
                assert_eq!(prefix, actual);
                assert!(!wire.contains(['\n', '\r']) && !encoded.contains('\u{18}'));
            }
            assert_eq!(actual, command);
            assert_eq!(native_editor_chunks(&"x".repeat(limit), shell).len(), 1);
        }
    }

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
    fn typing_keeps_graphemes_intact_and_bounds_long_command_delay() {
        let command = "终端e\u{301}👩‍💻";
        assert_eq!(
            typing_chunks(command, false),
            ["终", "端", "e\u{301}", "👩‍💻"]
        );
        let long = command.repeat(2_000);
        let chunks = typing_chunks(&long, false);
        assert!(chunks.len() <= TYPING_MAX_STEPS);
        assert_eq!(chunks.concat(), long);
        assert!(TYPING_INTERVAL * chunks.len() as u32 <= Duration::from_millis(1_700));
        assert_eq!(typing_chunks(command, true), [command]);
        assert_eq!(typing_chunks("", false), [""]);
    }

    #[test]
    fn native_editor_encoding_preserves_original_bytes_without_flow_control_keys() {
        assert_eq!(
            native_editor_input("a\nb\tc\rd"),
            "a\u{18}nb\u{18}tc\u{18}rd"
        );
        assert!(!native_editor_input("a\nb\tc\rd").contains(['\u{11}', '\u{13}']));
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
    fn user_submit_closes_prompt_gate_before_shell_start_event() {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        let (broker, registry, sessions, receiver) = harness();
        broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                b"\r",
                || Ok(()),
            )
            .unwrap();
        assert!(
            !broker
                .snapshot(Some("transport-1"))
                .unwrap()
                .session
                .unwrap()
                .prompt_ready
        );
        assert!(registry
            .start(
                &sessions,
                "transport-1",
                "agent",
                "task",
                "operation",
                "printf forbidden",
                "\n"
            )
            .is_err());
        assert!(
            receiver.try_recv().is_err(),
            "a control command reached a just-submitted user program"
        );
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

    #[test]
    fn prepared_shell_jobs_fence_replacement_before_command_creation_and_input() {
        for boundary in [
            TerminalExecuteValidationStage::LeaseAcquisition,
            TerminalExecuteValidationStage::CommandCreation,
            TerminalExecuteValidationStage::InputWrite,
        ] {
            for replace_generation in [false, true] {
                let (broker, registry, sessions, receiver) = harness();
                // State-machine coverage; real execution is covered by native PTY/SSH tests.
                broker
                    .accept_integration_event(
                        "transport-1",
                        "integration-1",
                        TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
                    )
                    .unwrap();
                broker
                    .accept_integration_event(
                        "transport-1",
                        "integration-1",
                        TerminalIntegrationControlEvent::NativeInput { enabled: true },
                    )
                    .unwrap();
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
                        TerminalIntegrationControlEvent::NativeJobs { enabled: true },
                    )
                    .unwrap();
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
                        TerminalIntegrationControlEvent::PromptEnd,
                    )
                    .unwrap();
                let target = crate::agent_runtime::AgentToolTargetNative::Local {
                    target_id: "owner".into(),
                    session_id: "transport-1".into(),
                    cwd: None,
                };
                let job = broker
                    .prepare_shell_job(
                        "transport-1",
                        &target,
                        "agent-1",
                        "task-1",
                        "launch",
                        "printf never",
                    )
                    .unwrap();
                assert!(broker
                    .prepare_shell_job(
                        "transport-1",
                        &target,
                        "agent-1",
                        "task-1",
                        "launch",
                        "printf never"
                    )
                    .unwrap_err()
                    .contains("TERMINAL_JOB_LAUNCH_ALREADY_REGISTERED"));
                let result = registry.start_native_submission(
                    &sessions,
                    "transport-1",
                    "agent-1",
                    "task-1",
                    "launch",
                    "printf never",
                    "\n",
                    Some(&job.submitted_command_line),
                    |stage| {
                        if stage == boundary {
                            if replace_generation {
                                broker
                                    .attach_transport(
                                        "replacement",
                                        Some("transport-1"),
                                        TerminalTransportKind::LocalPty,
                                        TerminalGeometry::new(80, 24),
                                    )
                                    .unwrap();
                            } else {
                                broker
                                    .register_integration_channel(
                                        "transport-1",
                                        "integration-replacement",
                                        TerminalShellKind::Zsh,
                                    )
                                    .unwrap();
                                for event in [
                                    TerminalIntegrationControlEvent::Ready {
                                        shell: TerminalShellKind::Zsh,
                                    },
                                    TerminalIntegrationControlEvent::PromptStart {
                                        cwd: "/tmp".into(),
                                    },
                                    TerminalIntegrationControlEvent::NativeInput { enabled: true },
                                    TerminalIntegrationControlEvent::NativeCheckpointMode {
                                        enabled: true,
                                    },
                                    TerminalIntegrationControlEvent::NativePrivateControl {
                                        enabled: true,
                                    },
                                    TerminalIntegrationControlEvent::NativeJobs { enabled: true },
                                    TerminalIntegrationControlEvent::PromptEnd,
                                ] {
                                    broker
                                        .accept_integration_event(
                                            "transport-1",
                                            "integration-replacement",
                                            event,
                                        )
                                        .unwrap();
                                }
                            }
                        }
                        Ok(())
                    },
                );
                assert!(result.is_err(), "{boundary:?} accepted stale prepared job");
                assert!(
                    receiver.try_recv().is_err(),
                    "stale preparation wrote terminal input at {boundary:?}"
                );
                let fenced = broker
                    .shell_job(&job.process_handle, "owner", "agent-1", "task-1")
                    .unwrap();
                assert!(fenced.control_lost);
                assert_eq!(
                    fenced.state,
                    if boundary == TerminalExecuteValidationStage::InputWrite {
                        "rejected"
                    } else {
                        "uncertain"
                    }
                );
            }
        }
    }

    #[test]
    fn native_job_wait_readiness_cancellation_and_deadline_write_nothing() {
        use std::sync::atomic::Ordering;
        for cancel in [true, false] {
            let (broker, _, sessions, receiver) = harness();
            let leases = TerminalLeaseManager::new(broker.clone());
            // Intentionally no readiness acknowledgement: exercise the actual
            // lease wait and cancellation deadline, not a fabricated command.
            let registry = TerminalExecuteRegistry::new(leases, broker.clone());
            let cancelled = Arc::new(AtomicBool::new(false));
            let signal = cancelled.clone();
            let trigger = thread::spawn(move || {
                thread::sleep(Duration::from_millis(30));
                if cancel {
                    signal.store(true, Ordering::SeqCst);
                }
            });
            let started = Instant::now();
            let result = registry.start_native_submission_until(
                &sessions,
                "transport-1",
                "ready-agent",
                "ready-task",
                "ready-operation",
                "printf never",
                "\n",
                None,
                Some(started + Duration::from_millis(120)),
                |_| {
                    if cancelled.load(Ordering::SeqCst) {
                        Err("wait cancelled".into())
                    } else {
                        Ok(())
                    }
                },
            );
            trigger.join().unwrap();
            assert!(result.is_err());
            assert!(
                started.elapsed() < Duration::from_millis(500),
                "readiness exceeded total budget"
            );
            assert!(
                receiver.try_recv().is_err(),
                "cancelled/expired readiness wrote input"
            );
            assert!(!registry.has_operation("transport-1").unwrap());
        }
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
    fn unexpected_prompt_cannot_reauthorize_an_unconfirmed_input_buffer() {
        let (broker, registry, sessions, _receiver) = harness();
        let operation = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "printf safe",
                "\n",
            )
            .unwrap();
        let error = broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            )
            .unwrap_err();
        assert!(error.starts_with("TERMINAL_INPUT_RECOVERY_REQUIRED"));
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        let snapshot = registry
            .wait(
                &sessions,
                "transport-1",
                &operation,
                Duration::from_millis(10),
            )
            .unwrap();
        assert!(snapshot.no_auto_replay);
        registry.leases.release_turn("agent-1").unwrap();
        let error = registry
            .leases
            .write(
                &sessions,
                "transport-1",
                "\n".into(),
                TerminalInputSource::User,
            )
            .unwrap_err();
        assert!(
            error.starts_with("TERMINAL_INPUT_RECOVERY_REQUIRED"),
            "{error}"
        );
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

    fn command_end(broker: &TerminalSessionBroker, exit_code: i32) {
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code,
                    cwd: "/tmp/after".into(),
                },
            )
            .unwrap();
    }

    #[test]
    fn submits_exact_real_input_and_returns_cooperative_contract() {
        let (broker, registry, sessions, receiver) = harness();
        let operation = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "printf '终端'",
                "\n",
            )
            .unwrap();
        let worker_broker = broker.clone();
        let worker = thread::spawn(move || {
            let SessionCommand::Write(input) = receiver.recv().unwrap() else {
                panic!("expected command input")
            };
            assert_eq!(input, "printf '终端'\n");
            assert!(!input.contains("/bin/sh -c"));
            assert!(!input.contains("BEGIN:"));
            assert!(!input.contains("[Agent]"));
            command_start(&worker_broker, "printf '终端'");
            worker_broker
                .observe_raw_output("transport-1", b"\x1b[31mterminal\x1b[0m")
                .unwrap();
            command_end(&worker_broker, 3);
        });
        let snapshot = registry
            .wait(&sessions, "transport-1", &operation, Duration::from_secs(2))
            .unwrap();
        worker.join().unwrap();
        assert_eq!(snapshot.state, TerminalCommandState::Completed);
        assert_eq!(snapshot.command_line, "printf '终端'");
        assert_eq!(snapshot.exit_code, Some(3));
        assert_eq!(snapshot.cwd.as_deref(), Some("/tmp/after"));
        assert!(snapshot.combined_output.contains("terminal"));
        assert!(snapshot.no_auto_replay);
    }

    fn interrupt_settlement(
        requested: TerminalCommandRequestedSettlement,
        expected: TerminalCommandState,
    ) {
        let (broker, registry, sessions, receiver) = harness();
        let operation = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "sleep 60",
                "\n",
            )
            .unwrap();
        let worker_broker = broker.clone();
        let worker = thread::spawn(move || {
            let SessionCommand::Write(input) = receiver.recv().unwrap() else {
                panic!("expected command input")
            };
            assert_eq!(input, "sleep 60\n");
            command_start(&worker_broker, "sleep 60");
            let SessionCommand::Write(interrupt) = receiver.recv().unwrap() else {
                panic!("expected interrupt")
            };
            assert_eq!(interrupt.as_bytes(), [3]);
            command_end(&worker_broker, 130);
        });
        match requested {
            TerminalCommandRequestedSettlement::Cancelled => {
                assert_eq!(registry.cancel_task(&sessions, "task-1").unwrap(), 1);
            }
            TerminalCommandRequestedSettlement::TakenOver => {
                assert!(registry
                    .takeover(&sessions, "transport-1", "agent-1", "operation-1",)
                    .unwrap());
            }
            TerminalCommandRequestedSettlement::TimedOut => {}
        }
        let timeout = if requested == TerminalCommandRequestedSettlement::TimedOut {
            Duration::from_millis(1)
        } else {
            Duration::from_secs(2)
        };
        let snapshot = registry
            .wait(&sessions, "transport-1", &operation, timeout)
            .unwrap();
        worker.join().unwrap();
        assert_eq!(snapshot.state, expected);
        assert_eq!(snapshot.exit_code, Some(130));
    }

    #[test]
    fn cancellation_timeout_and_takeover_use_one_scoped_interrupt_and_cooperative_end() {
        interrupt_settlement(
            TerminalCommandRequestedSettlement::Cancelled,
            TerminalCommandState::Cancelled,
        );
        interrupt_settlement(
            TerminalCommandRequestedSettlement::TimedOut,
            TerminalCommandState::TimedOut,
        );
        interrupt_settlement(
            TerminalCommandRequestedSettlement::TakenOver,
            TerminalCommandState::TakenOver,
        );
    }

    #[test]
    fn closed_terminal_returns_captured_uncertain_result_without_replay() {
        let (broker, registry, sessions, receiver) = harness();
        let operation = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "sleep 60",
                "\n",
            )
            .unwrap();
        assert!(matches!(receiver.recv().unwrap(), SessionCommand::Write(_)));
        command_start(&broker, "sleep 60");
        broker
            .observe_raw_output("transport-1", b"before close")
            .unwrap();
        assert!(registry.terminal_closed("transport-1").unwrap());
        broker
            .close_transport(
                "transport-1",
                crate::terminal_broker::TerminalGenerationCloseReason::UserClosed,
            )
            .unwrap();
        assert!(!registry.has_operation("transport-1").unwrap());
        let snapshot = registry
            .wait(&sessions, "transport-1", &operation, Duration::from_secs(1))
            .unwrap();
        assert_eq!(snapshot.state, TerminalCommandState::Uncertain);
        assert_eq!(snapshot.exit_code, None);
        assert_eq!(snapshot.combined_output, "before close");
        assert!(snapshot.no_auto_replay);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn retired_waiter_and_cleanup_leave_new_command_registered() {
        let (broker, registry, sessions, receiver) = harness();
        let old = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "sleep 60",
                "\n",
            )
            .unwrap();
        receiver.recv().unwrap();
        command_start(&broker, "sleep 60");
        registry.terminal_closed("transport-1").unwrap();
        broker
            .close_transport(
                "transport-1",
                crate::terminal_broker::TerminalGenerationCloseReason::UserClosed,
            )
            .unwrap();
        broker
            .attach_transport(
                "transport-1",
                Some("transport-1"),
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
        let current = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-2",
                "operation-2",
                "pwd",
                "\n",
            )
            .unwrap();
        receiver.recv().unwrap();
        registry
            .finish_registration(
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::TerminalClosed,
            )
            .unwrap();
        let old_snapshot = registry
            .wait(&sessions, "transport-1", &old, Duration::from_secs(1))
            .unwrap();
        assert_eq!(old_snapshot.state, TerminalCommandState::Uncertain);
        assert!(registry.has_operation("transport-1").unwrap());
        command_start(&broker, "pwd");
        command_end(&broker, 0);
        let current_snapshot = registry
            .wait(&sessions, "transport-1", &current, Duration::from_secs(1))
            .unwrap();
        assert_eq!(current_snapshot.state, TerminalCommandState::Completed);
        assert_eq!(current_snapshot.exit_code, Some(0));
        assert!(!registry.has_operation("transport-1").unwrap());
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn missing_cooperative_end_is_uncertain_and_never_reported_as_timeout() {
        let (broker, registry, sessions, receiver) = harness();
        let operation = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "side-effect; sleep 60",
                "\n",
            )
            .unwrap();
        let worker_broker = broker.clone();
        let worker = thread::spawn(move || {
            let SessionCommand::Write(_) = receiver.recv().unwrap() else {
                panic!("expected command input")
            };
            command_start(&worker_broker, "side-effect; sleep 60");
            let SessionCommand::Write(interrupt) = receiver.recv().unwrap() else {
                panic!("expected interrupt")
            };
            assert_eq!(interrupt.as_bytes(), [3]);
        });
        let snapshot = registry
            .wait(
                &sessions,
                "transport-1",
                &operation,
                Duration::from_millis(1),
            )
            .unwrap();
        worker.join().unwrap();
        assert_eq!(snapshot.state, TerminalCommandState::Uncertain);
        assert_eq!(snapshot.exit_code, None);
        assert!(snapshot.no_auto_replay);
    }
