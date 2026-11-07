//! Real native file tools, SQLite, process execution and PTY integration.
use super::*;
use crate::agent_runtime::{AgentSessionEventPayload, AgentSessionTarget};

fn result(scenario: &Scenario, session: &str, id: &str) -> serde_json::Value {
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
                summary,
                ..
            } if call_id == id => {
                assert_eq!(status, AgentToolResultStatus::Completed, "{summary}");
                data
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing successful result for {id}"))
}

#[tokio::test]
async fn scratch_scripts_execute_outside_project_with_original_cwd_on_both_surfaces() {
    for surface in [
        AgentExecutionSurface::Direct,
        AgentExecutionSurface::BoundTerminal,
    ] {
        let scenario = Scenario::with_native_input(
            TerminalShellKind::Bash,
            surface == AgentExecutionSurface::BoundTerminal,
        );
        let session = if surface == AgentExecutionSurface::Direct {
            "scratch-direct"
        } else {
            "scratch-bound"
        };
        let entry = scenario.root(session, surface, AgentSessionPermissionMode::Operator);
        scenario.start(&entry, "scratch-turn", "scratch-step");
        let run = |calls| {
            scenario.runtime.tools.process_model_calls(
                &entry,
                "scratch-turn",
                "scratch-step",
                "scratch-request",
                calls,
            )
        };
        run(vec![file_call("write_file", "save-script", json!({
            "path":"cwd.sh", "content":"pwd\n", "precondition":{"mustNotExist":true}, "fileScope":"scratch"
        }))]).await.unwrap();
        let saved = result(&scenario, session, "save-script");
        let root = saved["scratchRoot"].as_str().unwrap();
        let header = scenario.runtime.sessions.snapshot(session).unwrap().header;
        let key =
            crate::agent_runtime::scratch::key(session, header.target.as_ref().unwrap()).unwrap();
        assert_eq!(
            std::path::Path::new(root),
            scenario
                .root
                .path()
                .canonicalize()
                .unwrap()
                .join("state/tmp")
                .join(&key[..16])
        );
        assert_eq!(saved["fileScope"], "scratch");
        assert!(saved["verified"].as_bool().unwrap());
        let path = std::path::Path::new(root).join("cwd.sh");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "pwd\n");
        let project = scenario.root.path().join("work");
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 0);
        assert!(!path.starts_with(&project));

        run(vec![file_call(
            "edit_file",
            "edit-script",
            json!({
                "path":"cwd.sh", "oldString":"pwd", "newString":"pwd -P",
                "precondition":{"sha256":saved["afterSha256"]}, "fileScope":"scratch"
            }),
        )])
        .await
        .unwrap();
        result(&scenario, session, "edit-script");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "pwd -P\n");
        run(vec![file_call(
            "run_terminal_command",
            "run-script",
            json!({
                "command":format!("/bin/sh {}", shlex::try_quote(path.to_str().unwrap()).unwrap()),
                "explanation":"Run the saved working-directory check", "timeoutMs":10000
            }),
        )])
        .await
        .unwrap();
        if surface == AgentExecutionSurface::BoundTerminal {
            scenario.wait_prompt();
        }
        let execution = result(&scenario, session, "run-script");
        let output = execution[if surface == AgentExecutionSurface::Direct {
            "stdout"
        } else {
            "combinedOutput"
        }]
        .as_str()
        .unwrap();
        assert!(
            output.contains(project.canonicalize().unwrap().to_str().unwrap()),
            "{execution}"
        );
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 0);

        run(vec![file_call(
            "read_file",
            "read-script",
            json!({"path":"cwd.sh", "encoding":"utf8", "fileScope":"scratch"}),
        )])
        .await
        .unwrap();
        assert_eq!(
            result(&scenario, session, "read-script")["content"],
            "pwd -P\n"
        );
        run(vec![file_call("write_file", "escape", json!({
            "path":"../../outside.sh", "content":"pwd\n", "fileScope":"scratch", "precondition":{"mustNotExist":true}
        }))]).await.unwrap();
        let events = scenario.runtime.sessions.all_events(session).unwrap();
        assert!(events.iter().any(|event| matches!(&event.payload,
            AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Rejected | AgentToolResultStatus::Failed, .. } if call_id == "escape")));
        assert!(events.iter().any(|event| matches!(&event.payload,
            AgentSessionEventPayload::ToolCall { call, .. } if call.call_id == "save-script" && call.arguments["fileScope"] == "scratch")));
    }
}

