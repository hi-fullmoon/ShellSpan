use super::*;

fn local_model_provider() -> AiProviderConfig {
    AiProviderConfig {
        model_definition: None,
        retry_policy: None,
        profile: "ollama".into(),
        id: "local-stop-check".into(),
        kind: AiProviderKind::Ollama,
        base_url: "http://127.0.0.1:11434".into(),
        model: "deepseek-r1".into(),
        reasoning_effort: None,
        requires_api_key: false,
        api_key: None,
    }
}

fn queued_terminal_runtime() -> (tempfile::TempDir, AgentRuntime) {
    let root = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    for (id, terminal) in [("stopped", "terminal-a"), ("other", "terminal-b")] {
        runtime
            .create_session(
                serde_json::from_value(json!({
                    "sessionId": id, "taskId": id, "goal": "Check terminal stop cleanup",
                    "target": { "kind": "local", "targetId": terminal, "sessionId": terminal },
                    "executionSurface": "boundTerminal",
                }))
                .unwrap(),
            )
            .unwrap();
    }
    runtime
        .native_engine
        .begin_terminal_turn("terminal-b", "other")
        .unwrap();
    (root, runtime)
}

#[tokio::test]
async fn interrupt_releases_terminal_reservation_without_a_started_turn() {
    let (_root, runtime) = queued_terminal_runtime();
    runtime.set_event_publisher(Arc::new(|_| {})).unwrap();
    for attempt in 0..3 {
        // Exercise the admission/stop boundary before a driver claims the input.
        // No model or command execution is required to own a turn reservation.
        runtime
            .native_engine
            .begin_terminal_turn("terminal-a", "stopped")
            .unwrap();
        let message_id = format!("message-{attempt}");
        runtime
            .followup("stopped", message_id.clone(), "Check the terminal".into())
            .unwrap();
        assert_eq!(
            runtime
                .terminal_turn_owner("terminal-a")
                .unwrap()
                .as_deref(),
            Some("stopped")
        );
        assert!(runtime
            .native_engine
            .has_terminal_lease("terminal-a")
            .unwrap());

        let snapshot = runtime.interrupt("stopped").await.unwrap();
        assert_eq!(snapshot.status, AgentSessionStatus::Idle);
        assert!(!snapshot.ended);
        assert!(snapshot.inbox.paused_ids.contains(&message_id));
        assert_eq!(runtime.terminal_turn_owner("terminal-a").unwrap(), None);
        assert!(!runtime
            .native_engine
            .has_terminal_lease("terminal-a")
            .unwrap());
        assert_eq!(
            runtime
                .terminal_turn_owner("terminal-b")
                .unwrap()
                .as_deref(),
            Some("other")
        );
    }
    assert!(
        !all_events(&runtime, "stopped").iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::TurnStart | AgentSessionEventPayload::TurnEnd { .. }
        ))
    );
    runtime.interrupt("stopped").await.unwrap();
    assert_eq!(runtime.terminal_turn_owner("terminal-a").unwrap(), None);
}

#[tokio::test]
async fn cancel_releases_terminal_reservation_without_an_event_publisher() {
    let (_root, runtime) = queued_terminal_runtime();
    runtime
        .native_engine
        .begin_terminal_turn("terminal-a", "stopped")
        .unwrap();
    runtime
        .followup("stopped", "queued".into(), "Check the terminal".into())
        .unwrap();

    let snapshot = runtime.cancel("stopped").await.unwrap();
    assert!(snapshot.ended);
    assert_eq!(snapshot.status, AgentSessionStatus::Cancelled);
    assert_eq!(runtime.terminal_turn_owner("terminal-a").unwrap(), None);
    assert!(!runtime
        .native_engine
        .has_terminal_lease("terminal-a")
        .unwrap());
    assert_eq!(
        runtime
            .terminal_turn_owner("terminal-b")
            .unwrap()
            .as_deref(),
        Some("other")
    );
    runtime.cancel("stopped").await.unwrap();
}

