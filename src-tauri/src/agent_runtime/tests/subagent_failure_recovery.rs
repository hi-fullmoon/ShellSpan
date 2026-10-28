// Real Session storage, filesystem writes and a real refused HTTP connection.
// No model responses or native execution runtimes are substituted.
#[derive(Default)]
struct RecoveryStreamRecorder(Mutex<Vec<super::super::StreamDelta>>);

impl super::super::ModelStreamSink for RecoveryStreamRecorder {
    fn emit(
        &self,
        delta: super::super::StreamDelta,
    ) -> Result<(), super::super::NormalizedModelError> {
        self.0.lock().unwrap().push(delta);
        Ok(())
    }
}

fn child_retry_request() -> AgentChildRetryRequest {
    AgentChildRetryRequest {
        parent_session_id: "lifecycle-parent".into(),
        child_session_id: "lifecycle-child".into(),
        turn_id: "failure-turn".into(),
        content: None,
    }
}

async fn record_child_failure(
    root: &std::path::Path,
    manager: &SubAgentManager,
    entry: &AgentEntry,
    commit_result: bool,
) -> super::super::RecordedToolCall {
    let sessions = &manager.sessions;
    let append = |turn: Option<&str>, step: Option<&str>, payload| {
        sessions
            .append(
                &entry.session_id,
                turn.map(str::to_owned),
                step.map(str::to_owned),
                payload,
            )
            .unwrap();
    };
    append(
        None,
        None,
        AgentSessionEventPayload::AgentStatus {
            status: AgentSessionStatus::Running,
            reason: None,
        },
    );
    append(
        Some("failure-turn"),
        None,
        AgentSessionEventPayload::TurnStart,
    );
    append(
        Some("failure-turn"),
        Some("write-step"),
        AgentSessionEventPayload::StepStart,
    );
    append(
        Some("failure-turn"),
        Some("write-step"),
        AgentSessionEventPayload::TaskPlan {
            version: 1,
            steps: vec![
                super::super::AgentPlanStep {
                    id: "write-progress".into(),
                    title: "Save progress".into(),
                    status: super::super::AgentPlanStepStatus::Completed,
                    detail: None,
                    evidence_refs: Vec::new(),
                },
                super::super::AgentPlanStep {
                    id: "inspect-progress".into(),
                    title: "Inspect saved progress".into(),
                    status: super::super::AgentPlanStepStatus::Pending,
                    detail: None,
                    evidence_refs: Vec::new(),
                },
            ],
        },
    );
    let path = root.join("completed-operation.txt");
    let call = super::super::RecordedToolCall {
        call_id: "completed-write".into(),
        provider_call_id: None,
        name: "write_file".into(),
        native_name: Some("write_file".into()),
        arguments: json!({ "path": path, "content": "saved progress\n", "explanation": "save current work" }),
        title: None,
        effect: Some(AgentSessionEffect::StateChange),
        target: sessions.snapshot(&entry.session_id).unwrap().header.target,
    };
    append(
        Some("failure-turn"),
        Some("write-step"),
        AgentSessionEventPayload::ToolCall { call: call.clone() },
    );
    append(
        Some("failure-turn"),
        Some("write-step"),
        AgentSessionEventPayload::ToolApproval {
            request_id: "temporary-directory-write".into(),
            call_id: call.call_id.clone(),
            approval_id: None,
            status: super::super::AgentToolApprovalStatus::Approved,
            risk: call.effect,
            reason: Some("testOwnsTemporaryDirectory".into()),
            expires_at_unix_ms: None,
            prompt: None,
        },
    );
    append(
        Some("failure-turn"),
        Some("write-step"),
        AgentSessionEventPayload::ToolExecution {
            call_id: call.call_id.clone(),
            status: super::super::AgentToolExecutionStatus::Dispatched,
            idempotency: "no".into(),
        },
    );
    std::fs::write(&path, "saved progress\n").unwrap();
    if commit_result {
        append(
            Some("failure-turn"),
            Some("write-step"),
            AgentSessionEventPayload::ToolResult {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                status: AgentToolResultStatus::Completed,
                summary: format!("Wrote {} bytes", std::fs::metadata(&path).unwrap().len()),
                data: None,
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
        );
    }
    append(
        Some("failure-turn"),
        Some("write-step"),
        AgentSessionEventPayload::StepEnd {
            reason: "toolsCompleted".into(),
        },
    );
    append(
        Some("failure-turn"),
        Some("model-step"),
        AgentSessionEventPayload::StepStart,
    );
    if std::env::var_os("SHELLSPAN_CHILD_RECOVERY_REVIEW").is_some() {
        std::fs::write(
            root.join("running-snapshot.json"),
            serde_json::to_vec(&sessions.snapshot(&entry.session_id).unwrap()).unwrap(),
        )
        .unwrap();
    }
    // Hold a real bound socket without listening. The OS refuses connections;
    // no HTTP server fabricates an error or a model response.
    let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::STREAM, None).unwrap();
    socket
        .bind(&std::net::SocketAddr::from(([127, 0, 0, 1], 0)).into())
        .unwrap();
    let endpoint = socket.local_addr().unwrap().as_socket().unwrap();
    let mut provider = entry.model().unwrap().provider;
    provider.base_url = format!("http://{endpoint}");
    let adapter = manager.models.resolve(provider, None).unwrap();
    let snapshot = sessions.snapshot(&entry.session_id).unwrap();
    let request = super::super::ModelRequest::from_surface(
        "connection-failure".into(),
        &snapshot.surface,
        String::new(),
        Vec::new(),
    );
    let failure = adapter
        .stream(
            request,
            CancellationToken::new(),
            Arc::new(RecoveryStreamRecorder::default()),
        )
        .await
        .unwrap_err();
    assert!(
        failure.retryable(),
        "Actual connection failure must be recoverable: {failure:?}"
    );
    append(
        Some("failure-turn"),
        Some("model-step"),
        AgentSessionEventPayload::RequestFailure {
            request_id: "connection-failure".into(),
            attempt: 1,
            max_attempts: 1,
            cumulative_delay_ms: 0,
            interrupted: false,
            failure,
        },
    );
    append(
        Some("failure-turn"),
        Some("model-step"),
        AgentSessionEventPayload::StepEnd {
            reason: "providerFailure".into(),
        },
    );
    append(
        Some("failure-turn"),
        None,
        AgentSessionEventPayload::TurnEnd {
            reason: "providerFailure".into(),
        },
    );
    sessions
        .terminate(
            &entry.session_id,
            AgentSessionStatus::Failed,
            "providerFailure".into(),
        )
        .unwrap();
    call
}

