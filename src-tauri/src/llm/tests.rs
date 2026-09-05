use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;

use super::{
    adapters::{chat_completions::*, common::*, responses::*},
    config::*,
    registry::HttpModelAdapterFactory,
    transport::*,
    usage::*,
};
use crate::agent_runtime::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio_util::sync::CancellationToken;

struct RecordingSink(Mutex<String>, Mutex<Vec<ModelUsage>>, Mutex<String>);

impl Default for RecordingSink {
    fn default() -> Self {
        Self(
            Mutex::new(String::new()),
            Mutex::new(Vec::new()),
            Mutex::new(String::new()),
        )
    }
}

impl ModelStreamSink for RecordingSink {
    fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
        match delta {
            StreamDelta::Text { text, .. } => self.0.lock().unwrap().push_str(&text),
            StreamDelta::Reasoning { text, .. } => self.2.lock().unwrap().push_str(&text),
            StreamDelta::ToolCall { .. } => {}
            StreamDelta::Usage { usage } => self.1.lock().unwrap().push(usage),
        }
        Ok(())
    }
}

fn serve_stalled_response(
    prefix: Option<&'static [u8]>,
    headers: bool,
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request);
        if headers {
            stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                    )
                    .unwrap();
            if let Some(prefix) = prefix {
                write!(stream, "{:x}\r\n", prefix.len()).unwrap();
                stream.write_all(prefix).unwrap();
                stream.write_all(b"\r\n").unwrap();
            }
            stream.flush().unwrap();
        }
        thread::sleep(Duration::from_millis(100));
        let _ = stream.write_all(b"0\r\n\r\n");
    });
    (format!("http://{address}"), server)
}

fn serve_raw_http(response: String) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request);
        stream.write_all(response.as_bytes()).unwrap();
    });
    (format!("http://{address}"), server)
}

#[test]
fn model_exposes_only_strict_runtime_pipeline_tools() {
    let tools = default_model_tools();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        [
            "skill",
            "ask_user_question",
            "run_terminal_command",
            "read_file",
            "list_directory",
            "search_text",
            "apply_patch",
            "transfer_file",
            "call_mcp_tool",
            "update_plan",
            "spawn_one_shot_agent",
            "spawn_continuable_agent",
            "send_child_input",
            "inspect_child_agent",
            "cancel_child_agent",
            "fleet_plan",
            "fleet_start",
            "fleet_pause",
            "fleet_resume",
            "fleet_abort",
            "fleet_reconcile",
        ]
    );
    assert!(tools.iter().all(|tool| {
        tool.input_schema["type"] == "object"
            && tool.input_schema["additionalProperties"] == false
            && tool.input_schema["required"].is_array()
    }));
}

#[test]
fn minimax_cumulative_fragments_and_multiple_calls_remain_ordered_and_replayable() {
    let mut name = String::new();
    let mut arguments = String::new();
    append_fragment(&mut name, "run_terminal", true);
    append_fragment(&mut name, "run_terminal_command", true);
    append_fragment(&mut arguments, "{\"command\":\"pwd\"", true);
    append_fragment(
        &mut arguments,
        "{\"command\":\"pwd\",\"explanation\":\"inspect\"}",
        true,
    );
    assert_eq!(name, "run_terminal_command");
    let mut accumulated = ChatAccumulator {
        order: vec![ChatBlockKey::Tool(0), ChatBlockKey::Tool(1)],
        ..ChatAccumulator::default()
    };
    accumulated.calls.insert(
        0,
        ToolCallAccumulator {
            id: Some("report".into()),
            name: "report_task_outcome".into(),
            arguments: json!({ "summary": "premature" }).to_string(),
        },
    );
    accumulated.calls.insert(
        1,
        ToolCallAccumulator {
            id: Some("terminal".into()),
            name,
            arguments,
        },
    );
    let selected = accumulated.finish(true, false).unwrap();
    assert_eq!(selected.len(), 2);
    assert!(matches!(
        &selected[0],
        ModelContentBlock::ToolCall { call }
            if call.provider_call_id.as_deref() == Some("report")
    ));
    assert!(matches!(
        &selected[1],
        ModelContentBlock::ToolCall { call }
            if call.provider_call_id.as_deref() == Some("terminal")
    ));
}