#[test]
fn stopping_blocks_restart_and_new_input_until_terminal_cleanup_finishes() {
    let (_root, runtime) = queued_terminal_runtime();
    runtime
        .native_engine
        .begin_terminal_turn("terminal-a", "stopped")
        .unwrap();
    runtime
        .followup("stopped", "original".into(), "Check the terminal".into())
        .unwrap();
    let (entered, stopped) = std::sync::mpsc::sync_channel(1);
    let (resume, resumed) = std::sync::mpsc::sync_channel(1);
    let resumed = Mutex::new(resumed);
    runtime
        .set_event_publisher(Arc::new(move |event| {
            if event.session_id == "stopped"
                && matches!(
                    &event.payload,
                    AgentSessionEventPayload::AgentStatus { reason: Some(reason), .. }
                        if reason == "stoppedByUser"
                )
            {
                // Pause at the real published Idle event, before stop returns
                // and releases the terminal. Do not fabricate lifecycle events.
                entered.send(()).unwrap();
                resumed
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            }
        }))
        .unwrap();
    let (restart, input, duplicate, repeated_stop, other, snapshot) = std::thread::scope(|scope| {
        let stopping = scope.spawn(|| tauri::async_runtime::block_on(runtime.interrupt("stopped")));
        stopped
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let restart = runtime.start("stopped", local_model_provider(), None);
        // A failed assertion must not accidentally send a real model request
        // or recursively wait for the paused stop's question gate.
        let (input, repeated_stop) = if restart.is_err() {
            (
                Some(runtime.followup("stopped", "during-stop".into(), "Hello".into())),
                Some(tauri::async_runtime::block_on(runtime.interrupt("stopped"))),
            )
        } else {
            (None, None)
        };
        let duplicate = runtime.followup("stopped", "original".into(), "Check the terminal".into());
        // An unrelated Agent can start while this stop is pending. The real
        // HTTP adapter is prepared, but no model request is sent without input.
        let other = runtime.start("other", local_model_provider(), None);
        resume.send(()).unwrap();
        (
            restart,
            input,
            duplicate,
            repeated_stop,
            other,
            stopping.join().unwrap().unwrap(),
        )
    });
    assert_eq!(restart.unwrap_err(), "Agent Session is already stopping");
    assert_eq!(
        input.unwrap().unwrap_err(),
        "Agent Session is already stopping"
    );
    assert!(
        duplicate.is_ok(),
        "a committed receipt must remain readable"
    );
    assert_eq!(
        repeated_stop.unwrap().unwrap_err(),
        "Agent Session is already stopping"
    );
    assert!(other.is_ok(), "another Session must remain usable");
    assert_eq!(snapshot.inbox.paused_ids, ["original"]);
    assert_eq!(runtime.terminal_turn_owner("terminal-a").unwrap(), None);

    runtime
        .start("stopped", local_model_provider(), None)
        .unwrap();
    assert!(runtime.agents.get("stopped").unwrap().is_some());
    let _admission = runtime.terminal_submission_gate.lock().unwrap();
    let mut reservation = runtime
        .reserve_terminal_submission("stopped", "after-stop", false)
        .unwrap()
        .expect("a replacement Agent can reserve its own terminal after stop");
    reservation.committed = true;
    drop(reservation);
    assert_eq!(
        runtime
            .terminal_turn_owner("terminal-a")
            .unwrap()
            .as_deref(),
        Some("stopped")
    );
    assert_eq!(
        runtime
            .terminal_turn_owner("terminal-b")
            .unwrap()
            .as_deref(),
        Some("other")
    );
}

#[tokio::test]
async fn failed_stop_releases_its_fence_and_preserves_terminal_protection() {
    let (_root, runtime) = queued_terminal_runtime();
    // Attach the production HTTP adapter to a real Agent entry without making
    // a model request. Native tools remain unavailable in this headless runtime.
    runtime
        .start("stopped", local_model_provider(), None)
        .unwrap();
    runtime
        .native_engine
        .begin_terminal_turn("terminal-a", "stopped")
        .unwrap();
    let error = runtime.interrupt("stopped").await.unwrap_err();
    assert!(
        error.contains("native tool adapter is not configured"),
        "{error}"
    );
    assert!(runtime.require_session_not_stopping("stopped").is_ok());
    assert!(runtime.handles.lock().unwrap().contains_key("stopped"));
    assert_eq!(
        runtime
            .terminal_turn_owner("terminal-a")
            .unwrap()
            .as_deref(),
        Some("stopped")
    );
}
