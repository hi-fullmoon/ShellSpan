#[cfg(unix)]
fn stopped_execution_with_local_command(
    applies: bool,
    ended: bool,
) -> (tempfile::TempDir, AgentSessionStore, PathBuf) {
    let (root, store) = configured();
    let target = AgentSessionTarget {
        kind: "local".into(),
        target_id: "original-target".into(),
        session_id: "original-terminal".into(),
        cwd: Some(root.path().to_string_lossy().into()),
        local_root: Some(root.path().to_string_lossy().into()),
        ..target()
    };
    store
        .create(CreateAgentSessionRequest {
            session_id: "session-1".into(),
            task_id: "task-1".into(),
            goal: "Record a local marker once".into(),
            target: Some(target),
            parent_session_id: None,
            continued_from_session_id: None,
            permission_mode: Some(AgentSessionPermissionMode::Operator),
            execution_surface: AgentExecutionSurface::BoundTerminal,
            success_criteria: vec![],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    begin_prepared_request(&store);
    let command = if applies {
        "printf x >> \"$SHELLSPAN_RECONCILIATION_MARKER\""
    } else {
        "test -e \"$SHELLSPAN_RECONCILIATION_MARKER\""
    };
    for payload in [
        AgentSessionEventPayload::ToolCall { call: serde_json::from_value(serde_json::json!({
            "callId":"marker-call", "name":"run_terminal_command", "nativeName":"terminal_execute",
            "arguments":{"command":command}, "effect":"stateChange",
        })).unwrap() },
        AgentSessionEventPayload::ToolApproval {
            request_id: "marker-approval".into(), call_id: "marker-call".into(), approval_id: None,
            status: super::super::AgentToolApprovalStatus::Approved, risk: None, reason: None,
            expires_at_unix_ms: None, prompt: None,
        },
        AgentSessionEventPayload::ToolExecution { call_id: "marker-call".into(),
            status: super::super::AgentToolExecutionStatus::Dispatched, idempotency: "no".into() },
    ] {
        store.append("session-1", Some("turn-1".into()), Some("step-1".into()), payload).unwrap();
    }
    let marker = root.path().join("execution-marker");
    assert_eq!(
        std::process::Command::new("sh")
            .args(["-c", command])
            .env("SHELLSPAN_RECONCILIATION_MARKER", &marker)
            .status()
            .unwrap()
            .success(),
        applies
    );
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::ToolResult {
                call_id: "marker-call".into(),
                name: "run_terminal_command".into(),
                status: super::super::AgentToolResultStatus::Uncertain,
                summary: "Completion acknowledgement was not recorded".into(),
                data: None,
                duration_ms: None,
                evidence_refs: vec![],
            },
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::StepEnd {
                reason: "terminal recovery".into(),
            },
        )
        .unwrap();
    // The real incident advanced to another step before stopping.
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-2".into()),
            AgentSessionEventPayload::StepStart,
        )
        .unwrap();
    if ended {
        store.cancel("session-1").unwrap();
    } else {
        store.interrupt("session-1").unwrap();
    }
    (root, store, marker)
}

