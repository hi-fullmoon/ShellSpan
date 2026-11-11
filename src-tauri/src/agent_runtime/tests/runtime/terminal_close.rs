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

#[cfg(unix)]
#[tokio::test]
async fn explicit_close_waits_for_real_pty_tail_before_retiring_transport() {
    assert_terminal_close_captures_pty_tail(false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn explicit_recovery_close_waits_for_real_pty_tail_before_retiring_transport() {
    assert_terminal_close_captures_pty_tail(true).await;
}

#[cfg(unix)]
async fn assert_terminal_close_captures_pty_tail(recovery_required: bool) {
    use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
    use std::io::{Read, Write};
    use std::time::Duration;

    struct ProcessGuard {
        child: Box<dyn Child + Send + Sync>,
        reaped: bool,
    }
    impl Drop for ProcessGuard {
        fn drop(&mut self) {
            if !self.reaped {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }

    let root = tempfile::tempdir().unwrap();
    let broker = TerminalSessionBroker::phase5_with_journal_for_test(65_536, root.path());
    let terminal = "real-close-tail";
    broker
        .attach_transport(
            terminal,
            None,
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(80, 24),
        )
        .unwrap();
    broker.mark_output_ready(terminal).unwrap();
    let mut builder = AgentRuntimeBuilder::new();
    builder.native_engine = Arc::new(NativeToolEngine::with_terminal_broker(broker.clone()));
    let runtime = Arc::new(builder.build());
    runtime.configure(root.path().to_path_buf()).unwrap();
    let sessions = SessionManager::default();

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args([
        "-c",
        "stty -echo; printf 'BEFORE_CLOSE\\n'; IFS= read -r line; printf 'TAIL_AFTER_CLOSE\\n'",
    ]);
    command.cwd(root.path());
    command.env("HOME", root.path());
    let mut process = ProcessGuard {
        child: pair.slave.spawn_command(command).unwrap(),
        reaped: false,
    };
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (output_tx, output_rx) = crossbeam_channel::bounded(32);
    let reader_thread = std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 || output_tx.send(bytes[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut before = Vec::new();
    let mut accepted_frames = Vec::new();
    while !before.ends_with(b"BEFORE_CLOSE\r\n") {
        let bytes = output_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        accepted_frames.push(
            broker
                .observe_raw_output(terminal, &bytes)
                .unwrap()
                .unwrap(),
        );
        before.extend_from_slice(&bytes);
        assert!(before.len() < 8192);
    }
    let (command_tx, command_rx) = crossbeam_channel::unbounded();
    let shutdown = sessions
        .insert_with_shutdown(
            terminal.into(),
            ManagedSession {
                sender: SessionCommandSender::Event(command_tx),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: terminal.into(),
                    status: SessionStatus::Connected,
                    message: None,
                },
                output_ready: Arc::new(AtomicBool::new(true)),
                output_paused: Arc::new(AtomicBool::new(false)),
                terminal_kind: SessionTerminalKind::Local,
                identity: SessionIdentity {
                    title: terminal.into(),
                    host: "local".into(),
                    port: 0,
                    username: String::new(),
                },
            },
        )
        .unwrap();
    let (observed_tx, observed_rx) = crossbeam_channel::bounded(1);
    let (release_tx, release_rx) = crossbeam_channel::bounded(1);
    let worker_broker = broker.clone();
    let worker = std::thread::spawn(move || {
        let mut failures = Vec::new();
        let closed = matches!(
            command_rx.recv_timeout(Duration::from_secs(5)),
            Ok(SessionCommand::Close)
        );
        let _ = observed_tx.send(closed);
        if closed && release_rx.recv_timeout(Duration::from_secs(5)).is_ok() {
            if let Err(error) = writer.write_all(b"\n").and_then(|_| writer.flush()) {
                failures.push(error.to_string());
                let _ = process.child.kill();
            }
        } else {
            failures.push("Close request or real-output release was not received".into());
            let _ = process.child.kill();
        }
        drop(writer);
        let mut tail = Vec::new();
        let mut tail_frames = Vec::new();
        loop {
            match output_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(bytes) => {
                    tail.extend_from_slice(&bytes);
                    match worker_broker.observe_raw_output(terminal, &bytes) {
                        Ok(Some(frame)) => tail_frames.push(frame),
                        Ok(None) => {
                            failures.push("Enabled raw capture did not retain a frame".into())
                        }
                        Err(error) => failures.push(error),
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                Err(error) => {
                    failures.push(error.to_string());
                    let _ = process.child.kill();
                    break;
                }
            }
        }
        let status = process.child.wait().unwrap();
        process.reaped = true;
        drop(process);
        reader_thread.join().unwrap();
        drop(pair.master);
        worker_broker
            .close_transport(
                terminal,
                crate::terminal_broker::TerminalGenerationCloseReason::UserClosed,
            )
            .unwrap();
        // This acknowledgement follows real child exit and reader EOF, never
        // an invented native command or Agent settlement.
        let _ = shutdown.send(());
        (failures, tail, tail_frames, status)
    });
    let close_runtime = Arc::clone(&runtime);
    let close_sessions = sessions.clone();
    let mut closing = tokio::spawn(async move {
        if recovery_required {
            let _closing = close_runtime.begin_terminal_close(terminal)?;
            close_runtime
                .finish_terminal_close(
                    &close_sessions,
                    terminal,
                    Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native stop was not confirmed".into()),
                )
                .await
        } else {
            close_runtime
                .close_terminal(&close_sessions, terminal)
                .await
        }
    });
    assert!(tokio::task::spawn_blocking(move || {
        observed_rx.recv_timeout(Duration::from_secs(5)).unwrap()
    })
    .await
    .unwrap());
    let early = tokio::time::timeout(Duration::from_millis(30), &mut closing)
        .await
        .ok();
    let sequence = broker
        .snapshot(Some(terminal))
        .unwrap()
        .session
        .unwrap()
        .next_input_sequence;
    let rejected = runtime
        .write_user_terminal_input(&sessions, terminal, "MUST_NOT_REACH_PTY\r".into())
        .is_err();
    let after_sequence = broker
        .snapshot(Some(terminal))
        .unwrap()
        .session
        .unwrap()
        .next_input_sequence;
    release_tx.send(()).unwrap();
    let completed_early = early.is_some();
    let closed = match early {
        Some(result) => result,
        None => closing.await,
    };
    let (failures, tail, tail_frames, status) = worker.join().unwrap();
    closed.unwrap().unwrap();
    assert!(
        failures.is_empty(),
        "Actual PTY tail was rejected: {failures:?}"
    );
    assert!(
        !completed_early,
        "Close returned before the real PTY could emit its tail"
    );
    assert!(rejected);
    assert_eq!(after_sequence, sequence);
    assert!(sessions.target_state(terminal).is_err());
    assert!(status.success());
    assert_eq!(tail, b"TAIL_AFTER_CLOSE\r\n");
    before.extend_from_slice(&tail);
    accepted_frames.extend(tail_frames);
    let mut accepted_bytes = Vec::new();
    for (index, frame) in accepted_frames.iter().enumerate() {
        assert_eq!(frame.sequence, index as u64 + 1);
        assert_eq!(frame.byte_offset, accepted_bytes.len() as u64);
        accepted_bytes.extend_from_slice(&frame.bytes);
    }
    assert_eq!(accepted_bytes, before);
    let captured = broker.acceptance_raw_output(terminal).unwrap();
    assert!(!captured.open);
    assert_eq!(captured.captured_frame_count, accepted_frames.len() as u64);
    assert_eq!(captured.captured_byte_count, before.len() as u64);
    assert_eq!(captured.next_byte_offset, before.len() as u64);
    // Closed-generation memory is intentionally erased. The external observer
    // above must already hold the complete actual frames, just as the App's
    // acceptance observer does; do not weaken that byte comparison.
    assert!(captured.captured_bytes.is_empty() && captured.frames.is_empty());
    runtime.close_terminal(&sessions, terminal).await.unwrap();
}
