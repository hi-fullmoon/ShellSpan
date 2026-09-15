    use super::*;
    use crate::agent_runtime::images::ImageRef;
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener},
        sync::Mutex,
        thread,
        time::Duration,
    };

    #[derive(Default)]
    struct Sink(Mutex<Vec<StreamDelta>>);
    impl ModelStreamSink for Sink {
        fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
            self.0.lock().unwrap().push(delta);
            Ok(())
        }
    }

    fn anthropic_provider(base_url: String) -> crate::llm::config::AiProviderConfig {
        crate::llm::config::AiProviderConfig {
            model_definition: None,
            retry_policy: None,
            profile: "anthropic".into(),
            id: "anthropic-route".into(),
            kind: crate::llm::config::AiProviderKind::AnthropicMessages,
            base_url,
            model: "claude-sonnet-5".into(),
            reasoning_effort: Some("high".into()),
            requires_api_key: true,
            api_key: None,
        }
    }

    fn serve(response: Vec<u8>) -> (String, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut received = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let count = socket.read(&mut chunk).unwrap();
                received.extend_from_slice(&chunk[..count]);
                if let Some(end) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or_default();
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(&response).unwrap();
            received
        });
        (format!("http://{address}"), handle)
    }

    fn sse(events: &[Value]) -> Vec<u8> {
        let body = events
            .iter()
            .map(|value| {
                let event = value["type"].as_str().unwrap();
                format!("event: {event}\ndata: {value}\n\n")
            })
            .collect::<String>();
        format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_bytes()
    }

    fn basic_request() -> ModelRequest {
        ModelRequest {
            request_id: "request-safe".into(),
            surface_generation: 0,
            system_prompt: "system".into(),
            messages: vec![ModelMessage::User {
                content: "hello".into(),
            }],
            tools: Vec::new(),
        }
    }

    fn serve_stalled(
        prefix: Option<&'static [u8]>,
        headers: bool,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request);
            if headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n").unwrap();
                if let Some(prefix) = prefix {
                    write!(socket, "{:x}\r\n", prefix.len()).unwrap();
                    socket.write_all(prefix).unwrap();
                    socket.write_all(b"\r\n").unwrap();
                }
                socket.flush().unwrap();
            }
            thread::sleep(Duration::from_millis(100));
            let _ = socket.write_all(b"0\r\n\r\n");
        });
        (format!("http://{address}"), server)
    }

    #[tokio::test]
    async fn exact_messages_wire_and_stream_cover_images_thinking_redaction_and_parallel_tools() {
        let events = vec![
            json!({"type":"message_start","message":{"id":"msg_safe","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5","stop_reason":null,"usage":{"input_tokens":11,"cache_creation_input_tokens":3,"cache_read_input_tokens":5,"output_tokens":1}}}),
            json!({"type":"ping"}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-current"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-redacted"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"checking"}}),
            json!({"type":"content_block_stop","index":2}),
            json!({"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_one","name":"read_file","input":{}}}),
            json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a\"}"}}),
            json!({"type":"content_block_stop","index":3}),
            json!({"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"toolu_two","name":"list_files","input":{}}}),
            json!({"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
            json!({"type":"content_block_stop","index":4}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":19}}),
            json!({"type":"message_stop"}),
        ];
        let (base_url, server) = serve(sse(&events));
        let adapter = AnthropicMessagesAdapter {
            http: HttpConfig {
                client: build_streaming_client().unwrap(),
                provider: anthropic_provider(base_url),
                api_key: Some("stage-e-secret".into()),
                timeouts: ModelTimeoutPolicy::default(),
            },
        };
        let request = ModelRequest {
            request_id: "request-safe".into(),
            surface_generation: 1,
            system_prompt: "system".into(),
            messages: vec![
                ModelMessage::UserImages {
                    content: "inspect".into(),
                    images: vec![ImageRef {
                        version: 1,
                        sha256: "a".repeat(64),
                        media_type: "image/png".into(),
                        bytes: 3,
                        width: 1,
                        height: 1,
                        name: "pixel.png".into(),
                    }],
                    data_urls: vec!["data:image/png;base64,AAAA".into()],
                },
                ModelMessage::Assistant {
                    content: vec![
                        ModelContentBlock::Reasoning {
                            text: "prior plan".into(),
                            provider_item: Some(
                                json!({"anthropic":{"type":"thinking","signature":"signed-prior"}}),
                            ),
                        },
                        ModelContentBlock::ToolCall {
                            call: ModelToolCall {
                                call_id: "call-prior".into(),
                                provider_call_id: Some("toolu_prior".into()),
                                name: "read_file".into(),
                                arguments: json!({"path":"old"}),
                            },
                        },
                        ModelContentBlock::ToolCall {
                            call: ModelToolCall {
                                call_id: "call-prior-2".into(),
                                provider_call_id: Some("toolu_prior_2".into()),
                                name: "list_files".into(),
                                arguments: json!({}),
                            },
                        },
                    ],
                    replay: None,
                    native_replay: None,
                },
                ModelMessage::Tool {
                    call_id: "call-prior".into(),
                    provider_call_id: Some("toolu_prior".into()),
                    name: "read_file".into(),
                    content: "ok".into(),
                },
                ModelMessage::Tool {
                    call_id: "call-prior-2".into(),
                    provider_call_id: Some("toolu_prior_2".into()),
                    name: "list_files".into(),
                    content: "two".into(),
                },
                ModelMessage::User {
                    content: "continue".into(),
                },
            ],
            tools: vec![
                ModelToolDefinition {
                    name: "read_file".into(),
                    description: "Read one file".into(),
                    input_schema: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
                },
                ModelToolDefinition {
                    name: "list_files".into(),
                    description: "List files".into(),
                    input_schema: json!({"type":"object"}),
                },
            ],
        };
        let sink = Arc::new(Sink::default());
        let response = adapter
            .stream(request, CancellationToken::new(), sink.clone())
            .await
            .unwrap();
        let wire = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = wire.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("POST /v1/messages HTTP/1.1"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("x-api-key: stage-e-secret"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("anthropic-version: 2023-06-01"));
        assert!(!headers.to_ascii_lowercase().contains("anthropic-beta"));
        assert!(!headers.to_ascii_lowercase().contains("authorization:"));
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["system"], "system");
        assert_eq!(body["max_tokens"], 128000);
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(
            body["messages"][0]["content"][0]["source"]["media_type"],
            "image/png"
        );
        assert_eq!(
            body["messages"][1]["content"][0]["signature"],
            "signed-prior"
        );
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(
            body["messages"][2]["content"][0]["tool_use_id"],
            "toolu_prior"
        );
        assert_eq!(
            body["messages"][2]["content"][1]["tool_use_id"],
            "toolu_prior_2"
        );
        assert_eq!(body["messages"][2]["content"][2]["text"], "continue");
        assert_eq!(body["tool_choice"]["type"], "auto");
        assert_eq!(response.finish_reason, ModelFinishReason::ToolCalls);
        assert_eq!(response.usage.uncached_input_tokens, Some(11));
        assert_eq!(response.usage.cache_read_tokens, Some(5));
        assert_eq!(response.usage.cache_write_tokens, Some(3));
        assert_eq!(response.usage.output_tokens, Some(19));
        assert_eq!(response.usage.total_tokens, Some(38));
        assert_eq!(response.content.len(), 4);
        assert_eq!(
            response.replay.as_ref().unwrap().blocks[1]["redactedThinkingBefore"][0]["data"],
            "opaque-redacted"
        );
        let deltas = sink.0.lock().unwrap();
        assert!(deltas
            .iter()
            .any(|delta| matches!(delta, StreamDelta::Text { index: 1, .. })));
        assert!(deltas.iter().any(|delta| matches!(delta, StreamDelta::ToolCall { index:3, call_id:Some(id), .. } if id == "toolu_two")));
        drop(deltas);
        let serialized = serde_json::to_string(&response.replay).unwrap();
        assert!(!serialized.contains("stage-e-secret"));
        assert!(!serialized.contains("data:image"));
    }

    fn event(value: Value) -> String {
        format!("event: {}\ndata: {value}", value["type"].as_str().unwrap())
    }

    #[test]
    fn malformed_or_incomplete_anthropic_events_fail_closed() {
        let sink: Arc<dyn ModelStreamSink> = Arc::new(Sink::default());
        let start = event(
            json!({"type":"message_start","message":{"id":"msg","role":"assistant","content":[],"model":"model"}}),
        );
        let cases = vec![
            vec![
                start.clone(),
                event(
                    json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
                ),
            ],
            vec![
                start.clone(),
                event(
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
                ),
                event(json!({"type":"content_block_stop","index":0})),
            ],
            vec![
                start.clone(),
                event(
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu","name":"x","input":{}}}),
                ),
                event(
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}),
                ),
                event(json!({"type":"content_block_stop","index":0})),
            ],
            vec![
                start.clone(),
                event(json!({"type":"future_critical_event"})),
            ],
        ];
        for events in cases {
            let mut state = AnthropicAccumulator::default();
            let mut error = None;
            for next in events {
                if let Err(found) = process_anthropic_event(&next, &sink, &mut state) {
                    error = Some(found);
                    break;
                }
            }
            assert!(error.is_some());
            assert_eq!(error.unwrap().kind, NormalizedModelErrorKind::Protocol);
        }
    }

    #[test]
    fn stream_error_maps_stable_anthropic_classification() {
        let sink: Arc<dyn ModelStreamSink> = Arc::new(Sink::default());
        let mut state = AnthropicAccumulator::default();
        let error = process_anthropic_event(
            &event(json!({"type":"error","error":{"type":"overloaded_error","message":"busy"},"request_id":"req_safe"})),
            &sink,
            &mut state,
        ).unwrap_err();
        assert_eq!(error.kind, NormalizedModelErrorKind::Retryable);
        assert_eq!(error.status, Some(529));
        assert_eq!(error.code.as_deref(), Some("ANTHROPIC_OVERLOADED_ERROR"));
        assert!(error.message.contains("req_safe"));
    }

    #[tokio::test]
    async fn cancellation_and_all_three_timeout_phases_are_typed() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let cancelled = AnthropicMessagesAdapter {
            http: HttpConfig {
                client: build_streaming_client().unwrap(),
                provider: anthropic_provider("http://127.0.0.1:9".into()),
                api_key: Some("stage-e-secret".into()),
                timeouts: ModelTimeoutPolicy::default(),
            },
        }
        .stream(basic_request(), cancellation, Arc::new(Sink::default()))
        .await
        .unwrap_err();
        assert_eq!(cancelled.kind, NormalizedModelErrorKind::Cancelled);

        let timeouts = ModelTimeoutPolicy {
            request_headers: Duration::from_millis(20),
            first_byte: Duration::from_millis(20),
            stream_idle: Duration::from_millis(20),
        };
        const START: &[u8] = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"role\":\"assistant\",\"content\":[],\"model\":\"model\"}}\n\n";
        for (prefix, headers, expected) in [
            (None, false, "REQUEST_HEADERS_TIMEOUT"),
            (None, true, "FIRST_BYTE_TIMEOUT"),
            (Some(START), true, "STREAM_IDLE_TIMEOUT"),
        ] {
            let (base_url, server) = serve_stalled(prefix, headers);
            let error = AnthropicMessagesAdapter {
                http: HttpConfig {
                    client: build_streaming_client().unwrap(),
                    provider: anthropic_provider(base_url),
                    api_key: Some("stage-e-secret".into()),
                    timeouts,
                },
            }
            .stream(
                basic_request(),
                CancellationToken::new(),
                Arc::new(Sink::default()),
            )
            .await
            .unwrap_err();
            assert_eq!(error.kind, NormalizedModelErrorKind::Timeout);
            assert_eq!(error.code.as_deref(), Some(expected));
            assert!(!error.message.contains("stage-e-secret"));
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn http_auth_rate_limit_and_server_errors_keep_safe_request_id() {
        for (status, expected) in [
            (401, NormalizedModelErrorKind::Authentication),
            (403, NormalizedModelErrorKind::Authentication),
            (429, NormalizedModelErrorKind::RateLimited),
            (500, NormalizedModelErrorKind::Retryable),
        ] {
            let body =
                format!("{{\"type\":\"error\",\"error\":{{\"message\":\"status {status}\"}}}}");
            let response = format!("HTTP/1.1 {status} Error\r\ncontent-type: application/json\r\nrequest-id: req_safe_{status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_bytes();
            let (base_url, server) = serve(response);
            let error = AnthropicMessagesAdapter {
                http: HttpConfig {
                    client: build_streaming_client().unwrap(),
                    provider: anthropic_provider(base_url),
                    api_key: Some("stage-e-secret".into()),
                    timeouts: ModelTimeoutPolicy::default(),
                },
            }
            .stream(
                basic_request(),
                CancellationToken::new(),
                Arc::new(Sink::default()),
            )
            .await
            .unwrap_err();
            let _ = server.join().unwrap();
            assert_eq!(error.kind, expected);
            assert_eq!(error.status, Some(status));
            assert!(error.message.contains(&format!("req_safe_{status}")));
            assert!(!error.message.contains("stage-e-secret"));
        }
    }

    #[test]
    fn endpoint_normalization_never_duplicates_version_or_messages() {
        for base in [
            "https://api.anthropic.com",
            "https://api.anthropic.com/v1",
            "https://api.anthropic.com/v1/messages",
        ] {
            let provider = anthropic_provider(base.into());
            assert_eq!(
                crate::llm::config::endpoint_url(&provider, "messages")
                    .unwrap()
                    .as_str(),
                "https://api.anthropic.com/v1/messages",
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires SHELLSPAN_LIVE_ANTHROPIC_API_KEY and external network access"]
    async fn live_anthropic_messages_basic_round() {
        let api_key = std::env::var("SHELLSPAN_LIVE_ANTHROPIC_API_KEY")
            .expect("SHELLSPAN_LIVE_ANTHROPIC_API_KEY is required");
        let adapter = AnthropicMessagesAdapter {
            http: HttpConfig {
                client: build_streaming_client().unwrap(),
                provider: anthropic_provider("https://api.anthropic.com".into()),
                api_key: Some(api_key),
                timeouts: ModelTimeoutPolicy::default(),
            },
        };
        let mut request = basic_request();
        request.system_prompt = "Reply with exactly OK.".into();
        let response = adapter
            .stream(request, CancellationToken::new(), Arc::new(Sink::default()))
            .await
            .unwrap();
        assert!(response.content.iter().any(
            |block| matches!(block, ModelContentBlock::Text { text } if !text.trim().is_empty())
        ));
    }
