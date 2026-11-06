use super::*;

use crate::models::{
    ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
    SessionStatus, SessionTerminalKind, StatusEvent,
};
use crate::terminal_broker::{TerminalGeometry, TerminalSessionBroker, TerminalTransportKind};
use std::sync::atomic::AtomicBool;

fn close_transport_fixture() -> (
    tempfile::TempDir,
    AgentRuntime,
    SessionManager,
    TerminalSessionBroker,
    crossbeam_channel::Receiver<SessionCommand>,
) {
    let root = tempfile::tempdir().unwrap();
    let broker = TerminalSessionBroker::phase5_with_journal_for_test(65_536, root.path());
    let mut builder = AgentRuntimeBuilder::new();
    builder.native_engine = Arc::new(NativeToolEngine::with_terminal_broker(broker.clone()));
    let runtime = builder.build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    let sessions = SessionManager::default();
    let (sender, receiver) = crossbeam_channel::unbounded();
    for id in ["terminal-a", "terminal-b"] {
        broker
            .attach_transport(
                id,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        sessions
            .insert(
                id.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender.clone()),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: id.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: id.into(),
                        host: "local".into(),
                        port: 0,
                        username: "close-test".into(),
                    },
                },
            )
            .unwrap();
    }
    for (id, terminal, surface) in [
        ("bound", "terminal-a", "boundTerminal"),
        ("direct", "terminal-a", "direct"),
        ("other", "terminal-b", "boundTerminal"),
    ] {
        runtime
            .create_session(
                serde_json::from_value(json!({
                    "sessionId": id, "taskId": id, "goal": "Explicit close regression",
                    "target": {"kind":"local","targetId":terminal,"sessionId":terminal},
                    "executionSurface": surface,"permissionMode":"requestApproval",
                }))
                .unwrap(),
            )
            .unwrap();
    }
    (root, runtime, sessions, broker, receiver)
}

