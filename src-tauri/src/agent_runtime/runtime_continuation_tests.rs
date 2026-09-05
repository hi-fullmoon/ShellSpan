use super::*;
use crate::agent_runtime::{
    AgentInboxMutation, AgentInboxMutationInput, AgentRecoveryCheckpointKind,
};

#[tokio::test]
async fn interruption_pauses_queued_input_across_restart_and_allows_a_new_message() {
    let adapter = FakeAdapter::new(vec![FakeScript::Wait { response: None }]);
    let (root, runtime) = configured(adapter.clone());
    create(&runtime, "continue");
    runtime
        .followup("continue", "first".into(), "start".into())
        .unwrap();
    runtime.start("continue", provider(), None).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        adapter.started.notified(),
    )
    .await
    .expect("model started");
    runtime
        .followup("continue", "queued".into(), "queued work".into())
        .unwrap();
    runtime
        .steer("continue", "steered".into(), "steered work".into())
        .unwrap();
    let snapshot = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.interrupt("continue"),
    )
    .await
    .expect("interrupt settled")
    .unwrap();
    assert_eq!(snapshot.status, AgentSessionStatus::Idle);
    assert!(!snapshot.ended);
    assert_eq!(snapshot.inbox.paused_ids, ["queued", "steered"]);
    assert!(!all_events(&runtime, "continue")
        .iter()
        .any(|event| matches!(event.payload, AgentSessionEventPayload::SessionEnded { .. })));
    assert_eq!(snapshot.recovery.kind, AgentRecoveryCheckpointKind::Idle);

    let next = FakeAdapter::new(vec![reply("new reply", &[]), reply("queued reply", &[])]);
    let reloaded = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(next.clone())))
        .build();
    reloaded.configure(root.path().to_path_buf()).unwrap();
    reloaded.start("continue", provider(), None).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        reloaded.await_idle("continue"),
    )
    .await
    .expect(concat!("idle at ", line!()))
    .unwrap();
    assert_eq!(next.request_count(), 0);
    assert_eq!(
        reloaded.session("continue").unwrap().inbox.paused_ids,
        ["queued", "steered"]
    );
    reloaded
        .followup("continue", "new".into(), "new request".into())
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        reloaded.await_idle("continue"),
    )
    .await
    .expect(concat!("idle at ", line!()))
    .unwrap();
    assert_eq!(next.request_count(), 1);
    let snapshot = reloaded.session("continue").unwrap();
    assert_eq!(snapshot.inbox.paused_ids, ["queued", "steered"]);
    let input = AgentInboxMutationInput {
        session_id: "continue".into(),
        expected_revision: snapshot.event_count,
        client_operation_id: "resume-queued".into(),
        mutation: AgentInboxMutation::Resume {
            item_id: "queued".into(),
        },
    };
    reloaded.mutate_inbox(input.clone()).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        reloaded.await_idle("continue"),
    )
    .await
    .expect(concat!("idle at ", line!()))
    .unwrap();
    assert_eq!(next.request_count(), 2);
    reloaded.mutate_inbox(input).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        reloaded.await_idle("continue"),
    )
    .await
    .expect(concat!("idle at ", line!()))
    .unwrap();
    assert_eq!(
        next.request_count(),
        2,
        "a duplicate resume receipt must not execute again"
    );
    assert_eq!(
        reloaded.session("continue").unwrap().inbox.paused_ids,
        ["steered"]
    );
}

