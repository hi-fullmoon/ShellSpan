use super::*;
use crate::agent_runtime::{
    AgentAssistantContentBlock, AgentStoredReplay, AGENT_REPLAY_ARTIFACT_KIND,
};

#[tokio::test]
async fn output_limit_continues_with_partial_text_without_running_cut_off_tools() {
    let mut partial = response("Partial answer.");
    partial.finish_reason = ModelFinishReason::Length;
    set_tool_calls(
        &mut partial,
        vec![ModelToolCall {
            call_id: "cut-off-call".into(),
            provider_call_id: Some("provider-cut-off-call".into()),
            name: "write_file".into(),
            arguments: json!({ "path": "unfinished.txt", "content": "partial" }),
        }],
    );
    let adapter = FakeAdapter::new(vec![
        FakeScript::Reply {
            chunks: vec![],
            response: partial,
        },
        reply("Completed answer.", &[]),
    ]);
    let native = RecordingNativeRuntime::new(false);
    let (_root, runtime) = configured_with_native(
        adapter.clone(),
        AgentDriverConfig::default(),
        native.clone(),
    );
    let id = "session-output-limit-continuation";
    create(&runtime, id);
    runtime
        .followup(id, "message-output-limit".into(), "complete task".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    assert_eq!(adapter.request_count(), 2);
    assert_eq!(native.executions.load(Ordering::Acquire), 0);
    let events = all_events(&runtime, id);
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::AssistantMessage { content, interrupted: true, .. }
            if matches!(content.as_slice(), [AgentAssistantContentBlock::Text { text }]
                if text == "Partial answer.")
    )));
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::StepEnd { reason } if reason == "outputLimitContinuation"
    )));
    assert!(!events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolResult { call_id, .. } if call_id == "cut-off-call"
    )));
    let requests = adapter.requests.lock().unwrap();
    assert!(requests[1].messages.iter().any(|message| matches!(message,
        ModelMessage::Assistant { content, .. }
            if matches!(content.as_slice(), [ModelContentBlock::Text { text }]
                if text == "Partial answer.")
    )));
    assert!(requests[1].messages.iter().any(|message| matches!(message,
        ModelMessage::User { content } if content.contains("unfinished tool call was discarded")
    )));
}

#[tokio::test]
async fn repeated_output_limit_stops_after_two_automatic_continuations() {
    let scripts = (0..3)
        .map(|index| {
            let mut partial = response(&format!("Part {index}."));
            partial.finish_reason = ModelFinishReason::Length;
            FakeScript::Reply {
                chunks: vec![],
                response: partial,
            }
        })
        .collect();
    let adapter = FakeAdapter::new(scripts);
    let (_root, runtime) = configured(adapter.clone());
    let id = "session-output-limit-exhausted";
    create(&runtime, id);
    runtime
        .followup(id, "message-output-limit".into(), "complete task".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(adapter.request_count(), 3);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Failed
    );
    let events = all_events(&runtime, id);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(&event.payload,
                AgentSessionEventPayload::StepEnd { reason } if reason == "outputLimitContinuation"
            ))
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                &event.payload,
                AgentSessionEventPayload::AssistantMessage {
                    interrupted: true,
                    ..
                }
            ))
            .count(),
        3
    );
}

