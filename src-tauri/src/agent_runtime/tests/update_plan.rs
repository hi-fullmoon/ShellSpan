use super::*;
use serde_json::json;

const SESSION: &str = "plan-title";

fn plan_store() -> (tempfile::TempDir, AgentSessionStore) {
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    sessions
        .create(super::super::CreateAgentSessionRequest {
            session_id: SESSION.into(),
            task_id: SESSION.into(),
            goal: "Review the task plan".into(),
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
    sessions
        .append(
            SESSION,
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    (root, sessions)
}

fn commit_plan(sessions: &AgentSessionStore, value: Value) -> Result<u64, String> {
    let (version, arguments) =
        sessions.read_events(SESSION, |events| parse_update_plan_arguments(value, events))??;
    sessions.append(
        SESSION,
        Some("turn-1".into()),
        None,
        AgentSessionEventPayload::TaskPlan {
            version,
            steps: arguments.steps,
        },
    )?;
    Ok(version)
}

fn seed_plan(sessions: &AgentSessionStore) {
    sessions
        .append(
            SESSION,
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TaskEvidence {
                evidence_id: "inspection".into(),
                kind: "plan".into(),
                summary: "The plan store has been initialized".into(),
            },
        )
        .unwrap();
    commit_plan(sessions, json!({"steps": [
        {"id": "inspect", "title": "Inspect the workspace", "status": "completed", "detail": "Inspected", "evidenceRefs": ["inspection"]},
        {"id": "verify", "title": "Verify the result", "status": "inProgress"},
        {"id": "report", "title": "Report the result", "status": "pending"}
    ]})).unwrap();
}

#[test]
fn update_plan_preserves_omitted_titles_by_id_and_replays_complete_steps() {
    let (root, sessions) = plan_store();
    seed_plan(&sessions);
    let input = json!({"steps": [
        {"id": "verify", "status": "completed", "detail": "Verified"},
        {"id": "inspect", "status": "completed"}
    ]});
    assert_eq!(commit_plan(&sessions, input.clone()).unwrap(), 2);
    let plan = sessions.snapshot(SESSION).unwrap().task.plan.unwrap();
    assert_eq!(plan.steps.len(), 2);
    assert_eq!(plan.steps[0].title, "Verify the result");
    assert_eq!(plan.steps[0].detail.as_deref(), Some("Verified"));
    assert_eq!(plan.steps[1].title, "Inspect the workspace");
    assert_eq!(plan.steps[1].detail, None);
    assert!(plan.steps[1].evidence_refs.is_empty());
    assert!(plan
        .steps
        .iter()
        .all(|step| step.status == super::super::AgentPlanStepStatus::Completed));
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(reopened.snapshot(SESSION).unwrap().task.plan, Some(plan));
}

#[test]
fn update_plan_requires_titles_for_new_ids_and_preserves_plan_on_rejection() {
    let (_root, sessions) = plan_store();
    let missing = json!({"steps": [{"id": "new", "status": "pending"}]});
    let error = commit_plan(&sessions, missing).unwrap_err();
    assert!(error.contains("steps[0].title is required for a new step"));
    assert!(sessions.snapshot(SESSION).unwrap().task.plan.is_none());
    seed_plan(&sessions);
    let before = sessions.snapshot(SESSION).unwrap();
    let error = commit_plan(
        &sessions,
        json!({"steps": [
            {"id": "inspect", "status": "completed"},
            {"id": "new", "status": "pending"}
        ]}),
    )
    .unwrap_err();
    assert!(error.contains("steps[1].title is required for a new step"));
    let after = sessions.snapshot(SESSION).unwrap();
    assert_eq!(after.task.plan, before.task.plan);
    assert_eq!(after.event_count, before.event_count);
    assert_eq!(
        commit_plan(
            &sessions,
            json!({"steps": [
                {"id": "new", "title": "New task", "status": "pending"}
            ]})
        )
        .unwrap(),
        2
    );
}

#[test]
fn update_plan_validates_explicit_titles_and_all_other_fields() {
    let (_root, sessions) = plan_store();
    seed_plan(&sessions);
    let before = sessions.snapshot(SESSION).unwrap().task.plan;
    for title in [
        Value::Null,
        json!(""),
        json!(" "),
        json!("x".repeat(4097)),
        json!(42),
    ] {
        assert!(
            commit_plan(
                &sessions,
                json!({"steps": [
                    {"id": "inspect", "title": title, "status": "completed"}
                ]})
            )
            .is_err(),
            "Accepted invalid title: {title}"
        );
    }
    for invalid in [
        json!({"steps": [{"id": "inspect"}]}),
        json!({"steps": [{"status": "completed"}]}),
        json!({"steps": [{"id": "inspect", "status": "done"}]}),
        json!({"steps": [{"id": "inspect", "status": "completed", "unknown": true}]}),
        json!({"steps": [{"id": "inspect", "status": "completed", "evidenceRefs": ["not an identifier"]}]}),
        json!({"steps": [{"id": "inspect", "status": "completed"}, {"id": "inspect", "status": "pending"}]}),
        json!({"planVersion": 1, "steps": [{"id": "inspect", "status": "completed"}]}),
        json!({"explanation": " ", "steps": [{"id": "inspect", "status": "completed"}]}),
    ] {
        assert!(
            commit_plan(&sessions, invalid.clone()).is_err(),
            "Accepted {invalid}"
        );
    }
    assert_eq!(sessions.snapshot(SESSION).unwrap().task.plan, before);
    commit_plan(
        &sessions,
        json!({"steps": [
            {"id": "inspect", "title": "Inspect again", "status": "inProgress"}
        ]}),
    )
    .unwrap();
    assert_eq!(
        sessions.snapshot(SESSION).unwrap().task.plan.unwrap().steps[0].title,
        "Inspect again"
    );
    commit_plan(
        &sessions,
        json!({"steps": [
            {"id": "inspect", "status": "completed"}
        ]}),
    )
    .unwrap();
    assert_eq!(
        sessions.snapshot(SESSION).unwrap().task.plan.unwrap().steps[0].title,
        "Inspect again"
    );
    assert!(serde_json::from_value::<AgentPlanStep>(
        json!({"id": "inspect", "status": "completed"})
    )
    .is_err());
}

#[test]
fn update_plan_does_not_inherit_titles_from_a_cleared_plan() {
    let (_root, sessions) = plan_store();
    seed_plan(&sessions);
    assert_eq!(commit_plan(&sessions, json!({"steps": []})).unwrap(), 2);
    assert!(commit_plan(
        &sessions,
        json!({"steps": [
            {"id": "inspect", "status": "inProgress"}
        ]})
    )
    .is_err());
    assert!(sessions
        .snapshot(SESSION)
        .unwrap()
        .task
        .plan
        .unwrap()
        .steps
        .is_empty());
}

#[test]
fn update_plan_inherits_retained_titles_but_not_retired_titles_after_a_new_turn() {
    for completed in [false, true] {
        let (_root, sessions) = plan_store();
        commit_plan(&sessions, json!({"steps": [
            {"id": "inspect", "title": "Inspect the workspace", "status": if completed { "completed" } else { "inProgress" }}
        ]})).unwrap();
        sessions
            .append(
                SESSION,
                Some("turn-1".into()),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "interrupted".into(),
                },
            )
            .unwrap();
        sessions
            .append(
                SESSION,
                Some("turn-2".into()),
                None,
                AgentSessionEventPayload::TurnStart,
            )
            .unwrap();
        let events = sessions.all_events(SESSION).unwrap();
        let result = parse_update_plan_arguments(
            json!({"steps": [
                {"id": "inspect", "status": "inProgress"}
            ]}),
            &events,
        );
        if completed {
            assert!(result
                .unwrap_err()
                .contains("title is required for a new step"));
            let (version, _) = parse_update_plan_arguments(
                json!({"steps": [
                    {"id": "inspect", "title": "Inspect again", "status": "inProgress"}
                ]}),
                &events,
            )
            .unwrap();
            assert_eq!(version, 2);
        } else {
            let (version, arguments) = result.unwrap();
            assert_eq!(version, 2);
            assert_eq!(arguments.steps[0].title, "Inspect the workspace");
        }
    }
}
