fn running_steer_store() -> (tempfile::TempDir, AgentSessionStore) {
    let (root, store) = configured();
    create(&store);
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("initial", "initial"),
        )
        .unwrap();
    store
        .begin_turn_step("session-1", "turn-1".into(), "step-1".into())
        .unwrap();
    store
        .append(
            "session-1",
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Running,
                reason: None,
            },
        )
        .unwrap();
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("queued", "下一步\nfull content\n"),
        )
        .unwrap();
    (root, store)
}

fn steer_input(store: &AgentSessionStore, operation: &str) -> AgentInboxMutationInput {
    AgentInboxMutationInput {
        session_id: "session-1".into(),
        expected_revision: store.snapshot("session-1").unwrap().event_count,
        client_operation_id: operation.into(),
        mutation: AgentInboxMutation::Steer {
            item_id: "queued".into(),
        },
    }
}

#[test]
fn inbox_steer_preserves_identity_images_fifo_and_durable_receipt_after_consumption() {
    let (root, store) = running_steer_store();
    let mut attachment = message("with-image", "完整消息\nline two");
    attachment.client_submission_id = Some("original-submission".into());
    attachment.images.push(super::super::images::ImageRef {
        version: 1,
        sha256: "a".repeat(64),
        media_type: "image/png".into(),
        bytes: 100,
        width: 10,
        height: 10,
        name: "reference.png".into(),
    });
    store
        .enqueue("session-1", AgentInboxLane::NextTurn, attachment.clone())
        .unwrap();
    let existing = message("existing-step", "existing step");
    store
        .enqueue("session-1", AgentInboxLane::NextStep, existing.clone())
        .unwrap();
    let mut input = steer_input(&store, "steer-image");
    input.mutation = AgentInboxMutation::Steer {
        item_id: "with-image".into(),
    };
    let accepted = store.mutate_inbox(input.clone()).unwrap();
    assert_eq!(
        accepted.inbox.next_step,
        vec![existing.clone(), attachment.clone()]
    );
    assert_eq!(accepted.inbox.next_turn.len(), 1);
    assert_eq!(accepted.inbox.next_turn[0].message_id, "queued");
    assert_eq!(accepted.event_count, input.expected_revision + 1);
    assert_eq!(
        store.mutate_inbox(input.clone()).unwrap().event_count,
        accepted.event_count
    );
    let serialized =
        serde_json::to_value(store.all_events("session-1").unwrap().last().unwrap()).unwrap();
    assert_eq!(serialized["type"], "agent/inbox/item_steered");
    assert_eq!(serialized["data"]["itemId"], "with-image");
    let parsed: AgentSessionEvent = serde_json::from_value(serialized).unwrap();
    assert!(matches!(
        parsed.payload,
        AgentSessionEventPayload::InboxItemSteered { .. }
    ));

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(restarted.snapshot("session-1").unwrap(), accepted);
    let replay = AgentInbox::replay(&restarted.all_events("session-1").unwrap()).unwrap();
    assert_eq!(replay.next_step(), vec![existing, attachment.clone()]);
    let claimed = restarted
        .begin_continuation_step("session-1", "turn-1".into(), "step-2".into())
        .unwrap();
    assert_eq!(claimed.messages[1], attachment);
    assert!(restarted.claim_step("session-1").unwrap().is_empty());
    let after_claim = restarted.snapshot("session-1").unwrap();
    assert_eq!(restarted.mutate_inbox(input.clone()).unwrap(), after_claim);
    restarted.cancel("session-1").unwrap();
    restarted.archive("session-1").unwrap();
    let archived = restarted.snapshot("session-1").unwrap();
    assert_eq!(restarted.mutate_inbox(input.clone()).unwrap(), archived);
    let cold = AgentSessionStore::default();
    cold.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(cold.mutate_inbox(input).unwrap(), archived);
    assert_eq!(cold.all_events("session-1").unwrap().iter().filter(|event| matches!(
        &event.payload, AgentSessionEventPayload::UserMessage { message } if message.message_id == "with-image"
    )).count(), 1);
}