#[test]
fn cumulative_chat_content_is_merged_into_exactly_one_delta_stream() {
    let recording = Arc::new(RecordingSink::default());
    let sink: Arc<dyn ModelStreamSink> = recording.clone();
    let mut accumulated = ChatAccumulator::default();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
    let mut reason = ModelFinishReason::Other;
    for data in [
        json!({ "choices": [{ "delta": { "content": "Hello" }, "finish_reason": null }] }),
        json!({
            "choices": [{ "delta": { "content": "Hello world" }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 0, "completion_tokens": 3, "total_tokens": 3 },
        }),
    ] {
        process_chat_event(
            &format!("data: {data}"),
            ProviderCapabilities {
                cumulative_stream: true,
                supports_stream_usage: true,
                native_reasoning: true,
                split_reasoning: false,
                replay_reasoning_content: true,
                think_tag_fallback: false,
                parallel_tool_calls: true,
            },
            &sink,
            &mut accumulated,
            &mut usage,
            &mut completed,
            &mut reason,
        )
        .unwrap();
    }
    assert_eq!(accumulated.content, "Hello world");
    assert_eq!(*recording.0.lock().unwrap(), "Hello world");
    assert_eq!(
        *recording.1.lock().unwrap(),
        vec![ModelUsage {
            uncached_input_tokens: Some(0),
            output_tokens: Some(3),
            total_tokens: Some(3),
            ..ModelUsage::default()
        }]
    );
    assert_eq!(usage.uncached_input_tokens, Some(0));
    assert!(completed);
    assert_eq!(reason, ModelFinishReason::Stop);
}

#[test]
fn deepseek_reasoning_text_tools_and_usage_keep_provider_order_and_detail() {
    let recording = Arc::new(RecordingSink::default());
    let sink: Arc<dyn ModelStreamSink> = recording.clone();
    let provider = AiProviderConfig {
        model_definition: None,
        profile: None,
        retry_policy: None,
        id: "deepseek".into(),
        kind: AiProviderKind::OpenAiCompatible,
        base_url: "https://api.deepseek.com".into(),
        model: "deepseek-reasoner".into(),
        reasoning_effort: None,
        requires_api_key: true,
        api_key: None,
    };
    let capabilities = provider_capabilities(&provider);
    let mut accumulated = ChatAccumulator::default();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
    let mut reason = ModelFinishReason::Other;
    for data in [
        json!({
            "choices": [{ "delta": { "reasoning_content": "inspect first" }, "finish_reason": null }]
        }),
        json!({
            "choices": [{
                "delta": {
                    "content": "I will inspect.",
                    "tool_calls": [
                        { "index": 0, "id": "provider-a", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } },
                        { "index": 1, "id": "provider-b", "function": { "name": "read_file", "arguments": "{\"path\":\"b\"}" } }
                    ]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {
                "prompt_tokens": 10,
                "prompt_cache_hit_tokens": 7,
                "prompt_cache_miss_tokens": 3,
                "completion_tokens": 5,
                "completion_tokens_details": { "reasoning_tokens": 2 },
                "total_tokens": 15
            }
        }),
    ] {
        process_chat_event(
            &format!("data: {data}"),
            capabilities,
            &sink,
            &mut accumulated,
            &mut usage,
            &mut completed,
            &mut reason,
        )
        .unwrap();
    }
    let blocks = accumulated.finish(true, false).unwrap();
    assert!(
        matches!(&blocks[0], ModelContentBlock::Reasoning { text, .. } if text == "inspect first")
    );
    assert!(matches!(&blocks[1], ModelContentBlock::Text { text } if text == "I will inspect."));
    assert!(
        matches!(&blocks[2], ModelContentBlock::ToolCall { call } if call.provider_call_id.as_deref() == Some("provider-a"))
    );
    assert!(
        matches!(&blocks[3], ModelContentBlock::ToolCall { call } if call.provider_call_id.as_deref() == Some("provider-b"))
    );
    assert_eq!(usage.uncached_input_tokens, Some(3));
    assert_eq!(usage.cache_read_tokens, Some(7));
    assert_eq!(usage.reasoning_tokens, Some(2));
    assert_eq!(*recording.2.lock().unwrap(), "inspect first");
    assert!(completed);
    assert_eq!(reason, ModelFinishReason::ToolCalls);
}

#[test]
fn qwen_and_glm_profiles_enable_native_reasoning_and_stream_usage() {
    let qwen = AiProviderConfig {
        model_definition: None,
        profile: None,
        retry_policy: None,
        id: "qwen".into(),
        kind: AiProviderKind::OpenAiCompatible,
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
        model: "qwen3.8-max".into(),
        reasoning_effort: Some("on".to_string()),
        requires_api_key: true,
        api_key: None,
    };
    let glm = AiProviderConfig {
        model_definition: None,
        profile: None,
        retry_policy: None,
        id: "glm".into(),
        kind: AiProviderKind::OpenAiCompatible,
        base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
        model: "glm-5.2".into(),
        reasoning_effort: Some("high".to_string()),
        requires_api_key: true,
        api_key: None,
    };

    let qwen_capabilities = provider_capabilities(&qwen);
    assert!(qwen_capabilities.native_reasoning);
    assert!(qwen_capabilities.supports_stream_usage);
    assert!(qwen_capabilities.replay_reasoning_content);

    let glm_capabilities = provider_capabilities(&glm);
    assert!(glm_capabilities.native_reasoning);
    assert!(glm_capabilities.supports_stream_usage);
    assert!(glm_capabilities.replay_reasoning_content);
}

#[test]
fn minimax_cumulative_reasoning_text_and_tool_fragments_are_deduplicated() {
    let recording = Arc::new(RecordingSink::default());
    let sink: Arc<dyn ModelStreamSink> = recording.clone();
    let provider = AiProviderConfig {
        model_definition: None,
        profile: None,
        retry_policy: None,
        id: "minimax".into(),
        kind: AiProviderKind::OpenAiCompatible,
        base_url: "https://api.minimaxi.com".into(),
        model: "MiniMax-M2.7".into(),
        reasoning_effort: None,
        requires_api_key: true,
        api_key: None,
    };
    let capabilities = provider_capabilities(&provider);
    let mut accumulated = ChatAccumulator::default();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
    let mut reason = ModelFinishReason::Other;
    for data in [
        json!({ "choices": [{ "delta": { "reasoning_details": [{ "text": "plan" }] }, "finish_reason": null }] }),
        json!({ "choices": [{ "delta": { "reasoning_content": "plan safely", "content": "Ready" }, "finish_reason": null }] }),
        json!({ "choices": [{ "delta": {
                "reasoning_content": "plan safely",
                "content": "Ready now",
                "tool_calls": [{ "index": 0, "id": "provider", "function": { "name": "read", "arguments": "{\"path\":" } }]
            }, "finish_reason": null }] }),
        json!({ "choices": [{ "delta": {
                "reasoning_content": "plan safely",
                "content": "Ready now",
                "tool_calls": [{ "index": 0, "id": "provider", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } }]
            }, "finish_reason": "tool_calls" }] }),
    ] {
        process_chat_event(
            &format!("data: {data}"),
            capabilities,
            &sink,
            &mut accumulated,
            &mut usage,
            &mut completed,
            &mut reason,
        )
        .unwrap();
    }
    let blocks = accumulated.finish(true, false).unwrap();
    assert!(
        matches!(&blocks[0], ModelContentBlock::Reasoning { text, .. } if text == "plan safely")
    );
    assert!(matches!(&blocks[1], ModelContentBlock::Text { text } if text == "Ready now"));
    assert!(
        matches!(&blocks[2], ModelContentBlock::ToolCall { call } if call.name == "read_file" && call.arguments == json!({"path": "a"}))
    );
    assert_eq!(*recording.2.lock().unwrap(), "plan safely");
    assert_eq!(*recording.0.lock().unwrap(), "Ready now");
}

#[test]
fn think_tag_fallback_becomes_structured_reasoning_without_ui_parsing() {
    let mut accumulated = ChatAccumulator::default();
    accumulated.order.push(ChatBlockKey::Text);
    accumulated.content = "<think>check constraints</think>Final answer".into();
    assert_eq!(
        accumulated.finish(false, true).unwrap(),
        vec![
            ModelContentBlock::Reasoning {
                text: "check constraints".into(),
                provider_item: None,
            },
            ModelContentBlock::Text {
                text: "Final answer".into(),
            },
        ]
    );
}

#[test]
fn openai_reasoning_items_replay_exactly_and_keep_output_order() {
    let reasoning = json!({
        "type": "reasoning",
        "id": "rs_1",
        "summary": [{ "type": "summary_text", "text": "checked constraints" }],
        "encrypted_content": "opaque-provider-state"
    });
    let content = vec![ModelContentBlock::Reasoning {
        text: "checked constraints".into(),
        provider_item: Some(reasoning.clone()),
    }];
    assert_eq!(
        responses_input(&[ModelMessage::Assistant {
            content,
            replay: None,
            native_replay: None,
        }]),
        vec![reasoning.clone()]
    );
    let blocks = responses_output_blocks(BTreeMap::from([
            (0, reasoning.clone()),
            (1, json!({ "type": "message", "content": [{ "type": "output_text", "text": "done" }] })),
            (2, json!({ "type": "function_call", "call_id": "provider-call", "name": "read_file", "arguments": "{\"path\":\"a\"}" })),
        ]))
        .unwrap();
    assert!(
        matches!(&blocks[0], ModelContentBlock::Reasoning { provider_item: Some(item), .. } if item == &reasoning)
    );
    assert!(matches!(&blocks[1], ModelContentBlock::Text { text } if text == "done"));
    assert!(
        matches!(&blocks[2], ModelContentBlock::ToolCall { call } if call.provider_call_id.as_deref() == Some("provider-call"))
    );
}

#[test]
fn provider_errors_are_typed_for_retry_auth_rate_limit_and_context() {
    assert_eq!(
        normalize_provider_error(503, "unavailable").kind,
        NormalizedModelErrorKind::Retryable
    );
    assert_eq!(
        normalize_provider_error(401, "bad token").kind,
        NormalizedModelErrorKind::Authentication
    );
    assert_eq!(
        normalize_provider_error(429, "slow down").kind,
        NormalizedModelErrorKind::RateLimited
    );
    assert_eq!(
        normalize_provider_error(400, "maximum context length exceeded").kind,
        NormalizedModelErrorKind::ContextTooLarge
    );
    let permanent = normalize_provider_error(422, "invalid request");
    assert_eq!(permanent.kind, NormalizedModelErrorKind::Terminal);
    assert!(!permanent.retryable());
    assert!(normalize_provider_error(503, "unavailable").retryable());
}

#[test]
fn retry_after_accepts_seconds_and_imf_fixdate() {
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    assert_eq!(parse_retry_after("7", now), Some(7_000));
    let date = httpdate::fmt_http_date(now + Duration::from_secs(3));
    assert_eq!(parse_retry_after(&date, now), Some(3_000));
    assert_eq!(parse_retry_after("not-a-date", now), None);
    assert_eq!(
        parse_retry_after(&httpdate::fmt_http_date(now - Duration::from_secs(1)), now),
        None
    );
}

#[tokio::test]
async fn http_429_and_503_preserve_retry_after_seconds_and_dates() {
    let date = httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(3));
    for (status, retry_after, expected_kind) in [
        (429, "2".to_string(), NormalizedModelErrorKind::RateLimited),
        (503, date, NormalizedModelErrorKind::Retryable),
    ] {
        let body = "busy";
        let response = format!(
                "HTTP/1.1 {status} Error\r\nContent-Length: {}\r\nRetry-After: {retry_after}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        let (url, server) = serve_raw_http(response);
        let response = build_streaming_client()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        let error = checked_stream_response(
            response,
            &CancellationToken::new(),
            ModelTimeoutPolicy::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, expected_kind);
        assert_eq!(error.status, Some(status));
        if status == 429 {
            assert_eq!(error.retry_after_ms, Some(2_000));
        } else {
            assert!(error.retry_after_ms.is_some_and(|delay| delay <= 3_000));
            assert!(error.retry_after_ms.is_some_and(|delay| delay >= 1_000));
        }
        server.join().unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn stream_deadline_separates_first_byte_from_idle_timeout() {
    let timeouts = ModelTimeoutPolicy {
        request_headers: Duration::from_secs(1),
        first_byte: Duration::from_secs(2),
        stream_idle: Duration::from_secs(5),
    };
    let mut first_byte = StreamDeadline::new(timeouts);
    first_byte.timer.as_mut().await;
    assert_eq!(
        first_byte.timeout_error().code.as_deref(),
        Some("FIRST_BYTE_TIMEOUT")
    );

    let mut idle = StreamDeadline::new(timeouts);
    idle.observe_bytes(1);
    idle.timer.as_mut().await;
    assert_eq!(
        idle.timeout_error().code.as_deref(),
        Some("STREAM_IDLE_TIMEOUT")
    );
}

#[tokio::test(start_paused = true)]
async fn active_stream_can_run_beyond_the_removed_120_second_total_timeout() {
    let timeouts = ModelTimeoutPolicy {
        request_headers: Duration::from_secs(1),
        first_byte: Duration::from_secs(10),
        stream_idle: Duration::from_secs(61),
    };
    let mut deadline = StreamDeadline::new(timeouts);
    deadline.observe_bytes(1);
    for _ in 0..5 {
        tokio::time::advance(Duration::from_secs(60)).await;
        assert!(!deadline.timer.is_elapsed());
        deadline.observe_frame();
    }
    assert!(!deadline.timer.is_elapsed());
}

#[tokio::test(start_paused = true)]
async fn cancellation_wins_while_waiting_for_first_byte_or_idle() {
    for first_byte_seen in [false, true] {
        let cancellation = CancellationToken::new();
        let mut deadline = StreamDeadline::new(ModelTimeoutPolicy {
            request_headers: Duration::from_secs(1),
            first_byte: Duration::from_secs(30),
            stream_idle: Duration::from_secs(30),
        });
        if first_byte_seen {
            deadline.observe_bytes(1);
        }
        cancellation.cancel();
        let cancelled = tokio::select! {
            _ = cancellation.cancelled() => true,
            _ = deadline.timer.as_mut() => false,
        };
        assert!(cancelled);
    }
}

#[tokio::test]
async fn connection_and_response_header_failures_are_retryable_and_typed() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let unused = listener.local_addr().unwrap();
    drop(listener);
    let timeouts = ModelTimeoutPolicy {
        request_headers: Duration::from_millis(20),
        first_byte: Duration::from_secs(1),
        stream_idle: Duration::from_secs(1),
    };
    let connection = build_streaming_client()
        .unwrap()
        .get(format!("http://{unused}"))
        .send()
        .await
        .map_err(normalize_transport_error)
        .unwrap_err();
    assert_eq!(connection.kind, NormalizedModelErrorKind::Transport);
    assert_eq!(connection.code.as_deref(), Some("CONNECT"));

    let (url, server) = serve_stalled_response(None, false);
    let headers = send_request(
        build_streaming_client().unwrap().get(url),
        &CancellationToken::new(),
        timeouts,
    )
    .await
    .unwrap_err();
    assert_eq!(headers.kind, NormalizedModelErrorKind::Timeout);
    assert_eq!(headers.code.as_deref(), Some("REQUEST_HEADERS_TIMEOUT"));
    server.join().unwrap();
}

#[tokio::test]
async fn live_stream_distinguishes_first_byte_and_idle_timeouts() {
    let timeouts = ModelTimeoutPolicy {
        request_headers: Duration::from_secs(1),
        first_byte: Duration::from_millis(20),
        stream_idle: Duration::from_millis(20),
    };
    for (prefix, expected) in [
        (None, "FIRST_BYTE_TIMEOUT"),
        (
            Some(b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n".as_slice()),
            "STREAM_IDLE_TIMEOUT",
        ),
    ] {
        let (url, server) = serve_stalled_response(prefix, true);
        let response = send_request(
            build_streaming_client().unwrap().get(url),
            &CancellationToken::new(),
            timeouts,
        )
        .await
        .unwrap();
        let error = stream_chat(
            response,
            &CancellationToken::new(),
            Arc::new(RecordingSink::default()),
            provider_capabilities(&AiProviderConfig {
                model_definition: Some(crate::llm::catalog::fixture_definition(
                    AiProviderKind::OpenAiCompatible,
                    65536,
                )),
                profile: None,
                retry_policy: None,
                id: "timeout-test".into(),
                kind: AiProviderKind::OpenAiCompatible,
                base_url: "http://127.0.0.1".into(),
                model: "test".into(),
                reasoning_effort: None,
                requires_api_key: false,
                api_key: None,
            }),
            timeouts,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code.as_deref(), Some(expected));
        server.join().unwrap();
    }
}

#[test]
fn every_request_is_built_only_from_the_supplied_surface() {
    let surface = AgentSurfaceSnapshot {
        generation: 4,
        replaced_through_seq: None,
        messages: vec![AgentSurfaceMessage::User {
            message_id: "message-1".into(),
            content: "current surface".into(),
            source: crate::agent_runtime::AgentMessageSource::user(),
        }],
    };
    let request =
        ModelRequest::from_surface("request-1".into(), &surface, "system".into(), Vec::new());
    assert_eq!(request.surface_generation, 4);
    assert_eq!(
        request.messages,
        vec![ModelMessage::User {
            content: "current surface".into()
        }]
    );
}

#[test]
fn structured_assistant_and_tool_history_replays_in_committed_order() {
    let provider_item = json!({
        "type": "reasoning",
        "id": "reasoning-1",
        "summary": [{ "type": "summary_text", "text": "inspect" }]
    });
    let recorded_call = RecordedToolCall {
        call_id: "call-1".into(),
        provider_call_id: Some("provider-call-1".into()),
        name: "read_file".into(),
        native_name: None,
        arguments: json!({"path": "a"}),
        title: None,
        effect: None,
        target: None,
    };
    let surface = AgentSurfaceSnapshot {
        generation: 2,
        replaced_through_seq: Some(5),
        messages: vec![
            AgentSurfaceMessage::Assistant {
                message_id: "assistant-1".into(),
                content: vec![
                    AgentAssistantContentBlock::Reasoning {
                        text: "inspect".into(),
                        provider_item: Some(provider_item.clone()),
                    },
                    AgentAssistantContentBlock::Text {
                        text: "reading".into(),
                    },
                    AgentAssistantContentBlock::ToolCall {
                        call: Box::new(recorded_call),
                    },
                ],
                interrupted: false,
                replay: None,
            },
            AgentSurfaceMessage::Tool {
                call_id: "call-1".into(),
                name: "read_file".into(),
                status: crate::agent_runtime::AgentToolResultStatus::Completed,
                content: "file contents".into(),
            },
        ],
    };
    let request = ModelRequest::from_surface(
        "request-history".into(),
        &surface,
        "system".into(),
        Vec::new(),
    );
    assert!(matches!(
        &request.messages[0],
        ModelMessage::Assistant { content, .. }
            if matches!(&content[0], ModelContentBlock::Reasoning { provider_item: None, .. })
                && matches!(&content[1], ModelContentBlock::Text { text } if text == "reading")
                && matches!(&content[2], ModelContentBlock::ToolCall { call } if call.provider_call_id.is_none())
    ));
    assert!(matches!(
        &request.messages[1],
        ModelMessage::Tool { provider_call_id: None, content, .. }
            if content == "file contents"
    ));
    assert_eq!(
        responses_input(&request.messages),
        vec![
            json!({ "role": "assistant", "content": "reading" }),
            json!({
                "type": "function_call",
                "call_id": "call-1",
                "name": "read_file",
                "arguments": "{\"path\":\"a\"}"
            }),
            json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "file contents"
            }),
        ]
    );
}

#[tokio::test]
async fn cross_domain_responses_wire_never_contains_old_native_state() {
    let sse = concat!(
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_new\",\"model\":\"model-a\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"READY\"}]}]}}\n\n"
    )
    .to_string();
    let (base_url, body_receiver, server) = serve_recording_sse(sse);
    let definition = crate::llm::catalog::fixture_definition(AiProviderKind::OpenAi, 8192);
    let source_snapshot = crate::llm::runtime::RequestSnapshot::Prepared {
        route_id: "route-a".into(),
        route_revision: 7,
        adapter_id: "responses".into(),
        model_id: "model-a".into(),
        catalog_version: 1,
        capabilities: definition.clone(),
        endpoint_identity: "https://old-account.example/v1/responses".into(),
        replay_domain_id: "old-account-domain".into(),
        reasoning_effort: None,
        output_tokens: 8192,
        retry_policy: Default::default(),
        timeouts: crate::llm::routes::RouteTimeouts::default(),
        purpose: "step".into(),
        preparation_version: 1,
        projection_policy: "immutable-png-v1-strict".into(),
        content_hash: crate::llm::runtime::digest(b"old-request"),
        images: Vec::new(),
    };
    let canonical = vec![
        ModelContentBlock::Reasoning {
            text: "display plan".into(),
            provider_item: None,
        },
        ModelContentBlock::Text {
            text: "reading".into(),
        },
        ModelContentBlock::ToolCall {
            call: ModelToolCall {
                call_id: "call-1".into(),
                provider_call_id: Some("old-provider-call".into()),
                name: "read_file".into(),
                arguments: json!({"path":"a"}),
            },
        },
    ];
    let envelope = crate::llm::replay::prepare_envelope(
        crate::llm::registry::replay_codec("responses").unwrap(),
        "old-request-1",
        &source_snapshot,
        &canonical,
        crate::llm::types::AdapterReplayCapture {
            response: json!({"responseId":"old-response-id","model":"model-a"}),
            blocks: vec![
                json!({"nativeItem":{"type":"reasoning","id":"old-reasoning-id","summary":[{"type":"summary_text","text":"display plan"}],"encrypted_content":"old-private-state"}}),
                json!({}),
                json!({"providerCallId":"old-provider-call","providerItemId":"old-function-item"}),
            ],
        },
    )
    .unwrap();
    let mut untrusted_content = canonical.clone();
    if let ModelContentBlock::Reasoning { provider_item, .. } = &mut untrusted_content[0] {
        *provider_item = Some(json!({"type":"reasoning","id":"legacy-provider-item-bypass"}));
    }
    let provider = AiProviderConfig {
        id: "route-a".into(),
        kind: AiProviderKind::OpenAi,
        base_url: base_url.clone(),
        model: "model-a".into(),
        requires_api_key: true,
        api_key: None,
        reasoning_effort: None,
        profile: None,
        model_definition: Some(definition.clone()),
        retry_policy: None,
    };
    let adapter = HttpModelAdapterFactory
        .create(provider.clone(), Some("fixture-key".into()))
        .unwrap();
    let prepared = crate::llm::runtime::PreparedModel {
        provider,
        adapter,
        route: Some(crate::llm::routes::ProviderRoute {
            id: "route-a".into(),
            revision: 8,
            display_name: "Rotated account".into(),
            adapter_id: "responses".into(),
            base_url,
            auth: crate::llm::routes::RouteAuth::Keychain {
                reference: "new-key-version".into(),
            },
            replay_domain_id: "new-account-domain".into(),
            preset_id: None,
            models: Some(BTreeMap::from([("model-a".into(), definition)])),
            model_overrides: None,
            defaults: None,
            retry_policy: Default::default(),
            timeouts: Default::default(),
        }),
        images: None,
    };
    let call = prepared
        .prepare_request(
            ModelRequest {
                request_id: "new-request".into(),
                surface_generation: 0,
                system_prompt: "system".into(),
                messages: vec![
                    ModelMessage::Assistant {
                        content: untrusted_content,
                        replay: Some(envelope),
                        native_replay: None,
                    },
                    ModelMessage::Tool {
                        call_id: "call-1".into(),
                        provider_call_id: Some("old-provider-call".into()),
                        name: "read_file".into(),
                        content: "contents".into(),
                    },
                    ModelMessage::User {
                        content: "continue".into(),
                    },
                ],
                tools: Vec::new(),
            },
            "step",
            &CancellationToken::new(),
        )
        .unwrap();
    let response = call
        .stream(
            "new-request".into(),
            CancellationToken::new(),
            Arc::new(RecordingSink::default()),
        )
        .await
        .unwrap();
    assert!(matches!(
        response.replay_envelope,
        Some(crate::llm::replay::ReplayEnvelopeV5::Prepared { response, .. })
            if response.get("responseId").and_then(Value::as_str) == Some("resp_new")
    ));
    let body = body_receiver.recv().unwrap();
    server.join().unwrap();
    let encoded = serde_json::to_string(&body).unwrap();
    for forbidden in [
        "old-provider-call",
        "old-response-id",
        "old-reasoning-id",
        "old-private-state",
        "old-function-item",
        "legacy-provider-item-bypass",
    ] {
        assert!(
            !encoded.contains(forbidden),
            "wire leaked {forbidden}: {encoded}"
        );
    }
    assert!(encoded.contains("call-1"));
}

fn serve_recording_sse(sse: String) -> (String, mpsc::Receiver<Value>, thread::JoinHandle<()>) {
    serve_gated_recording_sse(sse, String::new(), None)
}

fn serve_gated_recording_sse(
    first: String,
    tail: String,
    release_tail: Option<mpsc::Receiver<()>>,
) -> (String, mpsc::Receiver<Value>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        let (header_end, content_length) = loop {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "request ended before its body was complete");
            request.extend_from_slice(&chunk[..read]);
            if let Some(header_end) = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4)
            {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length: ")
                            .or_else(|| line.strip_prefix("Content-Length: "))
                    })
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap();
                break (header_end, content_length);
            }
        };
        while request.len() < header_end + content_length {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "request ended before its body was complete");
            request.extend_from_slice(&chunk[..read]);
        }
        let body =
            serde_json::from_slice::<Value>(&request[header_end..header_end + content_length])
                .unwrap();
        sender.send(body).unwrap();
        write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                first.len() + tail.len(),
                first,
            )
            .unwrap();
        if let Some(release) = release_tail {
            release.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        stream.write_all(tail.as_bytes()).unwrap();
    });
    (format!("http://{address}"), receiver, handle)
}

