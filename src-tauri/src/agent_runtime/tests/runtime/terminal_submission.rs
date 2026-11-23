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

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
#[ignore = "requires native shell resources and Vim"]
async fn foreground_vim_handoff_allows_save_after_agent_stop_or_queued_turn() {
    use crate::terminal_screen::TerminalScreenBuffer;

    for (shell, queued) in [
        (TerminalShellKind::Bash, false),
        (TerminalShellKind::Bash, true),
        (TerminalShellKind::Zsh, false),
        (TerminalShellKind::Zsh, true),
    ] {
        let scenario = Scenario::with_native_input(shell, true);
        let runtime = &scenario.runtime;
        let session = "vim-handoff";
        let entry = scenario.root(
            session,
            AgentExecutionSurface::BoundTerminal,
            AgentSessionPermissionMode::Operator,
        );
        scenario.start(&entry, "vim-turn", "vim-step");
        runtime
            .native_engine
            .begin_terminal_turn(TERMINAL, session)
            .unwrap();
        let launch = runtime.tools.process_model_calls(
                &entry,
                "vim-turn",
                "vim-step",
                "vim-request",
                vec![file_call(
                    "run_terminal_command",
                    "open-vim",
                    json!({
                        "command": "while [ ! -f start-vim ]; do sleep 0.02; done; vim -Nu NONE -i NONE -n notes.txt",
                        "explanation": "Open Vim for the user to edit notes.txt",
                        "handoffToUser": true,
                        "timeoutMs": 5000,
                    }),
                )],
            );
        tokio::pin!(launch);
        let wait_for_shell_start = async {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let snapshot = scenario
                    .broker
                    .snapshot(Some(TERMINAL))
                    .unwrap()
                    .session
                    .unwrap();
                if snapshot
                    .input_observation
                    .active_command
                    .is_some_and(|command| {
                        command.phase == crate::terminal_command::state::CommandPhase::Running
                    })
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "{shell:?}: shell never started the command"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // Give the handoff waiter a chance to see Started while Vim is still gated.
            tokio::time::sleep(Duration::from_millis(150)).await;
        };
        tokio::select! {
            result = &mut launch => panic!("{shell:?}: tool returned before Vim opened: {result:?}"),
            () = wait_for_shell_start => {}
        }
        std::fs::write(scenario.root.path().join("work/start-vim"), []).unwrap();
        launch.await.unwrap();
        let (status, result) = recorded_result(&scenario, session, "open-vim");
        assert_eq!(
            status,
            AgentToolResultStatus::Completed,
            "{shell:?}: {result}"
        );
        assert_eq!(result["handedOffToUser"], true);
        assert_eq!(result["execution"], "running");
        assert!(result["exitCode"].is_null());
        assert_eq!(
            scenario
                .broker
                .submission_recovery_for_agent(session)
                .unwrap()
                .len(),
            1
        );

        assert_eq!(
            scenario
                .broker
                .screen_snapshot(TERMINAL)
                .unwrap()
                .active_buffer,
            TerminalScreenBuffer::Alternate
        );
        let write = |keys: &str| {
            runtime.write_user_terminal_input(&scenario.transport, TERMINAL, keys.into())
        };
        write("i").unwrap();
        if queued {
            runtime
                .sessions
                .enqueue(
                    session,
                    AgentInboxLane::NextTurn,
                    AgentInboxMessage {
                        message_id: "queued-during-vim".into(),
                        client_submission_id: None,
                        content: "Continue after opening Vim".into(),
                        source: AgentMessageSource::user(),
                        images: vec![],
                        terminal_context: None,
                    },
                )
                .unwrap();
            runtime
                .sessions
                .append(
                    session,
                    Some("vim-turn".into()),
                    Some("vim-step".into()),
                    AgentSessionEventPayload::StepEnd {
                        reason: "completed".into(),
                    },
                )
                .unwrap();
            assert!(runtime
                .sessions
                .end_turn_if_no_step_input(session, "vim-turn", "completed")
                .unwrap());
            assert!(runtime.terminal_turn_owner(TERMINAL).unwrap().is_none());
            scenario.start(&entry, "queued-turn", "queued-step");
            assert_eq!(
                runtime.terminal_turn_owner(TERMINAL).unwrap().as_deref(),
                Some(session)
            );
            assert!(runtime.sessions.all_events(session).unwrap().iter().any(|event| {
                event.turn_id.as_deref() == Some("queued-turn") && matches!(
                    &event.payload, AgentSessionEventPayload::StepInputClaim { turn_messages, .. }
                        if turn_messages.iter().any(|message| message.message_id == "queued-during-vim")
                )
            }));
        } else {
            // Ctrl+C from stopping the Agent would take Vim out of insert mode.
            runtime.interrupt(session).await.unwrap();
        }
        write("Saved from the terminal\x1b:wq\r").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = scenario
                .broker
                .snapshot(Some(TERMINAL))
                .unwrap()
                .session
                .unwrap();
            if snapshot.prompt_ready && snapshot.active_command_id.is_none() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{shell:?}: Vim did not save and return to the shell"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            std::fs::read_to_string(scenario.root.path().join("work/notes.txt")).unwrap(),
            "Saved from the terminal\n"
        );
        assert!(scenario
            .broker
            .submission_recovery_for_agent(session)
            .unwrap()
            .is_empty());
        if queued {
            assert!(
                write("x")
                    .unwrap_err()
                    .starts_with("TERMINAL_INPUT_BLOCKED_BY_AGENT:"),
                "the queued Agent turn must regain its normal shell input guard after Vim exits"
            );
        }
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
#[ignore = "requires the ShellSpan Bash development resources"]
async fn shellspan_bash_visible_command_requires_the_selected_pty_handshake() {
    use crate::terminal_broker::{TerminalIntegrationState, TerminalVisibleCommandRoute};

    let source = r#"printf '%s %s\n' "$BASH_VERSION" "$$" > visible-shell"#;
    for (startup, route) in [
        (None, TerminalVisibleCommandRoute::TerminalExecute),
        (
            Some("exec /bin/sh -i\n"),
            TerminalVisibleCommandRoute::Unavailable,
        ),
    ] {
        let scenario = Scenario::with_shell_startup(TerminalShellKind::Bash, true, startup);
        assert_eq!(
            scenario.broker.visible_command_route(TERMINAL).unwrap(),
            route
        );
        let snapshot = scenario
            .broker
            .snapshot(Some(TERMINAL))
            .unwrap()
            .session
            .unwrap();
        let session = "shellspan-bash-visible";
        let entry = scenario.root(
            session,
            AgentExecutionSurface::BoundTerminal,
            AgentSessionPermissionMode::Operator,
        );
        scenario.start(&entry, "bash-turn", "bash-step");
        let settlement = scenario.runtime.tools.process_model_calls(
            &entry, "bash-turn", "bash-step", "bash-request", vec![file_call(
                "run_terminal_command", "visible-bash", json!({
                    "command": source, "explanation": "Observe the Bash version and PID in the selected PTY",
                }),
            )],
        ).await;
        let (status, result) = recorded_result(&scenario, session, "visible-bash");
        let marker = scenario.root.path().join("work/visible-shell");
        if startup.is_none() {
            settlement.unwrap();
            assert_eq!(status, AgentToolResultStatus::Completed, "{result}");
            assert_eq!(result["channel"], "terminal");
            assert_eq!(result["terminalSessionId"], snapshot.terminal_session_id);
            assert_eq!(result["exitCode"], 0);
            let observed = std::fs::read_to_string(marker).unwrap();
            assert_eq!(
                observed.trim(),
                format!("5.3.20(1)-release {}", scenario.child.process_id().unwrap())
            );
        } else {
            assert_eq!(
                snapshot.integration_state,
                TerminalIntegrationState::Unavailable
            );
            assert_eq!(
                snapshot.integration_reason.as_deref(),
                Some("nativeControlClosed")
            );
            assert_eq!(status, AgentToolResultStatus::Rejected, "{result}");
            assert_eq!(result["execution"], "notStarted");
            assert_eq!(result["executed"], false);
            assert!(!marker.exists());
            assert_eq!(
                scenario
                    .runtime
                    .sessions
                    .snapshot(session)
                    .unwrap()
                    .header
                    .execution_surface,
                AgentExecutionSurface::BoundTerminal
            );
        }
    }
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
        run(vec![file_call("terminal_execute", "rejected-launch", json!({
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
        run(vec![file_call("terminal_execute", "corrected-launch", json!({
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
            file_call("terminal_execute", "expired-launch", json!({
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

#[tokio::test]
async fn bound_terminal_background_command_uses_independent_process_and_inherits_cwd() {
    let scenario = Scenario::with_native_input(TerminalShellKind::Bash, true);
    let session = "bound-independent-bg";
    let subdir = scenario.root.path().join("work/nested-dir");
    std::fs::create_dir_all(&subdir).unwrap();
    let entry = scenario.root(
        session,
        AgentExecutionSurface::BoundTerminal,
        AgentSessionPermissionMode::Operator,
    );
    scenario.start(&entry, "bg-turn", "bg-step");
    let run = |calls| {
        scenario.runtime.tools.process_model_calls(
            &entry,
            "bg-turn",
            "bg-step",
            "bg-request",
            calls,
        )
    };
    let cd_cmd = format!(
        "cd -- {}",
        shlex::try_quote(subdir.to_str().unwrap()).unwrap()
    );
    run(vec![file_call(
        "run_terminal_command",
        "cd-visible",
        json!({ "command": cd_cmd, "explanation": "Change bound terminal directory" }),
    )])
    .await
    .unwrap();
    assert_eq!(
        recorded_result(&scenario, session, "cd-visible").0,
        AgentToolResultStatus::Completed
    );
    run(vec![file_call(
        "run_terminal_command",
        "independent-bg",
        json!({
            "command": "pwd && printf 'independent-ok\\n'",
            "explanation": "Run a background command without touching the visible terminal",
            "background": true,
        }),
    )])
    .await
    .unwrap();
    let (status, started) = recorded_result(&scenario, session, "independent-bg");
    assert_eq!(status, AgentToolResultStatus::Completed, "{started}");
    assert_eq!(started["channel"], "direct");
    let handle = started["processHandle"].as_str().unwrap();
    assert!(
        handle.starts_with("proc-"),
        "expected proc-* handle, got {handle}"
    );
    assert!(!scenario.broker.has_active_shell_jobs(TERMINAL).unwrap());

    run(vec![file_call(
        "wait_process",
        "independent-bg-wait",
        json!({ "processHandle": handle, "timeoutMs": 5_000 }),
    )])
    .await
    .unwrap();
    let (status, waited) = recorded_result(&scenario, session, "independent-bg-wait");
    assert_eq!(status, AgentToolResultStatus::Completed, "{waited}");
    assert_eq!(waited["state"], "exited");
    assert_eq!(waited["exitCode"], 0);
    let stdout = waited["stdout"].as_str().unwrap();
    assert!(
        stdout.contains("nested-dir"),
        "expected inherited cwd in stdout: {stdout:?}"
    );
    assert!(
        stdout.contains("independent-ok"),
        "expected isolated stdout: {stdout:?}"
    );
}
