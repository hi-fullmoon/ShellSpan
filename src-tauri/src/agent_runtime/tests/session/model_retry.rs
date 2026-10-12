fn close_model_retry_test_turn(
    store: &AgentSessionStore,
    failure: super::super::model::NormalizedModelError,
) {
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::RequestFailure {
                request_id: "request-1".into(),
                attempt: 1,
                max_attempts: 1,
                cumulative_delay_ms: 0,
                interrupted: false,
                failure,
            },
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::StepEnd {
                reason: "rateLimited".into(),
            },
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnEnd {
                reason: "rateLimited".into(),
            },
        )
        .unwrap();
    store
        .terminate(
            "session-1",
            AgentSessionStatus::Failed,
            "rateLimited".into(),
        )
        .unwrap();
}

#[test]
fn model_retry_admission_is_durable_and_never_duplicates_user_input() {
    let (root, store) = configured();
    create(&store);
    begin_prepared_request(&store);
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::UserMessage {
                message: message("original-question", "Which model are you?"),
            },
        )
        .unwrap();
    close_model_retry_test_turn(
        &store,
        super::super::model::NormalizedModelError::new(
            super::super::model::NormalizedModelErrorKind::RateLimited,
            "upstream capacity",
        ),
    );
    assert!(store
        .validate_model_retry("session-1", "stale-turn")
        .is_err());
    store.resume("session-1").unwrap();
    let admitted = store.retry_model_failure("session-1", "turn-1").unwrap();
    assert_eq!(admitted.inbox.next_turn.len(), 1);
    assert_eq!(
        admitted.inbox.next_turn[0].source.kind,
        super::super::AgentMessageSourceKind::Runtime
    );
    assert_eq!(
        store.retry_model_failure("session-1", "turn-1").unwrap(),
        admitted
    );
    store.claim("session-1", AgentInboxLane::NextTurn).unwrap();
    let consumed = store.snapshot("session-1").unwrap();
    assert!(consumed.inbox.next_turn.is_empty());
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restored.retry_model_failure("session-1", "turn-1").unwrap(),
        consumed
    );
    assert_eq!(
        restored
            .read_events("session-1", |events| events
                .iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::UserMessage { .. }
                ))
                .count())
            .unwrap(),
        1
    );
}

#[test]
fn model_retry_blocks_configuration_errors_cooldown_and_pending_inputs() {
    for code in [
        "insufficient_quota",
        "billing_hard_limit_reached",
        "content_policy_violation",
    ] {
        let (_root, store) = configured();
        create(&store);
        begin_prepared_request(&store);
        let mut failure = super::super::model::NormalizedModelError::new(
            super::super::model::NormalizedModelErrorKind::RateLimited,
            "rejected request",
        );
        failure.status = Some(429);
        failure.code = Some(code.into());
        close_model_retry_test_turn(&store, failure);
        let before = store.snapshot("session-1").unwrap();
        assert!(store.retry_model_failure("session-1", "turn-1").is_err());
        assert_eq!(store.snapshot("session-1").unwrap(), before);
    }
    for (kind, status, delay) in [
        (
            super::super::model::NormalizedModelErrorKind::Authentication,
            Some(401),
            None,
        ),
        (
            super::super::model::NormalizedModelErrorKind::Retryable,
            Some(402),
            None,
        ),
        (
            super::super::model::NormalizedModelErrorKind::ContextTooLarge,
            None,
            None,
        ),
        (
            super::super::model::NormalizedModelErrorKind::RateLimited,
            Some(429),
            Some(60_000),
        ),
    ] {
        let (_root, store) = configured();
        create(&store);
        begin_prepared_request(&store);
        let mut failure = super::super::model::NormalizedModelError::new(kind, "rejected request");
        failure.status = status;
        failure.retry_after_ms = delay;
        close_model_retry_test_turn(&store, failure);
        let before = store.snapshot("session-1").unwrap();
        assert!(store.retry_model_failure("session-1", "turn-1").is_err());
        assert_eq!(store.snapshot("session-1").unwrap(), before);
    }
    let (_root, store) = configured();
    create(&store);
    begin_prepared_request(&store);
    close_model_retry_test_turn(
        &store,
        super::super::model::NormalizedModelError::new(
            super::super::model::NormalizedModelErrorKind::Transport,
            "connection interrupted",
        ),
    );
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("later", "new question"),
        )
        .unwrap();
    assert!(store.retry_model_failure("session-1", "turn-1").is_err());
}

