    use super::*;

    fn event(
        time_unix_ms: u64,
        payload: AgentSessionEventPayload,
    ) -> super::super::AgentSessionEvent {
        super::super::AgentSessionEvent {
            version: super::super::AGENT_SESSION_EVENT_VERSION,
            session_id: "budget-test".into(),
            seq: time_unix_ms,
            time_unix_ms,
            turn_id: None,
            step_id: None,
            payload,
        }
    }

    #[test]
    fn task_budget_excludes_waiting_and_idle_time_and_resets_on_explicit_resume() {
        let events = vec![
            event(
                100,
                AgentSessionEventPayload::AgentStatus {
                    status: AgentSessionStatus::Running,
                    reason: None,
                },
            ),
            event(
                200,
                AgentSessionEventPayload::AgentStatus {
                    status: AgentSessionStatus::Waiting,
                    reason: None,
                },
            ),
            event(
                1_000,
                AgentSessionEventPayload::AgentStatus {
                    status: AgentSessionStatus::Running,
                    reason: None,
                },
            ),
            event(
                1_200,
                AgentSessionEventPayload::AgentStatus {
                    status: AgentSessionStatus::Idle,
                    reason: None,
                },
            ),
            event(
                1_300,
                AgentSessionEventPayload::RequestContext {
                    request_id: "request-1".into(),
                    input_tokens: Some(40),
                    context_window: None,
                    system_tokens: None,
                    tool_schema_tokens: None,
                    message_tokens: None,
                    surface_generation: 0,
                    limited: None,
                    omitted_messages: None,
                },
            ),
            event(
                1_400,
                AgentSessionEventPayload::RequestUsage {
                    request_id: "request-1".into(),
                    usage: AgentTokenUsage {
                        output_tokens: Some(10),
                        ..AgentTokenUsage::default()
                    },
                    finish_reason: AgentStopReason::Stop,
                },
            ),
        ];
        assert_eq!(active_duration_ms(&events, 10_000), 300);
        assert_eq!(consumed_model_tokens(&events), 50);
        let mut resumed = events;
        resumed.push(event(10_100, AgentSessionEventPayload::SessionResumed {}));
        assert_eq!(active_duration_ms(&resumed, 10_200), 0);
        assert_eq!(consumed_model_tokens(&resumed), 0);
    }

    fn repeated_step(
        step_id: &str,
        call_id: &str,
        output: &str,
        user_input: bool,
        at: u64,
    ) -> Vec<super::super::AgentSessionEvent> {
        let mut payloads = Vec::new();
        if user_input {
            payloads.push(AgentSessionEventPayload::UserMessage {
                message: AgentInboxMessage {
                    images: Vec::new(),
                    message_id: format!("message-{step_id}"),
                    client_submission_id: None,
                    content: "check again".into(),
                    source: AgentMessageSource::user(),
                    terminal_context: None,
                },
            });
        }
        payloads.extend([
            AgentSessionEventPayload::ToolCall {
                call: super::super::RecordedToolCall {
                    call_id: call_id.into(),
                    provider_call_id: None,
                    name: "run_terminal_command".into(),
                    native_name: Some("exec_command".into()),
                    arguments: serde_json::json!({"command": "df -h"}),
                    title: None,
                    effect: None,
                    target: None,
                },
            },
            AgentSessionEventPayload::ToolResult {
                call_id: call_id.into(),
                name: "run_terminal_command".into(),
                status: super::super::AgentToolResultStatus::Completed,
                summary: "command completed".into(),
                data: Some(serde_json::json!({
                    "stdout": output,
                    "callId": call_id,
                    "processHandle": format!("process-{call_id}"),
                })),
                duration_ms: Some(10),
                evidence_refs: vec![format!("evidence-{call_id}")],
            },
            AgentSessionEventPayload::StepEnd {
                reason: "toolsCompleted".into(),
            },
        ]);
        payloads
            .into_iter()
            .enumerate()
            .map(|(index, payload)| {
                let mut event = event(at + index as u64, payload);
                event.turn_id = Some("turn-1".into());
                event.step_id = Some(step_id.into());
                event
            })
            .collect()
    }

    #[test]
    fn repeated_tool_streak_resets_on_new_observation_or_user_input() {
        let mut events = repeated_step("step-1", "call-1", "80%", false, 10);
        events.extend(repeated_step("step-2", "call-2", "80%", false, 20));
        assert_eq!(repeated_tool_step_streak(&events, "turn-1"), 2);
        events.extend(repeated_step("step-3", "call-3", "81%", false, 30));
        assert_eq!(repeated_tool_step_streak(&events, "turn-1"), 1);
        events.extend(repeated_step("step-4", "call-4", "81%", true, 40));
        assert_eq!(repeated_tool_step_streak(&events, "turn-1"), 1);
    }

    #[test]
    fn model_error_reasons_preserve_typed_terminal_classes() {
        for (kind, prefix) in [
            (NormalizedModelErrorKind::ContextTooLarge, "contextTooLarge"),
            (
                NormalizedModelErrorKind::Authentication,
                "authenticationFailed",
            ),
            (NormalizedModelErrorKind::RateLimited, "rateLimited"),
            (NormalizedModelErrorKind::Terminal, "providerFailure"),
        ] {
            assert!(
                model_error_reason(&NormalizedModelError::new(kind, "failure"), 1, 3, 0,)
                    .starts_with(prefix)
            );
        }
    }

    #[test]
    fn interrupted_stream_accumulator_preserves_reasoning_and_text_order() {
        let mut partial = PartialContentAccumulator::default();
        partial.push_reasoning(0, "checked constraints");
        partial.push_text(1, "partial answer");
        assert_eq!(
            partial.content(),
            vec![
                AgentAssistantContentBlock::Reasoning {
                    text: "checked constraints".into(),
                    provider_item: None,
                },
                AgentAssistantContentBlock::Text {
                    text: "partial answer".into(),
                },
            ]
        );
    }

    #[test]
    fn stream_chunks_stay_within_the_session_limit_without_splitting_utf8() {
        let input = format!(
            "{}思考内容{}",
            "a".repeat(MAX_AGENT_STREAM_DELTA_BYTES - 2),
            "b".repeat(MAX_AGENT_STREAM_DELTA_BYTES)
        );
        let chunks = utf8_chunks(&input, MAX_AGENT_STREAM_DELTA_BYTES);

        assert!(chunks.len() >= 3);
        assert!(chunks
            .iter()
            .all(|chunk| !chunk.is_empty() && chunk.len() <= MAX_AGENT_STREAM_DELTA_BYTES));
        assert_eq!(chunks.concat(), input);
    }