#[test]
fn inbox_steer_rejects_invalid_states_lanes_sources_and_revision_without_mutating() {
    for status in [AgentSessionStatus::Idle, AgentSessionStatus::Waiting] {
        let (_root, store) = running_steer_store();
        store
            .append(
                "session-1",
                None,
                None,
                AgentSessionEventPayload::AgentStatus {
                    status,
                    reason: None,
                },
            )
            .unwrap();
        let before = store.snapshot("session-1").unwrap();
        assert!(store
            .mutate_inbox(steer_input(&store, "bad-state"))
            .unwrap_err()
            .contains("running"));
        assert_eq!(store.snapshot("session-1").unwrap(), before);
    }
    let (_root, store) = running_steer_store();
    let mut bad_revision = steer_input(&store, "old-revision");
    bad_revision.expected_revision -= 1;
    assert!(store
        .mutate_inbox(bad_revision)
        .unwrap_err()
        .contains("revision conflict"));
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextStep,
            message("step-only", "step"),
        )
        .unwrap();
    let mut runtime = message("runtime", "context");
    runtime.source = AgentMessageSource::runtime("context".into());
    store
        .enqueue("session-1", AgentInboxLane::NextTurn, runtime)
        .unwrap();
    for (id, reason) in [
        ("step-only", "nextTurn"),
        ("runtime", "user message"),
        ("missing", "not found"),
    ] {
        let mut input = steer_input(&store, id);
        input.mutation = AgentInboxMutation::Steer { item_id: id.into() };
        let before = store.snapshot("session-1").unwrap();
        assert!(store.mutate_inbox(input).unwrap_err().contains(reason));
        assert_eq!(store.snapshot("session-1").unwrap(), before);
    }
    store.claim_turn("session-1").unwrap();
    assert!(store
        .mutate_inbox(steer_input(&store, "claimed"))
        .unwrap_err()
        .contains("no longer queued"));
    store.cancel("session-1").unwrap();
    assert!(store
        .mutate_inbox(steer_input(&store, "terminal"))
        .unwrap_err()
        .contains("terminal"));
    store.archive("session-1").unwrap();
    assert!(store
        .mutate_inbox(steer_input(&store, "archived"))
        .unwrap_err()
        .contains("archived"));
}

#[test]
fn inbox_steer_duplicate_operations_are_idempotent_and_payload_reuse_is_rejected() {
    let (_root, store) = running_steer_store();
    let input = steer_input(&store, "same-operation");
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            store.mutate_inbox(input.clone())
        });
        let second = scope.spawn(|| {
            barrier.wait();
            store.mutate_inbox(input.clone())
        });
        assert_eq!(
            first.join().unwrap().unwrap(),
            second.join().unwrap().unwrap()
        );
    });
    let mut duplicate_click = steer_input(&store, "different-operation");
    assert!(store
        .mutate_inbox(duplicate_click.clone())
        .unwrap_err()
        .contains("nextTurn"));
    duplicate_click.client_operation_id = input.client_operation_id;
    duplicate_click.mutation = AgentInboxMutation::Remove {
        item_id: "queued".into(),
    };
    assert!(store
        .mutate_inbox(duplicate_click)
        .unwrap_err()
        .contains("different payload"));
    assert_eq!(store.claim_step("session-1").unwrap().len(), 1);
    assert!(store.claim_step("session-1").unwrap().is_empty());
}

#[test]
fn inbox_steer_and_turn_close_share_one_atomic_boundary() {
    // Both deterministic lock orders plus a genuine concurrent attempt.
    let (_root, store) = running_steer_store();
    store
        .mutate_inbox(steer_input(&store, "before-close"))
        .unwrap();
    assert!(!store
        .end_turn_if_no_step_input("session-1", "turn-1")
        .unwrap());
    let (_root, store) = running_steer_store();
    assert!(store
        .end_turn_if_no_step_input("session-1", "turn-1")
        .unwrap());
    assert!(store
        .mutate_inbox(steer_input(&store, "after-close"))
        .unwrap_err()
        .contains("open running turn"));
    for _ in 0..12 {
        let (_root, store) = running_steer_store();
        let input = steer_input(&store, "racing-close");
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let steer = scope.spawn(|| {
                barrier.wait();
                store.mutate_inbox(input)
            });
            let close = scope.spawn(|| {
                barrier.wait();
                store.end_turn_if_no_step_input("session-1", "turn-1")
            });
            let accepted = steer.join().unwrap().is_ok();
            let closed = close.join().unwrap().unwrap();
            assert_ne!(accepted, closed);
            let snapshot = store.snapshot("session-1").unwrap();
            assert_eq!(snapshot.inbox.next_step.len(), usize::from(accepted));
            assert_eq!(snapshot.inbox.next_turn.len(), usize::from(closed));
        });
    }
}

