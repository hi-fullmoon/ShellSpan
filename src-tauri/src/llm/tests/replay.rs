    use super::*;
    use crate::llm::{
        catalog, config::AiProviderKind, routes::RouteTimeouts, types::ModelToolCall,
    };

    fn snapshot(adapter_id: &str) -> RequestSnapshot {
        let kind = match adapter_id {
            "responses" => AiProviderKind::OpenAi,
            "ollama" => AiProviderKind::Ollama,
            "anthropic-messages" => AiProviderKind::AnthropicMessages,
            _ => AiProviderKind::OpenAiCompatible,
        };
        RequestSnapshot::Prepared {
            route_id: "route-a".into(),
            route_revision: 7,
            adapter_id: adapter_id.into(),
            model_id: "model-a".into(),
            catalog_version: 1,
            capabilities: catalog::fixture_definition(kind, 8192),
            endpoint_identity: "https://example.test/v1".into(),
            replay_domain_id: "domain-a".into(),
            reasoning_effort: None,
            output_tokens: 8192,
            retry_policy: Default::default(),
            timeouts: RouteTimeouts::default(),
            purpose: "step".into(),
            preparation_version: 1,
            projection_policy: "immutable-png-v1-strict".into(),
            content_hash: super::super::runtime::digest(b"request-content"),
            images: Vec::new(),
        }
    }

    fn tool(provider_call_id: Option<&str>) -> ModelContentBlock {
        ModelContentBlock::ToolCall {
            call: ModelToolCall {
                call_id: "call-1".into(),
                provider_call_id: provider_call_id.map(str::to_string),
                name: "read_file".into(),
                arguments: json!({"path":"a"}),
            },
        }
    }

    fn envelope(
        adapter_id: &str,
        content: &[ModelContentBlock],
        response: Value,
        blocks: Vec<Value>,
    ) -> ReplayEnvelopeV5 {
        prepare_envelope(
            super::super::registry::replay_codec(adapter_id).unwrap(),
            "request-1",
            &snapshot(adapter_id),
            content,
            AdapterReplayCapture { response, blocks },
        )
        .unwrap()
    }

    #[test]
    fn each_adapter_restores_only_its_same_domain_private_format() {
        let cases = [
            (
                "chat-completions",
                vec![
                    ModelContentBlock::Reasoning {
                        text: "plan".into(),
                        provider_item: None,
                    },
                    tool(Some("chat-completions-provider-call")),
                ],
                json!({"id":"chat-response"}),
                vec![
                    json!({"reasoningDetails":[{"type":"reasoning.text","text":"plan","signature":"opaque-signature"}]}),
                    json!({"providerCallId":"chat-completions-provider-call"}),
                ],
            ),
            (
                "responses",
                vec![
                    ModelContentBlock::Reasoning {
                        text: "plan".into(),
                        provider_item: None,
                    },
                    tool(Some("responses-provider-call")),
                ],
                json!({"responseId":"resp_1","model":"model-a"}),
                vec![
                    json!({"nativeItem":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"plan"}],"encrypted_content":"opaque-state"}}),
                    json!({"providerCallId":"responses-provider-call","providerItemId":"fc_1"}),
                ],
            ),
            (
                "ollama",
                vec![tool(Some("ollama-provider-call"))],
                json!({"model":"model-a","doneReason":"stop"}),
                vec![json!({"providerCallId":"ollama-provider-call"})],
            ),
            (
                "anthropic-messages",
                vec![
                    ModelContentBlock::Reasoning {
                        text: "plan".into(),
                        provider_item: None,
                    },
                    tool(Some("anthropic-messages-provider-call")),
                ],
                json!({"messageId":"msg_1","model":"model-a","redactedThinkingTail":[{"data":"opaque-tail"}]}),
                vec![
                    json!({"signature":"anthropic-signature","redactedThinkingBefore":[{"data":"opaque-before"}]}),
                    json!({"providerCallId":"anthropic-messages-provider-call"}),
                ],
            ),
        ];
        for (adapter_id, canonical, response, blocks) in cases {
            let envelope = envelope(adapter_id, &canonical, response, blocks);
            validate_model_envelope(
                &envelope,
                &canonical,
                &snapshot(adapter_id),
                "request-1",
                super::super::registry::replay_codec(adapter_id).unwrap(),
            )
            .unwrap();

            let mut projected = canonical.clone();
            for block in &mut projected {
                match block {
                    ModelContentBlock::Reasoning { provider_item, .. } => *provider_item = None,
                    ModelContentBlock::ToolCall { call } => call.provider_call_id = None,
                    ModelContentBlock::Text { .. } => {}
                }
            }
            let mut messages = vec![
                ModelMessage::Assistant {
                    content: projected,
                    replay: Some(Box::new(envelope.clone())),
                    native_replay: None,
                },
                ModelMessage::Tool {
                    call_id: "call-1".into(),
                    provider_call_id: None,
                    name: "read_file".into(),
                    content: "ok".into(),
                },
            ];
            project_history(
                super::super::registry::replay_codec(adapter_id).unwrap(),
                &mut messages,
                ReplayTarget {
                    route_id: "route-a",
                    model_id: "model-a",
                    replay_domain_id: "domain-a",
                },
            )
            .unwrap();
            let ModelMessage::Assistant { content, .. } = &messages[0] else {
                panic!()
            };
            if adapter_id == "responses" {
                assert!(matches!(
                    &content[0],
                    ModelContentBlock::Reasoning { provider_item: Some(item), .. }
                        if item.get("encrypted_content").and_then(Value::as_str) == Some("opaque-state")
                ));
            } else if adapter_id == "anthropic-messages" {
                assert!(matches!(
                    &content[0],
                    ModelContentBlock::Reasoning { provider_item: Some(item), .. }
                        if item.pointer("/anthropic/signature").and_then(Value::as_str)
                            == Some("anthropic-signature")
                ));
            }
            let expected = format!("{adapter_id}-provider-call");
            assert!(content.iter().any(|block| matches!(
                block,
                ModelContentBlock::ToolCall { call }
                    if call.provider_call_id.as_deref() == Some(expected.as_str())
            )));
            assert!(matches!(
                &messages[1],
                ModelMessage::Tool { provider_call_id: Some(id), .. } if id == &expected
            ));
            let projected_serialized = serde_json::to_string(&messages).unwrap();
            assert!(!projected_serialized.contains("\"replay\""));
            assert!(!projected_serialized.contains("responseId"));
            if adapter_id == "responses" {
                let (input, previous) =
                    crate::llm::adapters::responses::responses_input_with_replay(&messages);
                assert_eq!(previous.as_deref(), Some("resp_1"));
                assert_eq!(input[0]["call_id"], "responses-provider-call");
            } else if adapter_id == "chat-completions" {
                let wire = crate::llm::adapters::common::chat_messages(
                    &messages,
                    false,
                    crate::llm::adapters::common::ProviderCapabilities {
                        cumulative_stream: false,
                        supports_stream_usage: true,
                        native_reasoning: true,
                        split_reasoning: true,
                        replay_reasoning_content: false,
                        think_tag_fallback: false,
                        parallel_tool_calls: true,
                    },
                );
                assert_eq!(
                    wire[0]["reasoning_details"][0]["signature"],
                    "opaque-signature"
                );
            } else if adapter_id == "anthropic-messages" {
                let wire = crate::llm::adapters::anthropic::encode_messages(&messages).unwrap();
                assert_eq!(wire[0]["content"][0]["type"], "redacted_thinking");
                assert_eq!(wire[0]["content"][1]["signature"], "anthropic-signature");
                assert_eq!(wire[0]["content"][2]["type"], "tool_use");
                assert_eq!(wire[0]["content"][3]["type"], "redacted_thinking");
                assert_eq!(
                    wire[1]["content"][0]["tool_use_id"],
                    "anthropic-messages-provider-call"
                );
            }

            let mut cross_domain = messages.clone();
            project_history(
                super::super::registry::replay_codec(adapter_id).unwrap(),
                &mut cross_domain,
                ReplayTarget {
                    route_id: "route-a",
                    model_id: "model-a",
                    replay_domain_id: "rotated-domain",
                },
            )
            .unwrap();
            let encoded = serde_json::to_string(&cross_domain).unwrap();
            assert!(!encoded.contains("opaque-state"));
            assert!(!encoded.contains("opaque-signature"));
            assert!(!encoded.contains("anthropic-signature"));
            assert!(!encoded.contains("opaque-before"));
            assert!(!encoded.contains("opaque-tail"));
            assert!(!encoded.contains(&expected));
            if adapter_id == "anthropic-messages" {
                let wire = crate::llm::adapters::anthropic::encode_messages(&cross_domain).unwrap();
                let wire = serde_json::to_string(&wire).unwrap();
                assert!(!wire.contains("signature"));
                assert!(!wire.contains("redacted_thinking"));
                assert!(!wire.contains("anthropic-messages-provider-call"));
            }
        }
    }

    #[test]
    fn persisted_envelope_rejects_source_content_block_tool_and_image_corruption() {
        let content = vec![
            ModelContentBlock::Text {
                text: "done".into(),
            },
            tool(Some("provider-call")),
        ];
        let base = envelope(
            "chat-completions",
            &content,
            json!({"id":"response-1"}),
            vec![json!({}), json!({"providerCallId":"provider-call"})],
        );
        let codec = super::super::registry::replay_codec("chat-completions").unwrap();
        let mut cases = Vec::new();
        for mutation in 0..9 {
            let mut candidate = base.clone();
            let ReplayEnvelopeV5::Prepared {
                version,
                adapter_id,
                replay_format_version,
                source,
                blocks,
                ..
            } = &mut candidate;
            match mutation {
                0 => *version = 9,
                1 => *replay_format_version = 9,
                2 => *adapter_id = "responses".into(),
                3 => source.route_id = "other-route".into(),
                4 => source.request_snapshot_digest = "0".repeat(64),
                5 => source.assistant_content_hash = "0".repeat(64),
                6 => blocks[0].index = 4,
                7 => blocks[1].metadata["providerCallId"] = json!("other-provider-call"),
                8 => source.image_projection_hash = "0".repeat(64),
                _ => unreachable!(),
            }
            cases.push(candidate);
        }
        for candidate in cases {
            assert!(validate_model_envelope(
                &candidate,
                &content,
                &snapshot("chat-completions"),
                "request-1",
                codec,
            )
            .is_err());
        }
        let changed_content = vec![
            ModelContentBlock::Text {
                text: "tampered".into(),
            },
            tool(Some("provider-call")),
        ];
        assert!(validate_model_envelope(
            &base,
            &changed_content,
            &snapshot("chat-completions"),
            "request-1",
            codec,
        )
        .is_err());

        let reasoning = vec![ModelContentBlock::Reasoning {
            text: "plan".into(),
            provider_item: None,
        }];
        let mut corrupted_reasoning = envelope(
            "chat-completions",
            &reasoning,
            json!({}),
            vec![
                json!({"reasoningDetails":[{"type":"reasoning.text","text":"plan","signature":"opaque"}]}),
            ],
        );
        let ReplayEnvelopeV5::Prepared { blocks, .. } = &mut corrupted_reasoning;
        blocks[0].metadata["reasoningDetails"][0]["unknown"] = json!(true);
        assert!(validate_model_envelope(
            &corrupted_reasoning,
            &reasoning,
            &snapshot("chat-completions"),
            "request-1",
            codec,
        )
        .is_err());
    }

    #[test]
    fn image_projection_binding_contains_only_immutable_refs_and_rejects_changes() {
        let mut source = snapshot("responses");
        let RequestSnapshot::Prepared { images, .. } = &mut source;
        images.push(crate::agent_runtime::images::ImageRef {
            version: 1,
            sha256: "a".repeat(64),
            media_type: "image/png".into(),
            bytes: 128,
            width: 16,
            height: 8,
            name: "diagram.png".into(),
        });
        let content = vec![ModelContentBlock::Text { text: "ok".into() }];
        let envelope = prepare_envelope(
            super::super::registry::replay_codec("responses").unwrap(),
            "request-1",
            &source,
            &content,
            AdapterReplayCapture {
                response: json!({"responseId":"resp_1"}),
                blocks: vec![json!({})],
            },
        )
        .unwrap();
        let encoded = serde_json::to_string(&envelope).unwrap();
        assert!(encoded.contains(&"a".repeat(64)));
        assert!(!encoded.contains("data:image"));
        let mut changed = source.clone();
        let RequestSnapshot::Prepared { images, .. } = &mut changed;
        images[0].sha256 = "b".repeat(64);
        assert!(validate_model_envelope(
            &envelope,
            &content,
            &changed,
            "request-1",
            super::super::registry::replay_codec("responses").unwrap(),
        )
        .is_err());
    }

    #[test]
    fn tool_history_rejects_orphans_duplicates_and_unsettled_calls() {
        let codec = super::super::registry::replay_codec("ollama").unwrap();
        let target = || ReplayTarget {
            route_id: "route-a",
            model_id: "model-a",
            replay_domain_id: "domain-a",
        };
        let mut orphan = vec![ModelMessage::Tool {
            call_id: "call-1".into(),
            provider_call_id: None,
            name: "read_file".into(),
            content: "result".into(),
        }];
        assert!(
            project_history(codec, &mut orphan, target())
                .unwrap_err()
                .code
                .as_deref()
                == Some("HISTORY_INCOMPATIBLE")
        );

        let mut duplicate = vec![ModelMessage::Assistant {
            content: vec![tool(None), tool(None)],
            replay: None,
            native_replay: None,
        }];
        assert!(project_history(codec, &mut duplicate, target()).is_err());

        let mut unsettled = vec![ModelMessage::Assistant {
            content: vec![tool(None)],
            replay: None,
            native_replay: None,
        }];
        assert!(project_history(codec, &mut unsettled, target()).is_err());
    }

    #[test]
    fn retry_envelopes_keep_the_frozen_snapshot_digest() {
        let snapshot = snapshot("ollama");
        let content = vec![ModelContentBlock::Text { text: "ok".into() }];
        let make = |request_id| {
            prepare_envelope(
                super::super::registry::replay_codec("ollama").unwrap(),
                request_id,
                &snapshot,
                &content,
                AdapterReplayCapture {
                    response: json!({}),
                    blocks: vec![json!({})],
                },
            )
            .unwrap()
        };
        let first = make("attempt-1");
        let second = make("attempt-2");
        let (
            ReplayEnvelopeV5::Prepared { source: first, .. },
            ReplayEnvelopeV5::Prepared { source: second, .. },
        ) = (first, second);
        assert_ne!(first.request_id, second.request_id);
        assert_eq!(
            first.request_snapshot_digest,
            second.request_snapshot_digest
        );
        assert_eq!(first.request_content_hash, second.request_content_hash);
        assert_eq!(first.image_projection_hash, second.image_projection_hash);
    }

    #[test]
    fn public_event_projection_removes_all_backend_native_fields() {
        let mut event = crate::agent_runtime::AgentSessionEvent::new(
            "session".into(),
            0,
            1,
            Some("turn".into()),
            Some("step".into()),
            crate::agent_runtime::AgentSessionEventPayload::AssistantMessage {
                message_id: "message".into(),
                content: vec![
                    crate::agent_runtime::AgentAssistantContentBlock::Reasoning {
                        text: "display".into(),
                        provider_item: Some(json!({"id":"untrusted-private-item"})),
                    },
                    crate::agent_runtime::AgentAssistantContentBlock::ToolCall {
                        call: Box::new(crate::agent_runtime::RecordedToolCall {
                            call_id: "call".into(),
                            provider_call_id: Some("private-provider-call".into()),
                            name: "read_file".into(),
                            native_name: None,
                            arguments: json!({}),
                            title: None,
                            effect: None,
                            target: None,
                        }),
                    },
                ],
                usage: Default::default(),
                stop_reason: crate::agent_runtime::AgentStopReason::ToolCalls,
                interrupted: false,
                replay: None,
            },
        );
        public_event_projection(&mut event);
        let encoded = serde_json::to_string(&event).unwrap();
        assert!(!encoded.contains("untrusted-private-item"));
        assert!(!encoded.contains("private-provider-call"));
        assert!(!encoded.contains("\"replay\""));
        assert!(encoded.contains("\"callId\":\"call\""));
    }
