#[test]
fn terminal_reconnect_preserves_conversation_and_replays_the_new_target() {
    let (root, store) = configured();
    // Use a real persisted target Session, with explicit project boundaries.
    let request = CreateAgentSessionRequest {
        session_id: "reconnect-agent".into(),
        task_id: "reconnect-task".into(),
        goal: "Inspect the project".into(),
        parent_session_id: None,
        continued_from_session_id: None,
        target: Some(target()),
        permission_mode: Some(AgentSessionPermissionMode::Operator),
        execution_surface: AgentExecutionSurface::Direct,
        success_criteria: vec![],
        capability_scope: None,
        subagent: None,
    };
    store.create(request).unwrap();
    let before = store.snapshot("reconnect-agent").unwrap();
    assert_eq!(
        store
            .scratch_ownership_target("reconnect-agent", &target())
            .unwrap(),
        target()
    );
    let replacement = AgentSessionTarget {
        session_id: "terminal-2".into(),
        target_id: "target-2".into(),
        ..target()
    };
    let after = store
        .reconnect_terminal("reconnect-agent", "terminal-1", replacement.clone())
        .unwrap();
    assert_eq!(after.header.session_id, before.header.session_id);
    assert_eq!(after.header.task_id, before.header.task_id);
    assert_eq!(after.header.goal, before.header.goal);
    assert_eq!(after.header.target, Some(replacement.clone()));
    assert_eq!(
        store
            .scratch_ownership_target("reconnect-agent", &replacement)
            .unwrap(),
        target()
    );
    assert!(store
        .scratch_ownership_target("reconnect-agent", &target())
        .is_err());
    assert_eq!(
        after.header.permission_mode,
        Some(AgentSessionPermissionMode::RequestApproval)
    );
    assert_eq!(after.event_count, before.event_count + 1);
    assert_eq!(after.inbox, before.inbox);
    assert_eq!(after.status, before.status);
    assert!(after.surface.messages.iter().any(|message| matches!(message,
        AgentSurfaceMessage::User { content, .. } if content.contains("Never replay a previous command"))));
    assert_eq!(
        store
            .reconnect_terminal("reconnect-agent", "terminal-1", replacement)
            .unwrap(),
        after
    );
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(restored.snapshot("reconnect-agent").unwrap(), after);
    assert_eq!(
        restored
            .scratch_ownership_target("reconnect-agent", after.header.target.as_ref().unwrap())
            .unwrap(),
        target()
    );
}

