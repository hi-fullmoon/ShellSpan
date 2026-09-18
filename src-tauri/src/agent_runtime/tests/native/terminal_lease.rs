    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crate::terminal_broker::{TerminalGeometry, TerminalSessionBroker, TerminalTransportKind};
    use crossbeam_channel::{unbounded, Receiver};
    use std::sync::atomic::AtomicBool;

    fn sessions() -> (SessionManager, Receiver<SessionCommand>) {
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                "terminal-1".into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: "terminal-1".into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "Local".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        (sessions, receiver)
    }

    fn acquire(manager: &TerminalLeaseManager) {
        manager
            .acquire("terminal-1", "agent-1", "task-1", "operation-1", None)
            .unwrap();
    }

    fn disabled_broker_manager() -> TerminalLeaseManager {
        TerminalLeaseManager::new(TerminalSessionBroker::disabled_for_test())
    }

    #[test]
    fn single_owner_busy_wrong_owner_and_idempotent_release() {
        let manager = disabled_broker_manager();
        assert!(!manager.has_lease("terminal-1").unwrap());
        acquire(&manager);
        assert!(manager.has_lease("terminal-1").unwrap());
        assert!(manager
            .acquire("terminal-1", "agent-2", "task-2", "operation-2", None)
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_BUSY:"));
        assert!(manager
            .release(
                "terminal-1",
                "agent-2",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::Cancelled,
            )
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_OWNER_MISMATCH:"));
        assert!(manager
            .release(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::Completed,
            )
            .unwrap());
        assert!(manager.has_lease("terminal-1").unwrap());
        manager.release_turn("agent-1").unwrap();
        assert!(!manager.has_lease("terminal-1").unwrap());
        assert!(!manager
            .release(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::Completed,
            )
            .unwrap());
    }

    #[test]
    fn user_input_is_rejected_and_agent_operation_must_match() {
        let manager = disabled_broker_manager();
        let (sessions, receiver) = sessions();
        manager
            .write(
                &sessions,
                "terminal-1",
                "before".into(),
                TerminalInputSource::User,
            )
            .unwrap();
        acquire(&manager);
        assert!(manager
            .write(
                &sessions,
                "terminal-1",
                "blocked".into(),
                TerminalInputSource::User,
            )
            .unwrap_err()
            .starts_with("TERMINAL_INPUT_BLOCKED_BY_AGENT:"));
        assert!(manager
            .write(
                &sessions,
                "terminal-1",
                "wrong".into(),
                TerminalInputSource::Agent {
                    agent_session_id: "agent-1",
                    task_id: "task-1",
                    operation_id: "operation-2",
                },
            )
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_OPERATION_MISMATCH:"));
        manager
            .write(
                &sessions,
                "terminal-1",
                "agent".into(),
                TerminalInputSource::Agent {
                    agent_session_id: "agent-1",
                    task_id: "task-1",
                    operation_id: "operation-1",
                },
            )
            .unwrap();
        let writes = receiver
            .try_iter()
            .filter_map(|command| match command {
                SessionCommand::Write(data) => Some(data),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(writes, vec!["before", "agent"]);
    }

    #[test]
    fn binary_user_input_preserves_bytes_and_respects_agent_ownership() {
        let manager = disabled_broker_manager();
        let (sessions, receiver) = sessions();
        let bytes = vec![0x1b, 0x5b, 0x80, 0xff];

        manager
            .write_binary(
                &sessions,
                "terminal-1",
                bytes.clone(),
                TerminalInputSource::User,
            )
            .unwrap();
        let SessionCommand::WriteBytes(received) = receiver.recv().unwrap() else {
            panic!("expected binary terminal input");
        };
        assert_eq!(received, bytes);

        acquire(&manager);
        assert!(manager
            .write_binary(
                &sessions,
                "terminal-1",
                vec![0x1b, 0x4d],
                TerminalInputSource::User,
            )
            .unwrap_err()
            .starts_with("TERMINAL_INPUT_BLOCKED_BY_AGENT:"));
    }

    #[test]
    fn user_input_stays_blocked_between_commands_until_turn_end() {
        let manager = disabled_broker_manager();
        let (sessions, receiver) = sessions();
        manager.begin_turn("terminal-1", "agent-1").unwrap();
        assert!(manager
            .write(
                &sessions,
                "terminal-1",
                "blocked before first command".into(),
                TerminalInputSource::User,
            )
            .unwrap_err()
            .starts_with("TERMINAL_INPUT_BLOCKED_BY_AGENT:"));
        acquire(&manager);
        manager
            .release(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::Completed,
            )
            .unwrap();
        assert!(manager.has_lease("terminal-1").unwrap());
        assert!(manager
            .write(
                &sessions,
                "terminal-1",
                "blocked".into(),
                TerminalInputSource::User
            )
            .unwrap_err()
            .starts_with("TERMINAL_INPUT_BLOCKED_BY_AGENT:"));
        assert!(manager
            .acquire("terminal-1", "agent-2", "task-2", "operation-2", None)
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_BUSY:"));
        manager
            .acquire("terminal-1", "agent-1", "task-1", "operation-2", None)
            .unwrap();
        manager
            .release(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-2",
                TerminalLeaseReleaseReason::Completed,
            )
            .unwrap();
        manager.release_turn("agent-1").unwrap();
        assert!(!manager.has_lease("terminal-1").unwrap());
        manager
            .write(
                &sessions,
                "terminal-1",
                "accepted".into(),
                TerminalInputSource::User,
            )
            .unwrap();
        assert_eq!(
            receiver
                .try_iter()
                .filter_map(|command| match command {
                    SessionCommand::Write(data) => Some(data),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            vec!["accepted"]
        );
    }

    #[test]
    fn takeover_restores_user_input_and_fences_late_agent_input_until_turn_end() {
        let manager = disabled_broker_manager();
        let (sessions, receiver) = sessions();
        manager.begin_turn("terminal-1", "agent-1").unwrap();
        acquire(&manager);

        assert!(manager
            .release_after_takeover("terminal-1", "agent-1", "task-1", "operation-1")
            .unwrap());
        manager
            .write(
                &sessions,
                "terminal-1",
                "user-after-takeover".into(),
                TerminalInputSource::User,
            )
            .unwrap();
        assert!(manager
            .write(
                &sessions,
                "terminal-1",
                "late-agent-input".into(),
                TerminalInputSource::Agent {
                    agent_session_id: "agent-1",
                    task_id: "task-1",
                    operation_id: "operation-1",
                },
            )
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_NOT_FOUND:"));
        assert!(manager
            .acquire("terminal-1", "agent-1", "task-1", "operation-2", None)
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_TAKEN_OVER:"));
        assert!(matches!(
            receiver.recv().unwrap(),
            SessionCommand::Write(data) if data == "user-after-takeover"
        ));

        manager.release_turn("agent-1").unwrap();
        manager.begin_turn("terminal-1", "agent-1").unwrap();
        manager
            .acquire("terminal-1", "agent-1", "task-1", "operation-2", None)
            .unwrap();
    }

    #[test]
    fn events_preserve_operation_identity_and_first_release_reason() {
        let manager = disabled_broker_manager();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        manager
            .set_publisher(Arc::new(move |event| {
                captured.lock().unwrap().push(event.clone());
            }))
            .unwrap();
        acquire(&manager);
        manager
            .release_terminal("terminal-1", TerminalLeaseReleaseReason::Shutdown)
            .unwrap();
        manager
            .release_terminal("terminal-1", TerminalLeaseReleaseReason::Cancelled)
            .unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].state, TerminalLeaseEventState::Acquired);
        assert_eq!(events[1].state, TerminalLeaseEventState::Released);
        assert_eq!(events[1].reason, Some(TerminalLeaseReleaseReason::Shutdown));
        assert_eq!(events[1].operation_id, "operation-1");
        assert_eq!(
            serde_json::to_value(&events[1]).unwrap(),
            serde_json::json!({
                "sessionId": "terminal-1",
                "agentSessionId": "agent-1",
                "taskId": "task-1",
                "operationId": "operation-1",
                "acquiredAtUnixMs": events[1].acquired_at_unix_ms,
                "state": "released",
                "reason": "shutdown"
            })
        );
    }

    #[test]
    fn frontend_ready_gate_accepts_only_clean_connected_state() {
        let manager = disabled_broker_manager();
        acquire(&manager);
        assert!(manager
            .acknowledge_frontend_ready(
                "terminal-1",
                "agent-1",
                "operation-1",
                true,
                true,
                false,
                false,
                false,
            )
            .unwrap());
        manager
            .wait_frontend_ready(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                Duration::ZERO,
            )
            .unwrap();
    }

    #[test]
    fn frontend_ready_gate_rejects_pending_input_and_times_out_boundedly() {
        let manager = disabled_broker_manager();
        acquire(&manager);
        manager
            .acknowledge_frontend_ready(
                "terminal-1",
                "agent-1",
                "operation-1",
                true,
                true,
                true,
                false,
                false,
            )
            .unwrap();
        assert!(manager
            .wait_frontend_ready(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                Duration::ZERO,
            )
            .unwrap_err()
            .starts_with("TERMINAL_FRONTEND_PENDING_INPUT:"));
        manager
            .release_terminal("terminal-1", TerminalLeaseReleaseReason::Failed)
            .unwrap();

        acquire(&manager);
        assert!(manager
            .wait_frontend_ready(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                Duration::ZERO,
            )
            .unwrap_err()
            .starts_with("TERMINAL_FRONTEND_READY_TIMEOUT:"));
    }

    #[test]
    fn runtime_restart_has_no_stale_in_memory_lease_or_input_block() {
        let before_restart = disabled_broker_manager();
        acquire(&before_restart);
        assert!(before_restart.lease("terminal-1").is_some());
        drop(before_restart);

        let after_restart = disabled_broker_manager();
        let (sessions, receiver) = sessions();
        assert!(after_restart.lease("terminal-1").is_none());
        after_restart
            .write(
                &sessions,
                "terminal-1",
                "user-after-restart".into(),
                TerminalInputSource::User,
            )
            .unwrap();
        assert!(matches!(
            receiver.recv().unwrap(),
            SessionCommand::Write(data) if data == "user-after-restart"
        ));
    }

    #[test]
    fn terminal_writes_share_the_enabled_broker_admission_path() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 64);
        broker
            .attach_transport(
                "terminal-1",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        let manager = TerminalLeaseManager::new(broker.clone());
        let (sessions, receiver) = sessions();

        manager
            .write(
                &sessions,
                "terminal-1",
                "user".into(),
                TerminalInputSource::User,
            )
            .unwrap();
        manager
            .acquire("terminal-1", "agent-1", "task-1", "operation-1", None)
            .unwrap();
        manager
            .write(
                &sessions,
                "terminal-1",
                "agent".into(),
                TerminalInputSource::Agent {
                    agent_session_id: "agent-1",
                    task_id: "task-1",
                    operation_id: "operation-1",
                },
            )
            .unwrap();
        manager
            .write(
                &sessions,
                "terminal-1",
                "\u{3}".into(),
                TerminalInputSource::System {
                    operation_id: Some("operation-1"),
                },
            )
            .unwrap();

        let writes = receiver
            .try_iter()
            .filter_map(|command| match command {
                SessionCommand::Write(data) => Some(data),
                SessionCommand::WriteBytes(_)
                | SessionCommand::Resize { .. }
                | SessionCommand::Close => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(writes, vec!["user", "agent", "\u{3}"]);
        assert_eq!(
            broker
                .snapshot(Some("terminal-1"))
                .unwrap()
                .session
                .unwrap()
                .next_input_sequence,
            4
        );
        assert!(manager
            .release(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::Completed,
            )
            .unwrap());
    }