#[tokio::test]
async fn chat_usage_after_finish_reason_in_a_separate_http_chunk_is_retained() {
    struct ReleaseTailSink(mpsc::Sender<()>, RecordingSink);
    impl ModelStreamSink for ReleaseTailSink {
        fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
            if matches!(delta, StreamDelta::Text { .. }) {
                self.0.send(()).unwrap();
            }
            self.1.emit(delta)
        }
    }
    let (release, after_first_frame) = mpsc::channel();
    let (base_url, body, server) = serve_gated_recording_sse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"READY\"},\"finish_reason\":\"stop\"}]}\n\n".into(),
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":3,\"total_tokens\":11}}\n\ndata: [DONE]\n\n".into(),
            Some(after_first_frame),
        );
    let provider = AiProviderConfig {
        model_definition: None,
        profile: Some("minimax".into()),
        retry_policy: None,
        id: "split-usage".into(),
        kind: AiProviderKind::OpenAiCompatible,
        base_url,
        model: "MiniMax-M2.7".into(),
        reasoning_effort: None,
        requires_api_key: false,
        api_key: None,
    };
    let sink = Arc::new(ReleaseTailSink(release, RecordingSink::default()));
    let response = ModelRegistry::default()
        .resolve(provider, None)
        .unwrap()
        .stream(
            ModelRequest {
                request_id: "split-usage".into(),
                surface_generation: 0,
                system_prompt: "system".into(),
                messages: Vec::new(),
                tools: Vec::new(),
            },
            CancellationToken::new(),
            sink.clone(),
        )
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(
        body.recv()
            .unwrap()
            .pointer("/stream_options/include_usage"),
        Some(&Value::Bool(true))
    );
    assert_eq!(response.usage.total_tokens, Some(11));
    assert_eq!(response.usage.output_tokens, Some(3));
    assert_eq!(sink.1 .0.lock().unwrap().as_str(), "READY");
    assert_eq!(sink.1 .1.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn chat_finish_boundary_handles_clean_eof_disconnect_cancel_and_idle() {
    struct ObservedSink(Arc<tokio::sync::Notify>, RecordingSink);
    impl ModelStreamSink for ObservedSink {
        fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
            if matches!(delta, StreamDelta::Text { .. }) {
                self.0.notify_one();
            }
            self.1.emit(delta)
        }
    }
    for boundary in ["clean-eof", "disconnect", "cancel", "idle"] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, hold) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let received = socket.read(&mut request).unwrap();
            assert!(received > 0, "test request ended before its first bytes");
            let frame = "data: {\"choices\":[{\"delta\":{\"content\":\"READY\"},\"finish_reason\":\"stop\"}]}\n\n";
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{frame}\r\n", frame.len()).unwrap();
            let clean = hold.recv_timeout(Duration::from_secs(5)).unwrap();
            if clean {
                let _ = socket.write_all(b"0\r\n\r\n");
            }
        });
        let timeouts = ModelTimeoutPolicy {
            request_headers: Duration::from_secs(2),
            first_byte: Duration::from_secs(2),
            stream_idle: Duration::from_secs(2),
        };
        let cancel = CancellationToken::new();
        let response = send_request(
            build_streaming_client()
                .unwrap()
                .get(format!("http://{address}")),
            &cancel,
            timeouts,
        )
        .await
        .unwrap();
        let observed = Arc::new(tokio::sync::Notify::new());
        let sink = Arc::new(ObservedSink(observed.clone(), RecordingSink::default()));
        let task_cancel = cancel.clone();
        let task_sink = sink.clone();
        let mut task = tokio::spawn(async move {
            stream_chat(
                response,
                &task_cancel,
                task_sink,
                ProviderCapabilities {
                    cumulative_stream: false,
                    supports_stream_usage: true,
                    native_reasoning: false,
                    split_reasoning: false,
                    replay_reasoning_content: false,
                    think_tag_fallback: true,
                    parallel_tool_calls: false,
                },
                timeouts,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), observed.notified())
            .await
            .unwrap();
        assert!(
            !task.is_finished(),
            "{boundary}: finish_reason closed the stream early"
        );
        let result = match boundary {
            "clean-eof" | "disconnect" => {
                release.send(boundary == "clean-eof").unwrap();
                tokio::time::timeout(Duration::from_secs(2), &mut task)
                    .await
                    .unwrap()
                    .unwrap()
            }
            "cancel" => {
                cancel.cancel();
                let result = tokio::time::timeout(Duration::from_secs(2), &mut task)
                    .await
                    .unwrap()
                    .unwrap();
                release.send(true).unwrap();
                result
            }
            _ => {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(3)).await;
                let result = task.await.unwrap();
                tokio::time::resume();
                release.send(true).unwrap();
                result
            }
        };
        server.join().unwrap();
        if boundary == "clean-eof" {
            let response = result.unwrap();
            assert_eq!(response.usage, ModelUsage::default());
            assert_eq!(
                response.content,
                vec![ModelContentBlock::Text {
                    text: "READY".into()
                }]
            );
        } else {
            let error = result.unwrap_err();
            assert_eq!(
                error.kind,
                match boundary {
                    "cancel" => NormalizedModelErrorKind::Cancelled,
                    "idle" => NormalizedModelErrorKind::Timeout,
                    _ => NormalizedModelErrorKind::Transport,
                }
            );
            if boundary == "idle" {
                assert_eq!(error.code.as_deref(), Some("STREAM_IDLE_TIMEOUT"));
            }
        }
        assert_eq!(sink.1 .0.lock().unwrap().as_str(), "READY");
    }
}