#[test]
fn model_retry_never_replays_a_turn_that_called_tools() {
    let (_root, store) = configured();
    create(&store);
    begin_prepared_request(&store);
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::ToolCall {
                call: RecordedToolCall {
                    call_id: "inspect-working-directory".into(),
                    provider_call_id: None,
                    name: "run_terminal_command".into(),
                    native_name: None,
                    arguments: serde_json::json!({"command":"pwd"}),
                    title: None,
                    effect: None,
                    target: None,
                },
            },
        )
        .unwrap();
    close_model_retry_test_turn(
        &store,
        super::super::model::NormalizedModelError::new(
            super::super::model::NormalizedModelErrorKind::Transport,
            "connection interrupted",
        ),
    );
    let before = store.snapshot("session-1").unwrap();
    assert!(store
        .retry_model_failure("session-1", "turn-1")
        .unwrap_err()
        .contains("MODEL_RETRY_VERIFY"));
    assert_eq!(store.snapshot("session-1").unwrap(), before);
}

#[test]
fn model_retry_explicitly_resumes_paused_input_after_restart_once() {
    let (root, store) = configured();
    create(&store);
    begin_prepared_request(&store);
    close_model_retry_test_turn(
        &store,
        super::super::model::NormalizedModelError::new(
            super::super::model::NormalizedModelErrorKind::Transport,
            "connection interrupted",
        ),
    );
    store.resume("session-1").unwrap();
    store.retry_model_failure("session-1", "turn-1").unwrap();
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    restored.pause_restored_inputs().unwrap();
    assert!(!restored.has_ready_input("session-1").unwrap());
    let paused = restored.snapshot("session-1").unwrap();
    assert_eq!(paused.inbox.paused_ids, vec!["model-retry-turn-1"]);
    let resumed = restored.retry_model_failure("session-1", "turn-1").unwrap();
    assert!(resumed.inbox.paused_ids.is_empty());
    assert!(restored.has_ready_input("session-1").unwrap());
    assert_eq!(
        restored.retry_model_failure("session-1", "turn-1").unwrap(),
        resumed
    );
    restored
        .claim("session-1", AgentInboxLane::NextTurn)
        .unwrap();
    let consumed = restored.snapshot("session-1").unwrap();
    assert_eq!(
        restored.retry_model_failure("session-1", "turn-1").unwrap(),
        consumed
    );
    assert!(!restored.has_ready_input("session-1").unwrap());
}

#[test]
fn model_retry_rejects_stale_paused_recovery_after_a_newer_turn() {
    let (_root, store) = configured();
    create(&store);
    begin_prepared_request(&store);
    close_model_retry_test_turn(
        &store,
        super::super::model::NormalizedModelError::new(
            super::super::model::NormalizedModelErrorKind::Transport,
            "connection interrupted",
        ),
    );
    store.resume("session-1").unwrap();
    store.retry_model_failure("session-1", "turn-1").unwrap();
    store.pause_restored_inputs().unwrap();
    store
        .append(
            "session-1",
            Some("newer-turn".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("newer-turn".into()),
            Some("newer-step".into()),
            AgentSessionEventPayload::StepStart,
        )
        .unwrap();
    assert!(store.retry_model_failure("session-1", "turn-1").is_err());
    store
        .append(
            "session-1",
            Some("newer-turn".into()),
            Some("newer-step".into()),
            AgentSessionEventPayload::StepEnd {
                reason: "completed".into(),
            },
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("newer-turn".into()),
            None,
            AgentSessionEventPayload::TurnEnd {
                reason: "completed".into(),
            },
        )
        .unwrap();
    let before = store.snapshot("session-1").unwrap();
    assert!(store.validate_model_retry("session-1", "turn-1").is_err());
    assert!(store.retry_model_failure("session-1", "turn-1").is_err());
    assert_eq!(store.snapshot("session-1").unwrap(), before);
    assert_eq!(before.inbox.paused_ids, vec!["model-retry-turn-1"]);
}