#[tokio::test]
async fn legacy_cancelled_conversation_resumes_with_its_history_and_a_fresh_entry() {
    let adapter = FakeAdapter::new(vec![
        FakeScript::Wait { response: None },
        reply("continued", &[]),
    ]);
    let (root, runtime) = configured(adapter.clone());
    create(&runtime, "legacy");
    runtime
        .followup("legacy", "first".into(), "original context".into())
        .unwrap();
    runtime.start("legacy", provider(), None).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        adapter.started.notified(),
    )
    .await
    .expect("model started");
    runtime.cancel("legacy").await.unwrap();
    let before = all_events(&runtime, "legacy");
    let snapshot = runtime.resume("legacy").await.unwrap();
    assert_eq!(snapshot.status, AgentSessionStatus::Idle);
    assert!(!snapshot.ended);
    let resumed = all_events(&runtime, "legacy");
    assert_eq!(&resumed[..before.len()], before.as_slice());
    assert_eq!(snapshot.recovery.kind, AgentRecoveryCheckpointKind::Idle);
    runtime.start("legacy", provider(), None).unwrap();
    runtime
        .followup("legacy", "second".into(), "continue".into())
        .unwrap();
    runtime.await_idle("legacy").await.unwrap();
    assert_eq!(adapter.request_count(), 2);
    assert!(
        serde_json::to_string(&runtime.session("legacy").unwrap().surface)
            .unwrap()
            .contains("original context")
    );
    let store = AgentSessionStore::default();
    store.configure(root.path().to_path_buf()).unwrap();
    assert!(
        !store.snapshot("legacy").unwrap().ended,
        "resumption must survive replay"
    );
    runtime.archive_session("legacy").unwrap();
    assert!(
        runtime.resume("legacy").await.is_err(),
        "archived conversations remain immutable"
    );
}

#[tokio::test]
async fn failed_turn_continuation_keeps_completed_write_results_without_reexecuting() {
    let native = RecordingNativeRuntime::new(false);
    let adapter = FakeAdapter::new(vec![
        tool_response(vec![native_call("write-once", "apply_patch")]),
        partial_failure(NormalizedModelErrorKind::Authentication),
        reply("continued", &[]),
    ]);
    let (_root, runtime) = configured_with_native(
        adapter.clone(),
        AgentDriverConfig::default(),
        native.clone(),
    );
    create(&runtime, "failed-continue");
    runtime
        .followup("failed-continue", "first".into(), "write".into())
        .unwrap();
    runtime.start("failed-continue", provider(), None).unwrap();
    runtime.await_idle("failed-continue").await.unwrap();
    assert_eq!(
        runtime.session("failed-continue").unwrap().status,
        AgentSessionStatus::Failed
    );
    assert_eq!(native.executions.load(Ordering::Acquire), 1);
    runtime.resume("failed-continue").await.unwrap();
    runtime.start("failed-continue", provider(), None).unwrap();
    runtime
        .followup(
            "failed-continue",
            "second".into(),
            "continue from completed work".into(),
        )
        .unwrap();
    runtime.await_idle("failed-continue").await.unwrap();
    assert_eq!(
        runtime.session("failed-continue").unwrap().status,
        AgentSessionStatus::Idle
    );
    assert_eq!(native.executions.load(Ordering::Acquire), 1);
    assert!(adapter
        .requests
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .messages
        .iter()
        .any(|message| matches!(message, ModelMessage::Tool { .. })));
}

#[tokio::test]
async fn interruption_cancels_pending_approval_and_allows_later_input() {
    let native = RecordingNativeRuntime::new(true);
    let adapter = FakeAdapter::new(vec![
        tool_response(vec![native_call("cancelled-write", "apply_patch")]),
        reply("continued", &[]),
    ]);
    let (_root, runtime) = configured_with_native(
        adapter.clone(),
        AgentDriverConfig::default(),
        native.clone(),
    );
    create(&runtime, "approval-continue");
    runtime
        .followup("approval-continue", "first".into(), "write".into())
        .unwrap();
    runtime
        .start("approval-continue", provider(), None)
        .unwrap();
    runtime.await_idle("approval-continue").await.unwrap();
    let decision = pending_approval(&runtime, "approval-continue");
    runtime.interrupt("approval-continue").await.unwrap();
    assert!(runtime.approve_tool(decision).await.is_err());
    runtime
        .start("approval-continue", provider(), None)
        .unwrap();
    runtime
        .followup("approval-continue", "second".into(), "just explain".into())
        .unwrap();
    runtime.await_idle("approval-continue").await.unwrap();
    assert_eq!(
        runtime.session("approval-continue").unwrap().status,
        AgentSessionStatus::Idle
    );
    assert_eq!(native.executions.load(Ordering::Acquire), 0);
}
