use super::*;
use crate::agent_runtime::AgentAssistantContentBlock;

#[tokio::test]
async fn whitespace_text_with_reasoning_and_tool_call_continues_after_approval() {
    // MiniMax can emit three newlines between reasoning and a tool call.
    let mut tool_response = response("\n\n\n");
    tool_response.content.insert(
        0,
        ModelContentBlock::Reasoning {
            text: "Inspect the current directory through the terminal.".into(),
            provider_item: None,
        },
    );
    tool_response.finish_reason = ModelFinishReason::ToolCalls;
    set_tool_calls(
        &mut tool_response,
        vec![ModelToolCall {
            call_id: "call-directory".into(),
            provider_call_id: Some("provider-directory".into()),
            name: "run_terminal_command".into(),
            arguments: json!({"command": "pwd", "explanation": "Inspect the directory"}),
        }],
    );
    let adapter = FakeAdapter::new(vec![
        FakeScript::Reply {
            chunks: vec!["\n\n\n".into()],
            response: tool_response,
        },
        reply("  Directory inspected.\n", &[]),
    ]);
    let (root, runtime) = configured(adapter.clone());
    let id = "session-whitespace-tool";
    create(&runtime, id);
    runtime
        .followup(id, "message-inspect".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Waiting
    );
    let events = all_events(&runtime, id);
    assert!(!events
        .iter()
        .any(|event| matches!(event.payload, AgentSessionEventPayload::ToolResult { .. })));

    runtime
        .approve_tool(pending_approval(&runtime, id))
        .await
        .unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(adapter.request_count(), 2);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    let events = all_events(&runtime, id);
    let messages = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::AssistantMessage { content, .. } => Some(content),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(matches!(messages[0].as_slice(), [
        AgentAssistantContentBlock::Reasoning { .. },
        AgentAssistantContentBlock::ToolCall { call },
    ] if call.provider_call_id.as_deref() == Some("provider-directory")));
    assert!(
        matches!(messages[1].as_slice(), [AgentAssistantContentBlock::Text { text }] if text == "  Directory inspected.\n")
    );
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Completed, .. }
            if call_id == "call-directory"
    )));
    assert!(adapter.requests.lock().unwrap()[1]
        .messages
        .iter()
        .any(|message| matches!(message,
            ModelMessage::Assistant { content, .. } if matches!(content.as_slice(), [
                ModelContentBlock::Reasoning { .. }, ModelContentBlock::ToolCall { .. }
            ])
        )));
    let restored = AgentRuntime::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restored.session(id).unwrap().surface,
        runtime.session(id).unwrap().surface
    );
}

#[tokio::test]
async fn whitespace_only_response_retries_as_empty_output() {
    let adapter = FakeAdapter::new(vec![
        reply("\n\t\u{3000}", &["\n", "\t\u{3000}"]),
        reply("recovered", &[]),
    ]);
    let (_root, runtime) = configured(adapter.clone());
    let id = "session-whitespace-retry";
    create(&runtime, id);
    runtime
        .followup(id, "message-empty".into(), "respond".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(adapter.request_count(), 2);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    assert!(all_events(&runtime, id)
        .iter()
        .any(|event| matches!(&event.payload,
            AgentSessionEventPayload::RequestRetry { error_code, .. }
                if error_code.as_deref() == Some("EMPTY_RESPONSE")
        )));
}

#[tokio::test]
async fn cancelling_after_whitespace_keeps_the_cancelled_boundary() {
    let adapter = FakeAdapter::new(vec![FakeScript::PartialError {
        deltas: vec![
            StreamDelta::Reasoning {
                index: 0,
                text: "Thinking through the request.".into(),
            },
            StreamDelta::Text {
                index: 1,
                text: "\n\n\n".into(),
            },
        ],
        error: NormalizedModelError::cancelled(),
    }]);
    let (_root, runtime) = configured(adapter);
    let id = "session-whitespace-cancel";
    create(&runtime, id);
    runtime
        .followup(id, "message-cancel".into(), "respond".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    let events = all_events(&runtime, id);
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::AssistantMessage { content, interrupted: true, .. }
            if matches!(content.as_slice(), [AgentAssistantContentBlock::Reasoning { .. }])
    )));
    assert!(!events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::SessionEnded {
            status: AgentSessionStatus::Failed,
            ..
        }
    )));
}

#[tokio::test]
async fn terminal_without_root_only_advertises_usable_native_tools() {
    let adapter = FakeAdapter::new(vec![reply("ready", &[])]);
    let (_root, runtime) = configured(adapter.clone());
    let id = "session-unscoped-tools";
    create(&runtime, id);
    runtime
        .followup(id, "message-tools".into(), "inspect".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();
    let requests = adapter.requests.lock().unwrap();
    let tools = &requests[0].tools;
    assert!(tools.iter().any(|tool| tool.name == "run_terminal_command"));
    for name in [
        "read_file",
        "list_directory",
        "search_text",
        "apply_patch",
        "transfer_file",
    ] {
        assert!(
            !tools.iter().any(|tool| tool.name == name),
            "advertised unavailable {name}"
        );
    }
    assert!(requests[0].system_prompt.contains("No filesystem root"));
}
