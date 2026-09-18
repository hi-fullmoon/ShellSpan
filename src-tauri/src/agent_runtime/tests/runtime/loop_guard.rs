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

fn plan_call(version: u64, status: &str) -> ModelToolCall {
    ModelToolCall {
        call_id: format!("plan-{version}"),
        provider_call_id: Some(format!("provider-plan-{version}")),
        name: "update_plan".into(),
        arguments: json!({
            "planVersion": version,
            "steps": [{ "id": "verify", "title": "Verify the result", "status": status }],
        }),
    }
}

fn disconnected_model_error() -> NormalizedModelError {
    let mut error =
        NormalizedModelError::new(NormalizedModelErrorKind::Transport, "network disconnected");
    error.code = Some("CONNECT".into());
    error
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
async fn alternating_tool_cycle_is_stopped_before_a_seventh_request() {
    let scripts = (0..7)
        .map(|index| {
            let mut call = repeated_read_call(index);
            call.arguments = json!({ "path": if index % 2 == 0 { "." } else { "./" } });
            tool_response(vec![call])
        })
        .collect();
    let model = FakeAdapter::new(scripts);
    let (_root, runtime) = configured_with_native(
        model.clone(),
        AgentDriverConfig::default(),
        RecordingNativeRuntime::new(false),
    );
    let id = "alternating-tool-loop";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(model.request_count(), 6);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Failed
    );
}

#[tokio::test]
async fn primary_session_can_finish_after_more_than_sixty_four_productive_steps() {
    let mut scripts = (0..65)
        .map(|index| {
            let mut call = repeated_read_call(index);
            call.arguments = json!({ "path": format!("./entry-{index}") });
            tool_response(vec![call])
        })
        .collect::<Vec<_>>();
    scripts.push(reply("finished after the long tool run", &[]));
    let model = FakeAdapter::new(scripts);
    let native = RecordingNativeRuntime::new(false);
    let (_root, runtime) =
        configured_with_native(model.clone(), AgentDriverConfig::default(), native.clone());
    let id = "productive-long-turn";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect many distinct entries".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(model.request_count(), 66);
    assert_eq!(native.executions.load(Ordering::Acquire), 65);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    assert!(!all_events(&runtime, id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
            if reason.starts_with("stepLimitExceeded:")
    )));
}

#[tokio::test]
async fn queued_followup_survives_the_default_style_step_boundary() {
    let mut first = response("");
    first.finish_reason = ModelFinishReason::ToolCalls;
    set_tool_calls(&mut first, vec![repeated_read_call(0)]);
    let model = FakeAdapter::new(vec![
        FakeScript::Wait {
            response: Some(first),
        },
        reply("handled the queued followup", &[]),
    ]);
    let (_root, runtime) = configured_with_native(
        model.clone(),
        AgentDriverConfig {
            max_steps_per_turn: Some(1),
            ..AgentDriverConfig::default()
        },
        RecordingNativeRuntime::new(false),
    );
    let id = "followup-after-step-limit";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    model.started.notified().await;
    runtime
        .followup(id, "next".into(), "handle a new request".into())
        .unwrap();
    model.release.notify_one();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(model.request_count(), 2);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    assert!(all_events(&runtime, id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::TurnEnd { reason } if reason.starts_with("stepBudgetReached:")
    )));
    assert!(!runtime.session(id).unwrap().ended);
}

#[tokio::test]
async fn unfinished_plan_gets_one_completion_check_then_stays_incomplete() {
    let model = FakeAdapter::new(vec![
        tool_response(vec![plan_call(1, "inProgress")]),
        reply("finished", &[]),
        reply("I cannot verify it yet", &[]),
    ]);
    let (_root, runtime) = configured(model.clone());
    let id = "incomplete-plan";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "verify".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(model.request_count(), 3);
    let snapshot = runtime.session(id).unwrap();
    assert_eq!(snapshot.status, AgentSessionStatus::Idle);
    assert!(snapshot.task.plan.is_some_and(|plan| {
        plan.steps[0].status == super::super::super::AgentPlanStepStatus::InProgress
    }));
    assert!(all_events(&runtime, id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::TurnEnd { reason } if reason == "incomplete"
    )));
    assert!(model.requests.lock().unwrap()[2].messages.iter().any(|message| matches!(
        message,
        ModelMessage::User { content } if content.contains("recorded task plan still has unfinished steps")
    )));
}