#[tokio::test]
async fn actual_chat_request_body_matches_the_assembled_prompt_and_canonical_tools() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"READY\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let (base_url, body_receiver, server) = serve_recording_sse(sse);
    let provider = AiProviderConfig {
        model_definition: None,
        profile: Some("minimax".into()),
        retry_policy: None,
        id: "wire-minimax".into(),
        kind: AiProviderKind::OpenAiCompatible,
        base_url,
        model: "MiniMax-M2.7".into(),
        reasoning_effort: None,
        requires_api_key: false,
        api_key: None,
    };
    let tool = AgentRequestToolSchema {
        name: "read_file".into(),
        description: "Read a bounded file.".into(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["path"],
            "properties": { "path": { "type": "string" } }
        }),
    };
    let request = ModelRequest {
        request_id: "wire-request".into(),
        surface_generation: 9,
        system_prompt: "exact assembled system prompt".into(),
        messages: vec![ModelMessage::User {
            content: "Say READY".into(),
        }],
        tools: vec![tool.clone()],
    };
    let adapter = HttpModelAdapterFactory.create(provider, None).unwrap();
    let response = adapter
        .stream(
            request.clone(),
            CancellationToken::new(),
            Arc::new(RecordingSink::default()),
        )
        .await
        .unwrap();
    let body = body_receiver.recv().unwrap();
    server.join().unwrap();
    assert_eq!(
        body.pointer("/messages/0/content").and_then(Value::as_str),
        Some(request.system_prompt.as_str())
    );
    assert_eq!(
        body.pointer("/tools/0/function/parameters"),
        Some(&tool.input_schema)
    );
    assert_eq!(
        body.pointer("/stream_options/include_usage")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        body.get("reasoning_split").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        response.content,
        vec![ModelContentBlock::Text {
            text: "READY".into()
        }]
    );
}