#[tokio::test]
async fn child_failure_recovery_preserves_progress_budgets_and_durable_identity() {
    let (root, manager, entry) = setup();
    let call = record_child_failure(root.path(), &manager, &entry, true).await;
    let before = manager.sessions.snapshot(&entry.session_id).unwrap();
    assert_eq!(
        before.child_failure_recovery.as_ref().unwrap().turn_id,
        "failure-turn"
    );
    let before_metrics = manager.sessions.driver_metrics(&entry.session_id).unwrap();
    let request = child_retry_request();
    let recovered = manager.sessions.retry_child_failure(&request, 64).unwrap();
    assert_eq!(recovered.header, before.header);
    assert_eq!(recovered.surface, before.surface);
    assert_eq!(recovered.task.plan, before.task.plan);
    assert!(!recovered.ended);
    assert_eq!(recovered.status, AgentSessionStatus::Idle);
    assert_eq!(recovered.inbox.next_turn.len(), 1);
    let metrics = manager.sessions.driver_metrics(&entry.session_id).unwrap();
    assert_eq!(
        (metrics.started_turns, metrics.model_tokens),
        (before_metrics.started_turns, before_metrics.model_tokens)
    );
    assert_eq!(
        manager.sessions.retry_child_failure(&request, 64).unwrap(),
        recovered
    );
    assert!(manager
        .sessions
        .retry_child_failure(
            &AgentChildRetryRequest {
                content: Some("Replace the admitted recovery instructions".into()),
                ..request.clone()
            },
            64
        )
        .is_err());
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(restored.snapshot(&entry.session_id).unwrap(), recovered);
    restored.pause_restored_inputs().unwrap();
    assert_eq!(
        restored
            .snapshot(&entry.session_id)
            .unwrap()
            .inbox
            .paused_ids
            .len(),
        1
    );
    let resumed = restored.retry_child_failure(&request, 64).unwrap();
    assert!(resumed.inbox.paused_ids.is_empty());
    assert_eq!(resumed.inbox.next_turn.len(), 1);
    assert_eq!(
        std::fs::read_to_string(root.path().join("completed-operation.txt")).unwrap(),
        "saved progress\n"
    );
    let events = restored.all_events(&entry.session_id).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.payload,
                AgentSessionEventPayload::SubagentRecoveryStarted { .. }
            ))
            .count(),
        1
    );
    assert_eq!(events.iter().filter(|event| matches!(&event.payload, AgentSessionEventPayload::ToolCall { call: saved } if saved.call_id == call.call_id)).count(), 1);
    restored
        .begin_turn_step(&entry.session_id, "next-turn".into(), "next-step".into())
        .unwrap();
    let consumed = restored.snapshot(&entry.session_id).unwrap();
    assert_eq!(
        restored.retry_child_failure(&request, 64).unwrap(),
        consumed
    );

    // Optional export for browser QA uses the actual refused-connection ledger.
    if let Some(directory) = std::env::var_os("SHELLSPAN_CHILD_RECOVERY_REVIEW") {
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::copy(
            root.path().join("running-snapshot.json"),
            directory.join("running-snapshot.json"),
        )
        .unwrap();
        std::fs::write(
            directory.join("failed-snapshot.json"),
            serde_json::to_vec(&before).unwrap(),
        )
        .unwrap();
        let events = manager.sessions.all_events(&entry.session_id).unwrap();
        let failed = &events[..before.event_count as usize];
        std::fs::write(
            directory.join("failed-events.json"),
            serde_json::to_vec(failed).unwrap(),
        )
        .unwrap();
        std::fs::write(
            directory.join("admitted-events.json"),
            serde_json::to_vec(&events).unwrap(),
        )
        .unwrap();
        std::fs::write(
            directory.join("admitted-snapshot.json"),
            serde_json::to_vec(&recovered).unwrap(),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn child_failure_recovery_blocks_unknown_effects_wrong_owner_and_stale_turn() {
    let (root, manager, entry) = setup();
    record_child_failure(root.path(), &manager, &entry, false).await;
    let before = manager.sessions.snapshot(&entry.session_id).unwrap();
    assert!(before.uncertain_native_effects);
    assert!(before.child_failure_recovery.is_none());
    assert!(manager
        .sessions
        .retry_child_failure(&child_retry_request(), 64)
        .is_err());
    assert_eq!(
        manager.sessions.snapshot(&entry.session_id).unwrap(),
        before
    );

    let (root, manager, entry) = setup();
    record_child_failure(root.path(), &manager, &entry, true).await;
    for request in [
        AgentChildRetryRequest {
            parent_session_id: "unrelated-parent".into(),
            ..child_retry_request()
        },
        AgentChildRetryRequest {
            turn_id: "stale-turn".into(),
            ..child_retry_request()
        },
    ] {
        let before = manager.sessions.snapshot(&entry.session_id).unwrap();
        assert!(manager.sessions.retry_child_failure(&request, 64).is_err());
        assert_eq!(
            manager.sessions.snapshot(&entry.session_id).unwrap(),
            before
        );
    }
}

#[tokio::test]
async fn child_failure_recovery_does_not_reset_exhausted_turn_tool_or_time_budgets() {
    for budget in [
        AgentSubagentBudget {
            max_turns: 1,
            ..default_subagent_budget()
        },
        AgentSubagentBudget {
            max_tool_calls: Some(1),
            ..default_subagent_budget()
        },
        AgentSubagentBudget {
            timeout_ms: 1_000,
            ..default_subagent_budget()
        },
    ] {
        let timeout_ms = budget.timeout_ms;
        let (root, manager, entry) = setup_with_budget(budget);
        record_child_failure(root.path(), &manager, &entry, true).await;
        if timeout_ms == 1_000 {
            tokio::time::sleep(std::time::Duration::from_millis(timeout_ms + 1)).await;
        }
        let before = manager.sessions.snapshot(&entry.session_id).unwrap();
        assert!(manager
            .sessions
            .retry_child_failure(&child_retry_request(), 64)
            .is_err());
        assert_eq!(
            manager.sessions.snapshot(&entry.session_id).unwrap(),
            before
        );
    }
}

#[tokio::test]
async fn child_recovery_rejects_completed_writes_with_new_call_ids_but_allows_observation() {
    let (root, manager, entry) = setup();
    let mut call = record_child_failure(root.path(), &manager, &entry, true).await;
    manager
        .sessions
        .retry_child_failure(&child_retry_request(), 64)
        .unwrap();
    manager
        .sessions
        .begin_turn_step(
            &entry.session_id,
            "recovery-turn".into(),
            "recovery-step".into(),
        )
        .unwrap();
    let events = manager.sessions.all_events(&entry.session_id).unwrap();
    call.call_id = "new-model-call".into();
    call.arguments["explanation"] = "continue work after a connection error".into();
    assert!(super::super::child_recovery::completed_recovery_operation(
        &events,
        "recovery-turn",
        &call
    )
    .is_some());
    call.effect = Some(AgentSessionEffect::ReadOnly);
    assert!(super::super::child_recovery::completed_recovery_operation(
        &events,
        "recovery-turn",
        &call
    )
    .is_none());
    call.effect = Some(AgentSessionEffect::StateChange);
    call.arguments["content"] = "new unfinished work".into();
    assert!(super::super::child_recovery::completed_recovery_operation(
        &events,
        "recovery-turn",
        &call
    )
    .is_none());
    assert!(super::super::child_recovery::completed_recovery_operation(
        &events,
        "unrelated-turn",
        &call
    )
    .is_none());
}

#[tokio::test]
async fn child_failure_recovery_respects_durable_cancellation_even_after_recreating_the_manager() {
    let (root, manager, entry) = setup();
    record_child_failure(root.path(), &manager, &entry, true).await;
    let handle = manager
        .handles
        .lock()
        .unwrap()
        .remove(&entry.session_id)
        .unwrap();
    handle.dispose().await.unwrap();
    manager.cancel_tree(&entry.session_id).await.unwrap();
    let restored_sessions = AgentSessionStore::default();
    restored_sessions
        .configure(root.path().to_path_buf())
        .unwrap();
    let recreated = SubAgentManager::new(
        restored_sessions,
        manager.agents.clone(),
        manager.models.clone(),
        manager.hooks.clone(),
        manager.tools.clone(),
        manager.compactions.clone(),
        manager.driver_config,
    );
    assert!(recreated
        .retry_child(child_retry_request())
        .await
        .unwrap_err()
        .contains("respect the cancellation"));
    assert_eq!(
        std::fs::read_to_string(root.path().join("completed-operation.txt")).unwrap(),
        "saved progress\n"
    );
}

#[tokio::test]
async fn child_failure_recovery_attaches_a_fresh_driver_without_replaying_completed_execution() {
    let (root, mut manager, entry) = setup();
    let call = record_child_failure(root.path(), &manager, &entry, true).await;
    manager.driver_config.retry_policy.max_attempts = 1;
    manager.driver_config.network_recovery_max_attempts = 1;
    manager.driver_config.network_recovery_window_ms = 0;
    let before = manager.sessions.snapshot(&entry.session_id).unwrap();
    manager.retry_child(child_retry_request()).await.unwrap();
    let fresh = manager.agents.get(&entry.session_id).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&entry, &fresh));
    assert!(entry.cancellation().is_cancelled());
    assert!(!fresh.cancellation().is_cancelled());
    tokio::time::timeout(std::time::Duration::from_secs(20), fresh.await_idle())
        .await
        .unwrap();
    let after = manager.sessions.snapshot(&entry.session_id).unwrap();
    assert_eq!(after.header, before.header);
    let events = manager.sessions.all_events(&entry.session_id).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == &call.call_id))
            .count(),
        1
    );
    assert!(events.iter().any(|event| matches!(
        event.payload,
        AgentSessionEventPayload::SubagentRecoveryStarted { .. }
    )));
    assert_eq!(
        manager.retry_child(child_retry_request()).await.unwrap(),
        after
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("completed-operation.txt")).unwrap(),
        "saved progress\n"
    );
}
