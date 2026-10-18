use super::*;

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