#[tokio::test]
async fn generic_compatible_request_omits_unsupported_stream_usage_options() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let (base_url, body_receiver, server) = serve_recording_sse(sse);
    let adapter = HttpModelAdapterFactory
        .create(
            AiProviderConfig {
                model_definition: Some(crate::llm::catalog::fixture_definition(
                    AiProviderKind::OpenAiCompatible,
                    65536,
                )),
                profile: None,
                retry_policy: None,
                id: "wire-compatible".into(),
                kind: AiProviderKind::OpenAiCompatible,
                base_url,
                model: "generic-chat-model".into(),
                reasoning_effort: None,
                requires_api_key: false,
                api_key: None,
            },
            None,
        )
        .unwrap();
    let response = adapter
        .stream(
            ModelRequest {
                request_id: "wire-generic".into(),
                surface_generation: 0,
                system_prompt: "system".into(),
                messages: Vec::new(),
                tools: Vec::new(),
            },
            CancellationToken::new(),
            Arc::new(RecordingSink::default()),
        )
        .await
        .unwrap();
    let body = body_receiver.recv().unwrap();
    server.join().unwrap();
    assert!(body.get("stream_options").is_none());
    assert!(body.get("parallel_tool_calls").is_none());
    assert_eq!(response.usage, ModelUsage::default());
    assert_eq!(
        response.content,
        vec![ModelContentBlock::Text { text: "ok".into() }]
    );
    assert!(!response
        .content
        .iter()
        .any(|block| matches!(block, ModelContentBlock::Reasoning { .. })));
}