#[tokio::test]
async fn scratch_write_approval_keeps_scope_and_does_not_save_script_before_decision() {
    let scenario = Scenario::new(TerminalShellKind::Zsh);
    let entry = scenario.root(
        "scratch-approval",
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::RequestApproval,
    );
    scenario.start(&entry, "approval-turn", "approval-step");
    let settled = scenario.runtime.tools.process_model_calls(&entry, "approval-turn", "approval-step", "approval-request", vec![
        file_call("write_file", "approved-script", json!({"path":"check.sh", "content":"pwd\n", "fileScope":"scratch", "precondition":{"mustNotExist":true}}))
    ]).await.unwrap();
    assert_eq!(settled, ToolPipelineSettlement::Waiting);
    let header = scenario
        .runtime
        .sessions
        .snapshot(&entry.session_id)
        .unwrap()
        .header;
    let key =
        crate::agent_runtime::scratch::key(&entry.session_id, header.target.as_ref().unwrap())
            .unwrap();
    let script = scenario
        .root
        .path()
        .join("state/tmp")
        .join(&key[..16])
        .join("check.sh");
    assert!(!script.exists());
    let events = scenario
        .runtime
        .sessions
        .all_events(&entry.session_id)
        .unwrap();
    assert!(events.iter().any(|e| matches!(&e.payload,
        AgentSessionEventPayload::ToolCall { call, .. } if call.call_id == "approved-script" && call.arguments["fileScope"] == "scratch")));
    scenario
        .runtime
        .tools
        .decide(
            &entry,
            scenario.approval(&entry.session_id),
            AgentToolDecision::Approve,
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(script).unwrap(), "pwd\n");
    assert_eq!(
        result(&scenario, &entry.session_id, "approved-script")["temporary"],
        true
    );
    assert_eq!(
        std::fs::read_dir(scenario.root.path().join("work"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn scratch_background_process_pins_files_until_confirmed_termination() {
    let scenario = Scenario::new(TerminalShellKind::Zsh);
    let session = "scratch-background";
    let entry = scenario.root(
        session,
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::Operator,
    );
    scenario.start(&entry, "background-turn", "background-step");
    let run = |calls| {
        scenario.runtime.tools.process_model_calls(
            &entry,
            "background-turn",
            "background-step",
            "background-request",
            calls,
        )
    };
    run(vec![file_call("write_file", "background-script", json!({"path":"wait.sh", "content":"sleep 30\n", "fileScope":"scratch", "precondition":{"mustNotExist":true}}))]).await.unwrap();
    let saved = result(&scenario, session, "background-script");
    let root = std::path::PathBuf::from(saved["scratchRoot"].as_str().unwrap());
    run(vec![file_call("run_terminal_command", "background-start", json!({
        "command":format!("/bin/sh {}", shlex::try_quote(root.join("wait.sh").to_str().unwrap()).unwrap()),
        "explanation":"Run the bounded background wait script", "background":true, "timeoutMs":60000
    }))]).await.unwrap();
    let started = result(&scenario, session, "background-start");
    assert_eq!(started["state"], "running");
    let handle = started["processHandle"].as_str().unwrap();
    let data_root = scenario.root.path().join("state");
    let database = crate::db::Database::open(&data_root.join("profiles.db")).unwrap();
    let credentials = crate::keychain::CredentialManager::new();
    let known_hosts = data_root.join("known_hosts");
    let services = crate::agent_runtime::scratch::ScratchServices {
        database: &database,
        credentials: &credentials,
        known_hosts: &known_hosts,
        engine: Some(&scenario.runtime.native_engine),
    };
    let future = crate::agent_runtime::native::current_unix_ms() + 30 * 24 * 60 * 60 * 1000;
    let reopened = crate::agent_runtime::scratch::ScratchStore::open(&data_root).unwrap();
    reopened.cleanup_at(future, &services).unwrap();
    assert!(root.join("wait.sh").exists());
    drop(reopened);
    run(vec![file_call(
        "wait_process",
        "background-observe",
        json!({"processHandle":handle, "timeoutMs":1}),
    )])
    .await
    .unwrap();
    assert_eq!(
        result(&scenario, session, "background-observe")["state"],
        "running"
    );
    run(vec![file_call(
        "kill_process",
        "background-stop",
        json!({"processHandle":handle, "signal":"terminate", "timeoutMs":10000}),
    )])
    .await
    .unwrap();
    assert_eq!(
        result(&scenario, session, "background-stop")["terminationConfirmed"],
        true
    );
    let reopened = crate::agent_runtime::scratch::ScratchStore::open(&data_root).unwrap();
    reopened.cleanup_at(future, &services).unwrap();
    assert!(!root.exists());
}

#[tokio::test]
async fn scratch_reconnected_process_uses_original_files_and_current_termination_identity() {
    let scenario = Scenario::new(TerminalShellKind::Zsh);
    let session = "scratch-reconnected-background";
    let previous = uuid::Uuid::new_v4().to_string();
    // A persisted destination starts unavailable. Reconnect below admits the
    // fixture's actual live PTY through the normal runtime, not a ready stub.
    let owner: AgentSessionTarget = serde_json::from_value(json!({
        "kind":"local", "sessionId":previous, "targetId":format!("terminal-{previous}"),
        "cwd":scenario.root.path().join("work"),
    }))
    .unwrap();
    let entry = scenario.root_for_target(
        session,
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::Operator,
        owner.clone(),
    );
    let restored = scenario
        .runtime
        .reconnect_terminal(&scenario.transport, session, &owner.session_id, TERMINAL)
        .unwrap();
    let current = restored.header.target.clone().unwrap();
    assert_eq!(current.session_id, TERMINAL);
    assert_eq!(
        restored.header.permission_mode,
        Some(AgentSessionPermissionMode::RequestApproval)
    );
    scenario.start(&entry, "reconnected-turn", "reconnected-step");
    let run = |calls| {
        let scenario = &scenario;
        let entry = &entry;
        async move {
            let settled = scenario
                .runtime
                .tools
                .process_model_calls(
                    entry,
                    "reconnected-turn",
                    "reconnected-step",
                    "reconnected-request",
                    calls,
                )
                .await?;
            if settled == ToolPipelineSettlement::Waiting {
                scenario
                    .runtime
                    .tools
                    .decide(
                        entry,
                        scenario.approval(session),
                        AgentToolDecision::Approve,
                    )
                    .await?;
            }
            Ok::<(), String>(())
        }
    };
    run(vec![file_call("write_file", "reconnected-script", json!({
        "path":"wait.sh", "content":"while [ ! -f \"$0.release\" ]; do sleep 0.01; done\n", "fileScope":"scratch", "precondition":{"mustNotExist":true}
    }))]).await.unwrap();
    let saved = result(&scenario, session, "reconnected-script");
    let root = std::path::PathBuf::from(saved["scratchRoot"].as_str().unwrap());
    let data_root = scenario.root.path().join("state").canonicalize().unwrap();
    let key = crate::agent_runtime::scratch::key(session, &owner).unwrap();
    assert_eq!(root, data_root.join("tmp").join(&key[..16]));
    run(vec![file_call("run_terminal_command", "reconnected-start", json!({
        "command":format!("/bin/sh {}", shlex::try_quote(root.join("wait.sh").to_str().unwrap()).unwrap()),
        "explanation":"Run the owned gate until its actual release file appears", "background":true, "timeoutMs":60000
    }))]).await.unwrap();
    let started = result(&scenario, session, "reconnected-start");
    assert_eq!(started["state"], "running");
    let handle = started["processHandle"].as_str().unwrap();
    let record: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            data_root
                .join("agent-runtime/scratch/records")
                .join(format!("{key}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(record["version"], 2);
    assert_eq!(record["target"], serde_json::to_value(&owner).unwrap());
    assert!(record["uses"]
        .as_object()
        .unwrap()
        .values()
        .any(|usage| usage["handle"] == handle
            && usage["executionTarget"] == serde_json::to_value(&current).unwrap()));
    let database = crate::db::Database::open(&data_root.join("profiles.db")).unwrap();
    let credentials = crate::keychain::CredentialManager::new();
    let known_hosts = data_root.join("known_hosts");
    let services = crate::agent_runtime::scratch::ScratchServices {
        database: &database,
        credentials: &credentials,
        known_hosts: &known_hosts,
        engine: Some(&scenario.runtime.native_engine),
    };
    let future = crate::agent_runtime::native::current_unix_ms() + 30 * 24 * 60 * 60 * 1000;
    let reopened = crate::agent_runtime::scratch::ScratchStore::open(&data_root).unwrap();
    reopened.cleanup_at(future, &services).unwrap();
    assert!(root.join("wait.sh").exists());
    std::fs::write(root.join("wait.sh.release"), b"release").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while scenario
        .runtime
        .native_engine
        .scratch_process_outcome(handle, session, session, &current)
        .is_none()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "The real background process did not exit after its release file"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(scenario
        .runtime
        .native_engine
        .scratch_process_outcome(handle, session, session, &owner)
        .is_none());
    reopened.cleanup_at(future, &services).unwrap();
    assert!(!root.exists());
}

#[tokio::test]
async fn scratch_is_available_without_a_project_root_and_workspace_access_stays_unavailable() {
    let scenario = Scenario::new(TerminalShellKind::Zsh);
    let session = "scratch-rootless";
    let entry = scenario.root_with_cwd(
        session,
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::Operator,
        None,
    );
    scenario.start(&entry, "rootless-turn", "rootless-step");
    let run = |calls| {
        scenario.runtime.tools.process_model_calls(
            &entry,
            "rootless-turn",
            "rootless-step",
            "rootless-request",
            calls,
        )
    };
    run(vec![file_call("write_file", "rootless-save", json!({"path":"check.sh", "content":"pwd\n", "fileScope":"scratch", "precondition":{"mustNotExist":true}}))]).await.unwrap();
    let saved = result(&scenario, session, "rootless-save");
    let root = std::path::Path::new(saved["scratchRoot"].as_str().unwrap());
    assert_eq!(
        std::fs::read_to_string(root.join("check.sh")).unwrap(),
        "pwd\n"
    );
    run(vec![file_call(
        "write_file",
        "rootless-project",
        json!({"path":"check.sh", "content":"pwd\n", "precondition":{"mustNotExist":true}}),
    )])
    .await
    .unwrap();
    assert!(scenario.runtime.sessions.all_events(session).unwrap().iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Rejected, .. } if call_id == "rootless-project")));
    assert_eq!(
        std::fs::read_dir(scenario.root.path().join("work"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn scratch_files_cannot_be_read_as_another_sessions_workspace() {
    let scenario = Scenario::new(TerminalShellKind::Zsh);
    let owner = scenario.root(
        "scratch-owner",
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::Operator,
    );
    scenario.start(&owner, "owner-turn", "owner-step");
    scenario
        .runtime
        .tools
        .process_model_calls(
            &owner,
            "owner-turn",
            "owner-step",
            "owner-request",
            vec![file_call(
                "write_file",
                "owner-save",
                json!({
                    "path":"check.sh", "content":"pwd\n", "fileScope":"scratch",
                    "precondition":{"mustNotExist":true}
                }),
            )],
        )
        .await
        .unwrap();
    let saved = result(&scenario, &owner.session_id, "owner-save");
    let root = std::path::PathBuf::from(saved["scratchRoot"].as_str().unwrap());
    let reader = scenario.root_with_cwd(
        "scratch-reader",
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::Operator,
        Some(root.clone()),
    );
    scenario.start(&reader, "reader-turn", "reader-step");
    scenario
        .runtime
        .tools
        .process_model_calls(
            &reader,
            "reader-turn",
            "reader-step",
            "reader-request",
            vec![file_call(
                "read_file",
                "reader-read",
                json!({"path":"check.sh", "encoding":"utf8"}),
            )],
        )
        .await
        .unwrap();
    let events = scenario
        .runtime
        .sessions
        .all_events(&reader.session_id)
        .unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Rejected, summary, .. }
            if call_id == "reader-read" && summary.contains("AGENT_SCRATCH_SCOPE_DENIED"))),
        "cross-session scratch read was not denied: {events:?}");
    assert_eq!(
        std::fs::read_to_string(root.join("check.sh")).unwrap(),
        "pwd\n"
    );
}
