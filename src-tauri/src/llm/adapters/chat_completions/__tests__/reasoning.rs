use super::*;
use crate::llm::{
    catalog,
    replay::{self, ReplayEnvelopeV5, ReplayTarget},
    routes::RouteTimeouts,
    runtime::RequestSnapshot,
};
use std::sync::Mutex;

#[derive(Default)]
struct ReasoningSink(Mutex<String>);

impl ModelStreamSink for ReasoningSink {
    fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
        if let StreamDelta::Reasoning { text, .. } = delta {
            self.0.lock().unwrap().push_str(&text);
        }
        Ok(())
    }
}

fn capabilities(cumulative: bool) -> ProviderCapabilities {
    ProviderCapabilities {
        cumulative_stream: cumulative,
        supports_stream_usage: true,
        native_reasoning: true,
        split_reasoning: cumulative,
        replay_reasoning_content: true,
        think_tag_fallback: false,
        parallel_tool_calls: false,
    }
}

fn snapshot() -> RequestSnapshot {
    RequestSnapshot::Prepared {
        route_id: "route-a".into(),
        route_revision: 1,
        adapter_id: "chat-completions".into(),
        model_id: "model-a".into(),
        catalog_version: 1,
        capabilities: catalog::fixture_definition(AiProviderKind::OpenAiCompatible, 8192),
        endpoint_identity: "https://api.minimax.io/v1".into(),
        replay_domain_id: "domain-a".into(),
        reasoning_effort: None,
        output_tokens: 8192,
        retry_policy: Default::default(),
        timeouts: RouteTimeouts::default(),
        purpose: "step".into(),
        preparation_version: 1,
        projection_policy: "immutable-png-v1-strict".into(),
        content_hash: crate::llm::runtime::digest(b"reasoning-round-trip"),
        images: Vec::new(),
    }
}

// Exercise the production stream parser, response capture, durable JSON
// encoding, envelope validation, history projection and request encoder.
// These are protocol boundary tests; no HTTP server or model adapter is mocked.
fn round_trip(
    deltas: Vec<Value>,
    caps: ProviderCapabilities,
    domain: &str,
) -> (Vec<Value>, String, ReplayEnvelopeV5) {
    let recording = Arc::new(ReasoningSink::default());
    let sink: Arc<dyn ModelStreamSink> = recording.clone();
    let mut accumulated = ChatAccumulator::default();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
    let mut finish_reason = ModelFinishReason::Other;
    for delta in deltas.into_iter().chain([json!({"tool_calls":[{
        "index":0,"id":"provider-call","function":{"name":"read_file","arguments":"{\"path\":\"nginx.conf\"}"}
    }]})]) {
        let event = json!({"choices":[{"delta":delta}]});
        process_chat_event(
            &format!("data: {event}"), caps, &sink, &mut accumulated,
            &mut usage, &mut completed, &mut finish_reason,
        ).unwrap();
    }
    process_chat_event(
        "data: [DONE]",
        caps,
        &sink,
        &mut accumulated,
        &mut usage,
        &mut completed,
        &mut finish_reason,
    )
    .unwrap();
    assert!(completed);
    let mut response = finish_chat_response(accumulated, caps, finish_reason, usage).unwrap();
    let capture = response.replay.take().unwrap();
    let (mut content, blocks): (Vec<_>, Vec<_>) = response
        .content
        .into_iter()
        .zip(capture.blocks)
        .filter(|(block, _)| replay::model_block_has_output(block))
        .unzip();
    for block in &mut content {
        if let ModelContentBlock::Reasoning { provider_item, .. } = block {
            *provider_item = None;
        }
    }
    let content = replay::committed_model_content(&content).unwrap();
    let envelope = replay::prepare_envelope(
        &CHAT_COMPLETIONS_REPLAY_CODEC,
        "request-1",
        &snapshot(),
        &content,
        AdapterReplayCapture {
            response: capture.response,
            blocks,
        },
    )
    .unwrap();
    let stored = serde_json::to_vec(&envelope).unwrap();
    let restored: ReplayEnvelopeV5 = serde_json::from_slice(&stored).unwrap();
    replay::validate_model_envelope(
        &restored,
        &content,
        &snapshot(),
        "request-1",
        &CHAT_COMPLETIONS_REPLAY_CODEC,
    )
    .unwrap();
    let mut history = vec![
        ModelMessage::Assistant {
            content,
            replay: Some(Box::new(restored)),
            native_replay: None,
        },
        ModelMessage::Tool {
            call_id: "call-1".into(),
            provider_call_id: None,
            name: "read_file".into(),
            content: "".into(),
        },
    ];
    replay::project_history(
        &CHAT_COMPLETIONS_REPLAY_CODEC,
        &mut history,
        ReplayTarget {
            route_id: "route-a",
            model_id: "model-a",
            replay_domain_id: domain,
        },
    )
    .unwrap();
    let displayed = recording.0.lock().unwrap().clone();
    (chat_messages(&history, false, caps), displayed, envelope)
}