#[test]
fn terminal_reconnect_and_continue_preserve_unfinished_task_plan_on_disk() {
    use crate::agent_runtime::{AgentPlanStep, AgentPlanStepStatus};

    let (root, store) = configured();
    store
        .create(CreateAgentSessionRequest {
            session_id: "reconnect-plan".into(),
            task_id: "reconnect-plan-task".into(),
            goal: "Inspect and verify the project".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: Some(target()),
            permission_mode: Some(AgentSessionPermissionMode::Operator),
            execution_surface: AgentExecutionSurface::Direct,
            success_criteria: vec![],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    store
        .enqueue(
            "reconnect-plan",
            AgentInboxLane::NextTurn,
            message("inspect-input", "Inspect and verify the project"),
        )
        .unwrap();
    store
        .begin_turn_step("reconnect-plan", "turn-1".into(), "step-1".into())
        .unwrap()
        .unwrap();
    let steps = vec![
        AgentPlanStep {
            id: "inspect".into(),
            title: "Inspect the project".into(),
            status: AgentPlanStepStatus::Completed,
            detail: None,
            evidence_refs: Vec::new(),
        },
        AgentPlanStep {
            id: "verify".into(),
            title: "Verify the result".into(),
            status: AgentPlanStepStatus::InProgress,
            detail: Some("Check current state after reconnect".into()),
            evidence_refs: Vec::new(),
        },
    ];
    store
        .append(
            "reconnect-plan",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::TaskPlan {
                version: 3,
                steps: steps.clone(),
            },
        )
        .unwrap();
    store
        .pause_for_input("reconnect-plan", "terminalTargetUnavailable")
        .unwrap();
    let failed = store
        .end(
            "reconnect-plan",
            AgentSessionStatus::Failed,
            Some("terminalTargetUnavailable".into()),
        )
        .unwrap();
    let plan = failed.task.plan.unwrap();
    assert_eq!(plan.version, 3);
    assert_eq!(plan.steps, steps);

    let replacement = AgentSessionTarget {
        session_id: "terminal-2".into(),
        target_id: "target-2".into(),
        ..target()
    };
    let rebound = store
        .reconnect_terminal("reconnect-plan", "terminal-1", replacement.clone())
        .unwrap();
    assert_eq!(rebound.task.plan.as_ref(), Some(&plan));
    store.resume("reconnect-plan").unwrap();
    store
        .enqueue(
            "reconnect-plan",
            AgentInboxLane::NextTurn,
            message("continue-input", "继续"),
        )
        .unwrap();
    store
        .begin_turn_step("reconnect-plan", "turn-2".into(), "step-2".into())
        .unwrap()
        .unwrap();
    let continued = store.snapshot("reconnect-plan").unwrap();
    assert_eq!(continued.task.plan.as_ref(), Some(&plan));
    assert_eq!(continued.header.target, Some(replacement));
    assert_eq!(
        continued.header.permission_mode,
        Some(AgentSessionPermissionMode::RequestApproval)
    );
    let restored = AgentSessionStore::default();
    restored.configure(root.path().into()).unwrap();
    assert_eq!(
        restored.snapshot("reconnect-plan").unwrap().task.plan,
        Some(plan)
    );
    store
        .append(
            "reconnect-plan",
            Some("turn-2".into()),
            Some("step-2".into()),
            AgentSessionEventPayload::TaskPlan {
                version: 4,
                steps: Vec::new(),
            },
        )
        .unwrap();
    assert!(store
        .snapshot("reconnect-plan")
        .unwrap()
        .task
        .plan
        .is_some_and(|plan| plan.version == 4 && plan.steps.is_empty()));
}

#[test]
fn terminal_reconnect_rejects_pending_work_and_changed_roots_without_mutation() {
    let (_root, store) = configured();
    store
        .create(CreateAgentSessionRequest {
            session_id: "reconnect-agent".into(),
            task_id: "reconnect-task".into(),
            goal: "Inspect the project".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: Some(target()),
            permission_mode: None,
            execution_surface: AgentExecutionSurface::Direct,
            success_criteria: vec![],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    let before = store.snapshot("reconnect-agent").unwrap();
    let replacement = AgentSessionTarget {
        session_id: "terminal-2".into(),
        target_id: "target-2".into(),
        ..target()
    };
    let changed_root = AgentSessionTarget {
        cwd: Some("/other".into()),
        ..replacement.clone()
    };
    assert!(store
        .reconnect_terminal("reconnect-agent", "terminal-1", changed_root)
        .is_err());
    assert!(store
        .reconnect_terminal("reconnect-agent", "unrelated", replacement.clone())
        .is_err());
    assert_eq!(store.snapshot("reconnect-agent").unwrap(), before);
    store
        .enqueue(
            "reconnect-agent",
            AgentInboxLane::NextTurn,
            message("pending", "Inspect current state"),
        )
        .unwrap();
    let pending = store.snapshot("reconnect-agent").unwrap();
    assert!(store
        .reconnect_terminal("reconnect-agent", "terminal-1", replacement.clone())
        .is_err());
    assert_eq!(store.snapshot("reconnect-agent").unwrap(), pending);
    store.cancel("reconnect-agent").unwrap();
    let cancelled = store.snapshot("reconnect-agent").unwrap();
    let rebound = store
        .reconnect_terminal("reconnect-agent", "terminal-1", replacement.clone())
        .unwrap();
    assert_eq!(rebound.status, cancelled.status);
    assert!(rebound.ended);
    assert_eq!(rebound.header.session_id, cancelled.header.session_id);
    store.resume("reconnect-agent").unwrap();
    store
        .append(
            "reconnect-agent",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    let running = store.snapshot("reconnect-agent").unwrap();
    assert!(store
        .reconnect_terminal(
            "reconnect-agent",
            "terminal-2",
            AgentSessionTarget {
                session_id: "terminal-3".into(),
                target_id: "target-3".into(),
                ..replacement
            }
        )
        .is_err());
    assert_eq!(store.snapshot("reconnect-agent").unwrap(), running);
}

#[test]
fn terminal_reconnect_preserves_pinned_filesystem_scope_for_paths_and_skills() {
    use crate::agent_runtime::{file_references, skill_runtime};
    use std::time::{Duration, Instant};
    use tokio_util::sync::CancellationToken;

    let (storage, store) = configured();
    let project = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(project.path()).unwrap();
    let original = AgentSessionTarget {
        cwd: Some(path.to_str().unwrap().into()),
        local_root: None,
        ..target()
    };
    store
        .create(CreateAgentSessionRequest {
            session_id: "reconnect-files".into(),
            task_id: "reconnect-files-task".into(),
            goal: "Inspect the current project".into(),
            target: Some(original.clone()),
            parent_session_id: None,
            continued_from_session_id: None,
            permission_mode: None,
            execution_surface: AgentExecutionSurface::Direct,
            success_criteria: vec![],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    let read_paths = |target, expected_scope| {
        file_references::read_local(file_references::FileReferenceRequest {
            target,
            expected_scope,
            query: String::new(),
            cancellation: CancellationToken::new(),
            deadline: Instant::now() + Duration::from_secs(4),
        })
    };
    let before = read_paths(original.clone(), None);
    assert_eq!(before.status, "ready");
    let pinned = before.scope.unwrap();
    store
        .append(
            "reconnect-files",
            None,
            None,
            AgentSessionEventPayload::FileReferenceScopeBound {
                scope: pinned.clone(),
            },
        )
        .unwrap();
    let replacement = AgentSessionTarget {
        session_id: "terminal-2".into(),
        target_id: "target-2".into(),
        ..original
    };
    store
        .reconnect_terminal("reconnect-files", "terminal-1", replacement.clone())
        .unwrap();
    let scope = file_references::current_bound_scope(&store.all_events("reconnect-files").unwrap())
        .unwrap();
    assert_eq!(scope.root, pinned.root);
    assert_eq!(scope.root_identity, pinned.root_identity);
    assert_eq!(scope.target, replacement);
    assert_eq!(
        read_paths(replacement.clone(), Some(scope.clone())).status,
        "ready"
    );
    let skills = skill_runtime::read_local(skill_runtime::SkillReadRequest {
        target: replacement,
        expected_scope: Some(scope.clone()),
        cancellation: CancellationToken::new(),
    });
    assert_eq!(skills.observation.snapshot.as_ref().unwrap().scope, scope);
    store
        .append(
            "reconnect-files",
            None,
            None,
            AgentSessionEventPayload::SkillCatalogObserved {
                observation: skills.observation,
            },
        )
        .unwrap();
    let mut changed = scope;
    changed.root_identity.push_str("-changed");
    assert!(store
        .append(
            "reconnect-files",
            None,
            None,
            AgentSessionEventPayload::FileReferenceScopeBound { scope: changed }
        )
        .is_err());
    let restored = AgentSessionStore::default();
    restored.configure(storage.path().into()).unwrap();
    assert_eq!(
        restored.snapshot("reconnect-files").unwrap(),
        store.snapshot("reconnect-files").unwrap()
    );
}

#[test]
fn terminal_reconnect_settles_orphaned_interrupted_model_stream_without_replay() {
    let (_storage, store) = configured();
    store
        .create(CreateAgentSessionRequest {
            session_id: "reconnect-interrupted".into(),
            task_id: "task-interrupted".into(),
            goal: "Inspect SSH files".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: Some(target()),
            permission_mode: Some(AgentSessionPermissionMode::Operator),
            execution_surface: AgentExecutionSurface::BoundTerminal,
            success_criteria: vec![],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    let request_snapshot = crate::llm::runtime::RequestSnapshot::Prepared {
        route_id: "route-1".into(),
        route_revision: 1,
        adapter_id: "chat-completions".into(),
        model_id: "model-1".into(),
        catalog_version: 1,
        capabilities: crate::llm::catalog::fixture_definition(
            crate::llm::config::AiProviderKind::OpenAiCompatible,
            8192,
        ),
        endpoint_identity: "https://example.test/v1/chat/completions".into(),
        replay_domain_id: "domain-1".into(),
        reasoning_effort: None,
        output_tokens: 8192,
        retry_policy: Default::default(),
        timeouts: Default::default(),
        purpose: "step".into(),
        preparation_version: 1,
        projection_policy: "immutable-png-v1-strict".into(),
        content_hash: crate::llm::runtime::digest(b"request"),
        images: Vec::new(),
    };
    let series = super::super::AgentRequestSeries {
        series_id: "series-1".into(),
        request_index: 0,
        starts_series: true,
    };
    store
        .append_batch(
            "reconnect-interrupted",
            vec![
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: None,
                    payload: AgentSessionEventPayload::TurnStart,
                },
                AgentScopedPayload {
                    turn_id: None,
                    step_id: None,
                    payload: AgentSessionEventPayload::AgentStatus {
                        status: AgentSessionStatus::Running,
                        reason: None,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::StepStart,
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::RequestHeader {
                        request_id: "req-1".into(),
                        snapshot: request_snapshot.clone(),
                        snapshot_digest: request_snapshot.digest(),
                        provider_id: "route-1".into(),
                        model: "model-1".into(),
                        reasoning_effort: None,
                        reason: super::super::AgentRequestReason::Initial,
                        series: series.clone(),
                        snapshot_reason: super::super::AgentRequestSnapshotReason::Initial,
                        system_prompt: "system".into(),
                        tool_schemas: Vec::new(),
                        attempt: 1,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::RequestStart {
                        request_id: "req-1".into(),
                        header_request_id: "req-1".into(),
                        provider_id: "route-1".into(),
                        model: "model-1".into(),
                        reasoning_effort: None,
                        reason: super::super::AgentRequestReason::Initial,
                        series,
                        attempt: 1,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::AssistantChunk {
                        request_id: "req-1".into(),
                        text_delta: Some("Partial response before restart".into()),
                        reasoning_delta: None,
                        tool_call_delta: None,
                        usage: None,
                    },
                },
            ],
        )
        .unwrap();
    let replacement = AgentSessionTarget {
        session_id: "terminal-2".into(),
        target_id: "target-2".into(),
        ..target()
    };
    let rebound = store
        .reconnect_terminal_settling_orphaned_turn(
            "reconnect-interrupted",
            "terminal-1",
            replacement.clone(),
        )
        .unwrap();
    assert_eq!(rebound.header.target, Some(replacement));
    assert_eq!(rebound.status, AgentSessionStatus::Failed);
    assert!(rebound.ended);
    assert_eq!(
        rebound.header.permission_mode,
        Some(AgentSessionPermissionMode::RequestApproval)
    );
    let resumed = store.resume("reconnect-interrupted").unwrap();
    assert!(!resumed.ended);
    assert_eq!(resumed.status, AgentSessionStatus::Idle);
}

#[test]
fn terminal_reconnect_does_not_settle_orphaned_turn_with_in_flight_execution() {
    let (_storage, store) = configured();
    store
        .create(CreateAgentSessionRequest {
            session_id: "reconnect-inflight".into(),
            task_id: "task-inflight".into(),
            goal: "Run command".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: Some(target()),
            permission_mode: Some(AgentSessionPermissionMode::Operator),
            execution_surface: AgentExecutionSurface::BoundTerminal,
            success_criteria: vec![],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    store
        .append_batch(
            "reconnect-inflight",
            vec![
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: None,
                    payload: AgentSessionEventPayload::TurnStart,
                },
                AgentScopedPayload {
                    turn_id: None,
                    step_id: None,
                    payload: AgentSessionEventPayload::AgentStatus {
                        status: AgentSessionStatus::Running,
                        reason: None,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::StepStart,
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::ToolCall {
                        call: super::super::RecordedToolCall {
                            call_id: "call-1".into(),
                            provider_call_id: None,
                            name: "run_terminal_command".into(),
                            native_name: Some("run_terminal_command".into()),
                            arguments: serde_json::json!({"command": "touch /tmp/x"}),
                            title: None,
                            effect: Some(super::super::AgentSessionEffect::ExternalSideEffect),
                            target: None,
                        },
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::ToolApproval {
                        request_id: "approval-1".into(),
                        call_id: "call-1".into(),
                        approval_id: None,
                        status: super::super::AgentToolApprovalStatus::Approved,
                        risk: Some(super::super::AgentSessionEffect::ExternalSideEffect),
                        reason: None,
                        expires_at_unix_ms: None,
                        prompt: None,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::ToolExecution {
                        call_id: "call-1".into(),
                        status: super::super::AgentToolExecutionStatus::Dispatched,
                        idempotency: "no".into(),
                    },
                },
            ],
        )
        .unwrap();
    let before = store.snapshot("reconnect-inflight").unwrap();
    let replacement = AgentSessionTarget {
        session_id: "terminal-2".into(),
        target_id: "target-2".into(),
        ..target()
    };
    let error = store
        .reconnect_terminal_settling_orphaned_turn("reconnect-inflight", "terminal-1", replacement)
        .unwrap_err();
    assert!(
        error.starts_with("TERMINAL_RECONNECT_RECOVERY_REQUIRED:"),
        "unexpected error: {error}"
    );
    assert_eq!(store.snapshot("reconnect-inflight").unwrap(), before);
}
