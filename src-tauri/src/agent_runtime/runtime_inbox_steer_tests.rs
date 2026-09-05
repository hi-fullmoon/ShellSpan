use super::*;
use crate::agent_runtime::{AgentInboxMutation, AgentInboxMutationInput};

fn queued_steer(runtime: &AgentRuntime, session_id: &str) -> AgentInboxMutationInput {
    AgentInboxMutationInput {
        session_id: session_id.into(),
        expected_revision: runtime.session(session_id).unwrap().event_count,
        client_operation_id: "steer-operation".into(),
        mutation: AgentInboxMutation::Steer {
            item_id: "queued-steer".into(),
        },
    }
}

#[tokio::test]
async fn inbox_steer_uses_same_turn_next_step_without_cancelling_model_and_retry_does_not_wake() {
    let model = FakeAdapter::new(vec![
        FakeScript::Wait {
            response: Some(response("first response")),
        },
        reply("steer response", &[]),
        reply("later turn", &[]),
    ]);
    let (root, runtime) = configured(model.clone());
    let id = "steer-running";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "first".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    model.started.notified().await;
    runtime
        .followup(id, "queued-steer".into(), "use at next step".into())
        .unwrap();
    runtime
        .followup(id, "later-turn".into(), "a separate task".into())
        .unwrap();
    let input = queued_steer(&runtime, id);
    let accepted = runtime.mutate_inbox(input.clone()).unwrap();
    assert_eq!(accepted.inbox.next_step[0].message_id, "queued-steer");
    assert_eq!(
        accepted.inbox.next_step[0].client_submission_id.as_deref(),
        Some("queued-steer")
    );
    assert_eq!(model.request_count(), 1);
    assert_eq!(model.active.load(Ordering::Acquire), 1);
    assert!(!runtime
        .agents
        .get(id)
        .unwrap()
        .unwrap()
        .cancellation()
        .is_cancelled());
    runtime.mutate_inbox(input.clone()).unwrap();
    model.release.notify_one();
    runtime.await_idle(id).await.unwrap();
    let events = all_events(&runtime, id);
    let initial = events.iter().find(|e| matches!(&e.payload, AgentSessionEventPayload::UserMessage { message } if message.message_id == "initial")).unwrap();
    let steered = events.iter().find(|e| matches!(&e.payload, AgentSessionEventPayload::UserMessage { message } if message.message_id == "queued-steer")).unwrap();
    let later = events.iter().find(|e| matches!(&e.payload, AgentSessionEventPayload::UserMessage { message } if message.message_id == "later-turn")).unwrap();
    assert_eq!(initial.turn_id, steered.turn_id);
    assert_ne!(initial.step_id, steered.step_id);
    assert_ne!(initial.turn_id, later.turn_id);
    assert_eq!(events.iter().filter(|e| matches!(&e.payload, AgentSessionEventPayload::UserMessage { message } if message.message_id == "queued-steer")).count(), 1);
    assert_eq!(model.request_count(), 3);
    assert!(model.requests.lock().unwrap()[1].messages.iter().any(
        |message| matches!(message, ModelMessage::User { content } if content == "use at next step")
    ));
    let before = runtime.session(id).unwrap();
    assert_eq!(runtime.mutate_inbox(input.clone()).unwrap(), before);
    assert_eq!(model.request_count(), 3);
    // New operation cannot act on an idle/claimed item. No wake or new request.
    let mut late = queued_steer(&runtime, id);
    late.client_operation_id = "late".into();
    assert!(runtime.mutate_inbox(late).unwrap_err().contains("running"));
    runtime.cancel(id).await.unwrap();
    let stopped = runtime.session(id).unwrap();
    assert_eq!(runtime.mutate_inbox(input.clone()).unwrap(), stopped);
    assert_eq!(model.request_count(), 3);
    let cold = AgentRuntime::default();
    cold.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(cold.mutate_inbox(input).unwrap(), stopped);
}

struct PausedNative {
    native: Arc<RecordingNativeRuntime>,
    entered: Notify,
    released: (Mutex<bool>, std::sync::Condvar),
}
impl NativeToolRuntime for PausedNative {
    fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
        self.native.prepare(request)
    }
    fn execute(
        &self,
        token: &str,
        approved: bool,
        cancellation: CancellationToken,
    ) -> Result<NativeToolResult, String> {
        self.entered.notify_one();
        let guard = self.released.0.lock().unwrap();
        let (guard, timeout) = self
            .released
            .1
            .wait_timeout_while(guard, std::time::Duration::from_secs(10), |released| {
                !*released
            })
            .unwrap();
        if timeout.timed_out() && !*guard {
            return Err("test tool release timed out".into());
        }
        assert!(
            !cancellation.is_cancelled(),
            "steering must not cancel the active tool"
        );
        self.native.execute(token, approved, cancellation)
    }
    fn abandon(&self, token: &str) {
        self.native.abandon(token);
    }
}

