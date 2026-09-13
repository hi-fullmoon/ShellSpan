use super::*;
use crate::agent_runtime::{AgentInboxMutation, AgentInboxMutationInput};

fn repeated_read_call(index: usize) -> ModelToolCall {
    ModelToolCall {
        call_id: format!("repeat-{index}"),
        provider_call_id: Some(format!("provider-repeat-{index}")),
        name: "list_directory".into(),
        arguments: json!({ "path": "." }),
    }
}

#[tokio::test]
async fn pending_user_steer_takes_priority_over_the_repetition_guard() {
    let mut command = response("");
    command.finish_reason = ModelFinishReason::ToolCalls;
    set_tool_calls(
        &mut command,
        vec![ModelToolCall {
            call_id: "call-1".into(),
            provider_call_id: Some("provider-call-1".into()),
            name: "list_directory".into(),
            arguments: json!({ "path": "." }),
        }],
    );
    let model = FakeAdapter::new(vec![
        FakeScript::Wait {
            response: Some(command),
        },
        reply("handled the new instruction", &[]),
    ]);
    let native = RecordingNativeRuntime::new(false);
    let (_root, runtime) = configured_with_native(
        model.clone(),
        AgentDriverConfig {
            max_identical_tool_steps: 1,
            ..AgentDriverConfig::default()
        },
        native,
    );
    let id = "steer-before-loop-guard";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    model.started.notified().await;
    runtime
        .followup(id, "queued-steer".into(), "use the updated goal".into())
        .unwrap();
    runtime
        .mutate_inbox(AgentInboxMutationInput {
            session_id: id.into(),
            expected_revision: runtime.session(id).unwrap().event_count,
            client_operation_id: "steer-before-guard".into(),
            mutation: AgentInboxMutation::Steer {
                item_id: "queued-steer".into(),
            },
        })
        .unwrap();
    model.release.notify_one();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    assert_eq!(model.request_count(), 2);
    assert!(model.requests.lock().unwrap()[1].messages.iter().any(
        |message| matches!(message, ModelMessage::User { content } if content == "use the updated goal")
    ));
}

#[tokio::test]
async fn repeated_identical_tool_results_stop_before_another_model_request() {
    let scripts = (0..4)
        .map(|index| tool_response(vec![repeated_read_call(index)]))
        .collect();
    let model = FakeAdapter::new(scripts);
    let native = RecordingNativeRuntime::new(false);
    let (_root, runtime) = configured_with_native(
        model.clone(),
        AgentDriverConfig {
            max_identical_tool_steps: 3,
            ..AgentDriverConfig::default()
        },
        native.clone(),
    );
    let id = "repeated-tool-loop";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect the same directory".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(model.request_count(), 3);
    assert_eq!(native.executions.load(Ordering::Acquire), 3);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Failed
    );
    assert!(all_events(&runtime, id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
            if reason.starts_with("noProgress:")
    )));
}

#[tokio::test]
async fn queued_followup_runs_after_stalled_turn_is_closed() {
    let mut third = response("");
    third.finish_reason = ModelFinishReason::ToolCalls;
    set_tool_calls(&mut third, vec![repeated_read_call(2)]);
    let model = FakeAdapter::new(vec![
        tool_response(vec![repeated_read_call(0)]),
        tool_response(vec![repeated_read_call(1)]),
        FakeScript::Wait {
            response: Some(third),
        },
        reply("handled the queued task", &[]),
    ]);
    let native = RecordingNativeRuntime::new(false);
    let (_root, runtime) = configured_with_native(
        model.clone(),
        AgentDriverConfig {
            max_identical_tool_steps: 3,
            ..AgentDriverConfig::default()
        },
        native,
    );
    let id = "queued-after-stall";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    model.started.notified().await;
    runtime
        .followup(id, "next-task".into(), "handle the next request".into())
        .unwrap();
    model.release.notify_one();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    assert_eq!(model.request_count(), 4);
    let events = all_events(&runtime, id);
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::TurnEnd { reason } if reason.starts_with("noProgress:")
    )));
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
            .count(),
        2
    );
}

#[tokio::test]
async fn model_request_is_not_sent_when_task_token_budget_is_exhausted() {
    let model = FakeAdapter::new(vec![reply("should not run", &[])]);
    let (_root, runtime) = configured_with(
        model.clone(),
        AgentDriverConfig {
            max_model_tokens_per_session: 1,
            ..AgentDriverConfig::default()
        },
    );
    let id = "task-token-budget";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(model.request_count(), 0);
    assert!(all_events(&runtime, id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
            if reason.starts_with("taskTokenBudgetExceeded:")
    )));
}

#[tokio::test]
async fn model_request_is_not_sent_when_active_time_budget_is_exhausted() {
    let model = FakeAdapter::new(vec![reply("should not run", &[])]);
    let (_root, runtime) = configured_with(
        model.clone(),
        AgentDriverConfig {
            max_active_duration_ms: 0,
            ..AgentDriverConfig::default()
        },
    );
    let id = "task-active-time-budget";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(model.request_count(), 0);
    assert!(all_events(&runtime, id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
            if reason.starts_with("taskActiveTimeExceeded:")
    )));
}