async fn run_live_provider_basic_round(
    prefix: &str,
    kind: AiProviderKind,
    default_base_url: &str,
    default_model: &str,
    reasoning_effort: Option<crate::ai::AiReasoningEffort>,
    requires_api_key: bool,
    require_reasoning: bool,
    forbid_reasoning: bool,
    require_usage: bool,
) {
    let base_url = std::env::var(format!("SHELLSPAN_LIVE_{prefix}_BASE_URL"))
        .unwrap_or_else(|_| default_base_url.to_string());
    let model = std::env::var(format!("SHELLSPAN_LIVE_{prefix}_MODEL"))
        .unwrap_or_else(|_| default_model.to_string());
    let api_key = std::env::var(format!("SHELLSPAN_LIVE_{prefix}_API_KEY")).ok();
    if requires_api_key && api_key.is_none() {
        panic!("SHELLSPAN_LIVE_{prefix}_API_KEY is required for this ignored live test");
    }
    let provider = AiProviderConfig {
        model_definition: Some(crate::llm::catalog::fixture_definition(
            AiProviderKind::OpenAiCompatible,
            65536,
        )),
        profile: match prefix {
            "OPENAI" => Some("openai".into()),
            "OLLAMA" => Some("ollama".into()),
            "DEEPSEEK" => Some("deepseek".into()),
            "MINIMAX" => Some("minimax".into()),
            "QWEN" => Some("qwen".into()),
            "GLM" => Some("glm".into()),
            "KIMI" => Some("kimi".into()),
            _ => None,
        },
        retry_policy: None,
        id: format!("live-{}", prefix.to_ascii_lowercase()),
        kind,
        base_url,
        model,
        reasoning_effort,
        requires_api_key,
        api_key: None,
    };
    let model_label = provider.model.clone();
    let adapter = ModelRegistry::default().resolve(provider, api_key).unwrap();
    let surface = AgentSurfaceSnapshot {
        generation: 0,
        replaced_through_seq: None,
        messages: vec![AgentSurfaceMessage::User {
            message_id: "live-message".into(),
            content: if require_reasoning {
                "Which is greater, 9.11 or 9.8? Answer briefly.".into()
            } else {
                "Reply briefly with READY.".into()
            },
            source: crate::agent_runtime::AgentMessageSource::user(),
        }],
    };
    let response = adapter
        .stream(
            ModelRequest::from_surface(
                "live-request".into(),
                &surface,
                "You are a concise test assistant.".into(),
                Vec::new(),
            ),
            CancellationToken::new(),
            Arc::new(RecordingSink::default()),
        )
        .await
        .unwrap_or_else(|error| {
            panic!("live provider failed: {:?}: {}", error.kind, error.message)
        });
    println!(
        "LIVE_EVIDENCE {}",
        json!({
            "profile": prefix, "model": model_label, "requests": 1,
            "finishReason": response.finish_reason, "usage": response.usage,
            "blocks": response.content.iter().map(|block| match block {
                ModelContentBlock::Text { text } => json!({"kind":"text", "bytes":text.len()}),
                ModelContentBlock::Reasoning { text, .. } => json!({"kind":"reasoning", "bytes":text.len()}),
                ModelContentBlock::ToolCall { .. } => json!({"kind":"toolCall"}),
            }).collect::<Vec<_>>()
        })
    );
    assert!(
        response.content.iter().any(|block| matches!(
            block,
            ModelContentBlock::Text { text } if !text.trim().is_empty()
        )),
        "live provider returned no answer text"
    );
    if require_reasoning {
        let block_kinds = response
            .content
            .iter()
            .map(|block| match block {
                ModelContentBlock::Text { .. } => "text",
                ModelContentBlock::Reasoning { .. } => "reasoning",
                ModelContentBlock::ToolCall { .. } => "toolCall",
            })
            .collect::<Vec<_>>();
        assert!(
                response.content.iter().any(|block| matches!(
                    block,
                    ModelContentBlock::Reasoning { text, .. } if !text.trim().is_empty()
                )),
                "live provider returned no structured reasoning; blocks={block_kinds:?}, reasoning_tokens={:?}, total_tokens={:?}",
                response.usage.reasoning_tokens,
                response.usage.total_tokens,
            );
    } else if forbid_reasoning {
        assert!(
            !response.content.iter().any(|block| matches!(
                block,
                ModelContentBlock::Reasoning { text, .. } if !text.trim().is_empty()
            )),
            "live provider returned reasoning while thinking was disabled"
        );
    }
    if require_usage {
        assert!(
            response.usage.uncached_input_tokens.is_some()
                || response.usage.cache_read_tokens.is_some()
                || response.usage.cache_write_tokens.is_some()
                || response.usage.output_tokens.is_some()
                || response.usage.reasoning_tokens.is_some()
                || response.usage.total_tokens.is_some(),
            "live provider returned no usage facts"
        );
    }
}

