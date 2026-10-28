#[tokio::test]
async fn all_fleet_roles_receive_and_enforce_the_persisted_call_budget() {
    let explicit = AgentSubagentBudget {
        max_steps_per_turn: 9,
        max_turns: 1,
        max_tool_calls: Some(3),
        max_tokens: Some(524_288),
        timeout_ms: 75_000,
    };
    for budget in [
        None,
        Some(explicit.clone()),
        Some(AgentSubagentBudget {
            max_tool_calls: None,
            ..explicit.clone()
        }),
    ] {
        let (root, manager, _entry) = setup();
        let target = AgentFleetTargetRequest {
            target_id: "lifecycle-target".into(),
            goal: "Track Fleet task progress".into(),
        };
        let plan = manager
            .plan_fleet(AgentFleetPlanRequest {
                parent_session_id: "lifecycle-parent".into(),
                targets: vec![target.clone()],
                canary_size: 1,
                wave_size: 1,
                failure_threshold: 0,
                budget: budget.clone(),
            })
            .unwrap();
        let fleet_id = plan.fleet.fleet_id.unwrap();
        manager.fleets.lock().unwrap().clear();
        let expected = budget.unwrap_or_else(fleet_role_budget);
        for role in [
            AgentSubagentRole::Explorer,
            AgentSubagentRole::Operator,
            AgentSubagentRole::Verifier,
            AgentSubagentRole::Reviewer,
        ] {
            // Use the same creation path as run_fleet, before it starts the model driver.
            let child = manager
                .create_fleet_child("lifecycle-parent", &fleet_id, &target, role)
                .unwrap();
            let snapshot = manager.sessions.snapshot(&child).unwrap();
            let metadata = snapshot.header.subagent.unwrap();
            assert_eq!(metadata.role, role);
            assert_eq!(metadata.budget, expected);
            assert!(!metadata.continuable);
            assert!(manager
                .sessions
                .all_events("lifecycle-parent")
                .unwrap()
                .iter()
                .any(|event| {
                    matches!(&event.payload, AgentSessionEventPayload::SubagentDescriptor {
                    child_session_id, role: saved_role, budget: saved_budget, ..
                } if child_session_id == &child && *saved_role == role && saved_budget == &expected)
                }));
            let entry = manager.agents.get(&child).unwrap().unwrap();
            assert_eq!(entry.subagent.as_ref().unwrap().budget, expected);
            assert!(entry.try_acquire_driver().unwrap());
            manager
                .sessions
                .begin_turn_step(
                    &child,
                    "fleet-budget-turn".into(),
                    "fleet-budget-step".into(),
                )
                .unwrap();
            let calls = (0..40).map(|index| super::super::super::ModelToolCall {
                call_id: format!("fleet-plan-{index}"),
                provider_call_id: None,
                name: "update_plan".into(),
                arguments: json!({"steps": [{"id": "progress", "title": format!("Fleet progress {index}"), "status": "inProgress"}]}),
            }).collect();
            let result = manager
                .tools
                .process_model_calls(
                    &entry,
                    "fleet-budget-turn",
                    "fleet-budget-step",
                    "fleet-budget-request",
                    calls,
                )
                .await;
            if expected.max_tool_calls.is_some() {
                assert!(
                    result
                        .unwrap_err()
                        .starts_with("subagentToolBudgetExceeded:"),
                    "{role:?}"
                );
            } else {
                assert_eq!(
                    result.unwrap(),
                    super::super::super::ToolPipelineSettlement::Completed
                );
            }
            let events = manager.sessions.all_events(&child).unwrap();
            let admitted = expected.max_tool_calls.unwrap_or(40);
            assert_eq!(
                super::super::super::tool_pipeline::admitted_tool_calls(&events),
                admitted
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(
                        event.payload,
                        AgentSessionEventPayload::ToolResult {
                            status: AgentToolResultStatus::Completed,
                            ..
                        }
                    ))
                    .count(),
                admitted as usize
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(&event.payload,
                        AgentSessionEventPayload::ToolResult {
                            status: AgentToolResultStatus::Rejected, data: Some(data), ..
                        } if data["schedulerAdmission"] == "notStarted"
                            && data["reason"] == "subagentToolBudgetExceeded"
                    ))
                    .count(),
                (40 - admitted) as usize
            );
            assert_eq!(
                manager
                    .sessions
                    .snapshot(&child)
                    .unwrap()
                    .task
                    .plan
                    .unwrap()
                    .version,
                u64::from(admitted)
            );
            entry.release_driver();

            let reloaded = AgentSessionStore::default();
            reloaded.configure(root.path().to_path_buf()).unwrap();
            assert_eq!(
                reloaded
                    .snapshot(&child)
                    .unwrap()
                    .header
                    .subagent
                    .unwrap()
                    .budget,
                expected
            );
            assert_eq!(
                super::super::super::tool_pipeline::admitted_tool_calls(
                    &reloaded.all_events(&child).unwrap()
                ),
                admitted
            );
        }
    }
}