#[tokio::test]
async fn explicit_close_cleans_associated_tasks_and_is_idempotent() {
    let (_root, runtime, sessions, broker, receiver) = close_transport_fixture();
    runtime
        .close_terminal(&sessions, "terminal-a")
        .await
        .unwrap();
    assert!(matches!(
        receiver.try_recv().unwrap(),
        SessionCommand::Close
    ));
    assert!(
        !broker
            .snapshot(Some("terminal-a"))
            .unwrap()
            .session
            .unwrap()
            .open
    );
    assert!(sessions.target_state("terminal-a").is_err());
    for id in ["bound", "direct"] {
        assert!(runtime.session(id).unwrap().ended);
    }
    assert!(!runtime.session("other").unwrap().ended);
    assert!(
        broker
            .snapshot(Some("terminal-b"))
            .unwrap()
            .session
            .unwrap()
            .open
    );
    assert_eq!(
        sessions.target_state("terminal-b").unwrap().status,
        SessionStatus::Connected
    );
    runtime
        .close_terminal(&sessions, "terminal-a")
        .await
        .unwrap();
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn explicit_close_recovery_fallback_preserves_unsettled_journal_and_other_target() {
    let (root, runtime, sessions, broker, receiver) = close_transport_fixture();
    let terminal = broker
        .snapshot(Some("terminal-a"))
        .unwrap()
        .session
        .unwrap();
    let identity = crate::terminal_command::state::CommandIdentity {
        terminal_session_id: terminal.terminal_session_id,
        terminal_generation: terminal.terminal_generation,
        lease_id: "close-lease".into(),
        lease_generation: 1,
        agent_session_id: "bound".into(),
        task_id: "bound".into(),
        operation_id: "uncertain-close-op".into(),
        command_id: "uncertain-close-command".into(),
        source_revision: 1,
    };
    let journal = crate::terminal_command::journal::SubmissionJournal::unconfigured();
    journal.configure(root.path()).unwrap();
    journal.record(&identity).unwrap();
    let before = runtime
        .terminal_submission_recovery(root.path(), "bound")
        .unwrap();
    assert_eq!(before.len(), 1);
    let closing = runtime.begin_terminal_close("terminal-a").unwrap();
    runtime
        .finish_terminal_close(
            &sessions,
            "terminal-a",
            Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native stop was not confirmed".into()),
        )
        .await
        .unwrap();
    assert!(matches!(
        receiver.try_recv().unwrap(),
        SessionCommand::Close
    ));
    assert!(
        !broker
            .snapshot(Some("terminal-a"))
            .unwrap()
            .session
            .unwrap()
            .open
    );
    assert!(sessions.target_state("terminal-a").is_err());
    assert!(runtime
        .followup("bound", "late-message".into(), "No input".into())
        .is_err());
    for id in ["bound", "direct"] {
        assert!(runtime.session(id).unwrap().ended);
    }
    assert!(!runtime.session("other").unwrap().ended);
    assert!(
        broker
            .snapshot(Some("terminal-b"))
            .unwrap()
            .session
            .unwrap()
            .open
    );
    assert_eq!(
        runtime
            .terminal_submission_recovery(root.path(), "bound")
            .unwrap(),
        before
    );
    drop(closing);
}

#[tokio::test]
async fn close_fallback_requires_guard_and_does_not_swallow_other_stop_errors() {
    let (_root, runtime, sessions, broker, receiver) = close_transport_fixture();
    assert_eq!(
        runtime
            .finish_terminal_close(&sessions, "terminal-a", Ok(()))
            .await
            .unwrap_err(),
        "TERMINAL_CLOSE_NOT_STARTED"
    );
    let _closing = runtime.begin_terminal_close("terminal-a").unwrap();
    assert_eq!(
        runtime
            .finish_terminal_close(
                &sessions,
                "terminal-a",
                Err("TERMINAL_ADMISSION_UNAVAILABLE".into())
            )
            .await
            .unwrap_err(),
        "TERMINAL_ADMISSION_UNAVAILABLE"
    );
    assert!(receiver.try_recv().is_err());
    assert!(
        broker
            .snapshot(Some("terminal-a"))
            .unwrap()
            .session
            .unwrap()
            .open
    );
    assert!(sessions.target_state("terminal-a").is_ok());
    assert!(!runtime.session("bound").unwrap().ended);
}

#[tokio::test]
async fn terminal_close_blocks_admission_and_stops_durable_tasks_on_both_surfaces() {
    let root = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    for (id, terminal, surface) in [
        ("bound", "terminal-a", "boundTerminal"),
        ("direct", "terminal-a", "direct"),
        ("other", "terminal-b", "boundTerminal"),
    ] {
        runtime
            .create_session(
                serde_json::from_value(json!({
                    "sessionId": id, "taskId": id, "goal": "Check close admission",
                    "target": { "kind": "local", "targetId": terminal, "sessionId": terminal },
                    "executionSurface": surface,
                }))
                .unwrap(),
            )
            .unwrap();
    }
    let closing = runtime.begin_terminal_close("terminal-a").unwrap();
    for (previous, replacement) in [("terminal-a", "replacement"), ("previous", "terminal-a")] {
        assert!(runtime
            .reconnect_terminal(
                &crate::models::SessionManager::default(),
                "bound",
                previous,
                replacement
            )
            .unwrap_err()
            .starts_with("TERMINAL_RECONNECT_BUSY"));
    }
    assert!(runtime.begin_terminal_close("terminal-a").is_err());
    for id in ["bound", "direct"] {
        assert_eq!(
            runtime.require_open_terminal_target(id).unwrap_err(),
            "TERMINAL_CLOSE_IN_PROGRESS"
        );
        assert_eq!(
            runtime
                .followup(id, format!("message-{id}"), "Do not enqueue".into())
                .unwrap_err(),
            "TERMINAL_CLOSE_IN_PROGRESS"
        );
        assert!(runtime.session(id).unwrap().inbox.next_turn.is_empty());
    }
    runtime.require_open_terminal_target("other").unwrap();
    runtime.stop_terminal_agents("terminal-a").await.unwrap();
    for id in ["bound", "direct"] {
        let snapshot = runtime.session(id).unwrap();
        assert!(snapshot.ended);
        assert_eq!(snapshot.status, AgentSessionStatus::Cancelled);
        assert_eq!(
            runtime.resume(id).await.unwrap_err(),
            "TERMINAL_CLOSE_IN_PROGRESS"
        );
    }
    assert!(!runtime.session("other").unwrap().ended);
    drop(closing);
    runtime.require_open_terminal_target("bound").unwrap();
    runtime.require_open_terminal_target("direct").unwrap();
    assert!(runtime.begin_terminal_close("terminal-a").is_ok());
}
