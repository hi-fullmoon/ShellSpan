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

    fn scoped_event(
        seq: u64,
        turn: &str,
        step: &str,
        payload: AgentSessionEventPayload,
    ) -> AgentSessionEvent {
        AgentSessionEvent::new(
            "session".into(),
            seq,
            1_000 + seq,
            Some(turn.into()),
            Some(step.into()),
            payload,
        )
    }

    fn assistant_call(message_id: &str) -> AgentSessionEventPayload {
        AgentSessionEventPayload::AssistantMessage {
            message_id: message_id.into(),
            content: vec![AgentAssistantContentBlock::ToolCall {
                call: Box::new(super::super::RecordedToolCall {
                    call_id: "call-1".into(),
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
            stop_reason: AgentStopReason::ToolCalls,
            interrupted: false,
            replay: None,
        }
    }

    fn tool_result(status: AgentToolResultStatus, summary: &str) -> AgentSessionEventPayload {
        AgentSessionEventPayload::ToolResult {
            call_id: "call-1".into(),
            name: "apply_patch".into(),
            status,
            summary: summary.into(),
            data: Some(serde_json::json!({"evidence": summary})),
            duration_ms: None,
            evidence_refs: vec!["evidence-1".into()],
        }
    }

    fn recovery_events(status: Option<AgentToolResultStatus>) -> Vec<AgentSessionEvent> {
        let mut events = vec![scoped_event(
            0,
            "turn-1",
            "step-1",
            assistant_call("assistant-1"),
        )];
        if let Some(status) = status {
            events.push(scoped_event(
                1,
                "turn-1",
                "step-1",
                tool_result(status, "original"),
            ));
        }
        events.push(scoped_event(
            events.len() as u64,
            "turn-1",
            "step-1",
            AgentSessionEventPayload::StepEnd {
                reason: "interrupted".into(),
            },
        ));
        let mut end = event(
            events.len() as u64,
            AgentSessionEventPayload::TurnEnd {
                reason: "interrupted".into(),
            },
        );
        end.turn_id = Some("turn-1".into());
        events.push(end);
        events.push(event(
            events.len() as u64,
            AgentSessionEventPayload::SessionResumed {},
        ));
        events
    }

    fn assert_tool(message: &AgentSurfaceMessage, expected: AgentToolResultStatus, summary: &str) {
        let AgentSurfaceMessage::Tool {
            call_id,
            name,
            status,
            content,
        } = message
        else {
            panic!("expected a tool result, got {message:?}");
        };
        assert_eq!(call_id, "call-1");
        assert_eq!(name, "apply_patch");
        assert_eq!(*status, expected);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(content).unwrap(),
            serde_json::json!({
                "status": expected,
                "summary": summary,
                "data": {"evidence": summary},
            }),
        );
    }

    fn validate_history(
        surface: &AgentSurfaceSnapshot,
    ) -> Result<(), crate::llm::errors::NormalizedModelError> {
        let mut request = crate::llm::types::ModelRequest::from_surface(
            "recovery-request".into(),
            surface,
            String::new(),
            Vec::new(),
        );
        crate::llm::replay::project_history(
            crate::llm::registry::replay_codec("chat-completions").unwrap(),
            &mut request.messages,
            crate::llm::replay::ReplayTarget {
                route_id: "route",
                model_id: "model",
                replay_domain_id: "domain",
            },
        )
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
    fn recovery_reconciles_uncertain_results_without_rewriting_audit_events() {
        for status in [
            AgentToolResultStatus::Completed,
            AgentToolResultStatus::Cancelled,
        ] {
            let mut events = recovery_events(Some(AgentToolResultStatus::Uncertain));
            let original = derive_surface(&events).unwrap();
            assert_tool(
                &original.messages[1],
                AgentToolResultStatus::Uncertain,
                "original",
            );
            events.push(scoped_event(
                events.len() as u64,
                "turn-1",
                "step-1",
                tool_result(status, "verified"),
            ));
            let audit = events.clone();
            let surface = derive_surface(&events).unwrap();
            assert_eq!(events, audit);
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(
                        event.payload,
                        AgentSessionEventPayload::ToolResult { .. }
                    ))
                    .count(),
                2
            );
            assert_eq!(surface.messages.len(), 2);
            assert_eq!(surface.messages[0], original.messages[0]);
            assert_tool(&surface.messages[1], status, "verified");
            validate_history(&surface).unwrap();
        }
    }

    #[test]
    fn recovery_reconciles_old_calls_after_new_steps_turns_and_assistant_messages() {
        for initial in [None, Some(AgentToolResultStatus::Uncertain)] {
            for status in [
                AgentToolResultStatus::Completed,
                AgentToolResultStatus::Cancelled,
            ] {
                for new_turn in [false, true] {
                    let mut events = recovery_events(initial);
                    let original = derive_surface(&events).unwrap();
                    let turn = if new_turn { "turn-2" } else { "turn-1" };
                    if new_turn {
                        events.push(scoped_event(
                            events.len() as u64,
                            turn,
                            "step-2",
                            AgentSessionEventPayload::TurnStart,
                        ));
                    }
                    events.push(scoped_event(
                        events.len() as u64,
                        turn,
                        "step-2",
                        AgentSessionEventPayload::StepStart,
                    ));
                    // A text-only assistant message must not discard an older call's slot.
                    events.push(scoped_event(
                        events.len() as u64,
                        turn,
                        "step-2",
                        AgentSessionEventPayload::AssistantMessage {
                            message_id: "later-text".into(),
                            content: vec![AgentAssistantContentBlock::Text {
                                text: "Inspect saved execution evidence.".into(),
                            }],
                            usage: AgentTokenUsage::default(),
                            stop_reason: AgentStopReason::Stop,
                            interrupted: false,
                            replay: None,
                        },
                    ));
                    let mut sibling = assistant_call("later-call");
                    let AgentSessionEventPayload::AssistantMessage { content, .. } = &mut sibling
                    else {
                        unreachable!()
                    };
                    let AgentAssistantContentBlock::ToolCall { call } = &mut content[0] else {
                        unreachable!()
                    };
                    call.call_id = "call-2".into();
                    events.push(scoped_event(events.len() as u64, turn, "step-2", sibling));
                    let mut result = tool_result(AgentToolResultStatus::Completed, "later result");
                    let AgentSessionEventPayload::ToolResult { call_id, .. } = &mut result else {
                        unreachable!()
                    };
                    *call_id = "call-2".into();
                    events.push(scoped_event(events.len() as u64, turn, "step-2", result));
                    let before_confirmation = derive_surface(&events).unwrap();
                    events.push(scoped_event(
                        events.len() as u64,
                        "turn-1",
                        "step-1",
                        tool_result(status, "verified older execution"),
                    ));
                    let audit = events.clone();
                    let surface = derive_surface(&events).unwrap();
                    assert_eq!(events, audit);
                    assert_eq!(surface.messages.len(), before_confirmation.messages.len());
                    assert_eq!(surface.messages[0], original.messages[0]);
                    assert_eq!(surface.messages[2..], before_confirmation.messages[2..]);
                    assert_tool(&surface.messages[1], status, "verified older execution");
                    validate_history(&surface).unwrap();
                }
            }
        }
    }

    #[test]
    fn recovery_reconciles_synthetic_results_directly_or_after_uncertain_evidence() {
        for status in [
            AgentToolResultStatus::Completed,
            AgentToolResultStatus::Cancelled,
        ] {
            for uncertain_first in [false, true] {
                let mut events = recovery_events(None);
                let synthetic = derive_surface(&events).unwrap();
                assert_eq!(synthetic.messages.len(), 2);
                validate_history(&synthetic).unwrap();
                if uncertain_first {
                    events.push(scoped_event(
                        events.len() as u64,
                        "turn-1",
                        "step-1",
                        tool_result(AgentToolResultStatus::Uncertain, "original"),
                    ));
                    let uncertain = derive_surface(&events).unwrap();
                    assert_eq!(uncertain.messages.len(), 2);
                    assert_tool(
                        &uncertain.messages[1],
                        AgentToolResultStatus::Uncertain,
                        "original",
                    );
                    validate_history(&uncertain).unwrap();
                }
                events.push(scoped_event(
                    events.len() as u64,
                    "turn-1",
                    "step-1",
                    tool_result(status, "verified"),
                ));
                let surface = derive_surface(&events).unwrap();
                assert_eq!(surface.messages.len(), 2);
                assert_tool(&surface.messages[1], status, "verified");
                validate_history(&surface).unwrap();
            }
        }
    }

    #[test]
    fn recovery_does_not_hide_illegal_duplicate_or_orphan_results() {
        for statuses in [
            vec![
                AgentToolResultStatus::Completed,
                AgentToolResultStatus::Completed,
            ],
            vec![
                AgentToolResultStatus::Cancelled,
                AgentToolResultStatus::Completed,
            ],
            vec![
                AgentToolResultStatus::Uncertain,
                AgentToolResultStatus::Uncertain,
            ],
            vec![
                AgentToolResultStatus::Uncertain,
                AgentToolResultStatus::Completed,
                AgentToolResultStatus::Cancelled,
            ],
        ] {
            let mut events = vec![scoped_event(
                0,
                "turn-1",
                "step-1",
                assistant_call("assistant-1"),
            )];
            for status in statuses {
                events.push(scoped_event(
                    events.len() as u64,
                    "turn-1",
                    "step-1",
                    tool_result(status, "result"),
                ));
            }
            let surface = derive_surface(&events).unwrap();
            assert_eq!(surface.messages.len(), 3);
            let error = validate_history(&surface).unwrap_err();
            assert_eq!(error.code.as_deref(), Some("HISTORY_INCOMPATIBLE"));
            assert!(error.message.contains("duplicate tool result"));
        }
        let orphan = vec![
            scoped_event(
                0,
                "turn-1",
                "step-1",
                tool_result(AgentToolResultStatus::Uncertain, "original"),
            ),
            scoped_event(
                1,
                "turn-1",
                "step-1",
                tool_result(AgentToolResultStatus::Completed, "verified"),
            ),
        ];
        let surface = derive_surface(&orphan).unwrap();
        assert_eq!(surface.messages.len(), 2);
        assert_eq!(
            validate_history(&surface).unwrap_err().code.as_deref(),
            Some("HISTORY_INCOMPATIBLE")
        );
    }

    #[test]
    fn recovery_does_not_replace_results_from_other_turns_steps_or_assistants() {
        for initial in [None, Some(AgentToolResultStatus::Uncertain)] {
            for (turn, step, boundary) in [
                (
                    "turn-2",
                    "step-1",
                    Some(AgentSessionEventPayload::TurnStart),
                ),
                (
                    "turn-1",
                    "step-2",
                    Some(AgentSessionEventPayload::StepStart),
                ),
                ("turn-1", "step-1", None),
            ] {
                let mut events = recovery_events(initial);
                let original = derive_surface(&events).unwrap();
                if let Some(boundary) = boundary {
                    events.push(scoped_event(events.len() as u64, turn, step, boundary));
                }
                events.push(scoped_event(
                    events.len() as u64,
                    turn,
                    step,
                    assistant_call("assistant-2"),
                ));
                events.push(scoped_event(
                    events.len() as u64,
                    turn,
                    step,
                    tool_result(AgentToolResultStatus::Completed, "new call"),
                ));
                let surface = derive_surface(&events).unwrap();
                assert_eq!(surface.messages.len(), 4);
                assert_eq!(surface.messages[..2], original.messages);
                assert_tool(
                    &surface.messages[3],
                    AgentToolResultStatus::Completed,
                    "new call",
                );
                let error = validate_history(&surface).unwrap_err();
                assert_eq!(error.code.as_deref(), Some("HISTORY_INCOMPATIBLE"));
                assert!(error.message.contains("duplicate tool call id"));
            }
        }
    }

    #[test]
    fn recovery_requires_matching_scope_even_without_a_new_assistant() {
        for initial in [None, Some(AgentToolResultStatus::Uncertain)] {
            for (turn, step) in [("turn-2", "step-1"), ("turn-1", "step-2")] {
                let mut events = recovery_events(initial);
                let original = derive_surface(&events).unwrap();
                events.push(scoped_event(
                    events.len() as u64,
                    turn,
                    step,
                    tool_result(AgentToolResultStatus::Completed, "other scope"),
                ));
                let surface = derive_surface(&events).unwrap();
                assert_eq!(surface.messages.len(), 3);
                assert_eq!(surface.messages[..2], original.messages);
                assert_tool(
                    &surface.messages[2],
                    AgentToolResultStatus::Completed,
                    "other scope",
                );
                assert_eq!(
                    validate_history(&surface).unwrap_err().code.as_deref(),
                    Some("HISTORY_INCOMPATIBLE")
                );
            }
        }
    }

    #[test]
    fn recovery_does_not_clear_pending_calls_with_results_from_other_scopes() {
        for (turn, step) in [("turn-2", "step-1"), ("turn-1", "step-2")] {
            let events = vec![
                scoped_event(0, "turn-1", "step-1", assistant_call("assistant-1")),
                scoped_event(
                    1,
                    turn,
                    step,
                    tool_result(AgentToolResultStatus::Completed, "other scope"),
                ),
                event(2, AgentSessionEventPayload::SessionResumed {}),
                scoped_event(
                    3,
                    "turn-1",
                    "step-1",
                    tool_result(AgentToolResultStatus::Cancelled, "verified"),
                ),
            ];
            let surface = derive_surface(&events).unwrap();
            assert_eq!(surface.messages.len(), 3);
            assert_tool(
                &surface.messages[1],
                AgentToolResultStatus::Completed,
                "other scope",
            );
            assert_tool(
                &surface.messages[2],
                AgentToolResultStatus::Cancelled,
                "verified",
            );
            assert_eq!(
                validate_history(&surface).unwrap_err().code.as_deref(),
                Some("HISTORY_INCOMPATIBLE")
            );
        }
    }

    #[test]
    fn recovery_after_compaction_reconciles_only_retained_calls() {
        for boundary in [
            AgentSessionEventPayload::StepEnd {
                reason: "reconciled".into(),
            },
            AgentSessionEventPayload::TurnEnd {
                reason: "reconciled".into(),
            },
        ] {
            for initial in [None, Some(AgentToolResultStatus::Uncertain)] {
                let mut events = vec![
                    scoped_event(0, "turn-1", "step-1", assistant_call("assistant-1")),
                    scoped_event(
                        1,
                        "turn-1",
                        "step-1",
                        tool_result(AgentToolResultStatus::Uncertain, "original"),
                    ),
                    scoped_event(
                        2,
                        "turn-1",
                        "step-1",
                        tool_result(AgentToolResultStatus::Completed, "verified"),
                    ),
                    scoped_event(3, "turn-1", "step-1", boundary.clone()),
                    scoped_event(4, "turn-2", "step-2", assistant_call("assistant-2")),
                ];
                if let Some(status) = initial {
                    events.push(scoped_event(
                        events.len() as u64,
                        "turn-2",
                        "step-2",
                        tool_result(status, "retained"),
                    ));
                }
                events.push(event(
                    events.len() as u64,
                    AgentSessionEventPayload::SessionResumed {},
                ));
                events.push(event(
                    events.len() as u64,
                    AgentSessionEventPayload::CompactionSummary {
                        summary: "compacted prefix".into(),
                        replaced_through_seq: 3,
                        surface_generation: 1,
                    },
                ));
                events.push(event(
                    events.len() as u64,
                    AgentSessionEventPayload::CompactionEnd {
                        status: AgentCompactionStatus::Completed,
                        surface_generation: 1,
                        replaced_through_seq: 3,
                        compaction_id: None,
                        duration_ms: None,
                        reason: None,
                    },
                ));
                events.push(scoped_event(
                    events.len() as u64,
                    "turn-2",
                    "step-2",
                    tool_result(AgentToolResultStatus::Cancelled, "retained verified"),
                ));
                let audit = events.clone();
                let surface = derive_surface(&events).unwrap();
                assert_eq!(events, audit);
                assert_eq!(surface.generation, 1);
                assert_eq!(surface.replaced_through_seq, Some(3));
                assert_eq!(surface.messages.len(), 3);
                assert!(
                    matches!(&surface.messages[0], AgentSurfaceMessage::User { content, .. } if content == "compacted prefix")
                );
                assert!(
                    matches!(&surface.messages[1], AgentSurfaceMessage::Assistant { message_id, .. } if message_id == "assistant-2")
                );
                assert_tool(
                    &surface.messages[2],
                    AgentToolResultStatus::Cancelled,
                    "retained verified",
                );
                assert_eq!(surface_messages_after(&events, 3), surface.messages[1..]);
                validate_history(&surface).unwrap();
            }
        }
    }

    #[test]
    fn compaction_replaces_only_model_surface_at_a_completed_turn_boundary() {
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
    fn compaction_accepts_a_completed_step_boundary() {
        let events = vec![
            event(0, user("old", "old context")),
            event(
                1,
                AgentSessionEventPayload::StepEnd {
                    reason: "toolsCompleted".into(),
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
    }

    #[test]
    fn compaction_rejects_generation_gaps_and_partial_interaction_prefixes() {
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