#[test]
fn inbox_steer_concurrent_claim_never_loses_or_duplicates_a_message() {
    for _ in 0..12 {
        let (_root, store) = running_steer_store();
        let input = steer_input(&store, "racing-claim");
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let steer = scope.spawn(|| {
                barrier.wait();
                store.mutate_inbox(input)
            });
            let claim = scope.spawn(|| {
                barrier.wait();
                store.claim_turn("session-1")
            });
            let accepted = steer.join().unwrap().is_ok();
            let turn = claim.join().unwrap().unwrap();
            let step = store.claim_step("session-1").unwrap();
            assert_eq!(turn.len() + step.len(), 1);
            assert_eq!(step.len(), usize::from(accepted));
            assert!(store
                .snapshot("session-1")
                .unwrap()
                .inbox
                .next_turn
                .is_empty());
            assert!(store.claim_step("session-1").unwrap().is_empty());
        });
    }
}

#[test]
fn inbox_steer_persistence_failure_keeps_original_and_retries_the_same_operation() {
    let (root, store) = running_steer_store();
    let input = steer_input(&store, "retry-after-disk-failure");
    let before = store.snapshot("session-1").unwrap();
    let published = Arc::new(Mutex::new(Vec::new()));
    let observed = published.clone();
    store
        .set_publisher(Arc::new(move |event| {
            observed.lock().unwrap().push(event.clone())
        }))
        .unwrap();
    let path = log_path(&root);
    fs::rename(&path, path.with_extension("saved")).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(store.mutate_inbox(input.clone()).is_err());
    assert_eq!(store.snapshot("session-1").unwrap(), before);
    assert!(published.lock().unwrap().is_empty());
    fs::remove_dir(&path).unwrap();
    fs::rename(path.with_extension("saved"), &path).unwrap();
    let accepted = store.mutate_inbox(input).unwrap();
    assert_eq!(published.lock().unwrap().len(), 1);
    assert_eq!(accepted.inbox.next_step, before.inbox.next_turn);
    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(restarted.snapshot("session-1").unwrap(), accepted);
}

#[test]
fn inbox_steer_wire_input_is_identity_only() {
    let value = serde_json::json!({"sessionId":"s", "clientOperationId":"o", "expectedRevision":3,
        "mutation":{"type":"steer", "itemId":"m"}});
    let input: AgentInboxMutationInput = serde_json::from_value(value.clone()).unwrap();
    assert!(matches!(input.mutation, AgentInboxMutation::Steer { item_id } if item_id == "m"));
    let mut forged = value;
    forged["mutation"]["content"] = serde_json::json!("replacement");
    assert!(serde_json::from_value::<AgentInboxMutationInput>(forged).is_err());
}

#[test]
fn inbox_steer_removed_during_step_preparation_closes_turn_without_an_empty_model_step() {
    let (_root, store) = running_steer_store();
    store
        .mutate_inbox(steer_input(&store, "steer-before-hook"))
        .unwrap();
    assert!(!store
        .end_turn_if_no_step_input("session-1", "turn-1")
        .unwrap());
    let revision = store.snapshot("session-1").unwrap().event_count;
    store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: revision,
            client_operation_id: "remove-in-hook".into(),
            mutation: AgentInboxMutation::Remove {
                item_id: "queued".into(),
            },
        })
        .unwrap();
    assert!(store
        .begin_step_or_end_turn("session-1", "turn-1".into(), "unused-step".into())
        .unwrap()
        .is_none());
    let events = store.all_events("session-1").unwrap();
    assert!(matches!(
        events.last().unwrap().payload,
        AgentSessionEventPayload::TurnEnd { .. }
    ));
    assert!(!events
        .iter()
        .any(|event| event.step_id.as_deref() == Some("unused-step")));
}
