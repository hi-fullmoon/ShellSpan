#[test]
fn optional_child_step_budgets_survive_creation_and_reload() {
    let (root, manager, _entry) = setup();
    assert_eq!(default_subagent_budget().max_steps_per_turn, None);
    assert_eq!(fleet_role_budget().max_steps_per_turn, Some(6));

    for explicit_limit in [None, Some(1), Some(64)] {
        let mut wire = serde_json::to_value(default_subagent_budget()).unwrap();
        assert!(wire.get("maxStepsPerTurn").is_none());
        if let Some(limit) = explicit_limit {
            wire["maxStepsPerTurn"] = json!(limit);
        }
        let budget: AgentSubagentBudget = serde_json::from_value(wire).unwrap();
        super::super::session::validate_subagent_budget(&budget).unwrap();

        for continuable in [true, false] {
            let child = manager
                .create_child(
                    "lifecycle-parent",
                    "Review the child step-budget contract".into(),
                    AgentSubagentRole::Explorer,
                    "blank",
                    vec!["lifecycle-target".into()],
                    budget.clone(),
                    continuable,
                )
                .unwrap();
            let snapshot = manager.sessions.snapshot(&child).unwrap();
            let metadata = snapshot.header.subagent.unwrap();
            let expected_limit = if continuable {
                explicit_limit
            } else {
                explicit_limit.or(Some(6))
            };
            assert_eq!(metadata.budget.max_steps_per_turn, expected_limit);
            assert_eq!(metadata.budget.max_turns, if continuable { 8 } else { 1 });
            assert_eq!(metadata.budget.timeout_ms, budget.timeout_ms);
            assert_eq!(metadata.budget.max_tool_calls, budget.max_tool_calls);
            assert_eq!(metadata.budget.max_tokens, budget.max_tokens);
            assert!(manager
                .sessions
                .all_events("lifecycle-parent")
                .unwrap()
                .iter()
                .any(|event| matches!(
                    &event.payload,
                    AgentSessionEventPayload::SubagentDescriptor {
                        child_session_id,
                        budget: saved,
                        ..
                    } if child_session_id == &child && saved == &metadata.budget
                )));

            let reloaded = AgentSessionStore::default();
            reloaded.configure(root.path().to_path_buf()).unwrap();
            assert_eq!(
                reloaded.snapshot(&child).unwrap().header.subagent.unwrap(),
                metadata
            );
            let saved = serde_json::to_value(&metadata.budget).unwrap();
            assert_eq!(
                saved
                    .get("maxStepsPerTurn")
                    .and_then(serde_json::Value::as_u64),
                expected_limit.map(u64::from)
            );
        }
    }
}

#[test]
fn optional_step_budget_does_not_relax_native_validation() {
    let baseline = default_subagent_budget();
    super::super::session::validate_subagent_budget(&baseline).unwrap();
    for limit in [0, 65, u16::MAX] {
        let budget = AgentSubagentBudget {
            max_steps_per_turn: Some(limit),
            ..baseline.clone()
        };
        assert!(super::super::session::validate_subagent_budget(&budget).is_err());
    }
    for budget in [
        AgentSubagentBudget {
            max_turns: 0,
            ..baseline.clone()
        },
        AgentSubagentBudget {
            timeout_ms: 999,
            ..baseline.clone()
        },
        AgentSubagentBudget {
            max_tool_calls: Some(0),
            ..baseline.clone()
        },
        AgentSubagentBudget {
            max_tokens: Some(1023),
            ..baseline
        },
    ] {
        assert!(super::super::session::validate_subagent_budget(&budget).is_err());
    }
}