#[tokio::test]
async fn completion_check_allows_the_model_to_finish_the_plan() {
    let model = FakeAdapter::new(vec![
        tool_response(vec![plan_call(1, "inProgress")]),
        reply("finished", &[]),
        tool_response(vec![plan_call(2, "completed")]),
        reply("verified", &[]),
    ]);
    let (_root, runtime) = configured(model.clone());
    let id = "completed-after-check";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "verify".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(model.request_count(), 4);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    assert!(runtime
        .session(id)
        .unwrap()
        .task
        .plan
        .is_some_and(|plan| plan
            .steps
            .iter()
            .all(|step| { step.status == super::super::super::AgentPlanStepStatus::Completed })));
    assert!(all_events(&runtime, id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::TurnEnd { reason } if reason == "completed"
    )));
}

#[tokio::test]
async fn model_stream_total_deadline_stops_a_nonresponsive_adapter() {
    let model = FakeAdapter::new(vec![FakeScript::Wait { response: None }]);
    let (_root, runtime) = configured_with(
        model.clone(),
        AgentDriverConfig {
            max_model_stream_duration_ms: 20,
            ..AgentDriverConfig::default()
        },
    );
    let id = "model-stream-total-deadline";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), runtime.await_idle(id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Failed
    );
    assert!(all_events(&runtime, id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
            if reason.starts_with("modelStreamTotalTimeout:")
    )));
}

#[tokio::test]
async fn exhausted_stream_deadline_does_not_dispatch_even_an_immediate_reply() {
    let model = FakeAdapter::new(vec![reply("should not run", &[])]);
    let (_root, runtime) = configured_with(
        model.clone(),
        AgentDriverConfig {
            max_model_stream_duration_ms: 0,
            ..AgentDriverConfig::default()
        },
    );
    let id = "zero-model-stream-deadline";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(model.request_count(), 0);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Failed
    );
}

#[tokio::test]
async fn network_recovery_waits_and_retries_the_frozen_model_step() {
    let model = FakeAdapter::new(vec![
        FakeScript::Error(disconnected_model_error()),
        FakeScript::Error(disconnected_model_error()),
        reply("network recovered", &[]),
    ]);
    let (_root, runtime) = configured_with(
        model.clone(),
        AgentDriverConfig {
            retry_policy: RetryPolicy {
                max_attempts: 1,
                initial_delay_ms: 0,
                max_delay_ms: 0,
                max_server_delay_ms: 0,
                jitter_ratio: 0.0,
            },
            network_recovery_window_ms: 500,
            network_recovery_max_attempts: 3,
            network_recovery_initial_delay_ms: 5,
            network_recovery_max_delay_ms: 5,
            ..AgentDriverConfig::default()
        },
    );
    let id = "network-recovery";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "respond".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(model.request_count(), 3);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    let events = all_events(&runtime, id);
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::AgentStatus { status: AgentSessionStatus::Waiting, reason: Some(reason) }
            if reason == "waitingForNetwork"
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::AgentStatus { status: AgentSessionStatus::Running, reason: Some(reason) }
            if reason == "networkRetry"
    )));
    assert!(
        events
            .iter()
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestRetry { .. }))
            .count()
            >= 2
    );
}

#[tokio::test]
async fn network_recovery_window_expires_without_sending_an_extra_request() {
    let model = FakeAdapter::new(vec![FakeScript::Error(disconnected_model_error())]);
    let (_root, runtime) = configured_with(
        model.clone(),
        AgentDriverConfig {
            retry_policy: RetryPolicy {
                max_attempts: 1,
                initial_delay_ms: 0,
                max_delay_ms: 0,
                max_server_delay_ms: 0,
                jitter_ratio: 0.0,
            },
            network_recovery_window_ms: 20,
            network_recovery_max_attempts: 3,
            network_recovery_initial_delay_ms: 100,
            ..AgentDriverConfig::default()
        },
    );
    let id = "network-window-expired";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "respond".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(model.request_count(), 1);
    let reason = all_events(&runtime, id)
        .into_iter()
        .find_map(|event| match event.payload {
            AgentSessionEventPayload::SessionEnded { reason, .. } => reason,
            _ => None,
        })
        .expect("network recovery must end the session");
    assert!(reason.starts_with("networkRecoveryTimeout:"), "{reason}");
}

#[tokio::test]
async fn network_recovery_wait_can_be_cancelled_without_another_request() {
    let model = FakeAdapter::new(vec![FakeScript::Error(disconnected_model_error())]);
    let (_root, runtime) = configured_with(
        model.clone(),
        AgentDriverConfig {
            retry_policy: RetryPolicy {
                max_attempts: 1,
                initial_delay_ms: 0,
                max_delay_ms: 0,
                max_server_delay_ms: 0,
                jitter_ratio: 0.0,
            },
            network_recovery_initial_delay_ms: 30_000,
            ..AgentDriverConfig::default()
        },
    );
    let id = "network-wait-cancel";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "respond".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if runtime.session(id).unwrap().status == AgentSessionStatus::Waiting {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), runtime.cancel(id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(model.request_count(), 1);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Cancelled
    );
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
