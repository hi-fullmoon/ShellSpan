use super::*;

#[tokio::test]
async fn archive_rejection_wakes_input_queued_while_the_worker_slot_was_reserved() {
    let adapter = FakeAdapter::new(vec![reply("Queued reply", &[])]);
    let (_root, runtime) = configured(adapter.clone());
    let id = "archive-queued-live";
    create(&runtime, id);
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    let entry = runtime.agents.get(id).unwrap().unwrap();
    assert!(entry.try_acquire_archive());
    runtime
        .followup_submission(id, "message".into(), "submission".into(), "Queued".into())
        .unwrap();
    assert_eq!(adapter.request_count(), 0);
    entry.release_driver();
    assert_eq!(
        runtime.archive_session(id).unwrap_err(),
        "AGENT_SESSION_ARCHIVE_BUSY"
    );
    runtime.await_idle(id).await.unwrap();
    assert_eq!(adapter.request_count(), 1);
    assert!(runtime.session(id).unwrap().inbox.next_turn.is_empty());
}

#[tokio::test]
async fn archive_keeps_parents_with_unfinished_children_open() {
    let (_root, runtime) = configured(FakeAdapter::new(vec![reply("Child answer", &[])]));
    create(&runtime, "parent");
    runtime.start("parent", provider(), None).unwrap();
    runtime.await_idle("parent").await.unwrap();
    let child = runtime
        .spawn_subagent(AgentSubagentSpawnRequest {
            parent_session_id: "parent".into(),
            goal: "Inspect the target".into(),
            role: AgentSubagentRole::Explorer,
            inheritance_mode: "blank".into(),
            target_ids: vec!["target-local".into()],
            budget: None,
            continuable: true,
        })
        .await
        .unwrap();
    runtime.await_idle(&child.header.session_id).await.unwrap();
    assert_eq!(
        runtime.archive_session("parent").unwrap_err(),
        "AGENT_SESSION_ARCHIVE_BUSY"
    );
    assert!(!runtime.session("parent").unwrap().ended);
    runtime.sessions.cancel(&child.header.session_id).unwrap();
    assert!(runtime.archive_session("parent").unwrap().archived);
}

#[tokio::test]
async fn archive_closes_idle_conversations_and_releases_retained_agents() {
    let (root, runtime) = configured(FakeAdapter::new(vec![reply("Finished", &[])]));
    let id = "archive-idle";
    create(&runtime, id);
    runtime.start(id, provider(), None).unwrap();
    runtime
        .followup_submission(id, "message".into(), "submission".into(), "Hello".into())
        .unwrap();
    runtime.await_idle(id).await.unwrap();
    let before = runtime.session(id).unwrap();
    assert_eq!(before.status, AgentSessionStatus::Idle);
    assert!(!before.ended);
    assert!(runtime.agents.get(id).unwrap().is_some());

    let archived = runtime.archive_session(id).unwrap();
    assert!(archived.archived && archived.ended);
    assert_eq!(archived.status, AgentSessionStatus::Completed);
    assert_eq!(archived.surface.messages, before.surface.messages);
    assert!(runtime.agents.get(id).unwrap().is_none());
    assert!(!runtime.handles.lock().unwrap().contains_key(id));
    assert_eq!(
        runtime.archive_session(id).unwrap().event_count,
        archived.event_count
    );
    assert!(runtime
        .followup_submission(id, "late".into(), "late".into(), "late".into())
        .is_err());

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert!(restarted.snapshot(id).unwrap().archived);
    assert_eq!(
        restarted.snapshot(id).unwrap().surface.messages,
        before.surface.messages
    );
}