#[tokio::test]
async fn inbox_steer_waits_for_current_tool_to_finish_before_the_next_step() {
    let native = Arc::new(PausedNative {
        native: RecordingNativeRuntime::new(false),
        entered: Notify::new(),
        released: (Mutex::new(false), std::sync::Condvar::new()),
    });
    let model = FakeAdapter::new(vec![
        tool_response(vec![native_call("read", "list_directory")]),
        reply("done", &[]),
    ]);
    let (_root, runtime) =
        configured_with_native(model.clone(), AgentDriverConfig::default(), native.clone());
    let id = "steer-tool";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "first".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        native.entered.notified(),
    )
    .await
    .unwrap();
    runtime
        .followup(id, "queued-steer".into(), "after this tool".into())
        .unwrap();
    runtime.mutate_inbox(queued_steer(&runtime, id)).unwrap();
    assert_eq!(model.request_count(), 1);
    assert!(!all_events(&runtime, id)
        .iter()
        .any(|e| matches!(e.payload, AgentSessionEventPayload::ToolResult { .. })));
    *native.released.0.lock().unwrap() = true;
    native.released.1.notify_one();
    runtime.await_idle(id).await.unwrap();
    let events = all_events(&runtime, id);
    let result = events
        .iter()
        .find(|e| matches!(e.payload, AgentSessionEventPayload::ToolResult { .. }))
        .unwrap();
    let message = events.iter().find(|e| matches!(&e.payload, AgentSessionEventPayload::UserMessage { message } if message.message_id == "queued-steer")).unwrap();
    assert!(result.seq < message.seq);
    assert_eq!(result.turn_id, message.turn_id);
    assert_ne!(result.step_id, message.step_id);
    assert_eq!(native.native.executions.load(Ordering::Acquire), 1);
    assert_eq!(model.request_count(), 2);
}

#[tokio::test]
async fn inbox_steer_cold_running_log_requires_a_real_driver_but_replays_receipts() {
    let model = FakeAdapter::new(vec![
        FakeScript::Wait {
            response: Some(response("first")),
        },
        reply("next", &[]),
    ]);
    let (root, runtime) = configured(model.clone());
    let id = "steer-cold";
    create(&runtime, id);
    runtime
        .followup(id, "initial".into(), "first".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    model.started.notified().await;
    runtime
        .followup(id, "queued-steer".into(), "next step".into())
        .unwrap();
    // Capture the durable running log in a separate cold store, with no attach.
    let cold_root = tempfile::tempdir().unwrap();
    let logs = cold_root.path().join("agent-runtime/sessions-v5");
    std::fs::create_dir_all(&logs).unwrap();
    let path = root
        .path()
        .join(format!("agent-runtime/sessions-v5/{id}.jsonl"));
    std::fs::copy(&path, logs.join(format!("{id}.jsonl"))).unwrap();
    let cold = AgentRuntime::default();
    cold.configure(cold_root.path().to_path_buf()).unwrap();
    let before = cold.session(id).unwrap();
    assert_eq!(before.status, AgentSessionStatus::Running);
    assert!(cold
        .mutate_inbox(queued_steer(&cold, id))
        .unwrap_err()
        .contains("active running driver"));
    assert_eq!(cold.session(id).unwrap(), before);
    assert!(cold.agents.get(id).unwrap().is_none());

    let input = queued_steer(&runtime, id);
    runtime.mutate_inbox(input.clone()).unwrap();
    std::fs::copy(&path, logs.join(format!("{id}.jsonl"))).unwrap();
    let receipt_only = AgentRuntime::default();
    receipt_only
        .configure(cold_root.path().to_path_buf())
        .unwrap();
    let accepted = receipt_only.session(id).unwrap();
    assert_eq!(receipt_only.mutate_inbox(input).unwrap(), accepted);
    assert!(receipt_only.agents.get(id).unwrap().is_none());
    model.release.notify_one();
    runtime.await_idle(id).await.unwrap();
}
