//! Exercise production tool policy, real PTYs, persisted results and recovery.
use super::*;
use crate::agent_runtime::AgentSessionEventPayload;

fn recorded_result(
    scenario: &Scenario,
    session: &str,
    id: &str,
) -> (AgentToolResultStatus, serde_json::Value) {
    scenario
        .runtime
        .sessions
        .all_events(session)
        .unwrap()
        .into_iter()
        .find_map(|event| match event.payload {
            AgentSessionEventPayload::ToolResult {
                call_id,
                status,
                data,
                ..
            } if call_id == id => Some((status, data.unwrap_or(serde_json::Value::Null))),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing result for {id}"))
}

#[tokio::test]
async fn rejected_background_launch_does_not_restrict_later_execution_or_reopen_as_unknown() {
    for shell in [TerminalShellKind::Bash, TerminalShellKind::Zsh] {
        let scenario = Scenario::with_native_input(shell, true);
        let session = "launch-rejection";
        let entry = scenario.root(
            session,
            AgentExecutionSurface::BoundTerminal,
            AgentSessionPermissionMode::Operator,
        );
        scenario.start(&entry, "submission-turn", "submission-step");
        let run = |calls| {
            scenario.runtime.tools.process_model_calls(
                &entry,
                "submission-turn",
                "submission-step",
                "submission-request",
                calls,
            )
        };
        let marker = scenario.root.path().join("work/must-not-run");
        let source = format!(
            "printf rejected > {} &",
            shlex::try_quote(marker.to_str().unwrap()).unwrap()
        );
        run(vec![file_call("run_terminal_command", "rejected-launch", json!({
            "command": source, "explanation": "Exercise rejection of nested background execution", "background": true,
        }))]).await.unwrap();
        let (status, rejected) = recorded_result(&scenario, session, "rejected-launch");
        assert_eq!(status, AgentToolResultStatus::Failed, "{rejected}");
        assert_eq!(rejected["execution"], "notStarted");
        assert_eq!(rejected["errorDetails"]["nextAction"], "correctRequest");
        assert_eq!(rejected["errorDetails"]["terminalRecoveryRequired"], false);
        assert_eq!(rejected["job"]["state"], "rejected");
        assert_eq!(rejected["job"]["nativeActive"], false);
        assert_eq!(rejected["job"]["launchConfirmed"], false);
        assert!(rejected["job"]["acceptedCommandLine"].is_null());
        assert!(rejected["job"]["exitCode"].is_null());
        assert!(!marker.exists());
        assert!(!scenario.broker.has_active_shell_jobs(TERMINAL).unwrap());
        assert!(scenario
            .broker
            .shell_jobs_for_cleanup(Some(session))
            .unwrap()
            .is_empty());
        assert!(!scenario
            .runtime
            .sessions
            .execution_observation_only(session)
            .unwrap());
        run(vec![file_call(
            "wait_process",
            "rejected-wait",
            json!({
                "processHandle": rejected["processHandle"], "timeoutMs": 5000,
            }),
        )])
        .await
        .unwrap();
        assert_eq!(
            recorded_result(&scenario, session, "rejected-wait").0,
            AgentToolResultStatus::Failed
        );

        let completed_marker = scenario.root.path().join("work/completed");
        let corrected = format!(
            "printf started > {}; sleep 0.2",
            shlex::try_quote(completed_marker.to_str().unwrap()).unwrap()
        );
        run(vec![file_call("run_terminal_command", "corrected-launch", json!({
            "command": corrected, "explanation": "Launch the corrected foreground source as a managed job", "background": true,
        }))]).await.unwrap();
        let (status, started) = recorded_result(&scenario, session, "corrected-launch");
        assert_eq!(status, AgentToolResultStatus::Completed, "{started}");
        scenario.wait_prompt();
        run(vec![file_call(
            "wait_process",
            "corrected-wait",
            json!({
                "processHandle": started["processHandle"], "timeoutMs": 5000,
            }),
        )])
        .await
        .unwrap();
        let (status, finished) = recorded_result(&scenario, session, "corrected-wait");
        assert_eq!(status, AgentToolResultStatus::Completed, "{finished}");
        assert_eq!(finished["state"], "exited");
        assert_eq!(finished["exitCode"], 0);
        assert_eq!(
            std::fs::read_to_string(&completed_marker).unwrap(),
            "started"
        );
        assert!(!marker.exists());
        let reopened = AgentSessionStore::default();
        reopened
            .configure(scenario.root.path().join("state"))
            .unwrap();
        assert!(!reopened.execution_observation_only(session).unwrap());
        assert!(!reopened.snapshot(session).unwrap().uncertain_native_effects);
    }
}

#[tokio::test]
async fn background_launch_deadline_before_accept_line_reports_not_started() {
    for shell in [TerminalShellKind::Bash, TerminalShellKind::Zsh] {
        let scenario = Scenario::new(shell);
        let session = "launch-deadline";
        let entry = scenario.root(
            session,
            AgentExecutionSurface::BoundTerminal,
            AgentSessionPermissionMode::Operator,
        );
        scenario.start(&entry, "deadline-turn", "deadline-step");
        let marker = scenario.root.path().join("work/must-not-run");
        let source = format!(
            "printf deadline > {}",
            shlex::try_quote(marker.to_str().unwrap()).unwrap()
        );
        let outcome = scenario.runtime.tools.process_model_calls(&entry, "deadline-turn", "deadline-step", "deadline-request", vec![
            file_call("run_terminal_command", "expired-launch", json!({
                "command": source, "explanation": "Apply a real launch deadline before native accept-line", "background": true, "timeoutMs": 1,
            }))
        ]).await;
        let (status, result) = recorded_result(&scenario, session, "expired-launch");
        if let Err(error) = outcome {
            assert!(
                crate::agent_runtime::terminal_execution_needs_user_action(&error),
                "{error}"
            );
            assert_eq!(result["errorDetails"]["terminalRecoveryRequired"], true);
        }
        assert_eq!(status, AgentToolResultStatus::Failed, "{result}");
        assert_eq!(result["execution"], "notStarted");
        assert_eq!(result["job"]["state"], "rejected");
        assert!(!marker.exists());
        assert!(scenario
            .broker
            .shell_jobs_for_cleanup(Some(session))
            .unwrap()
            .is_empty());
        assert!(!scenario
            .runtime
            .sessions
            .execution_observation_only(session)
            .unwrap());
    }
}

#[tokio::test]
async fn losing_completion_after_real_execution_remains_unknown_and_blocks_writes() {
    for shell in [TerminalShellKind::Bash, TerminalShellKind::Zsh] {
        let scenario = Scenario::with_native_input(shell, true);
        let session = "executed-without-completion";
        let entry = scenario.root(
            session,
            AgentExecutionSurface::BoundTerminal,
            AgentSessionPermissionMode::Operator,
        );
        scenario.start(&entry, "lost-turn", "lost-step");
        let marker = scenario.root.path().join("work/executed-once");
        // Replacing the real shell closes its private lifecycle channel before
        // an end record can be emitted; the marker proves execution took place.
        let source = format!(
            "printf x >> {}; exec /bin/sleep 0.05",
            shlex::try_quote(marker.to_str().unwrap()).unwrap()
        );
        scenario.runtime.tools.process_model_calls(&entry, "lost-turn", "lost-step", "lost-request", vec![
            file_call("run_terminal_command", "lost-completion", json!({
                "command": source, "explanation": "Replace the actual shell before its completion receipt", "timeoutMs": 2000,
            }))
        ]).await.unwrap();
        let (status, result) = recorded_result(&scenario, session, "lost-completion");
        assert_eq!(status, AgentToolResultStatus::Uncertain, "{result}");
        assert_eq!(result["execution"], "unknown");
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "x");
        assert!(scenario
            .runtime
            .sessions
            .execution_observation_only(session)
            .unwrap());
        scenario.runtime.tools.process_model_calls(&entry, "lost-turn", "lost-step", "blocked-request", vec![
            file_call("write_file", "blocked-write", json!({
                "path": "must-not-write", "content": include_str!("../../../../../src/lib/README.md"), "precondition": { "mustNotExist": true },
            }))
        ]).await.unwrap();
        assert_eq!(
            recorded_result(&scenario, session, "blocked-write").0,
            AgentToolResultStatus::Rejected
        );
        assert!(!scenario.root.path().join("work/must-not-write").exists());
        let reopened = AgentSessionStore::default();
        reopened
            .configure(scenario.root.path().join("state"))
            .unwrap();
        assert!(reopened.execution_observation_only(session).unwrap());
    }
}

#[tokio::test]
async fn missing_search_mode_returns_canonical_schema_and_allows_corrected_call() {
    let scenario = Scenario::new(TerminalShellKind::Zsh);
    let session = "search-validation";
    let entry = scenario.root(
        session,
        AgentExecutionSurface::BoundTerminal,
        AgentSessionPermissionMode::Operator,
    );
    scenario.start(&entry, "search-turn", "search-step");
    let source = include_str!("../../../../../src/lib/README.md");
    std::fs::write(scenario.root.path().join("work/README.md"), source).unwrap();
    let run = |calls| {
        scenario.runtime.tools.process_model_calls(
            &entry,
            "search-turn",
            "search-step",
            "search-request",
            calls,
        )
    };
    run(vec![file_call(
        "search_text",
        "missing-mode",
        json!({ "path": "README.md", "query": "src/lib" }),
    )])
    .await
    .unwrap();
    let (status, rejected) = recorded_result(&scenario, session, "missing-mode");
    assert_eq!(status, AgentToolResultStatus::Rejected);
    assert_eq!(rejected["execution"], "notStarted");
    assert_eq!(rejected["executed"], false);
    assert_eq!(
        rejected["inputSchema"]["properties"]["mode"]["enum"],
        json!(["content", "fileName", "both"])
    );
    run(vec![file_call(
        "search_text",
        "corrected-mode",
        json!({ "path": "README.md", "query": "src/lib", "mode": "content" }),
    )])
    .await
    .unwrap();
    let (status, searched) = recorded_result(&scenario, session, "corrected-mode");
    assert_eq!(status, AgentToolResultStatus::Completed, "{searched}");
    assert!(!searched["matches"].as_array().unwrap().is_empty());
    assert!(!scenario
        .runtime
        .sessions
        .execution_observation_only(session)
        .unwrap());
}
