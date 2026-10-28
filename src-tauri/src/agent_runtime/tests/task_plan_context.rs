fn task_plan_context_store() -> (tempfile::TempDir, AgentSessionStore) {
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    sessions
        .create(super::super::CreateAgentSessionRequest {
            session_id: "plan-context".into(),
            task_id: "plan-context".into(),
            goal: "Inspect and verify the workspace".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: None,
            permission_mode: None,
            execution_surface: super::super::AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    (root, sessions)
}

fn task_plan_request_prompt(sessions: &AgentSessionStore, turn_id: &str) -> String {
    let snapshot = sessions.snapshot("plan-context").unwrap();
    let mut assembly = assemble_model_input(&snapshot.header, super::super::default_model_tools());
    append_current_task_plan_context(sessions, &snapshot, turn_id, &mut assembly.system_prompt)
        .unwrap();
    ModelRequest::from_surface(
        "plan-context-request".into(),
        &sessions.model_surface("plan-context").unwrap(),
        assembly.system_prompt,
        assembly.tools,
    )
    .system_prompt
}

#[test]
fn task_plan_context_survives_interruption_and_replay_until_committed_adoption() {
    use super::super::AgentPlanStepStatus::{Blocked, Completed, InProgress};

    let (root, sessions) = task_plan_context_store();
    let mut steps = vec![
        super::super::AgentPlanStep {
            id: "inspect".into(),
            title: "Inspect the workspace".into(),
            status: Completed,
            detail: Some("Inspection is complete".into()),
            evidence_refs: vec![],
        },
        super::super::AgentPlanStep {
            id: "verify".into(),
            title: "Verify the result".into(),
            status: InProgress,
            detail: Some("Verify after reconnect".into()),
            evidence_refs: vec![],
        },
    ];
    let append = |store: &AgentSessionStore, turn: &str, payload| {
        store
            .append("plan-context", Some(turn.into()), None, payload)
            .unwrap();
    };
    append(&sessions, "turn-1", AgentSessionEventPayload::TurnStart);
    append(
        &sessions,
        "turn-1",
        AgentSessionEventPayload::TaskPlan {
            version: 3,
            steps: steps.clone(),
        },
    );
    sessions
        .pause_for_input("plan-context", "terminalTargetUnavailable")
        .unwrap();
    sessions
        .end(
            "plan-context",
            AgentSessionStatus::Failed,
            Some("terminalTargetUnavailable".into()),
        )
        .unwrap();
    sessions.resume("plan-context").unwrap();
    let replaced_through_seq = sessions
        .read_events("plan-context", |events| {
            events
                .iter()
                .rev()
                .find(|event| matches!(event.payload, AgentSessionEventPayload::TurnEnd { .. }))
                .unwrap()
                .seq
        })
        .unwrap();
    sessions
        .append(
            "plan-context",
            Some("turn-2".into()),
            Some("step-2".into()),
            AgentSessionEventPayload::CompactionSummary {
                summary: "The first turn was interrupted; inspect current state before proceeding"
                    .into(),
                replaced_through_seq,
                surface_generation: 1,
            },
        )
        .unwrap();
    sessions
        .append(
            "plan-context",
            Some("turn-2".into()),
            Some("step-2".into()),
            AgentSessionEventPayload::CompactionEnd {
                replaced_through_seq,
                surface_generation: 1,
                status: super::super::AgentCompactionStatus::Completed,
                compaction_id: None,
                duration_ms: None,
                reason: None,
            },
        )
        .unwrap();
    append(&sessions, "turn-2", AgentSessionEventPayload::TurnStart);

    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    let before = reopened.snapshot("plan-context").unwrap();
    assert_eq!(before.surface.generation, 1);
    let retained = task_plan_request_prompt(&reopened, "turn-2");
    assert!(retained.contains("first call update_plan with the complete list"));
    assert!(retained.contains("without activating, clearing or executing the retained plan"));
    assert!(retained.contains(&serde_json::to_string(before.task.plan.as_ref().unwrap()).unwrap()));
    // Request preparation itself cannot activate or mutate the retained plan.
    assert_eq!(reopened.snapshot("plan-context").unwrap(), before);
    assert!(!reopened
        .read_turn_events("plan-context", |events| incomplete_plan_for_turn(
            events, "turn-2"
        ))
        .unwrap());

    append(
        &reopened,
        "turn-2",
        AgentSessionEventPayload::TaskPlan {
            version: 4,
            steps: steps.clone(),
        },
    );
    let adopted = task_plan_request_prompt(&reopened, "turn-2");
    assert!(adopted.contains("This turn owns the plan"));
    assert!(!adopted.contains("retained from an earlier turn"));
    assert!(reopened
        .read_turn_events("plan-context", |events| plan_needs_completion_check(
            events, "turn-2"
        ))
        .unwrap());

    steps[1].status = Blocked;
    steps[1].detail = Some("Await the user's decision".into());
    append(
        &reopened,
        "turn-2",
        AgentSessionEventPayload::TaskPlan { version: 5, steps },
    );
    let blocked = task_plan_request_prompt(&reopened, "turn-2");
    assert!(blocked.contains("awaiting a user decision"));
    assert!(blocked.contains("\"status\":\"blocked\""));
    assert!(!blocked.contains("\"status\":\"inProgress\""));
    assert!(reopened
        .read_turn_events("plan-context", |events| incomplete_plan_for_turn(
            events, "turn-2"
        ))
        .unwrap());
    assert!(!reopened
        .read_turn_events("plan-context", |events| plan_needs_completion_check(
            events, "turn-2"
        ))
        .unwrap());
}

#[test]
fn task_plan_context_is_absent_without_steps_and_after_explicit_clear() {
    let (_root, sessions) = task_plan_context_store();
    assert!(!task_plan_request_prompt(&sessions, "turn-1").contains("## Current task plan"));
    sessions
        .append(
            "plan-context",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    sessions
        .append(
            "plan-context",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TaskPlan {
                version: 1,
                steps: Vec::new(),
            },
        )
        .unwrap();
    assert!(!task_plan_request_prompt(&sessions, "turn-1").contains("## Current task plan"));
}