#[test]
fn cumulative_reasoning_preserves_one_complete_block_and_nullable_fields() {
    let (wire, displayed, envelope) = round_trip(
        vec![
            json!({"reasoning_details":[{"type":"reasoning.text","text":"","id":null,"signature":null}]}),
            json!({"reasoning_content":"","reasoning_details":[{"type":"reasoning.text","text":"plan"}]}),
            json!({"reasoning_details":[{"type":"reasoning.text","text":"plan safely","signature":"signed"}]}),
            json!({"reasoning_details":[{"type":"reasoning.text","text":"plan safely","signature":"signed"}]}),
            json!({"reasoning_details":[{"text":"","signature":null}]}),
        ],
        capabilities(true),
        "domain-a",
    );
    assert_eq!(displayed, "plan safely");
    assert_eq!(
        wire[0]["reasoning_details"],
        json!([
            {"type":"reasoning.text","text":"plan safely","signature":"signed","id":null}
        ])
    );
    assert!(wire[0].get("reasoning_content").is_none());
    assert_eq!(wire[0]["tool_calls"][0]["id"], wire[1]["tool_call_id"]);
    let ReplayEnvelopeV5::Prepared { blocks, .. } = envelope;
    assert!(blocks
        .iter()
        .all(|block| block.metadata.get("reasoningDetails").is_none()));
}

#[test]
fn cumulative_reasoning_tracks_distinct_blocks_in_order() {
    let (wire, displayed, _) = round_trip(
        vec![
            json!({"reasoning_details":[{"index":0,"text":"first"}]}),
            json!({"reasoning_details":[{"index":1,"text":"second"}]}),
            json!({"reasoning_details":[{"index":0,"text":"first"},{"index":1,"text":"second part"}]}),
        ],
        capabilities(true),
        "domain-a",
    );
    assert_eq!(displayed, "firstsecond part");
    assert_eq!(
        wire[0]["reasoning_details"],
        json!([
            {"index":0,"text":"first"},{"index":1,"text":"second part"}
        ])
    );
}

#[test]
fn cumulative_opaque_snapshots_are_not_concatenated() {
    let (wire, _, _) = round_trip(
        vec![
            json!({"reasoning_details":[{"index":0,"text":"plan","signature":"signature-one"}]}),
            json!({"reasoning_details":[{"index":0,"text":"plan more","signature":"signature-two"}]}),
            json!({"reasoning_details":[{"index":1,"type":"reasoning.encrypted","data":"state-one"}]}),
            json!({"reasoning_details":[{"index":1,"type":"reasoning.encrypted","data":"state-two"}]}),
        ],
        capabilities(true),
        "domain-a",
    );
    assert_eq!(
        wire[0]["reasoning_details"],
        json!([
            {"index":0,"text":"plan more","signature":"signature-two"},
            {"index":1,"type":"reasoning.encrypted","data":"state-two"}
        ])
    );
}

#[test]
fn incremental_reasoning_keeps_repeated_fragments_signatures_and_opaque_blocks() {
    let details = vec![
        json!({"type":"reasoning.text","text":"ha","index":0,"signature":null}),
        json!({"type":"reasoning.text","text":"ha","index":0,"signature":null}),
        json!({"type":"reasoning.text","text":"","index":0,"signature":"signed"}),
        json!({"type":"reasoning.summary","summary":"Repeated text","id":null}),
        json!({"type":"reasoning.encrypted","data":"cHJvdG9jb2w=","id":"encrypted-1"}),
    ];
    let (wire, displayed, _) = round_trip(
        details
            .iter()
            .map(|detail| json!({"reasoning_details":[detail]}))
            .collect(),
        capabilities(false),
        "domain-a",
    );
    assert_eq!(displayed, "haha");
    assert_eq!(wire[0]["reasoning_details"], json!(details));
}

