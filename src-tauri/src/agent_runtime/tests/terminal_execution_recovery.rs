use super::*;
use crate::terminal_broker::{TerminalGeometry, TerminalSessionBroker, TerminalTransportKind};
use crate::terminal_integration::{TerminalIntegrationControlEvent as Event, TerminalShellKind};

fn ready_terminal(broker: &TerminalSessionBroker, id: &str, predecessor: Option<&str>) {
    broker
        .attach_transport(
            id,
            predecessor,
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(120, 30),
        )
        .unwrap();
    broker
        .register_integration_channel(id, id, TerminalShellKind::Bash)
        .unwrap();
    for event in [
        Event::Ready {
            shell: TerminalShellKind::Bash,
        },
        Event::PromptStart {
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        },
        Event::NativeInput { enabled: true },
        Event::NativeCheckpointMode { enabled: true },
        Event::NativePrivateControl { enabled: true },
        Event::NativeJobs { enabled: true },
        Event::PromptEnd,
    ] {
        broker.accept_integration_event(id, id, event).unwrap();
    }
}

fn quarantined_terminal(broker: &TerminalSessionBroker) -> String {
    ready_terminal(broker, "terminal", None);
    broker
        .acquire_agent_lease("terminal", "agent", "task", "operation")
        .unwrap();
    broker
        .require_native_input_recovery("terminal", "operation")
        .unwrap();
    broker
        .acquire_agent_lease("terminal", "agent", "task", "next-operation")
        .unwrap_err()
}