#[cfg(unix)]
fn begin_observation_turn(store: &AgentSessionStore) {
    store.resume("session-1").unwrap();
    store
        .append(
            "session-1",
            Some("observation-turn".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("observation-turn".into()),
            Some("observation-step".into()),
            AgentSessionEventPayload::StepStart,
        )
        .unwrap();
}

#[cfg(unix)]
fn admit_observation_tool(
    store: &AgentSessionStore,
    id: &str,
    name: &str,
    effect: super::super::AgentSessionEffect,
    arguments: serde_json::Value,
) -> Result<Vec<AgentSessionEvent>, String> {
    let payloads = vec![
        AgentSessionEventPayload::ToolCall {
            call: serde_json::from_value(serde_json::json!({
                "callId":id, "name":name, "nativeName":name, "arguments":arguments, "effect":effect,
            }))
            .unwrap(),
        },
        AgentSessionEventPayload::ToolApproval {
            request_id: format!("approval-{id}"),
            call_id: id.into(),
            approval_id: None,
            status: super::super::AgentToolApprovalStatus::Approved,
            risk: Some(effect),
            reason: None,
            expires_at_unix_ms: None,
            prompt: None,
        },
        AgentSessionEventPayload::ToolExecution {
            call_id: id.into(),
            status: super::super::AgentToolExecutionStatus::Dispatched,
            idempotency: "no".into(),
        },
    ];
    store.append_batch(
        "session-1",
        payloads
            .into_iter()
            .map(|payload| AgentScopedPayload {
                turn_id: Some("observation-turn".into()),
                step_id: Some("observation-step".into()),
                payload,
            })
            .collect(),
    )
}

#[test]
#[cfg(unix)]
fn unknown_execution_restores_the_same_conversation_without_confirmation_or_replay() {
    for ended in [true, false] {
        let (root, store, marker) = stopped_execution_with_local_command(true, ended);
        let before = store.snapshot("session-1").unwrap();
        assert!(before.uncertain_native_effects);
        let replacement = AgentSessionTarget {
            session_id: "replacement-terminal".into(),
            target_id: "replacement-target".into(),
            ..before.header.target.clone().unwrap()
        };
        let rebound = store
            .reconnect_terminal("session-1", "original-terminal", replacement)
            .unwrap();
        assert_eq!(rebound.header.session_id, before.header.session_id);
        assert_eq!(rebound.header.task_id, before.header.task_id);
        assert!(rebound.uncertain_native_effects);
        assert_eq!(
            rebound.header.permission_mode,
            Some(AgentSessionPermissionMode::RequestApproval)
        );
        let resumed = store.resume("session-1").unwrap();
        assert!(!resumed.ended);
        assert_eq!(resumed.status, AgentSessionStatus::Idle);
        assert!(store.execution_observation_only("session-1").unwrap());
        assert!(
            super::super::recovery::open_turn_id(&store.all_events("session-1").unwrap()).is_none()
        );
        drop(store);
        let reopened = AgentSessionStore::default();
        reopened.configure(root.path().to_path_buf()).unwrap();
        assert_eq!(reopened.snapshot("session-1").unwrap(), resumed);
        begin_observation_turn(&reopened);
        admit_observation_tool(
            &reopened,
            "observe",
            "read_file",
            super::super::AgentSessionEffect::ReadOnly,
            serde_json::json!({"path":marker}),
        )
        .unwrap();
        let contents = std::fs::read_to_string(&marker).unwrap();
        assert_eq!(contents, "x");
        reopened
            .append(
                "session-1",
                Some("observation-turn".into()),
                Some("observation-step".into()),
                AgentSessionEventPayload::ToolResult {
                    call_id: "observe".into(),
                    name: "read_file".into(),
                    status: super::super::AgentToolResultStatus::Completed,
                    summary: "Read the local marker".into(),
                    data: Some(serde_json::json!({"content":contents})),
                    duration_ms: None,
                    evidence_refs: vec![],
                },
            )
            .unwrap();
        assert!(reopened.execution_observation_only("session-1").unwrap());
        assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    }
}

#[test]
#[cfg(unix)]
fn unknown_execution_blocks_new_writes_even_with_full_access_and_auto_approval() {
    let (_root, store, marker) = stopped_execution_with_local_command(true, false);
    begin_observation_turn(&store);
    assert_eq!(
        store.snapshot("session-1").unwrap().header.permission_mode,
        Some(AgentSessionPermissionMode::Operator)
    );
    for (index, effect) in [
        super::super::AgentSessionEffect::StateChange,
        super::super::AgentSessionEffect::Destructive,
        super::super::AgentSessionEffect::ExternalSideEffect,
        super::super::AgentSessionEffect::Unknown,
    ]
    .into_iter()
    .enumerate()
    {
        let before = store.snapshot("session-1").unwrap();
        assert!(admit_observation_tool(
            &store,
            &format!("blocked-{index}"),
            "write_file",
            effect,
            serde_json::json!({"path":marker, "content":"replace existing marker"})
        )
        .unwrap_err()
        .starts_with("EXECUTION_OUTCOME_UNKNOWN"));
        assert_eq!(store.snapshot("session-1").unwrap(), before);
        assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    }
    admit_observation_tool(
        &store,
        "diagnostic",
        "inspect_service",
        super::super::AgentSessionEffect::SensitiveRead,
        serde_json::json!({"service":"sshd"}),
    )
    .unwrap();
}

#[test]
#[cfg(unix)]
fn authoritative_completion_clears_only_its_original_unknown_execution() {
    let (_root, store, marker) = stopped_execution_with_local_command(true, false);
    begin_observation_turn(&store);
    assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::ToolResult {
                call_id: "marker-call".into(),
                name: "run_terminal_command".into(),
                status: super::super::AgentToolResultStatus::Completed,
                summary:
                    "The original local command completed and its marker contains exactly one x."
                        .into(),
                data: Some(serde_json::json!({"exitCode":0})),
                duration_ms: None,
                evidence_refs: vec![],
            },
        )
        .unwrap();
    assert!(!store.execution_observation_only("session-1").unwrap());
    admit_observation_tool(
        &store,
        "fresh-write",
        "run_terminal_command",
        super::super::AgentSessionEffect::StateChange,
        serde_json::json!({"command":"printf y >> \"$SHELLSPAN_RECONCILIATION_MARKER\""}),
    )
    .unwrap();
    assert!(std::process::Command::new("sh")
        .args(["-c", "printf y >> \"$SHELLSPAN_RECONCILIATION_MARKER\""])
        .env("SHELLSPAN_RECONCILIATION_MARKER", &marker)
        .status()
        .unwrap()
        .success());
    assert_eq!(std::fs::read(marker).unwrap(), b"xy");
}

#[test]
#[ignore = "requires an explicit read-only recorded ledger and a fresh private output path"]
fn export_unknown_execution_review() {
    use std::io::Write;
    let input = std::env::var("SHELLSPAN_EXECUTION_REVIEW_LEDGER").unwrap();
    let output = std::env::var("SHELLSPAN_EXECUTION_REVIEW_OUTPUT").unwrap();
    let events = serde_json::Deserializer::from_reader(File::open(input).unwrap())
        .into_iter::<AgentSessionEvent>()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let snapshot = AgentSessionRecord::from_events(events.clone())
        .unwrap()
        .snapshot()
        .unwrap();
    assert!(snapshot.uncertain_native_effects);
    let relevant = events
        .iter()
        .filter(|event| {
            event.step_id == snapshot.recovery.step_id
                && match &event.payload {
                    AgentSessionEventPayload::ToolCall { call } => {
                        Some(&call.call_id) == snapshot.recovery.call_id.as_ref()
                    }
                    AgentSessionEventPayload::ToolResult { call_id, .. } => {
                        Some(call_id) == snapshot.recovery.call_id.as_ref()
                    }
                    _ => false,
                }
        })
        .collect::<Vec<_>>();
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(output).unwrap();
    let evidence = serde_json::json!({ "sessionId":snapshot.header.session_id, "recovery":snapshot.recovery, "target":snapshot.header.target, "events":relevant });
    file.write_all(serde_json::to_string(&evidence).unwrap().as_bytes())
        .unwrap();
}
