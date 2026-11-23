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

fn task_plan_request_parts(sessions: &AgentSessionStore, turn_id: &str) -> (String, String) {
    let snapshot = sessions.snapshot("plan-context").unwrap();
    let mut assembly = assemble_model_input(&snapshot.header, super::super::default_model_tools());
    append_current_task_plan_context(sessions, &snapshot, turn_id, &mut assembly).unwrap();
    let injection = assembly
        .context
        .iter()
        .find(|item| item.source.producer_id == "shellspan.task-plan.v1")
        .expect("task plan context injection should be present")
        .content
        .clone();
    let system_prompt = ModelRequest::from_surface(
        "plan-context-request".into(),
        &sessions.model_surface("plan-context").unwrap(),
        assembly.system_prompt,
        assembly.tools,
    )
    .system_prompt;
    (system_prompt, injection)
}

fn task_plan_surface_messages(sessions: &AgentSessionStore) -> Vec<String> {
    sessions
        .model_surface("plan-context")
        .unwrap()
        .messages
        .into_iter()
        .filter_map(|message| match message {
            super::super::AgentSurfaceMessage::User {
                source, content, ..
            } if source.producer_id == "shellspan.task-plan.v1" => Some(content),
            _ => None,
        })
        .collect()
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
    let (retained_prompt, retained) = task_plan_request_parts(&reopened, "turn-2");
    assert!(retained_prompt.contains("first call update_plan with the complete list"));
    assert!(retained_prompt.contains("without activating, clearing or executing the retained plan"));
    assert!(retained.contains("retained from an earlier turn"));
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
    let (adopted_prompt, adopted) = task_plan_request_parts(&reopened, "turn-2");
    assert_eq!(adopted_prompt, retained_prompt);
    assert!(adopted.contains("owned by this turn"));
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
    let (blocked_prompt, blocked) = task_plan_request_parts(&reopened, "turn-2");
    assert_eq!(blocked_prompt, retained_prompt);
    assert!(blocked_prompt.contains("awaiting a user decision"));
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
fn task_plan_context_reports_no_plan_without_steps_and_after_explicit_clear() {
    let (_root, sessions) = task_plan_context_store();
    let (initial_prompt, initial) = task_plan_request_parts(&sessions, "turn-1");
    assert!(initial.contains("There is no current task plan"));
    assert!(initial.contains("including id, title and status for every step"));
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
    let (cleared_prompt, cleared) = task_plan_request_parts(&sessions, "turn-1");
    assert_eq!(cleared_prompt, initial_prompt);
    assert!(cleared.contains("There is no current task plan"));
    assert!(cleared.contains("Historical IDs cannot supply omitted titles"));
}

#[test]
fn task_plan_context_reports_retired_completed_plan_after_next_turn_and_replay() {
    let (root, sessions) = task_plan_context_store();
    for payload in [
        AgentSessionEventPayload::TurnStart,
        AgentSessionEventPayload::TaskPlan {
            version: 1,
            steps: vec![super::super::AgentPlanStep {
                id: "inspect".into(),
                title: "Inspect the workspace".into(),
                status: super::super::AgentPlanStepStatus::Completed,
                detail: None,
                evidence_refs: vec![],
            }],
        },
        AgentSessionEventPayload::TurnEnd {
            reason: "completed".into(),
        },
    ] {
        sessions
            .append("plan-context", Some("turn-1".into()), None, payload)
            .unwrap();
    }
    let (turn1_prompt, turn1_injection) = task_plan_request_parts(&sessions, "turn-1");
    assert!(turn1_injection.contains("owned by this turn"));
    sessions
        .append(
            "plan-context",
            Some("turn-2".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    let before = reopened.snapshot("plan-context").unwrap();
    assert!(before.task.plan.is_none());
    let (turn2_prompt, injection) = task_plan_request_parts(&reopened, "turn-2");
    assert_eq!(turn2_prompt, turn1_prompt);
    assert!(injection.contains("There is no current task plan"));
    assert!(injection.contains("completed plan is retired when the next turn starts"));
    assert!(injection.contains("including id, title and status for every step"));
    assert!(!injection.contains("owned by this turn"));
    assert!(!injection.contains("\"id\":\"inspect\""));
    assert_eq!(reopened.snapshot("plan-context").unwrap(), before);
}

#[test]
fn task_plan_updates_keep_system_prompt_stable_and_deduplicate_context() {
    use super::super::AgentPlanStepStatus::{Completed, InProgress, Pending};

    let (_root, sessions) = task_plan_context_store();
    let sync_step = |turn_id: &str, step_id: &str| -> String {
        let snapshot = sessions.snapshot("plan-context").unwrap();
        let mut assembly =
            assemble_model_input(&snapshot.header, super::super::default_model_tools());
        append_current_task_plan_context(&sessions, &snapshot, turn_id, &mut assembly).unwrap();
        ensure_model_context(
            &sessions,
            "plan-context",
            turn_id,
            step_id,
            &snapshot.surface,
            &assembly,
        )
        .unwrap();
        assembly.system_prompt
    };

    sessions
        .append(
            "plan-context",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    let prompt_initial = sync_step("turn-1", "step-1");
    assert_eq!(task_plan_surface_messages(&sessions).len(), 1);
    assert!(task_plan_surface_messages(&sessions)[0].contains("There is no current task plan"));

    // Unchanged plan state must not append a duplicate task-plan message.
    assert_eq!(sync_step("turn-1", "step-2"), prompt_initial);
    assert_eq!(task_plan_surface_messages(&sessions).len(), 1);

    // Committing v1 keeps system_prompt identical and appends exactly one snapshot.
    sessions
        .append(
            "plan-context",
            Some("turn-1".into()),
            Some("step-2".into()),
            AgentSessionEventPayload::TaskPlan {
                version: 1,
                steps: vec![
                    super::super::AgentPlanStep {
                        id: "create".into(),
                        title: "Create config".into(),
                        status: InProgress,
                        detail: None,
                        evidence_refs: vec![],
                    },
                    super::super::AgentPlanStep {
                        id: "verify".into(),
                        title: "Verify config".into(),
                        status: Pending,
                        detail: None,
                        evidence_refs: vec![],
                    },
                ],
            },
        )
        .unwrap();
    assert_eq!(sync_step("turn-1", "step-3"), prompt_initial);
    let messages_v1 = task_plan_surface_messages(&sessions);
    assert_eq!(messages_v1.len(), 2);
    assert!(messages_v1[1].contains("owned by this turn"));
    assert!(messages_v1[1].contains("\"version\":1"));

    // Another step with unchanged v1 stays deduplicated.
    assert_eq!(sync_step("turn-1", "step-4"), prompt_initial);
    assert_eq!(task_plan_surface_messages(&sessions).len(), 2);

    // Committing v2 keeps system_prompt identical and appends one new snapshot.
    sessions
        .append(
            "plan-context",
            Some("turn-1".into()),
            Some("step-4".into()),
            AgentSessionEventPayload::TaskPlan {
                version: 2,
                steps: vec![
                    super::super::AgentPlanStep {
                        id: "create".into(),
                        title: "Create config".into(),
                        status: Completed,
                        detail: None,
                        evidence_refs: vec![],
                    },
                    super::super::AgentPlanStep {
                        id: "verify".into(),
                        title: "Verify config".into(),
                        status: Completed,
                        detail: None,
                        evidence_refs: vec![],
                    },
                ],
            },
        )
        .unwrap();
    assert_eq!(sync_step("turn-1", "step-5"), prompt_initial);
    let messages_v2 = task_plan_surface_messages(&sessions);
    assert_eq!(messages_v2.len(), 3);
    assert!(messages_v2[2].contains("\"version\":2"));

    // Compaction clears prior injections; the next step re-injects the latest snapshot.
    sessions
        .append(
            "plan-context",
            Some("turn-1".into()),
            Some("step-5".into()),
            AgentSessionEventPayload::StepEnd {
                reason: "toolsCompleted".into(),
            },
        )
        .unwrap();
    let latest_seq = sessions
        .read_events("plan-context", |events| events.last().unwrap().seq)
        .unwrap();
    sessions
        .append(
            "plan-context",
            Some("turn-1".into()),
            Some("step-6".into()),
            AgentSessionEventPayload::CompactionSummary {
                summary: "Compacted earlier progress".into(),
                replaced_through_seq: latest_seq,
                surface_generation: 1,
            },
        )
        .unwrap();
    sessions
        .append(
            "plan-context",
            Some("turn-1".into()),
            Some("step-6".into()),
            AgentSessionEventPayload::CompactionEnd {
                replaced_through_seq: latest_seq,
                surface_generation: 1,
                status: super::super::AgentCompactionStatus::Completed,
                compaction_id: None,
                duration_ms: None,
                reason: None,
            },
        )
        .unwrap();
    assert!(task_plan_surface_messages(&sessions).is_empty());
    assert_eq!(sync_step("turn-1", "step-6"), prompt_initial);
    let messages_after_compaction = task_plan_surface_messages(&sessions);
    assert_eq!(messages_after_compaction.len(), 1);
    assert!(messages_after_compaction[0].contains("\"version\":2"));

    // Inherited surface filtering excludes assembled task-plan snapshots for child agents.
    assert!(is_assembled_context_source(
        &super::super::AgentMessageSource::task_plan()
    ));
}