#[tokio::test]
async fn coded_output_limit_error_continues_with_streamed_partial_text() {
    let mut error = NormalizedModelError::new(
        NormalizedModelErrorKind::Terminal,
        "provider reached its output limit",
    );
    error.code = Some("OUTPUT_LIMIT".into());
    let adapter = FakeAdapter::new(vec![
        FakeScript::PartialError {
            deltas: vec![StreamDelta::Text {
                index: 0,
                text: "Kept partial text.".into(),
            }],
            error,
        },
        reply("Finished response.", &[]),
    ]);
    let (_root, runtime) = configured(adapter.clone());
    let id = "session-coded-output-limit";
    create(&runtime, id);
    runtime
        .followup(id, "message-output-limit".into(), "complete task".into())
        .unwrap();
    runtime.start(id, provider(), None).unwrap();
    runtime.await_idle(id).await.unwrap();

    assert_eq!(adapter.request_count(), 2);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Idle
    );
    let events = all_events(&runtime, id);
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::RequestFailure { failure, .. }
            if failure.code.as_deref() == Some("OUTPUT_LIMIT")
    )));
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::AssistantMessage { content, interrupted: true, .. }
            if matches!(content.as_slice(), [AgentAssistantContentBlock::Text { text }]
                if text == "Kept partial text.")
    )));
    assert!(adapter.requests.lock().unwrap()[1]
        .messages
        .iter()
        .any(|message| matches!(message,
            ModelMessage::Assistant { content, .. }
                if matches!(content.as_slice(), [ModelContentBlock::Text { text }]
                    if text == "Kept partial text.")
        )));
}

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
    tool_response
        .replay
        .as_mut()
        .unwrap()
        .blocks
        .insert(0, serde_json::json!({}));
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
async fn oversized_replay_uses_a_claim_check_and_restores_after_restart() {
    let reasoning = "r".repeat(64 * 1024);
    let mut reasoning_details = (0..6_000)
        .map(|index| {
            json!({
                "type": "reasoning.text",
                "text": "fragment",
                "index": index,
            })
        })
        .collect::<Vec<_>>();
    reasoning_details[0]["signature"] = json!("opaque-replay-signature");
    let replay_metadata = json!({ "reasoningDetails": reasoning_details });
    let replay_bytes = serde_json::to_vec(&replay_metadata).unwrap().len();
    assert!(replay_bytes > 256 * 1024);
    assert!(replay_bytes < 8 * 1024 * 1024);

    let content = vec![
        ModelContentBlock::Reasoning {
            text: reasoning,
            provider_item: None,
        },
        ModelContentBlock::Text {
            text: "Large replay completed.".into(),
        },
    ];
    let oversized = ModelResponse {
        replay: Some(crate::llm::types::AdapterReplayCapture {
            response: json!({ "id": "large-replay-response" }),
            blocks: vec![replay_metadata, json!({})],
        }),
        replay_envelope: None,
        content,
        finish_reason: ModelFinishReason::Stop,
        usage: ModelUsage {
            uncached_input_tokens: Some(10),
            output_tokens: Some(9_000),
            reasoning_tokens: Some(8_900),
            total_tokens: Some(9_010),
            ..ModelUsage::default()
        },
    };
    let adapter = FakeAdapter::new(vec![FakeScript::Reply {
        chunks: Vec::new(),
        response: oversized,
    }]);
    let root = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(adapter)))
        .native_tool_runtime(Arc::new(FakeNativeRuntime))
        .build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    let mut config = provider();
    config.id = "large-replay-route".into();
    config.kind = AiProviderKind::OpenAiCompatible;
    config.profile = "minimax".into();
    config.model = "large-replay-model".into();
    config.model_definition = Some(crate::llm::catalog::fixture_definition(
        AiProviderKind::OpenAiCompatible,
        131_072,
    ));
    register_test_model(&runtime, root.path(), &config);
    let session_id = "session-large-replay";
    create(&runtime, session_id);
    runtime
        .followup(session_id, "message-large".into(), "respond".into())
        .unwrap();
    runtime.start(session_id, config.clone(), None).unwrap();
    runtime.await_idle(session_id).await.unwrap();
    assert_eq!(
        runtime.session(session_id).unwrap().status,
        AgentSessionStatus::Idle
    );

    let artifact = all_events(&runtime, session_id)
        .into_iter()
        .find_map(|event| match event.payload {
            AgentSessionEventPayload::AssistantMessage {
                replay: Some(AgentStoredReplay::Artifact(reference)),
                ..
            } => Some(reference.artifact),
            _ => None,
        })
        .expect("oversized replay is stored by reference");
    assert_eq!(artifact.kind, AGENT_REPLAY_ARTIFACT_KIND);
    assert!(artifact.artifact_id.starts_with("replay-"));
    assert!(artifact.size_bytes < replay_bytes as u64);
    let artifact_path = root
        .path()
        .join("agent-runtime/artifacts-v2")
        .join(session_id)
        .join(format!("{}.bin", artifact.artifact_id));
    assert!(artifact_path.is_file());
    let log = std::fs::read_to_string(
        root.path()
            .join("agent-runtime/sessions-v5")
            .join(format!("{session_id}.jsonl")),
    )
    .unwrap();
    assert!(log.lines().all(|line| line.len() <= 256 * 1024));
    let public_events = serde_json::to_string(
        &runtime
            .events(AgentSessionEventsRequest {
                session_id: session_id.into(),
                cursor: None,
                limit: 1_024,
            })
            .unwrap(),
    )
    .unwrap();
    assert!(!public_events.contains(&artifact.artifact_id));
    assert!(!public_events.contains("opaque-replay-signature"));
    drop(runtime);

    let resumed_adapter = FakeAdapter::new(vec![reply("continued", &[])]);
    let resumed = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(resumed_adapter.clone())))
        .native_tool_runtime(Arc::new(FakeNativeRuntime))
        .build();
    resumed.configure(root.path().to_path_buf()).unwrap();
    register_test_model(&resumed, root.path(), &config);
    resumed
        .followup(session_id, "message-continued".into(), "continue".into())
        .unwrap();
    resumed.start(session_id, config, None).unwrap();
    resumed.await_idle(session_id).await.unwrap();
    let requests = resumed_adapter.requests.lock().unwrap();
    assert!(requests[0].messages.iter().any(|message| matches!(
        message,
        ModelMessage::Assistant {
            content,
            native_replay: Some(_),
            ..
        } if matches!(
            content.as_slice(),
            [ModelContentBlock::Reasoning { provider_item: Some(_), .. }, ModelContentBlock::Text { .. }]
        )
    )));
    assert!(serde_json::to_string(&requests[0].messages)
        .unwrap()
        .contains("opaque-replay-signature"));
    drop(requests);
    assert!(resumed.archive_session(session_id).unwrap().archived);
    drop(resumed);
    std::fs::remove_file(artifact_path).unwrap();

    let historical = AgentRuntime::default();
    historical.configure(root.path().to_path_buf()).unwrap();
    assert!(historical.session(session_id).unwrap().archived);
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
        "write_file",
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
