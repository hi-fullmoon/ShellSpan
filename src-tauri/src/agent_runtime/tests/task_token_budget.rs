// Exercise the production store, checkpoint writer, admission counter and resume
// projection. No model adapter, synthetic model replies or reported usage.
fn task_budget_session() -> (
    tempfile::TempDir,
    AgentSessionStore,
    super::super::AgentArtifactStore,
) {
    use super::super::{AgentInboxMessage, AgentMessageSource, AgentPlanStep, AgentPlanStepStatus};
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    let artifacts = super::super::AgentArtifactStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    artifacts.configure(root.path()).unwrap();
    sessions.create(super::super::CreateAgentSessionRequest {
        session_id: "token-budget-review".into(),
        task_id: "token-budget-review".into(),
        goal: "Inspect task token budgeting and verify continuation".into(),
        parent_session_id: None,
        continued_from_session_id: None,
        target: None,
        permission_mode: None,
        execution_surface: super::super::AgentExecutionSurface::Direct,
        success_criteria: vec!["Saved progress is available after explicit continuation".into()],
        capability_scope: None,
        subagent: None,
    }).unwrap();
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent_runtime/driver_metrics.rs"),
    )
    .unwrap();
    sessions.enqueue("token-budget-review", super::super::AgentInboxLane::NextTurn, AgentInboxMessage {
        message_id: "inspect-budget-source".into(),
        client_submission_id: None,
        content: format!("Review the task token budget logic in this source, then verify continuation:\n{source}"),
        source: AgentMessageSource::user(),
        images: vec![],
        terminal_context: None,
    }).unwrap();
    sessions
        .begin_turn_step(
            "token-budget-review",
            "review-turn".into(),
            "review-step".into(),
        )
        .unwrap();
    sessions
        .append(
            "token-budget-review",
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Running,
                reason: None,
            },
        )
        .unwrap();
    sessions
        .append(
            "token-budget-review",
            Some("review-turn".into()),
            Some("review-step".into()),
            AgentSessionEventPayload::TaskEvidence {
                evidence_id: "source-read".into(),
                kind: "source".into(),
                summary: format!(
                    "Read src/agent_runtime/driver_metrics.rs from disk ({} UTF-8 bytes)",
                    source.len()
                ),
            },
        )
        .unwrap();
    sessions
        .append(
            "token-budget-review",
            Some("review-turn".into()),
            Some("review-step".into()),
            AgentSessionEventPayload::TaskPlan {
                version: 1,
                steps: vec![
                    AgentPlanStep {
                        id: "read".into(),
                        title: "Read driver_metrics.rs from disk".into(),
                        status: AgentPlanStepStatus::Completed,
                        detail: None,
                        evidence_refs: vec!["source-read".into()],
                    },
                    AgentPlanStep {
                        id: "verify".into(),
                        title: "Verify continued model input".into(),
                        status: AgentPlanStepStatus::Pending,
                        detail: None,
                        evidence_refs: vec![],
                    },
                ],
            },
        )
        .unwrap();
    (root, sessions, artifacts)
}

fn record_budget_admission(sessions: &AgentSessionStore, index: usize, input_tokens: u64) {
    sessions
        .append(
            "token-budget-review",
            Some("review-turn".into()),
            Some("review-step".into()),
            AgentSessionEventPayload::RequestContext {
                request_id: format!("admission-{index}"),
                input_tokens: Some(input_tokens),
                context_window: None,
                system_tokens: None,
                tool_schema_tokens: None,
                message_tokens: Some(input_tokens),
                surface_generation: 0,
                limited: None,
                omitted_messages: None,
            },
        )
        .unwrap();
}