fn recovery_pipeline() -> (tempfile::TempDir, AgentToolPipeline, NativeToolRequest) {
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    let target: AgentSessionTarget = serde_json::from_value(serde_json::json!({
        "kind": "local", "targetId": "terminal", "sessionId": "terminal",
    }))
    .unwrap();
    sessions
        .create(
            serde_json::from_value(serde_json::json!({
                "sessionId": "agent", "taskId": "task", "goal": "Inspect current directory",
                "target": target, "permissionMode": "operator", "executionSurface": "boundTerminal",
            }))
            .unwrap(),
        )
        .unwrap();
    sessions
        .append(
            "agent",
            Some("turn".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    let pipeline = AgentToolPipeline::new(
        Default::default(),
        sessions,
        Default::default(),
        Arc::new(NativeToolRuntimeSlot::default()),
        Default::default(),
        Default::default(),
    );
    let request = NativeToolRequest {
        session_id: "agent".into(),
        task_id: "task".into(),
        goal: "Inspect current directory".into(),
        success_criteria: vec![],
        turn_id: "turn".into(),
        step_id: "step".into(),
        request_id: "request".into(),
        model_call: ModelToolCall {
            call_id: "call".into(),
            provider_call_id: None,
            name: "run_terminal_command".into(),
            arguments: serde_json::json!({"command":"pwd", "explanation":"Inspect current directory"}),
        },
        target,
        permission_mode: super::super::AgentSessionPermissionMode::Operator,
        execution_surface: super::super::AgentExecutionSurface::BoundTerminal,
    };
    (root, pipeline, request)
}

#[test]
fn terminal_execution_capabilities_follow_recovery_and_new_generation() {
    let broker = TerminalSessionBroker::phase3_enabled_for_test(4096);
    ready_terminal(&broker, "terminal", None);
    let (_root, pipeline, _) = recovery_pipeline();
    let header = pipeline.sessions.snapshot("agent").unwrap().header;
    let build = |state: Option<&crate::terminal_broker::TerminalExecutionCapabilities>| {
        let mut assembly =
            super::super::assemble_model_input(&header, super::super::default_model_tools());
        super::super::prompt::apply_terminal_execution_context(&header, state, &mut assembly);
        assembly
    };
    let before = broker.execution_capabilities("terminal").unwrap();
    assert!(build(Some(&before))
        .tools
        .iter()
        .find(|tool| tool.name == "run_terminal_command")
        .unwrap()
        .description
        .contains("nativeScriptInput=true; nativeJobControl=true; boundCommandReady=true"));
    broker
        .acquire_agent_lease("terminal", "agent", "task", "operation")
        .unwrap();
    broker
        .require_native_input_recovery("terminal", "operation")
        .unwrap();
    let blocked = broker.execution_capabilities("terminal").unwrap();
    assert!(blocked.input_recovery_required);
    let assembly = build(Some(&blocked));
    let current = &assembly.context.last().unwrap().content;
    assert!(current.contains("\"nativeScriptInput\":false"));
    assert!(current.contains("\"nativeJobControl\":false"));
    assert!(current.contains("\"inputRecoveryRequired\":true"));
    assert!(build(None)
        .context
        .last()
        .unwrap()
        .content
        .contains("\"nativeScriptInput\":false"));
    broker
        .close_transport(
            "terminal",
            crate::terminal_broker::TerminalGenerationCloseReason::TransportDisconnected,
        )
        .unwrap();
    ready_terminal(&broker, "reconnected", Some("terminal"));
    let after = broker.execution_capabilities("reconnected").unwrap();
    assert!(after.terminal_generation > before.terminal_generation);
    assert!(!after.input_recovery_required);
    assert!(build(Some(&after))
        .context
        .last()
        .unwrap()
        .content
        .contains("\"nativeScriptInput\":true"));
}

#[test]
fn terminal_recovery_rejection_stops_admission_and_pauses_queued_input() {
    use crate::llm::adapter::ModelAdapterFactory;
    let broker = TerminalSessionBroker::phase3_enabled_for_test(4096);
    let error = quarantined_terminal(&broker);
    let (_root, pipeline, request) = recovery_pipeline();
    assert_eq!(
        pipeline
            .commit_prepare_failure(&request, &error)
            .unwrap_err(),
        error
    );
    let provider = crate::ai::AiProviderConfig {
        model_definition: None,
        retry_policy: None,
        profile: "ollama".into(),
        id: "local".into(),
        kind: crate::ai::AiProviderKind::Ollama,
        base_url: "http://127.0.0.1:11434".into(),
        model: "deepseek-r1".into(),
        reasoning_effort: None,
        requires_api_key: false,
        api_key: None,
    };
    let adapter = crate::llm::registry::HttpModelAdapterFactory
        .create(provider.clone(), None)
        .unwrap();
    let handle = pipeline
        .agents
        .attach(pipeline.sessions.clone(), "agent".into(), provider, adapter)
        .unwrap();
    let entry = handle.entry();
    entry
        .set_scope(Some(AgentActiveScope {
            turn_id: "turn".into(),
            step_id: Some("step".into()),
        }))
        .unwrap();
    pipeline
        .sessions
        .enqueue(
            "agent",
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                message_id: "queued".into(),
                client_submission_id: Some("queued".into()),
                content: "Continue inspection".into(),
                source: AgentMessageSource::user(),
                terminal_context: None,
                images: vec![],
            },
        )
        .unwrap();
    pipeline
        .mark_terminal_execution_blocked(&entry, &error)
        .unwrap();
    let snapshot = pipeline.sessions.snapshot("agent").unwrap();
    assert!(!snapshot.ended);
    assert_eq!(snapshot.status, AgentSessionStatus::Idle);
    assert!(snapshot.inbox.paused_ids.contains(&"queued".into()));
    let events = pipeline.sessions.all_events("agent").unwrap();
    assert!(!events.iter().any(|event| matches!(
        event.payload,
        AgentSessionEventPayload::ToolExecution { .. }
    )));
    assert!(events.iter().any(|event| matches!(&event.payload, AgentSessionEventPayload::TurnEnd { reason } if reason == &error)));
    assert!(events.iter().any(|event| matches!(&event.payload, AgentSessionEventPayload::ToolResult { data: Some(data), .. } if data["retryable"] == false && data["executed"] == false && data["recoveryAction"] == "reconnectTerminal")));
}

#[test]
fn terminal_recovery_result_propagates_after_the_result_is_committed() {
    let broker = TerminalSessionBroker::phase3_enabled_for_test(4096);
    let error = quarantined_terminal(&broker);
    let (_root, pipeline, request) = recovery_pipeline();
    let mut call = super::super::recorded_tool_call(request.model_call.clone());
    call.native_name = Some("terminal_execute".into());
    call.target = Some(request.target.clone());
    call.effect = Some(AgentSessionEffect::ReadOnly);
    let preparation = NativeToolPreparation {
        token: "unused".into(),
        call,
        requires_approval: false,
        prompt: String::new(),
        expires_at_unix_ms: u64::MAX,
        idempotency: NativeToolIdempotency::Conditional,
        parallel: false,
        exclusive: true,
    };
    pipeline
        .append_auto_approved_call(&request, &preparation)
        .unwrap();
    pipeline
        .append_execution_dispatch(&request, &preparation)
        .unwrap();
    assert_eq!(
        pipeline
            .finish_native(&request, &preparation, Ok(Err(error.clone())))
            .unwrap_err(),
        error
    );
    let events = pipeline.sessions.all_events("agent").unwrap();
    assert_eq!(events.iter().filter(|event| matches!(&event.payload, AgentSessionEventPayload::ToolResult { summary, .. } if summary == &error)).count(), 1);
}

#[test]
fn quarantined_terminal_rejects_short_and_native_scripts_before_any_input() {
    use crate::agent_runtime::{TerminalExecuteRegistry, TerminalLeaseManager};
    let broker = TerminalSessionBroker::phase3_enabled_for_test(4096);
    quarantined_terminal(&broker);
    let registry =
        TerminalExecuteRegistry::new(TerminalLeaseManager::new(broker.clone()), broker.clone());
    let sessions = crate::models::SessionManager::default();
    let before = broker
        .snapshot(Some("terminal"))
        .unwrap()
        .session
        .unwrap()
        .next_input_sequence;
    for source in [
        "pwd".to_string(),
        "printf one\nprintf two".to_string(),
        "x".repeat(513),
    ] {
        let error = registry
            .start(
                &sessions, "terminal", "agent", "task", "retry", &source, "\r",
            )
            .unwrap_err();
        assert!(super::super::terminal_execution_needs_user_action(&error));
        assert!(!registry.has_operation("terminal").unwrap());
    }
    assert_eq!(
        broker
            .snapshot(Some("terminal"))
            .unwrap()
            .session
            .unwrap()
            .next_input_sequence,
        before
    );
}

#[test]
fn direct_requirement_is_non_retryable_and_ordinary_failures_remain_ordinary() {
    let (_root, pipeline, request) = recovery_pipeline();
    let error = "TERMINAL_DIRECT_REQUIRED: explicitly switch the session to direct before retrying";
    assert_eq!(
        pipeline
            .commit_prepare_failure(&request, error)
            .unwrap_err(),
        error
    );
    for ordinary in [
        "TERMINAL_INPUT_UNSUPPORTED: editor unavailable",
        "exit status 1",
        "TERMINAL_INPUT_RECOVERY_REQUIRED_OTHER",
    ] {
        assert!(!super::super::terminal_execution_needs_user_action(
            ordinary
        ));
    }
}