#[tokio::test]
#[ignore = "requires SHELLSPAN_LIVE_OPENAI_API_KEY and external network access"]
async fn live_provider_basic_round_openai() {
    run_live_provider_basic_round(
        "OPENAI",
        AiProviderKind::OpenAi,
        "https://api.openai.com",
        "gpt-5.4-mini",
        None,
        true,
        false,
        false,
        false,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires SHELLSPAN_LIVE_DEEPSEEK_API_KEY and external network access"]
async fn live_provider_basic_round_deepseek() {
    run_live_provider_basic_round(
        "DEEPSEEK",
        AiProviderKind::OpenAiCompatible,
        "https://api.deepseek.com",
        "deepseek-v4-flash",
        Some("high".to_string()),
        true,
        true,
        false,
        true,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires SHELLSPAN_LIVE_DEEPSEEK_API_KEY and external network access"]
async fn live_provider_basic_round_deepseek_no_reasoning() {
    run_live_provider_basic_round(
        "DEEPSEEK",
        AiProviderKind::OpenAiCompatible,
        "https://api.deepseek.com",
        "deepseek-v4-flash",
        Some("off".to_string()),
        true,
        false,
        true,
        true,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires SHELLSPAN_LIVE_KIMI_API_KEY and external network access"]
async fn live_provider_basic_round_kimi() {
    run_live_provider_basic_round(
        "KIMI",
        AiProviderKind::OpenAiCompatible,
        "https://api.kimi.com/coding",
        "k3",
        None,
        true,
        false,
        false,
        false,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires SHELLSPAN_LIVE_MINIMAX_API_KEY and external network access"]
async fn live_provider_basic_round_minimax() {
    run_live_provider_basic_round(
        "MINIMAX",
        AiProviderKind::OpenAiCompatible,
        "https://api.minimaxi.com",
        "MiniMax-M2.7",
        None,
        true,
        true,
        false,
        true,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires a local Ollama service and model"]
async fn live_provider_basic_round_ollama() {
    run_live_provider_basic_round(
        "OLLAMA",
        AiProviderKind::Ollama,
        "http://127.0.0.1:11434",
        "qwen3",
        None,
        false,
        false,
        false,
        false,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires a configured OpenAI-compatible service"]
async fn live_provider_basic_round_compatible() {
    run_live_provider_basic_round(
        "COMPATIBLE",
        AiProviderKind::OpenAiCompatible,
        "http://127.0.0.1:1234",
        "generic-chat-model",
        None,
        false,
        false,
        true,
        false,
    )
    .await;
}
#[tokio::test]
#[ignore = "requires SHELLSPAN_LIVE_QWEN_API_KEY"]
async fn live_provider_basic_round_qwen() {
    run_live_provider_basic_round(
        "QWEN",
        AiProviderKind::OpenAiCompatible,
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "qwen3-235b-a22b",
        Some("on".to_string()),
        true,
        true,
        false,
        true,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires SHELLSPAN_LIVE_GLM_API_KEY"]
async fn live_provider_basic_round_glm() {
    run_live_provider_basic_round(
        "GLM",
        AiProviderKind::OpenAiCompatible,
        "https://open.bigmodel.cn/api/paas/v4",
        "glm-5",
        Some("on".to_string()),
        true,
        true,
        false,
        true,
    )
    .await;
}

#[tokio::test]
async fn every_profile_proxy_request_stream_usage_and_history_fixture() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../src/lib/__tests__/provider-contract-fixtures.json"
    ))
    .unwrap();
    for fixture in fixtures {
        let mut provider: AiProviderConfig =
            serde_json::from_value(fixture["provider"].clone()).unwrap();
        let mut declared = crate::llm::catalog::resolve(&provider).unwrap().definition;
        declared.context_window = 32768;
        declared.max_output_tokens = 16384;
        provider.model_definition = Some(declared);
        let profile = provider.profile.clone().unwrap();
        let sse = match provider.kind {
                AiProviderKind::OpenAi => concat!(
                    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"READY\"}\n\n",
                    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"READY\"}]}],\"usage\":{\"input_tokens\":8,\"output_tokens\":3,\"total_tokens\":11}}}\n\n").to_string(),
                AiProviderKind::Ollama => "{\"message\":{\"role\":\"assistant\",\"content\":\"READY\",\"thinking\":\"plan\"},\"done\":true,\"prompt_eval_count\":8,\"eval_count\":3}\n".into(),
                AiProviderKind::OpenAiCompatible => {
                    let reasoning = if profile == "minimax" { json!({"reasoning_details":[{"type":"reasoning.text","text":"plan","signature":"opaque"}]}) }
                        else { json!({"reasoning_content":"plan"}) };
                    format!("data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                        json!({"choices":[{"delta":reasoning}]}),
                        json!({"choices":[{"delta":{"content":"READY","tool_calls":[{"index":0,"id":"call-wire","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"x\"}"}}]},"finish_reason":"tool_calls"}]}),
                        json!({"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}))
                },
                AiProviderKind::AnthropicMessages => unreachable!("legacy profile fixture"),
            };
        let (base_url, receiver, server) = serve_recording_sse(sse);
        provider.base_url = base_url;
        let adapter = HttpModelAdapterFactory
            .create(provider.clone(), Some("fixture".into()))
            .unwrap();
        let response = adapter.stream(ModelRequest { request_id: "profile-fixture".into(), surface_generation: 0,
                system_prompt: "system".into(), messages: vec![ModelMessage::User { content: "inspect".into() }],
                tools: vec![ModelToolDefinition { name: "read_file".into(), description: "read".into(), input_schema: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}) }] },
                CancellationToken::new(), Arc::new(RecordingSink::default())).await.unwrap();
        let body = receiver.recv().unwrap();
        assert_eq!(body["model"], provider.model);
        let wire_output = match provider.kind {
            AiProviderKind::OpenAi => &body["max_output_tokens"],
            AiProviderKind::OpenAiCompatible => &body["max_tokens"],
            AiProviderKind::Ollama => &body["options"]["num_predict"],
            AiProviderKind::AnthropicMessages => unreachable!("legacy profile fixture"),
        };
        assert_eq!(wire_output, &json!(16384), "{profile}");
        server.join().unwrap();
        for (key, expected) in fixture["reasoningBody"].as_object().unwrap() {
            assert_eq!(&body[key], expected, "{profile} {key}");
        }
        for key in [
            "thinking",
            "think",
            "reasoning",
            "reasoning_effort",
            "enable_thinking",
        ] {
            if fixture["reasoningBody"].get(key).is_none() {
                assert!(body.get(key).is_none(), "{profile} unexpected {key}");
            }
        }
        assert_eq!(response.usage.output_tokens, Some(3), "{profile}");
        if provider.kind == AiProviderKind::OpenAiCompatible {
            let caps = provider_capabilities(&provider);
            assert_eq!(
                body.get("stream_options").is_some(),
                caps.supports_stream_usage
            );
            assert!(!body
                .as_object()
                .unwrap()
                .contains_key("parallel_tool_calls"));
            assert!(response
                .content
                .iter()
                .any(|b| matches!(b, ModelContentBlock::ToolCall { .. })));
            assert_eq!(
                response
                    .content
                    .iter()
                    .any(|b| matches!(b, ModelContentBlock::Reasoning { .. })),
                caps.native_reasoning
            );
            let encoded = serde_json::to_string(&response.content).unwrap();
            let content: Vec<ModelContentBlock> = serde_json::from_str(&encoded).unwrap();
            let messages = chat_messages(
                &[ModelMessage::Assistant {
                    content,
                    replay: None,
                    native_replay: None,
                }],
                false,
                caps,
            );
            if profile == "minimax" {
                assert_eq!(messages[0]["reasoning_details"][0]["signature"], "opaque");
            } else if caps.replay_reasoning_content && caps.native_reasoning {
                assert_eq!(messages[0]["reasoning_content"], "plan");
            }
        }
    }
}

#[test]
fn deepseek_replays_reasoning_on_all_assistant_messages_including_non_tool_turns() {
    let provider: AiProviderConfig = serde_json::from_value(json!({"id":"x","profile":"deepseek","kind":"openAiCompatible","model":"deepseek-v4-flash","baseUrl":"https://proxy.example/v1","requiresApiKey":false})).unwrap();
    let messages = (0..2)
        .map(|index| ModelMessage::Assistant {
            content: vec![
                ModelContentBlock::Reasoning {
                    text: format!("reason {index}"),
                    provider_item: None,
                },
                ModelContentBlock::Text {
                    text: "answer".into(),
                },
            ],
            replay: None,
            native_replay: None,
        })
        .collect::<Vec<_>>();
    let wire = chat_messages(&messages, false, provider_capabilities(&provider));
    assert_eq!(wire[0]["reasoning_content"], "reason 0");
    assert_eq!(wire[1]["reasoning_content"], "reason 1");
}

#[tokio::test]
async fn qwen_thinking_only_sse_is_not_classified_as_empty() {
    let sse = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"reason only\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".into();
    let (base_url, receiver, server) = serve_recording_sse(sse);
    let provider: AiProviderConfig = serde_json::from_value(json!({"id":"qwen","profile":"qwen","kind":"openAiCompatible","model":"qwen3-thinking-2507","baseUrl":base_url,"requiresApiKey":false})).unwrap();
    let adapter = HttpModelAdapterFactory.create(provider, None).unwrap();
    let response = adapter
        .stream(
            ModelRequest {
                request_id: "qwen".into(),
                surface_generation: 0,
                system_prompt: "system".into(),
                messages: vec![],
                tools: vec![],
            },
            CancellationToken::new(),
            Arc::new(RecordingSink::default()),
        )
        .await
        .unwrap();
    let body = receiver.recv().unwrap();
    server.join().unwrap();
    assert!(body.get("enable_thinking").is_none());
    assert!(
        matches!(&response.content[0], ModelContentBlock::Reasoning { text, .. } if text == "reason only")
    );
}