#[test]
fn metadata_only_reasoning_survives_without_a_visible_reasoning_block() {
    let details = json!([{"type":"reasoning.text","text":"","signature":"signed","id":null}]);
    let (wire, displayed, envelope) = round_trip(
        vec![json!({"reasoning_details":details})],
        capabilities(true),
        "domain-a",
    );
    assert_eq!(displayed, "");
    assert_eq!(wire[0]["reasoning_details"], details);
    let ReplayEnvelopeV5::Prepared { blocks, .. } = envelope;
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, replay::ReplayBlockKind::ToolCall);
}

#[test]
fn long_reasoning_and_data_url_prose_round_trip_without_truncation() {
    let text = format!(
        "data: SSE syntax and data:image/png;base64, in source code. {}",
        "思考".repeat(12000)
    );
    assert!(text.len() > 64 * 1024);
    let (wire, displayed, _) = round_trip(
        vec![
            json!({"reasoning_details":[{"text":text,"signature":null}]}),
            json!({"reasoning_details":[{"text":text,"signature":null}]}),
        ],
        capabilities(true),
        "domain-a",
    );
    assert_eq!(displayed, text);
    assert_eq!(wire[0]["reasoning_details"][0]["text"], text);
    assert_eq!(wire[0]["reasoning_details"].as_array().unwrap().len(), 1);
}

#[test]
fn cross_domain_history_does_not_replay_private_reasoning_details() {
    let (wire, _, _) = round_trip(
        vec![json!({"reasoning_details":[
            {"text":"","signature":"private-signature"}
        ]})],
        capabilities(true),
        "different-domain",
    );
    assert!(wire[0].get("reasoning_details").is_none());
    assert!(!serde_json::to_string(&wire)
        .unwrap()
        .contains("private-signature"));
}

#[test]
fn invalid_reasoning_reports_field_without_logging_payload() {
    for (details, field) in [
        (json!([{"text":42}]), "text"),
        (json!([{"index":-1}]), "index"),
        (json!([{"api_key":"must-not-appear"}]), "api_key"),
    ] {
        let error = reasoning::validate_details(&details).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("REPLAY_METADATA_INVALID"));
        assert!(error.message.contains("reasoningDetails[0]"));
        assert!(error.message.contains(field));
        assert!(!error.message.contains("must-not-appear"));
    }
}

#[test]
fn reasoning_budget_is_bounded_and_reports_exact_bytes() {
    let bytes = replay::MAX_REPLAY_METADATA_BYTES + 1;
    let error = reasoning::validate_details(&json!([{"text":"x".repeat(bytes)}])).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("REPLAY_METADATA_TOO_LARGE"));
    assert!(error.message.contains("reasoningDetails[0].text"));
    assert!(error.message.contains(&bytes.to_string()));
    let metadata = json!({"reasoningDetails":[
        {"text":"a".repeat(replay::MAX_REPLAY_METADATA_BYTES / 2)},
        {"text":"b".repeat(replay::MAX_REPLAY_METADATA_BYTES / 2)}
    ]});
    reasoning::validate_details(&metadata["reasoningDetails"]).unwrap();
    let error = replay::validate_metadata_safety(&metadata).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("REPLAY_METADATA_TOO_LARGE"));
    assert!(error
        .message
        .contains(&serde_json::to_vec(&metadata).unwrap().len().to_string()));
    assert!(!error.retryable());
}

#[test]
fn opaque_metadata_still_rejects_attachments_and_credentials() {
    for metadata in [
        json!({"reasoningDetails":[{"signature":"data:image/png;base64,AAAA"}]}),
        json!({"reasoningDetails":[{"api_key":"secret"}]}),
    ] {
        assert_eq!(
            replay::validate_metadata_safety(&metadata)
                .unwrap_err()
                .code
                .as_deref(),
            Some("REPLAY_METADATA_FORBIDDEN")
        );
    }
}