#[tokio::test]
async fn archive_preserves_terminal_outcomes_with_retained_agents() {
    let (_root, runtime) = configured(FakeAdapter::new(vec![]));
    for (id, status) in [
        ("completed", AgentSessionStatus::Completed),
        ("failed", AgentSessionStatus::Failed),
        ("cancelled", AgentSessionStatus::Cancelled),
    ] {
        create(&runtime, id);
        runtime.start(id, provider(), None).unwrap();
        runtime.await_idle(id).await.unwrap();
        runtime
            .sessions
            .terminate(id, status, "settled".into())
            .unwrap();
        runtime
            .agents
            .get(id)
            .unwrap()
            .unwrap()
            .set_phase(AgentLifecyclePhase::Stopping)
            .unwrap();
        let archived = runtime.archive_session(id).unwrap();
        assert!(archived.archived);
        assert_eq!(archived.status, status);
        assert!(runtime.agents.get(id).unwrap().is_none());
    }
}

#[tokio::test]
async fn archive_rejects_active_workers_without_cancelling_them() {
    let adapter = FakeAdapter::new(vec![FakeScript::Wait {
        response: Some(response("Finished")),
    }]);
    let (_root, runtime) = configured(adapter.clone());
    let id = "archive-running";
    create(&runtime, id);
    runtime.start(id, provider(), None).unwrap();
    runtime
        .followup_submission(id, "message".into(), "submission".into(), "Hello".into())
        .unwrap();
    adapter.started.notified().await;
    let before = runtime.session(id).unwrap().event_count;
    assert_eq!(
        runtime.archive_session(id).unwrap_err(),
        "AGENT_SESSION_ARCHIVE_BUSY"
    );
    assert_eq!(runtime.session(id).unwrap().event_count, before);
    assert!(!runtime
        .agents
        .get(id)
        .unwrap()
        .unwrap()
        .cancellation()
        .is_cancelled());
    adapter.release.notify_one();
    runtime.await_idle(id).await.unwrap();
    assert!(runtime.archive_session(id).unwrap().archived);
}

#[tokio::test]
async fn archive_rejects_queued_input_and_waiting_agents() {
    let (_root, runtime) = configured(FakeAdapter::new(vec![]));
    create(&runtime, "queued");
    runtime
        .followup_submission(
            "queued",
            "message".into(),
            "submission".into(),
            "Queued".into(),
        )
        .unwrap();
    assert_eq!(
        runtime.archive_session("queued").unwrap_err(),
        "AGENT_SESSION_ARCHIVE_BUSY"
    );
    let queued = runtime.session("queued").unwrap();
    assert!(!queued.ended && !queued.archived);
    assert_eq!(queued.inbox.next_turn.len(), 1);

    create(&runtime, "waiting");
    runtime.start("waiting", provider(), None).unwrap();
    runtime.await_idle("waiting").await.unwrap();
    let entry = runtime.agents.get("waiting").unwrap().unwrap();
    entry.set_phase(AgentLifecyclePhase::Waiting).unwrap();
    assert_eq!(
        runtime.archive_session("waiting").unwrap_err(),
        "AGENT_SESSION_ARCHIVE_BUSY"
    );
    assert!(!entry.is_driver_active());
    assert!(!runtime.session("waiting").unwrap().ended);
}

#[tokio::test]
async fn archive_append_failure_leaves_the_idle_agent_usable() {
    let (_root, runtime) = configured(FakeAdapter::new(vec![]));
    create(&runtime, "archive-write-failure");
    runtime
        .start("archive-write-failure", provider(), None)
        .unwrap();
    runtime.await_idle("archive-write-failure").await.unwrap();
    runtime.sessions.fail_appends_matching(|payload| {
        matches!(payload, AgentSessionEventPayload::SessionEnded { .. })
    });
    assert!(runtime.archive_session("archive-write-failure").is_err());
    let snapshot = runtime.session("archive-write-failure").unwrap();
    assert!(!snapshot.archived && !snapshot.ended);
    let entry = runtime
        .agents
        .get("archive-write-failure")
        .unwrap()
        .unwrap();
    assert_eq!(entry.phase().unwrap(), AgentLifecyclePhase::Idle);
    assert!(!entry.is_driver_active());
}
