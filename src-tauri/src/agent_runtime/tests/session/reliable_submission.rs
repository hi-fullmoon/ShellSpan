#[test]
fn reliable_submission_retains_failed_queue_across_restart_and_explicit_resume() {
    let (root, store) = configured();
    create(&store);
    for id in ["A", "B", "C"] {
        store
            .enqueue("session-1", AgentInboxLane::NextTurn, message(id, id))
            .unwrap();
    }
    store.claim("session-1", AgentInboxLane::NextTurn).unwrap();
    let failed = store
        .terminate(
            "session-1",
            AgentSessionStatus::Failed,
            "network unavailable".into(),
        )
        .unwrap();
    assert_eq!(failed.inbox.paused_ids, vec!["B", "C"]);
    assert_eq!(failed.inbox.next_turn.len(), 2);
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(restored.snapshot("session-1").unwrap(), failed);
    let late = restored
        .enqueue_submission(
            "session-1",
            AgentInboxLane::NextTurn,
            message("late-after-failure", "later input"),
            false,
            None,
        )
        .unwrap();
    assert!(late.ended);
    assert_eq!(late.status, AgentSessionStatus::Failed);
    assert_eq!(late.inbox.paused_ids, vec!["B", "C", "late-after-failure"]);
    restored.resume("session-1").unwrap();
    assert!(!restored.has_ready_input("session-1").unwrap());
    let revision = restored.snapshot("session-1").unwrap().event_count;
    restored
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: revision,
            client_operation_id: "resume-B".into(),
            mutation: AgentInboxMutation::Resume {
                item_id: "B".into(),
            },
        })
        .unwrap();
    let claimed = restored
        .claim("session-1", AgentInboxLane::NextTurn)
        .unwrap();
    assert_eq!(claimed[0].message_id, "B");
    assert!(!restored.has_ready_input("session-1").unwrap());
}

#[test]
fn reliable_submission_restart_pauses_only_unclaimed_work() {
    let (root, store) = configured();
    create(&store);
    store
        .enqueue("session-1", AgentInboxLane::NextTurn, message("A", "first"))
        .unwrap();
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("B", "second"),
        )
        .unwrap();
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    restored.pause_restored_inputs().unwrap();
    let paused = restored.snapshot("session-1").unwrap();
    assert_eq!(paused.inbox.paused_ids, vec!["A", "B"]);
    assert!(!restored.has_ready_input("session-1").unwrap());
    restored.pause_restored_inputs().unwrap();
    assert_eq!(
        restored.snapshot("session-1").unwrap().event_count,
        paused.event_count
    );
}

#[test]
fn reliable_submission_late_steering_and_receipt_replay_are_atomic() {
    let (root, store) = configured();
    create(&store);
    let input = message("late", "correction");
    let accepted = store
        .enqueue_submission(
            "session-1",
            AgentInboxLane::NextStep,
            input.clone(),
            false,
            Some("finished-turn"),
        )
        .unwrap();
    assert_eq!(accepted.inbox.next_turn[0].message_id, "late");
    assert!(accepted.inbox.next_step.is_empty());
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    let replay = restored
        .enqueue_submission(
            "session-1",
            AgentInboxLane::NextStep,
            input,
            false,
            Some("finished-turn"),
        )
        .unwrap();
    assert_eq!(accepted, replay);
    assert!(restored
        .enqueue_submission(
            "session-1",
            AgentInboxLane::NextStep,
            message("late", "different"),
            false,
            Some("finished-turn")
        )
        .is_err());
}

#[test]
fn reliable_submission_creation_retry_and_paused_admission_survive_replay() {
    let (root, store) = configured();
    create(&store);
    let before = store.snapshot("session-1").unwrap();
    create(&store);
    assert_eq!(store.snapshot("session-1").unwrap(), before);
    store
        .enqueue_submission(
            "session-1",
            AgentInboxLane::NextTurn,
            message("after-stop", "next"),
            true,
            None,
        )
        .unwrap();
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert!(!restored.has_ready_input("session-1").unwrap());
    assert_eq!(
        restored.snapshot("session-1").unwrap().inbox.paused_ids,
        vec!["after-stop"]
    );
}

#[test]
fn reliable_submission_failed_admission_is_one_recoverable_log_record() {
    for legacy in [false, true] {
        for interrupted_tail in [false, true] {
            let (root, store) = configured();
            create(&store);
            store
                .terminate(
                    "session-1",
                    AgentSessionStatus::Failed,
                    "network failure".into(),
                )
                .unwrap();
            let before = store.snapshot("session-1").unwrap().event_count;
            store
                .enqueue_submission(
                    "session-1",
                    AgentInboxLane::NextTurn,
                    message("late", "retained input"),
                    false,
                    None,
                )
                .unwrap();
            let mut events = store.all_events("session-1").unwrap();
            assert_eq!(
                events.len() as u64,
                before + 1,
                "paused admission must commit in one record"
            );
            if legacy {
                let AgentSessionEventPayload::InboxSpliced { messages, .. } =
                    &mut events.last_mut().unwrap().payload
                else {
                    panic!("expected admission");
                };
                messages[0].source.metadata.remove("admissionPaused");
            }
            let mut bytes = events
                .iter()
                .map(|event| format!("{}\n", serde_json::to_string(event).unwrap()))
                .collect::<String>();
            if interrupted_tail {
                bytes.push_str("{\"interruptedPause\":");
            }
            std::fs::write(log_path(&root), bytes).unwrap();
            let restored = AgentSessionStore::default();
            restored.configure(root.path().to_path_buf()).unwrap();
            let snapshot = restored
                .snapshot("session-1")
                .expect("complete admission must not quarantine session history");
            assert!(snapshot.ended);
            assert_eq!(snapshot.inbox.paused_ids, vec!["late"]);
            assert!(!restored.has_ready_input("session-1").unwrap());
            let retry = restored
                .enqueue_submission(
                    "session-1",
                    AgentInboxLane::NextTurn,
                    message("late", "retained input"),
                    false,
                    None,
                )
                .unwrap();
            assert_eq!(retry.event_count, snapshot.event_count);
        }
    }
}

#[test]
fn reliable_submission_paused_enqueue_replay_and_resume_do_not_repause_on_retry() {
    let (root, store) = configured();
    create(&store);
    let before = store.snapshot("session-1").unwrap().event_count;
    let saved = store
        .enqueue_submission(
            "session-1",
            AgentInboxLane::NextTurn,
            message("queued", "next"),
            true,
            None,
        )
        .unwrap();
    assert_eq!(saved.event_count, before + 1);
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restored.snapshot("session-1").unwrap().inbox.paused_ids,
        vec!["queued"]
    );
    let resumed = restored
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: saved.event_count,
            client_operation_id: "resume-queued".into(),
            mutation: AgentInboxMutation::Resume {
                item_id: "queued".into(),
            },
        })
        .unwrap();
    let retry = restored
        .enqueue_submission(
            "session-1",
            AgentInboxLane::NextTurn,
            message("queued", "next"),
            true,
            None,
        )
        .unwrap();
    assert_eq!(retry, resumed);
    assert!(retry.inbox.paused_ids.is_empty());
}