#[test]
fn task_token_budget_checkpoint_survives_restart_and_explicit_resume() {
    use super::super::driver_metrics::TaskTokenBudgetDecision;
    use super::super::{measure_model_messages, AgentSurfaceMessage, TaskBudgetCheckpointStage};
    let (root, sessions, artifacts) = task_budget_session();
    let id = "token-budget-review";
    let surface = sessions.model_surface(id).unwrap();
    let request = ModelRequest::from_surface("measure".into(), &surface, String::new(), vec![]);
    let tokens = measure_model_messages(&request.messages, 0).0;
    let maximum = tokens * 10;
    for index in 0..8 {
        record_budget_admission(&sessions, index, tokens);
    }
    assert_eq!(
        sessions
            .driver_metrics(id)
            .unwrap()
            .token_budget_decision(tokens - 1, maximum),
        TaskTokenBudgetDecision::Continue
    );
    assert_eq!(
        sessions
            .driver_metrics(id)
            .unwrap()
            .token_budget_decision(tokens, maximum),
        TaskTokenBudgetDecision::Checkpoint
    );
    let manager = AgentCompactionManager::new(sessions.clone(), artifacts.clone());
    let cancellation = tokio_util::sync::CancellationToken::new();
    manager
        .checkpoint_task_budget(
            id,
            "review-turn",
            "review-step",
            maximum,
            TaskBudgetCheckpointStage::Approaching,
            &cancellation,
        )
        .unwrap();
    assert_eq!(sessions.model_surface(id).unwrap(), surface);
    assert_eq!(
        sessions.driver_metrics(id).unwrap().model_tokens,
        tokens * 8
    );
    assert_eq!(
        sessions
            .driver_metrics(id)
            .unwrap()
            .token_budget_decision(tokens, maximum),
        TaskTokenBudgetDecision::Continue
    );

    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        reopened
            .driver_metrics(id)
            .unwrap()
            .token_budget_decision(tokens, maximum),
        TaskTokenBudgetDecision::Continue
    );
    for index in 8..10 {
        record_budget_admission(&reopened, index, tokens);
    }
    assert_eq!(
        reopened
            .driver_metrics(id)
            .unwrap()
            .token_budget_decision(tokens, maximum),
        TaskTokenBudgetDecision::Stop
    );
    let manager = AgentCompactionManager::new(reopened.clone(), artifacts.clone());
    let before = reopened.all_events(id).unwrap();
    let StepSettlement::Failed(reason) = stop_for_token_budget(
        &manager,
        id,
        "review-turn",
        "review-step",
        maximum,
        &cancellation,
    ) else {
        panic!("expected the token budget boundary");
    };
    assert!(reason.starts_with("taskTokenBudgetExceeded:"));
    assert!(!reason.contains("checkpointUnavailable"));
    let after_checkpoint = reopened.all_events(id).unwrap();
    assert_eq!(&after_checkpoint[..before.len()], before);
    assert_eq!(after_checkpoint.len(), before.len() + 2);
    assert!(!after_checkpoint[before.len()..]
        .iter()
        .any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::RequestStart { .. }
                | AgentSessionEventPayload::RequestUsage { .. }
        )));
    let (artifact_id, _) = after_checkpoint
        .iter()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::ContextArtifact {
                artifact_id, kind, ..
            } if kind == super::super::TASK_BUDGET_CHECKPOINT_KIND => Some((artifact_id, kind)),
            _ => None,
        })
        .unwrap();
    let body = std::fs::read(artifacts.path_for_test(id, artifact_id)).unwrap();
    let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(document["summary"]
        .as_str()
        .unwrap()
        .contains("Verify continued model input"));
    assert!(document["summary"]
        .as_str()
        .unwrap()
        .contains("Read driver_metrics.rs from disk"));
    assert!(document["evidenceRefs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "source-read"));

    reopened
        .append(
            id,
            Some("review-turn".into()),
            Some("review-step".into()),
            AgentSessionEventPayload::StepEnd {
                reason: reason.clone(),
            },
        )
        .unwrap();
    reopened
        .append(
            id,
            Some("review-turn".into()),
            None,
            AgentSessionEventPayload::TurnEnd {
                reason: reason.clone(),
            },
        )
        .unwrap();
    reopened
        .terminate(id, AgentSessionStatus::Failed, reason)
        .unwrap();
    let failed = reopened.snapshot(id).unwrap();
    let failed_events = reopened.all_events(id).unwrap();
    assert!(failed.ended);
    let continued = reopened.resume(id).unwrap();
    assert!(!continued.ended);
    assert_eq!(continued.status, AgentSessionStatus::Idle);
    assert_eq!(reopened.driver_metrics(id).unwrap().model_tokens, 0);
    assert_eq!(continued.surface, failed.surface);
    assert!(continued.surface.messages.iter().any(|message| matches!(message,
        AgentSurfaceMessage::User { source, content, .. }
            if source.label == "task-budget-checkpoint" && content.contains("Verify continued model input"))));
    let request = ModelRequest::from_surface(
        "continued".into(),
        &continued.surface,
        String::new(),
        vec![],
    );
    let next_tokens = measure_model_messages(&request.messages, 0).0;
    assert_eq!(
        reopened
            .driver_metrics(id)
            .unwrap()
            .token_budget_decision(next_tokens, maximum),
        TaskTokenBudgetDecision::Continue
    );
    assert_eq!(
        reopened
            .driver_metrics(id)
            .unwrap()
            .token_budget_decision(maximum, maximum),
        TaskTokenBudgetDecision::Checkpoint
    );
    assert_eq!(
        &reopened.all_events(id).unwrap()[..failed_events.len()],
        failed_events
    );

    // Optional capture for frontend/browser replay of this real persisted lifecycle.
    if let Some(path) = std::env::var_os("SHELLSPAN_TOKEN_BUDGET_EVIDENCE") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "failed": failed, "events": failed_events, "continued": continued,
                "continuedEvents": reopened.all_events(id).unwrap(),
            }))
            .unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn task_token_budget_checkpoint_cancellation_and_storage_failure_preserve_history() {
    let (_root, sessions, _artifacts) = task_budget_session();
    let manager = AgentCompactionManager::new(
        sessions.clone(),
        super::super::AgentArtifactStore::default(),
    );
    let before = sessions.all_events("token-budget-review").unwrap();
    let cancelled = tokio_util::sync::CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        stop_for_token_budget(
            &manager,
            "token-budget-review",
            "review-turn",
            "review-step",
            2_000_000,
            &cancelled
        ),
        StepSettlement::Cancelled
    ));
    let StepSettlement::Failed(reason) = stop_for_token_budget(
        &manager,
        "token-budget-review",
        "review-turn",
        "review-step",
        2_000_000,
        &tokio_util::sync::CancellationToken::new(),
    ) else {
        panic!("expected the token budget boundary despite unavailable artifact storage");
    };
    assert!(reason.ends_with("; checkpointUnavailable"));
    assert_eq!(sessions.all_events("token-budget-review").unwrap(), before);
}
