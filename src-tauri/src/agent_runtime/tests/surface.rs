    use super::*;
    use crate::agent_runtime::{
        AgentAssistantContentBlock, AgentInboxMessage, AgentMessageSource, AgentStopReason,
        AgentTokenUsage,
    };

    fn event(seq: u64, payload: AgentSessionEventPayload) -> AgentSessionEvent {
        AgentSessionEvent::new("session".into(), seq, 1_000 + seq, None, None, payload)
    }

    fn user(id: &str, content: &str) -> AgentSessionEventPayload {
        AgentSessionEventPayload::UserMessage {
            message: AgentInboxMessage {
                images: Vec::new(),
                message_id: id.into(),
                client_submission_id: None,
                content: content.into(),
                source: AgentMessageSource::user(),
                terminal_context: None,
            },
        }
    }

    #[test]
    fn surface_excludes_chunks_and_control_events() {
        let events = vec![
            event(0, AgentSessionEventPayload::TurnStart),
            event(1, user("user", "inspect")),
            event(
                2,
                AgentSessionEventPayload::AssistantChunk {
                    request_id: "request".into(),
                    text_delta: Some("par".into()),
                    reasoning_delta: None,
                    tool_call_delta: None,
                    usage: None,
                },
            ),
            event(
                3,
                AgentSessionEventPayload::AssistantMessage {
                    message_id: "assistant".into(),
                    content: vec![AgentAssistantContentBlock::Text {
                        text: "partial".into(),
                    }],
                    usage: AgentTokenUsage::default(),
                    stop_reason: AgentStopReason::Stop,
                    interrupted: false,
                    replay: None,
                },
            ),
        ];

        let surface = derive_surface(&events).unwrap();
        assert_eq!(surface.messages.len(), 2);
        assert!(matches!(
            surface.messages[0],
            AgentSurfaceMessage::User { .. }
        ));
        assert!(matches!(
            surface.messages[1],
            AgentSurfaceMessage::Assistant { .. }
        ));
    }

    #[test]
    fn surface_preserves_structured_tool_data_for_the_next_model_request() {
        let events = vec![event(
            0,
            AgentSessionEventPayload::ToolResult {
                call_id: "call-1".into(),
                name: "run_terminal_command".into(),
                status: AgentToolResultStatus::Completed,
                summary: "Direct command reached Exited.".into(),
                data: Some(serde_json::json!({
                    "exitCode": 0,
                    "stdout": "Mem: 3.6Gi total\n/dev/vda1 72% /\n",
                    "stderr": "",
                    "truncated": false,
                })),
                duration_ms: Some(1251),
                evidence_refs: Vec::new(),
            },
        )];

        let surface = derive_surface(&events).unwrap();
        let AgentSurfaceMessage::Tool {
            status, content, ..
        } = &surface.messages[0]
        else {
            panic!("expected a tool surface message");
        };
        let content: serde_json::Value = serde_json::from_str(content).unwrap();

        assert_eq!(*status, AgentToolResultStatus::Completed);
        assert_eq!(content["status"], "completed");
        assert_eq!(content["summary"], "Direct command reached Exited.");
        assert_eq!(content["data"]["exitCode"], 0);
        assert_eq!(
            content["data"]["stdout"],
            "Mem: 3.6Gi total\n/dev/vda1 72% /\n"
        );
    }

    #[test]
    fn interrupted_tool_calls_keep_one_protocol_result_and_prefer_committed_evidence() {
        let mut events = vec![
            event(
                0,
                AgentSessionEventPayload::AssistantMessage {
                    message_id: "partial-tool-call".into(),
                    content: vec![AgentAssistantContentBlock::ToolCall {
                        call: Box::new(super::super::RecordedToolCall {
                            call_id: "interrupted-call".into(),
                            provider_call_id: None,
                            name: "apply_patch".into(),
                            native_name: None,
                            arguments: serde_json::json!({}),
                            title: None,
                            effect: None,
                            target: None,
                        }),
                    }],
                    usage: AgentTokenUsage::default(),
                    stop_reason: AgentStopReason::Cancelled,
                    interrupted: true,
                    replay: None,
                },
            ),
            event(
                1,
                AgentSessionEventPayload::TurnEnd {
                    reason: "cancelled".into(),
                },
            ),
            event(2, AgentSessionEventPayload::SessionResumed {}),
        ];
        let surface = derive_surface(&events).unwrap();
        assert_eq!(surface.messages.len(), 2);
        assert!(
            matches!(&surface.messages[1], AgentSurfaceMessage::Tool { status: AgentToolResultStatus::Cancelled, content, .. } if content.contains("without a recorded outcome"))
        );
        events.push(event(
            3,
            AgentSessionEventPayload::ToolResult {
                call_id: "interrupted-call".into(),
                name: "apply_patch".into(),
                status: AgentToolResultStatus::Completed,
                summary: "write confirmed".into(),
                data: None,
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
        ));
        let surface = derive_surface(&events).unwrap();
        assert_eq!(
            surface.messages.len(),
            2,
            "there must be exactly one result for a tool call"
        );
        assert!(
            matches!(&surface.messages[1], AgentSurfaceMessage::Tool { status: AgentToolResultStatus::Completed, content, .. } if content.contains("write confirmed"))
        );
    }

    #[test]
    fn compaction_replaces_only_model_surface_and_requires_a_turn_boundary() {
        let events = vec![
            event(0, user("old", "old context")),
            event(
                1,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            ),
            event(
                2,
                AgentSessionEventPayload::CompactionSummary {
                    summary: "summary".into(),
                    replaced_through_seq: 1,
                    surface_generation: 1,
                },
            ),
            event(3, user("new", "new context")),
        ];

        let surface = derive_surface(&events).unwrap();
        assert_eq!(surface.generation, 1);
        assert_eq!(surface.replaced_through_seq, Some(1));
        assert_eq!(surface.messages.len(), 2);
        assert!(matches!(
            &surface.messages[0],
            AgentSurfaceMessage::User { content, .. } if content == "summary"
        ));
        assert!(matches!(
            &surface.messages[1],
            AgentSurfaceMessage::User { content, .. } if content == "new context"
        ));
        assert_eq!(events.len(), 4, "the original log remains untouched");
    }

    #[test]
    fn compaction_rejects_generation_gaps_and_partial_turn_prefixes() {
        let gap = vec![
            event(
                0,
                AgentSessionEventPayload::TurnEnd {
                    reason: "ok".into(),
                },
            ),
            event(
                1,
                AgentSessionEventPayload::CompactionSummary {
                    summary: "summary".into(),
                    replaced_through_seq: 0,
                    surface_generation: 2,
                },
            ),
        ];
        assert!(derive_surface(&gap).is_err());

        let partial = vec![
            event(0, user("old", "old")),
            event(
                1,
                AgentSessionEventPayload::CompactionSummary {
                    summary: "summary".into(),
                    replaced_through_seq: 0,
                    surface_generation: 1,
                },
            ),
        ];
        assert!(derive_surface(&partial).is_err());
    }
