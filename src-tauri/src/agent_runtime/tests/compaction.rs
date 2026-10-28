    use super::*;
    use crate::agent_runtime::{
        estimate_model_surface_budget, AgentInboxMessage, AgentMessageSource, AgentPlanStep,
        AgentSessionEvent, AgentStopReason, AgentTokenUsage, AgentToolApprovalStatus,
        AgentToolResultStatus, RecordedToolCall,
    };
    use crate::ai::{AiProviderConfig, AiProviderKind};

    fn event(
        seq: u64,
        turn_id: Option<&str>,
        step_id: Option<&str>,
        payload: AgentSessionEventPayload,
    ) -> AgentSessionEvent {
        AgentSessionEvent::new(
            "session".into(),
            seq,
            1_000 + seq,
            turn_id.map(str::to_string),
            step_id.map(str::to_string),
            payload,
        )
    }

    fn budget() -> ModelSurfaceBudget {
        ModelSurfaceBudget {
            reserved_tokens_per_image: 0,
            context_window: 16_384,
            output_reserve_tokens: 1_024,
            safety_reserve_tokens: 1_024,
            usable_input_tokens: 14_336,
            compaction_threshold_tokens: 12_185,
            compaction_target_tokens: 8_601,
            system_tokens: 100,
            tool_schema_tokens: 100,
            message_tokens: 13_000,
            estimated_input_tokens: 13_200,
            estimated_input_bytes: 52_800,
            maximum_input_bytes: 57_344,
            tool_message_sizes: Default::default(),
            assistant_message_sizes: Default::default(),
        }
    }

    #[test]
    fn semantic_claims_cannot_restore_an_old_one_time_goal() {
        let (_root, sessions, _) = configured_session();
        let mut header = sessions.snapshot("session").unwrap().header;
        header.goal = "现在只回复“收到”。".into();
        header.success_criteria = vec![header.goal.clone()];
        let input = |seq, turn: &str, content: &str| {
            event(
                seq,
                Some(turn),
                Some("step"),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        message_id: format!("message-{seq}"),
                        client_submission_id: None,
                        content: content.into(),
                        source: AgentMessageSource::user(),
                        images: Vec::new(),
                        terminal_context: None,
                    },
                },
            )
        };
        let events = vec![
            input(0, "ack", &header.goal),
            input(1, "review", "完成跨模块只读审查并输出带文件行号的结论。"),
        ];
        // The current request can be outside the compressed prefix.
        let checkpoint = structured_checkpoint(&header, &events, 0, 0);
        let summary = serde_json::json!({
            "latestUserConstraints": [header.goal],
            "completedWork": ["None recorded"],
            "unfinishedWork": ["None recorded"],
            "keyDecisionsAndReasons": ["None recorded"],
            "relatedFilesSymbolsCommands": ["None recorded"],
            "todosAndBlockers": ["None recorded"],
            "nextSteps": ["None recorded"],
        });
        let merged = SemanticSummary::parse(&summary.to_string())
            .unwrap()
            .merge(&checkpoint);
        assert_eq!(merged.goal, "完成跨模块只读审查并输出带文件行号的结论。");
        assert!(merged.success_criteria.is_empty());
        assert_eq!(
            merged.latest_user_constraints,
            checkpoint.latest_user_constraints
        );
        assert!(!merged
            .latest_user_constraints
            .iter()
            .any(|line| line.contains("现在只回复")));
        assert_eq!(merged.historical_user_constraints, vec![header.goal]);
    }

    #[test]
    #[ignore = "requires a real read-only session ledger in SHELLSPAN_CURRENT_TASK_AUDIT_LOG"]
    fn historical_current_task_audit() {
        let path = std::env::var("SHELLSPAN_CURRENT_TASK_AUDIT_LOG").unwrap();
        let events = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<AgentSessionEvent>(line).unwrap())
            .collect::<Vec<_>>();
        let (_root, sessions, _) = configured_session();
        let mut header = sessions.snapshot("session").unwrap().header;
        if let AgentSessionEventPayload::SessionCreated {
            goal,
            success_criteria,
            parent_session_id,
            ..
        } = &events[0].payload
        {
            header.goal = goal.clone();
            header.success_criteria = success_criteria.clone();
            header.parent_session_id = parent_session_id.clone();
        } else {
            panic!("ledger must start with session/created");
        }
        // Audit the screenshot's review turn even if the live session has since
        // received a continuation or another user request.
        let review = events.iter().find(|event| matches!(&event.payload,
            AgentSessionEventPayload::UserMessage { message }
                if message.source.kind == AgentMessageSourceKind::User && message.content.contains("完成一次跨模块"))).unwrap();
        let end = events.iter().position(|event| event.seq > review.seq && matches!(&event.payload,
            AgentSessionEventPayload::UserMessage { message }
                if message.source.kind == AgentMessageSourceKind::User && event.turn_id != review.turn_id)).unwrap_or(events.len());
        let events = &events[..end];
        let task = super::super::prompt::current_task_context(&header, events);
        assert!(header.goal.contains("现在只回复"));
        assert!(task.goal.contains("完成一次跨模块"));
        assert!(task.success_criteria.is_empty());
        assert!(!task
            .requests
            .iter()
            .any(|request| request.contains("现在只回复")));
        let mut audited = 0;
        for event in events {
            if let AgentSessionEventPayload::CompactionSummary {
                replaced_through_seq,
                surface_generation,
                ..
            } = event.payload
            {
                let checkpoint = structured_checkpoint(
                    &header,
                    &events[..event.seq as usize],
                    replaced_through_seq,
                    surface_generation - 1,
                );
                assert_eq!(checkpoint.goal, task.goal);
                assert!(checkpoint.success_criteria.is_empty());
                assert!(!checkpoint
                    .latest_user_constraints
                    .iter()
                    .any(|request| request.contains("现在只回复")));
                // A syntactically valid semantic result carrying the old observed
                // instruction cannot overwrite canonical current user input.
                let semantic = SemanticSummary {
                    latest_user_constraints: vec![header.goal.clone()],
                    completed_work: checkpoint.completed_work.clone(),
                    unfinished_work: checkpoint.unfinished_work.clone(),
                    key_decisions_and_reasons: checkpoint.key_decisions_and_reasons.clone(),
                    related_files_symbols_commands: Vec::new(),
                    todos_and_blockers: Vec::new(),
                    next_steps: Vec::new(),
                }
                .merge(&checkpoint);
                assert_eq!(
                    semantic.latest_user_constraints,
                    checkpoint.latest_user_constraints
                );
                assert_eq!(semantic.goal, checkpoint.goal);
                audited += 1;
            }
        }
        assert!(
            audited > 1,
            "the real ledger must exercise repeated compaction"
        );
    }

    #[test]
    fn summary_reasoning_does_not_consume_json_budget_and_both_remain_bounded() {
        use super::super::{ModelStreamSink, StreamDelta};
        let source = include_str!("../compaction.rs");
        let reasoning = source
            .chars()
            .take(SUMMARY_OUTPUT_BYTES + 1)
            .collect::<String>();
        let sink = SummarySink::default();
        sink.emit(StreamDelta::Reasoning {
            index: 0,
            text: reasoning,
        })
        .unwrap();
        sink.emit(StreamDelta::Text {
            index: 1,
            text: include_str!("../../../../package.json").into(),
        })
        .unwrap();
        assert!(sink
            .emit(StreamDelta::Reasoning {
                index: 0,
                text: source.into()
            })
            .is_err());
        assert!(sink
            .emit(StreamDelta::Text {
                index: 1,
                text: source.into()
            })
            .is_err());
    }

    #[test]
    fn summary_policy_preserves_selected_model_and_bounds_multifragment_time() {
        let provider: AiProviderConfig = serde_json::from_value(serde_json::json!({
            "id":"deepseek", "kind":"openAiCompatible", "profile":"deepseek",
            "baseUrl":"https://api.deepseek.com", "model":"deepseek-v4-pro", "reasoningEffort":"high", "requiresApiKey":true
        })).unwrap();
        let summary = crate::llm::catalog::compaction_provider(&provider).unwrap();
        assert_eq!(provider.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(summary.reasoning_effort.as_deref(), Some("off"));
        assert_eq!(summary.model, provider.model);
        let main_model = crate::llm::catalog::resolve(&provider).unwrap();
        let summary_model = crate::llm::catalog::resolve(&summary).unwrap();
        assert_eq!(main_model.context_window, summary_model.context_window);
        assert_eq!(summary_model.max_output_tokens, 2048);
        let mut body = serde_json::json!({});
        crate::llm::catalog::apply_reasoning(
            &mut body,
            &summary_model,
            summary.reasoning_effort.clone(),
        );
        assert_eq!(body["thinking"]["type"], "disabled");
        let chunk = summary_chunk_bytes(
            summary_model.context_window,
            summary_model.max_output_tokens,
            4096,
        );
        assert_eq!(summary_deadline_seconds(chunk, chunk), 45);
        assert_eq!(summary_deadline_seconds(chunk * 4, chunk), 105);
        assert_eq!(
            summary_deadline_seconds(SUMMARY_MAX_SOURCE_BYTES, chunk),
            180
        );
    }

    #[test]
    fn below_trigger_compaction_requires_meaningful_reduction_and_byte_headroom() {
        let budget = budget();
        assert!(ProjectedBudget {
            input_tokens: 10_000,
            input_bytes: 40_000
        }
        .fits_target(&budget));
        assert!(!ProjectedBudget {
            input_tokens: 12_500,
            input_bytes: 50_000
        }
        .fits_target(&budget));
        assert!(!ProjectedBudget {
            input_tokens: 10_000,
            input_bytes: 52_000
        }
        .fits_target(&budget));
    }

    #[test]
    fn projection_matches_retained_occurrences_when_call_ids_are_reused() {
        let previous = AgentSurfaceSnapshot {
            generation: 0,
            replaced_through_seq: None,
            messages: [
                include_str!("../../../../src-tauri/Cargo.toml"),
                include_str!("../../../../AGENTS.md"),
            ]
            .into_iter()
            .map(|content| AgentSurfaceMessage::Tool {
                call_id: "reused".into(),
                name: "read_file".into(),
                status: AgentToolResultStatus::Completed,
                content: content.into(),
            })
            .collect(),
        };
        let replacement = AgentSurfaceSnapshot {
            generation: 1,
            replaced_through_seq: Some(1),
            messages: vec![previous.messages[1].clone()],
        };
        let request = ModelRequest::from_surface("cost".into(), &previous, String::new(), vec![]);
        let sizes = request
            .messages
            .iter()
            .map(|message| measure_model_messages(std::slice::from_ref(message), 0))
            .collect::<Vec<_>>();
        let mut budget = budget();
        budget
            .tool_message_sizes
            .insert("reused".into(), sizes.clone());
        budget.estimated_input_tokens = sizes.iter().map(|size| size.0).sum::<u64>() + 200;
        budget.estimated_input_bytes = sizes.iter().map(|size| size.1).sum::<u64>() + 800;
        let projected = budget_after_surface_replacement(&budget, &previous, &replacement);
        assert_eq!(projected.input_tokens, sizes[1].0 + 200);
        assert_eq!(projected.input_bytes, sizes[1].1 + 800);
    }

    #[test]
    fn projection_removes_live_terminal_arguments_and_preserves_inherited_costs() {
        use crate::agent_runtime::{ModelContentBlock, ModelMessage, ModelToolCall};
        let texts = [
            include_str!("../../../../AGENTS.md"),
            include_str!("../../../../src-tauri/Cargo.toml"),
        ];
        let calls = texts
            .iter()
            .enumerate()
            .map(|(index, text)| ModelToolCall {
                call_id: format!("input-{index}"),
                provider_call_id: None,
                name: "write_terminal_input".into(),
                arguments: serde_json::json!({"inputKind":"paste","text":text}),
            })
            .collect::<Vec<_>>();
        let previous = AgentSurfaceSnapshot {
            generation: 0,
            replaced_through_seq: None,
            messages: calls
                .iter()
                .enumerate()
                .map(|(index, call)| AgentSurfaceMessage::Assistant {
                    message_id: format!("input-{index}"),
                    content: vec![AgentAssistantContentBlock::ToolCall {
                        call: Box::new(crate::agent_runtime::model::recorded_tool_call(
                            call.clone(),
                        )),
                    }],
                    interrupted: false,
                    replay: None,
                })
                .collect(),
        };
        let replacement = AgentSurfaceSnapshot {
            generation: 1,
            replaced_through_seq: Some(1),
            messages: vec![previous.messages[1].clone()],
        };
        let mut request =
            ModelRequest::from_surface("live-input".into(), &previous, String::new(), vec![]);
        for (message, call) in request.messages.iter_mut().zip(&calls) {
            let ModelMessage::Assistant { content, .. } = message else {
                panic!()
            };
            let ModelContentBlock::ToolCall { call: historical } = &mut content[0] else {
                panic!()
            };
            assert_ne!(historical.arguments, call.arguments);
            historical.arguments = call.arguments.clone();
        }
        request.messages.insert(
            0,
            ModelMessage::Assistant {
                content: vec![ModelContentBlock::Text {
                    text: include_str!("../../../../src-tauri/Cargo.toml").into(),
                }],
                replay: None,
                native_replay: None,
            },
        );
        let sizes = request
            .messages
            .iter()
            .map(|message| measure_model_messages(std::slice::from_ref(message), 0))
            .collect::<Vec<_>>();
        let mut budget = budget();
        budget.assistant_message_sizes = sizes.clone();
        budget.estimated_input_tokens = sizes.iter().map(|size| size.0).sum::<u64>() + 200;
        budget.estimated_input_bytes = sizes.iter().map(|size| size.1).sum::<u64>() + 800;
        let projected = budget_after_surface_replacement(&budget, &previous, &replacement);
        assert_eq!(projected.input_tokens, 200 + sizes[0].0 + sizes[2].0);
        assert_eq!(projected.input_bytes, 800 + sizes[0].1 + sizes[2].1);
    }

    #[tokio::test]
    async fn prepared_budget_recovery_compacts_real_stored_input_once_and_honors_cancellation() {
        let source = include_str!("../../../../src-tauri/Cargo.lock")
            .char_indices()
            .take_while(|(offset, ch)| offset + ch.len_utf8() <= 64 * 1024)
            .map(|(_, ch)| ch)
            .collect::<String>();
        let root = tempfile::tempdir().unwrap();
        let sessions = AgentSessionStore::default();
        let artifacts = AgentArtifactStore::default();
        sessions.configure(root.path().to_path_buf()).unwrap();
        artifacts.configure(root.path()).unwrap();
        sessions.create(serde_json::from_value(serde_json::json!({"sessionId":"session","taskId":"task","goal":"Inspect repository instructions","executionSurface":"direct"})).unwrap()).unwrap();
        sessions
            .enqueue(
                "session",
                crate::agent_runtime::AgentInboxLane::NextTurn,
                AgentInboxMessage {
                    message_id: "source".into(),
                    client_submission_id: None,
                    content: source.clone(),
                    source: AgentMessageSource::user(),
                    images: vec![],
                    terminal_context: None,
                },
            )
            .unwrap();
        sessions
            .begin_turn_step("session", "turn-old".into(), "step-old".into())
            .unwrap();
        // Commit actual repository input and close it through the real pause API.
        // This test does not invent an assistant response or replay envelope.
        sessions
            .pause_for_input("session", "stoppedByUser")
            .unwrap();
        let previous = sessions.model_surface("session").unwrap();
        let request =
            ModelRequest::from_surface("prepared".into(), &previous, String::new(), vec![]);
        let mut measured = budget();
        let plain = measure_model_messages(&request.messages, 0);
        measured.estimated_input_tokens = plain.0 + 200;
        measured.estimated_input_bytes = plain.1 + 800;
        assert!(!measured.fits_hard_limit());
        let manager = AgentCompactionManager::new(sessions.clone(), artifacts);
        let mut attempted = false;
        assert!(crate::agent_runtime::driver::compact_prepared_budget(
            &manager,
            "session",
            "turn-current",
            "step-current",
            previous.generation,
            &measured,
            &mut attempted,
            &CancellationToken::new()
        )
        .await
        .unwrap());
        let updated = sessions.model_surface("session").unwrap();
        assert!(updated.generation > previous.generation);
        assert!(
            budget_after_surface_replacement(&measured, &previous, &updated).fits_target(&measured)
        );
        assert!(!crate::agent_runtime::driver::compact_prepared_budget(
            &manager,
            "session",
            "turn-current",
            "step-current",
            updated.generation,
            &measured,
            &mut attempted,
            &CancellationToken::new()
        )
        .await
        .unwrap());
        assert_eq!(
            sessions.model_surface("session").unwrap().generation,
            updated.generation
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let mut cancelled_attempt = false;
        assert!(crate::agent_runtime::driver::compact_prepared_budget(
            &manager,
            "session",
            "turn-current",
            "step-current",
            updated.generation,
            &measured,
            &mut cancelled_attempt,
            &cancelled
        )
        .await
        .is_err());
        assert_eq!(
            sessions.model_surface("session").unwrap().generation,
            updated.generation
        );
        assert!(sessions.all_events("session").unwrap().iter().any(|event| matches!(&event.payload,AgentSessionEventPayload::UserMessage { message } if message.content == source)));
    }

    #[test]
    fn projection_removes_private_metadata_with_the_replaced_assistant() {
        use crate::agent_runtime::ModelMessage;
        let previous = AgentSurfaceSnapshot {
            generation: 0,
            replaced_through_seq: None,
            messages: vec![AgentSurfaceMessage::Assistant {
                message_id: "manifest".into(),
                content: vec![AgentAssistantContentBlock::Text {
                    text: include_str!("../../../../src-tauri/Cargo.toml").into(),
                }],
                interrupted: false,
                replay: None,
            }],
        };
        let mut request =
            ModelRequest::from_surface("cost".into(), &previous, String::new(), vec![]);
        let ModelMessage::Assistant { native_replay, .. } = &mut request.messages[0] else {
            panic!()
        };
        *native_replay = Some(
            serde_json::json!({"reasoningDetails":include_str!("../../../../src-tauri/Cargo.lock")}),
        );
        let size = measure_model_messages(&request.messages, 0);
        let mut budget = budget();
        budget.assistant_message_sizes = vec![size];
        budget.estimated_input_tokens = size.0 + 200;
        budget.estimated_input_bytes = size.1 + 800;
        let replacement = AgentSurfaceSnapshot {
            generation: 1,
            replaced_through_seq: Some(1),
            messages: vec![],
        };
        let projected = budget_after_surface_replacement(&budget, &previous, &replacement);
        assert_eq!(projected.input_tokens, 200);
        assert_eq!(projected.input_bytes, 800);
    }

    #[tokio::test]
    async fn prepared_budget_recovery_without_a_safe_prefix_does_not_mutate_history() {
        let root = tempfile::tempdir().unwrap();
        let sessions = AgentSessionStore::default();
        let artifacts = AgentArtifactStore::default();
        sessions.configure(root.path().to_path_buf()).unwrap();
        artifacts.configure(root.path()).unwrap();
        sessions.create(serde_json::from_value(serde_json::json!({"sessionId":"session","taskId":"task","goal":"Inspect repository input","executionSurface":"direct"})).unwrap()).unwrap();
        let source = include_str!("../../../../src-tauri/Cargo.lock")
            .char_indices()
            .take_while(|(offset, ch)| offset + ch.len_utf8() <= 64 * 1024)
            .map(|(_, ch)| ch)
            .collect::<String>();
        sessions
            .enqueue(
                "session",
                crate::agent_runtime::AgentInboxLane::NextTurn,
                AgentInboxMessage {
                    message_id: "source".into(),
                    client_submission_id: None,
                    content: source,
                    source: AgentMessageSource::user(),
                    images: vec![],
                    terminal_context: None,
                },
            )
            .unwrap();
        sessions
            .begin_turn_step("session", "turn-current".into(), "step-current".into())
            .unwrap();
        let before = sessions.all_events("session").unwrap();
        let surface = sessions.model_surface("session").unwrap();
        let request =
            ModelRequest::from_surface("prepared".into(), &surface, String::new(), vec![]);
        let size = measure_model_messages(&request.messages, 0);
        let mut measured = budget();
        measured.estimated_input_tokens = size.0 + 200;
        measured.estimated_input_bytes = size.1 + 800;
        assert!(!measured.fits_hard_limit());
        let manager = AgentCompactionManager::new(sessions.clone(), artifacts);
        let mut attempted = false;
        assert!(crate::agent_runtime::driver::compact_prepared_budget(
            &manager,
            "session",
            "turn-current",
            "step-current",
            surface.generation,
            &measured,
            &mut attempted,
            &CancellationToken::new()
        )
        .await
        .unwrap_err()
        .contains("no completed safe"));
        assert!(attempted);
        assert_eq!(sessions.all_events("session").unwrap(), before);
        assert!(!crate::agent_runtime::driver::compact_prepared_budget(
            &manager,
            "session",
            "turn-current",
            "step-current",
            surface.generation,
            &measured,
            &mut attempted,
            &CancellationToken::new()
        )
        .await
        .unwrap());
        assert_eq!(sessions.all_events("session").unwrap(), before);
    }

    #[test]
    fn retained_real_image_pixels_are_included_in_compaction_projection() {
        use base64::Engine;
        let (root, sessions, _) = configured_session();
        let images = crate::agent_runtime::images::ImageStore::default();
        images.configure(root.path()).unwrap();
        let refs = images
            .import(
                &[crate::agent_runtime::images::ImageUpload {
                    media_type: "image/png".into(),
                    name: "ShellSpan icon".into(),
                    data: base64::engine::general_purpose::STANDARD
                        .encode(include_bytes!("../../../../src-tauri/icons/32x32.png")),
                }],
                &CancellationToken::new(),
            )
            .unwrap();
        let mut events = sessions.all_events("session").unwrap();
        for event in &mut events {
            if let AgentSessionEventPayload::UserMessage { message } = &mut event.payload {
                message.images = refs.clone();
                break;
            }
        }
        let surface = super::super::derive_surface(&events).unwrap();
        let request =
            ModelRequest::from_surface("image-budget".into(), &surface, String::new(), vec![]);
        let mut budget = budget();
        budget.reserved_tokens_per_image = 20_000;
        let measured = measure_model_messages(&request.messages, budget.reserved_tokens_per_image);
        budget.estimated_input_tokens = measured.0 + 200;
        budget.estimated_input_bytes = measured.1 + 800;
        let projection = projected_budget(
            &surface,
            &events,
            events.last().unwrap().seq,
            "checkpoint",
            &budget,
        );
        assert!(projection.input_tokens >= 20_000);
        assert!(!projection.fits_target(&budget));
    }

    #[test]
    #[ignore = "requires a real historical session log supplied through SHELLSPAN_CONTEXT_AUDIT_LOG"]
    fn historical_approval_budget_audit() {
        let path = std::env::var("SHELLSPAN_CONTEXT_AUDIT_LOG").expect("provide the real log path");
        let text = std::fs::read_to_string(path).unwrap();
        let all: Vec<AgentSessionEvent> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let failed = all.iter().position(|event| matches!(&event.payload, AgentSessionEventPayload::CompactionStart { reason, .. } if reason.contains("smallest checkpoint projected"))).expect("log must contain the original budget failure");
        let old_boundary = all[failed..]
            .iter()
            .find_map(|event| match event.payload {
                AgentSessionEventPayload::CompactionEnd {
                    replaced_through_seq,
                    status: AgentCompactionStatus::Failed,
                    ..
                } => Some(replaced_through_seq),
                _ => None,
            })
            .unwrap();
        let events = &all[..failed];
        let surface = super::super::derive_surface(events).unwrap();
        let active_turn = events
            .iter()
            .rev()
            .find_map(|event| event.turn_id.as_deref())
            .unwrap();
        let latest_complete = events.iter().rev().find(|event| matches!(&event.payload, AgentSessionEventPayload::StepEnd { reason } if reason == "toolsCompleted")).unwrap().seq;
        let selected =
            complete_compaction_boundaries(events, surface.replaced_through_seq, Some(active_turn))
                .unwrap();
        assert_eq!(selected.last().copied(), Some(latest_complete));
        assert!(latest_complete > old_boundary);
        for index in 0..events.len() {
            if matches!(&events[index].payload, AgentSessionEventPayload::StepEnd { reason } if reason == "waitingForTool")
            {
                assert!(!complete_compaction_boundaries(
                    &events[..=index],
                    None,
                    Some(active_turn)
                )
                .unwrap()
                .contains(&events[index].seq));
            }
        }
        let header_event = events
            .iter()
            .find(|event| {
                matches!(
                    event.payload,
                    AgentSessionEventPayload::SessionCreated { .. }
                )
            })
            .unwrap();
        let mut header_value = serde_json::to_value(&header_event.payload).unwrap()["data"].clone();
        header_value["sessionId"] = serde_json::json!(header_event.session_id);
        header_value["createdAtUnixMs"] = serde_json::json!(header_event.time_unix_ms);
        let header: AgentSessionHeader = serde_json::from_value(header_value).unwrap();
        let (system_prompt, tools) = events
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                AgentSessionEventPayload::RequestHeader {
                    system_prompt,
                    tool_schemas,
                    ..
                } => Some((system_prompt.clone(), tool_schemas.clone())),
                _ => None,
            })
            .unwrap();
        let mut request =
            ModelRequest::from_surface("historical-audit".into(), &surface, String::new(), tools);
        // The archived header already includes ModelRequest's trust preamble.
        request.system_prompt = system_prompt;
        let (message_tokens, message_bytes) = measure_model_messages(&request.messages, 0);
        let system_bytes = request.system_prompt.len() as u64;
        let tool_bytes = serde_json::to_vec(&request.tools).unwrap().len() as u64;
        let mut observed = budget();
        observed.system_tokens = system_bytes.div_ceil(4);
        observed.tool_schema_tokens = tool_bytes.div_ceil(4);
        observed.message_tokens = message_tokens;
        observed.estimated_input_tokens =
            observed.system_tokens + observed.tool_schema_tokens + message_tokens;
        observed.estimated_input_bytes = system_bytes + tool_bytes + message_bytes;
        observed.compaction_target_tokens = 7864;
        observed.compaction_threshold_tokens = 11141;
        observed.usable_input_tokens = 13108;
        observed.maximum_input_bytes = 52432;
        let old = structured_checkpoint(&header, events, old_boundary, surface.generation);
        let new = structured_checkpoint(&header, events, latest_complete, surface.generation);
        let before = projected_budget(
            &surface,
            events,
            old_boundary,
            &render_checkpoint(&old, 2048),
            &observed,
        );
        let after = projected_budget(
            &surface,
            events,
            latest_complete,
            &render_checkpoint(&new, 2048),
            &observed,
        );
        assert!(after.input_tokens < before.input_tokens);
        assert!(after.input_bytes < before.input_bytes);
        assert!(
            after.fits_target(&observed),
            "{} tokens / {} bytes",
            after.input_tokens,
            after.input_bytes
        );
        if let Ok(report) = std::env::var("SHELLSPAN_CONTEXT_AUDIT_REPORT") {
            std::fs::write(report, serde_json::to_vec_pretty(&serde_json::json!({"oldBoundary":old_boundary,"newBoundary":latest_complete,"systemTokens":observed.system_tokens,"toolSchemaTokens":observed.tool_schema_tokens,"messageTokens":observed.message_tokens,"beforeProjection":{"tokens":before.input_tokens,"bytes":before.input_bytes},"afterProjection":{"tokens":after.input_tokens,"bytes":after.input_bytes},"targetTokens":observed.compaction_target_tokens,"targetBytes":target_input_bytes(&observed),"mode":"readOnlyHistoricalReplayWithBoundedExtractiveCheckpoint"})).unwrap()).unwrap();
        }
    }

    fn configured_session() -> (tempfile::TempDir, AgentSessionStore, AgentArtifactStore) {
        let root = tempfile::tempdir().unwrap();
        let sessions = AgentSessionStore::default();
        let artifacts = AgentArtifactStore::default();
        sessions.configure(root.path().to_path_buf()).unwrap();
        artifacts.configure(root.path()).unwrap();
        sessions
            .create(super::super::CreateAgentSessionRequest {
                session_id: "session".into(),
                task_id: "task".into(),
                goal: "Preserve audit history while compacting".into(),
                parent_session_id: None,
                continued_from_session_id: None,
                target: None,
                permission_mode: None,
                execution_surface: crate::agent_runtime::AgentExecutionSurface::Direct,
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
        for (turn_id, step_id, payload) in [
            (Some("turn-old"), None, AgentSessionEventPayload::TurnStart),
            (
                Some("turn-old"),
                Some("step-old"),
                AgentSessionEventPayload::StepStart,
            ),
            (
                Some("turn-old"),
                Some("step-old"),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        images: Vec::new(),
                        message_id: "message-old".into(),
                        client_submission_id: None,
                        content: "old context ".repeat(2_000),
                        source: AgentMessageSource::user(),
                        terminal_context: None,
                    },
                },
            ),
            (
                Some("turn-old"),
                Some("step-old"),
                AgentSessionEventPayload::StepEnd {
                    reason: "completed".into(),
                },
            ),
            (
                Some("turn-old"),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            ),
        ] {
            sessions
                .append(
                    "session",
                    turn_id.map(str::to_string),
                    step_id.map(str::to_string),
                    payload,
                )
                .unwrap();
        }
        (root, sessions, artifacts)
    }

    fn append_simple_turn(sessions: &AgentSessionStore, turn_id: &str, content: &str) {
        let step_id = format!("step-{turn_id}");
        for (step, payload) in [
            (None, AgentSessionEventPayload::TurnStart),
            (Some(step_id.as_str()), AgentSessionEventPayload::StepStart),
            (
                Some(step_id.as_str()),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        images: Vec::new(),
                        message_id: format!("message-{turn_id}"),
                        client_submission_id: None,
                        content: content.into(),
                        source: AgentMessageSource::user(),
                        terminal_context: None,
                    },
                },
            ),
            (
                Some(step_id.as_str()),
                AgentSessionEventPayload::StepEnd {
                    reason: "completed".into(),
                },
            ),
            (
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            ),
        ] {
            sessions
                .append(
                    "session",
                    Some(turn_id.into()),
                    step.map(str::to_string),
                    payload,
                )
                .unwrap();
        }
    }

    fn surface_budget(sessions: &AgentSessionStore) -> ModelSurfaceBudget {
        let snapshot = sessions.snapshot("session").unwrap();
        let request = ModelRequest::from_surface(
            "budget".into(),
            &snapshot.surface,
            "system".into(),
            Vec::new(),
        );
        estimate_model_surface_budget(
            &AiProviderConfig {
                model_definition: Some(crate::llm::catalog::fixture_definition(
                    AiProviderKind::OpenAiCompatible,
                    8192,
                )),
                profile: "generic".into(),
                retry_policy: None,
                id: "fixture-context-8192".into(),
                kind: AiProviderKind::OpenAiCompatible,
                base_url: "http://127.0.0.1".into(),
                model: "fixture-context-8192".into(),
                reasoning_effort: Some("off".to_string()),
                requires_api_key: false,
                api_key: None,
            },
            &request,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn selects_only_oldest_complete_safe_turn_prefix() {
        let events = vec![
            event(0, Some("turn-a"), None, AgentSessionEventPayload::TurnStart),
            event(
                1,
                Some("turn-a"),
                Some("step-a"),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        images: Vec::new(),
                        message_id: "message-a".into(),
                        client_submission_id: None,
                        content: "x".repeat(20_000),
                        source: AgentMessageSource::user(),
                        terminal_context: None,
                    },
                },
            ),
            event(
                2,
                Some("turn-a"),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            ),
            event(3, Some("turn-b"), None, AgentSessionEventPayload::TurnStart),
        ];
        assert_eq!(
            select_complete_compaction_prefix(&events, None, Some("turn-b"), &budget(), false)
                .unwrap(),
            Some(2)
        );
    }

    #[tokio::test]
    async fn selects_a_completed_step_inside_the_active_turn() {
        let events = vec![
            event(0, Some("turn"), None, AgentSessionEventPayload::TurnStart),
            event(
                1,
                Some("turn"),
                Some("step-1"),
                AgentSessionEventPayload::StepStart,
            ),
            event(
                2,
                Some("turn"),
                Some("step-1"),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        images: Vec::new(),
                        message_id: "message".into(),
                        client_submission_id: None,
                        content: "x".repeat(40_000),
                        source: AgentMessageSource::user(),
                        terminal_context: None,
                    },
                },
            ),
            event(
                3,
                Some("turn"),
                Some("step-1"),
                AgentSessionEventPayload::StepEnd {
                    reason: "toolsCompleted".into(),
                },
            ),
            event(
                4,
                Some("turn"),
                Some("step-2"),
                AgentSessionEventPayload::StepStart,
            ),
        ];
        assert_eq!(
            select_complete_compaction_prefix(&events, None, Some("turn"), &budget(), false)
                .unwrap(),
            Some(3)
        );
    }

    #[tokio::test]
    async fn pending_approval_and_unfinished_tool_group_block_prefix_selection() {
        let call = RecordedToolCall {
            call_id: "call".into(),
            provider_call_id: None,
            name: "apply_patch".into(),
            native_name: Some("apply_patch".into()),
            arguments: serde_json::json!({}),
            title: None,
            effect: None,
            target: None,
        };
        let events = vec![
            event(0, Some("turn"), None, AgentSessionEventPayload::TurnStart),
            event(
                1,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::ToolCall { call },
            ),
            event(
                2,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::ToolApproval {
                    request_id: "request".into(),
                    call_id: "call".into(),
                    approval_id: Some("approval".into()),
                    status: AgentToolApprovalStatus::Requested,
                    risk: None,
                    reason: None,
                    expires_at_unix_ms: Some(10_000),
                    prompt: None,
                },
            ),
            event(
                3,
                Some("turn"),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "waiting".into(),
                },
            ),
        ];
        assert_eq!(
            select_complete_compaction_prefix(&events, None, None, &budget(), true).unwrap(),
            None
        );
        let _ = AgentToolResultStatus::Completed;
    }

    #[tokio::test]
    async fn compaction_commits_artifact_summary_and_generation_atomically() {
        let (_root, sessions, artifacts) = configured_session();
        let manager = AgentCompactionManager::new(sessions.clone(), artifacts.clone());
        let outcome = manager
            .compact(
                "session",
                "turn-new",
                "step-new",
                None,
                "budgetThreshold",
                &budget(),
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let snapshot = sessions.snapshot("session").unwrap();
        assert_eq!(snapshot.surface.generation, 1);
        assert_eq!(
            artifacts.verify("session", &outcome.artifact).unwrap(),
            super::super::AgentArtifactIntegrity::Verified
        );
        let events = sessions.all_events("session").unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::UserMessage { .. })));
        assert!(matches!(
            events.last().map(|event| &event.payload),
            Some(AgentSessionEventPayload::CompactionEnd {
                status: AgentCompactionStatus::Completed,
                ..
            })
        ));
    }

    struct FailingSummarizer;

    #[async_trait::async_trait]
    impl AgentCompactionSummarizer for FailingSummarizer {
        async fn summarize(
            &self,
            _checkpoint: &StructuredCheckpoint,
            _cancellation: &CancellationToken,
        ) -> Result<SummaryProposal, String> {
            Err("synthetic summarizer failure".into())
        }
    }

    struct UnavailableSemanticSummarizer;

    #[async_trait::async_trait]
    impl AgentCompactionSummarizer for UnavailableSemanticSummarizer {
        async fn summarize(
            &self,
            _checkpoint: &StructuredCheckpoint,
            _cancellation: &CancellationToken,
        ) -> Result<SummaryProposal, String> {
            Ok(SummaryProposal {
                provenance: vec![serde_json::json!({"failure": "inputBudget"})],
                failure: Some(
                    "semantic summary unavailable (inputBudget); preserved current Surface".into(),
                ),
                ..SummaryProposal::default()
            })
        }
    }

    #[tokio::test]
    async fn active_turn_uses_extractive_fallback_at_a_completed_step_boundary() {
        let (_root, sessions, artifacts) = configured_session();
        sessions
            .append(
                "session",
                Some("turn-active".into()),
                None,
                AgentSessionEventPayload::TurnStart,
            )
            .unwrap();
        sessions
            .append(
                "session",
                Some("turn-active".into()),
                Some("step-large".into()),
                AgentSessionEventPayload::StepStart,
            )
            .unwrap();
        sessions
            .append(
                "session",
                Some("turn-active".into()),
                Some("step-large".into()),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        images: Vec::new(),
                        message_id: "message-active".into(),
                        client_submission_id: None,
                        content: "continue the task".into(),
                        source: AgentMessageSource::user(),
                        terminal_context: None,
                    },
                },
            )
            .unwrap();
        sessions
            .append(
                "session",
                Some("turn-active".into()),
                Some("step-large".into()),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        images: Vec::new(),
                        message_id: "message-large".into(),
                        client_submission_id: None,
                        content: "large model evidence ".repeat(5_000),
                        source: AgentMessageSource::runtime("large test context".into()),
                        terminal_context: None,
                    },
                },
            )
            .unwrap();
        let boundary = sessions
            .append(
                "session",
                Some("turn-active".into()),
                Some("step-large".into()),
                AgentSessionEventPayload::StepEnd {
                    reason: "toolsCompleted".into(),
                },
            )
            .unwrap()
            .seq;
        sessions
            .append(
                "session",
                Some("turn-active".into()),
                Some("step-current".into()),
                AgentSessionEventPayload::StepStart,
            )
            .unwrap();

        let oversized = surface_budget(&sessions);
        assert!(oversized.requires_compaction());
        let manager = AgentCompactionManager::with_summarizer(
            sessions.clone(),
            artifacts.clone(),
            Arc::new(UnavailableSemanticSummarizer),
        );
        let outcome = manager
            .compact(
                "session",
                "turn-active",
                "step-current",
                Some("turn-active"),
                "providerContextTooLarge",
                &oversized,
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(outcome.replaced_through_seq, boundary);
        let snapshot = sessions.snapshot("session").unwrap();
        assert_eq!(snapshot.surface.generation, 1);
        assert!(snapshot.surface.messages.iter().any(|message| matches!(
            message,
            AgentSurfaceMessage::User { content, .. }
                if content.contains("bounded extractive fallback")
        )));
        let stored = artifacts
            .retrieve("session", &outcome.artifact, 2 * 1024 * 1024)
            .unwrap();
        let stored: serde_json::Value = serde_json::from_slice(&stored).unwrap();
        assert!(stored["summaryProvenance"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["fallback"] == "boundedExtractiveCheckpoint"
                && item["boundary"] == "completedStep"));
    }

    #[tokio::test]
    async fn failed_compaction_is_durable_and_never_advances_the_surface() {
        let (_root, sessions, artifacts) = configured_session();
        let manager = AgentCompactionManager::with_summarizer(
            sessions.clone(),
            artifacts,
            Arc::new(FailingSummarizer),
        );
        assert!(manager
            .compact(
                "session",
                "turn-new",
                "step-new",
                None,
                "budgetThreshold",
                &budget(),
                true,
                &CancellationToken::new(),
            )
            .await
            .is_err());
        assert_eq!(sessions.snapshot("session").unwrap().surface.generation, 0);
        assert!(matches!(
            sessions
                .all_events("session")
                .unwrap()
                .last()
                .map(|event| &event.payload),
            Some(AgentSessionEventPayload::CompactionEnd {
                status: AgentCompactionStatus::Failed,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn checkpoint_preserves_latest_constraints_decisions_work_and_tool_evidence() {
        let (_root, sessions, _artifacts) = configured_session();
        let header = sessions.snapshot("session").unwrap().header;
        let repeated_data = serde_json::json!({
            "output": "x".repeat(8 * 1024),
            "authorization": "Bearer must-not-survive",
        });
        let events = vec![
            event(
                0,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        images: Vec::new(),
                        message_id: "constraint-old".into(),
                        client_submission_id: None,
                        content: "Implement quickly".into(),
                        source: AgentMessageSource::user(),
                        terminal_context: None,
                    },
                },
            ),
            event(
                1,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::TaskPlan {
                    version: 1,
                    steps: vec![
                        AgentPlanStep {
                            id: "done".into(),
                            title: "Audit the old path".into(),
                            status: AgentPlanStepStatus::Completed,
                            detail: None,
                            evidence_refs: vec!["evidence-a".into()],
                        },
                        AgentPlanStep {
                            id: "next".into(),
                            title: "Run the complete regression suite".into(),
                            status: AgentPlanStepStatus::Blocked,
                            detail: Some("waiting for the implementation".into()),
                            evidence_refs: Vec::new(),
                        },
                    ],
                },
            ),
            event(
                2,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::AssistantMessage {
                    message_id: "assistant-decision".into(),
                    content: vec![
                        AgentAssistantContentBlock::Text {
                            text: "Use append-only replacement because recovery must replay raw events."
                                .into(),
                        },
                        AgentAssistantContentBlock::Reasoning {
                            text: "The event log is the audit authority.".into(),
                            provider_item: None,
                        },
                    ],
                    usage: AgentTokenUsage::default(),
                    stop_reason: AgentStopReason::Cancelled,
                    interrupted: true,
                    replay: None,
                },
            ),
            event(
                3,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::ToolResult {
                    call_id: "call-success".into(),
                    name: "exec_command".into(),
                    status: AgentToolResultStatus::Completed,
                    summary: "tests passed".into(),
                    data: Some(repeated_data.clone()),
                    duration_ms: Some(10),
                    evidence_refs: vec!["artifact-log".into()],
                },
            ),
            event(
                4,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::ToolResult {
                    call_id: "call-duplicate".into(),
                    name: "exec_command".into(),
                    status: AgentToolResultStatus::Completed,
                    summary: "tests passed".into(),
                    data: Some(repeated_data),
                    duration_ms: Some(10),
                    evidence_refs: vec!["artifact-log".into()],
                },
            ),
            event(
                5,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::ToolResult {
                    call_id: "call-failed".into(),
                    name: "cargo_test".into(),
                    status: AgentToolResultStatus::Failed,
                    summary: "linker failed with exit code 1".into(),
                    data: None,
                    duration_ms: Some(20),
                    evidence_refs: Vec::new(),
                },
            ),
            event(
                6,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::ToolCall {
                    call: RecordedToolCall {
                        call_id: "call-reference".into(),
                        provider_call_id: None,
                        name: "exec_command".into(),
                        native_name: Some("exec_command".into()),
                        arguments: serde_json::json!({
                            "command": "cargo test --lib",
                            "path": "src-tauri/src/agent_runtime/compaction.rs",
                        }),
                        title: None,
                        effect: None,
                        target: None,
                    },
                },
            ),
            event(
                7,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        images: Vec::new(),
                        message_id: "constraint-latest".into(),
                        client_submission_id: None,
                        content: "Latest constraint: do not edit the reference repository.".into(),
                        source: AgentMessageSource::user(),
                        terminal_context: None,
                    },
                },
            ),
        ];

        let checkpoint = structured_checkpoint(&header, &events, 7, 0);
        assert_eq!(checkpoint.format, CHECKPOINT_FORMAT);
        assert!(checkpoint
            .latest_user_constraints
            .last()
            .unwrap()
            .contains("do not edit the reference repository"));
        assert!(checkpoint
            .completed_work
            .iter()
            .any(|item| item.contains("Audit the old path")));
        assert!(checkpoint
            .unfinished_work
            .iter()
            .any(|item| item.contains("Run the complete regression suite")));
        assert!(checkpoint
            .key_decisions_and_reasons
            .iter()
            .any(|item| item.contains("append-only replacement")));
        assert!(checkpoint
            .key_decisions_and_reasons
            .iter()
            .any(|item| item.contains("was interrupted")));
        assert!(checkpoint
            .related_files_symbols_commands
            .iter()
            .any(|item| item.contains("cargo test --lib")));
        assert!(checkpoint
            .related_files_symbols_commands
            .iter()
            .any(|item| item.contains("agent_runtime/compaction.rs")));
        assert_eq!(
            checkpoint.tool_outcomes.len(),
            2,
            "repeated output is deduplicated"
        );
        let success = checkpoint
            .tool_outcomes
            .iter()
            .find(|outcome| outcome.status == "completed")
            .unwrap();
        assert!(success.data_truncated);
        assert_eq!(success.data_sha256.as_ref().unwrap().len(), 64);
        assert!(success.data_preview.as_ref().unwrap().len() <= MAX_TOOL_DATA_PREVIEW_BYTES);
        assert!(!success
            .data_preview
            .as_deref()
            .unwrap()
            .contains("must-not-survive"));
        assert!(checkpoint
            .todos_and_blockers
            .iter()
            .any(|item| item.contains("linker failed")));
        assert!(checkpoint
            .next_steps
            .iter()
            .any(|item| item.contains("Run the complete regression suite")));

        let rendered = render_checkpoint(&checkpoint, MAX_COMPACTION_SUMMARY_BYTES);
        assert!(summary_has_required_sections(&rendered));
        assert!(rendered.contains("untrustedPreview="));
        assert!(rendered.len() <= MAX_COMPACTION_SUMMARY_BYTES);
    }

    struct EmptySummarizer;

    #[async_trait::async_trait]
    impl AgentCompactionSummarizer for EmptySummarizer {
        async fn summarize(
            &self,
            _checkpoint: &StructuredCheckpoint,
            _cancellation: &CancellationToken,
        ) -> Result<SummaryProposal, String> {
            Ok(" \n\t".to_string().into())
        }
    }

    #[tokio::test]
    async fn cancellation_and_empty_summary_do_not_commit_surface_or_artifact_events() {
        let (_root, sessions, artifacts) = configured_session();
        let manager = AgentCompactionManager::new(sessions.clone(), artifacts.clone());
        let count_before_cancel = sessions.snapshot("session").unwrap().event_count;
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let cancelled = manager
            .compact(
                "session",
                "turn-new",
                "step-new",
                None,
                "budgetThreshold",
                &budget(),
                true,
                &cancellation,
            )
            .await;
        assert!(cancelled.unwrap_err().contains("cancelled"));
        assert_eq!(
            sessions.snapshot("session").unwrap().event_count,
            count_before_cancel
        );

        let empty = AgentCompactionManager::with_summarizer(
            sessions.clone(),
            artifacts,
            Arc::new(EmptySummarizer),
        );
        assert!(empty
            .compact(
                "session",
                "turn-new",
                "step-new",
                None,
                "budgetThreshold",
                &budget(),
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap_err()
            .contains("empty"));
        let events = sessions.all_events("session").unwrap();
        assert_eq!(sessions.snapshot("session").unwrap().surface.generation, 0);
        assert!(!events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::CompactionSummary { .. }
                | AgentSessionEventPayload::ContextArtifact { .. }
        )));
        assert!(matches!(
            events.last().map(|event| &event.payload),
            Some(AgentSessionEventPayload::CompactionEnd {
                status: AgentCompactionStatus::Failed,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn bounded_degradation_rejects_a_checkpoint_that_cannot_reach_target() {
        let (_root, sessions, artifacts) = configured_session();
        let manager = AgentCompactionManager::new(sessions.clone(), artifacts);
        let mut impossible = budget();
        impossible.compaction_target_tokens = 64;
        impossible.maximum_input_bytes = 256;

        let error = manager
            .compact(
                "session",
                "turn-new",
                "step-new",
                None,
                "providerContextTooLarge",
                &impossible,
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.contains("remained above its target"));
        let snapshot = sessions.snapshot("session").unwrap();
        assert_eq!(snapshot.surface.generation, 0);
        assert!(matches!(
            sessions
                .all_events("session")
                .unwrap()
                .last()
                .map(|event| &event.payload),
            Some(AgentSessionEventPayload::CompactionEnd {
                status: AgentCompactionStatus::Failed,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn restart_recovers_checkpoint_and_continuous_compaction_stays_flat() {
        let (root, sessions, artifacts) = configured_session();
        let first = AgentCompactionManager::new(sessions.clone(), artifacts);
        first
            .compact(
                "session",
                "turn-maintenance-1",
                "step-maintenance-1",
                None,
                "budgetThreshold",
                &budget(),
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(sessions.snapshot("session").unwrap().surface.generation, 1);

        let restarted_sessions = AgentSessionStore::default();
        let restarted_artifacts = AgentArtifactStore::default();
        restarted_sessions
            .configure(root.path().to_path_buf())
            .unwrap();
        restarted_artifacts.configure(root.path()).unwrap();
        let recovered = restarted_sessions.snapshot("session").unwrap();
        assert_eq!(recovered.surface.generation, 1);
        assert!(recovered.surface.replaced_through_seq.is_some());

        append_simple_turn(
            &restarted_sessions,
            "turn-after-restart",
            &"new context ".repeat(2_000),
        );
        let second_budget = surface_budget(&restarted_sessions);
        let second = AgentCompactionManager::new(restarted_sessions.clone(), restarted_artifacts);
        second
            .compact(
                "session",
                "turn-maintenance-2",
                "step-maintenance-2",
                None,
                "budgetThreshold",
                &second_budget,
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();

        let snapshot = restarted_sessions.snapshot("session").unwrap();
        assert_eq!(snapshot.surface.generation, 2);
        let compacted_budget = surface_budget(&restarted_sessions);
        assert!(compacted_budget.estimated_input_tokens <= second_budget.compaction_target_tokens);
        assert!(compacted_budget.estimated_input_bytes <= target_input_bytes(&second_budget));
        assert_eq!(
            snapshot
                .surface
                .messages
                .iter()
                .filter(|message| matches!(
                    message,
                    AgentSurfaceMessage::User { content, .. }
                        if content.contains(CHECKPOINT_PREAMBLE)
                ))
                .count(),
            1,
            "the latest checkpoint replaces the previous checkpoint instead of nesting it"
        );
        let raw = restarted_sessions.all_events("session").unwrap();
        assert!(raw.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::UserMessage { message }
                if message.message_id == "message-old"
        )));
        assert_eq!(
            raw.iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::CompactionSummary { .. }
                ))
                .count(),
            2
        );
    }
    struct SemanticFixture {
        mode: &'static str,
        calls: std::sync::Mutex<Vec<super::super::ModelRequest>>,
    }
    impl SemanticFixture {
        fn new(mode: &'static str) -> Arc<Self> {
            Arc::new(Self {
                mode,
                calls: Default::default(),
            })
        }
    }
    #[async_trait::async_trait]
    impl super::super::ModelAdapter for SemanticFixture {
        fn replay_codec(&self) -> &'static dyn crate::llm::adapter::ReplayCodec {
            crate::llm::registry::replay_codec("chat-completions").unwrap()
        }

        async fn stream(
            &self,
            request: super::super::ModelRequest,
            cancellation: CancellationToken,
            sink: Arc<dyn super::super::ModelStreamSink>,
        ) -> Result<super::super::ModelResponse, super::super::NormalizedModelError> {
            use super::super::{
                ModelContentBlock, ModelFinishReason, ModelMessage, ModelResponse, ModelUsage,
                NormalizedModelError, NormalizedModelErrorKind, StreamDelta,
            };
            self.calls.lock().unwrap().push(request.clone());
            assert!(request.tools.is_empty());
            let ModelMessage::User { content } = &request.messages[0] else {
                panic!("summary source");
            };
            if self.mode == "cancel" {
                cancellation.cancel();
                return Err(NormalizedModelError::cancelled());
            }
            if self.mode == "wait" {
                cancellation.cancelled().await;
                return Err(NormalizedModelError::cancelled());
            }
            let transient_partial = (self.mode == "partial-then-success"
                && self.calls.lock().unwrap().len() == 1)
                || (self.mode == "alternating-partial"
                    && self.calls.lock().unwrap().len() % 2 == 1);
            if self.mode == "partial" || transient_partial {
                sink.emit(StreamDelta::Text {
                    index: 0,
                    text: "{".into(),
                })?;
            }
            if self.mode == "fail" || self.mode == "partial" || transient_partial {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Transport,
                    "fixture",
                ));
            }
            let active = if content.contains("USER REVOKES read-only") {
                "Read-only revoked; edits authorized"
            } else if content.contains("READ_ONLY_CONSTRAINT") {
                "READ_ONLY_CONSTRAINT"
            } else {
                "None recorded"
            };
            let text = match self.mode {
                "invalid" => "{\"completedWork\":[]}".into(),
                "empty" => String::new(),
                "oversize" => "x".repeat(SUMMARY_OUTPUT_BYTES + 1),
                _ => serde_json::json!({"latestUserConstraints":[active],"completedWork":["Inspected existing state"],
                    "unfinishedWork":["Implementation pending"],"keyDecisionsAndReasons":["Keep append-only history because recovery requires evidence"],
                    "relatedFilesSymbolsCommands":["src/example.rs; cargo test"],"todosAndBlockers":["None recorded"],
                    "nextSteps":["Implement after approval"]}).to_string(),
            };
            Ok(ModelResponse {
                content: vec![ModelContentBlock::Text { text }],
                finish_reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    output_tokens: (self.mode == "overusage").then_some(4097),
                    ..ModelUsage::default()
                },
                replay: Some(crate::llm::types::AdapterReplayCapture {
                    response: serde_json::json!({}),
                    blocks: vec![serde_json::json!({})],
                }),
                replay_envelope: None,
            })
        }
    }
    fn semantic_summarizer(adapter: Arc<SemanticFixture>) -> SemanticCompactionSummarizer {
        SemanticCompactionSummarizer { adapter, provider: serde_json::from_value(serde_json::json!({
            "id":"summary", "kind":"openAiCompatible", "profile":"deepseek", "baseUrl":"https://proxy.example/v1",
            "model":"deepseek-flash", "requiresApiKey":false })).unwrap(), retry_policy: super::super::RetryPolicy {
                initial_delay_ms: 0, max_delay_ms: 0, ..Default::default()
            } }
    }
    #[tokio::test]
    async fn semantic_success_preserves_uncropped_constraints_and_carries_decisions_across_restart()
    {
        let (root, sessions, artifacts) = configured_session();
        append_simple_turn(
            &sessions,
            "constraint",
            &format!("{} READ_ONLY_CONSTRAINT", "padding ".repeat(2000)),
        );
        for i in 0..10 {
            append_simple_turn(
                &sessions,
                &format!("followup-{i}"),
                "Continue examining the repository",
            );
        }
        let fixture = SemanticFixture::new("ok");
        let manager = AgentCompactionManager::with_summarizer(
            sessions.clone(),
            artifacts.clone(),
            Arc::new(semantic_summarizer(fixture.clone())),
        );
        let mut compact_budget = surface_budget(&sessions);
        compact_budget.compaction_target_tokens = 1000;
        let first = manager
            .compact(
                "session",
                "maintenance",
                "step",
                None,
                "test",
                &compact_budget,
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let snapshot = sessions.snapshot("session").unwrap();
        let summary = snapshot
            .surface
            .messages
            .iter()
            .find_map(|m| match m {
                AgentSurfaceMessage::User { content, .. }
                    if content.contains(CHECKPOINT_PREAMBLE) =>
                {
                    Some(content)
                }
                _ => None,
            })
            .unwrap();
        assert!(summary.contains("READ_ONLY_CONSTRAINT"));
        assert!(summary.contains("because recovery requires evidence"));
        let input = fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|r| serde_json::to_string(r).unwrap())
            .collect::<String>();
        assert!(input.contains("READ_ONLY_CONSTRAINT"));
        let stored = artifacts
            .retrieve("session", &first.artifact, 1024 * 1024)
            .unwrap();
        let stored: serde_json::Value = serde_json::from_slice(&stored).unwrap();
        assert!(stored["summaryProvenance"].as_array().unwrap().len() >= 2);
        assert!(stored["summaryProvenance"][0]["request"]["systemPrompt"].is_string());
        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        append_simple_turn(
            &restarted,
            "after-restart",
            "USER REVOKES read-only; please edit now",
        );
        let fixture2 = SemanticFixture::new("ok");
        let manager2 = AgentCompactionManager::with_summarizer(
            restarted.clone(),
            artifacts,
            Arc::new(semantic_summarizer(fixture2.clone())),
        );
        manager2
            .compact(
                "session",
                "maintenance2",
                "step2",
                None,
                "test",
                &surface_budget(&restarted),
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let request = serde_json::to_string(&fixture2.calls.lock().unwrap()[0]).unwrap();
        assert!(request.contains("Previous committed checkpoint"));
        assert!(request.contains("because recovery requires evidence"));
        let snapshot = restarted.snapshot("session").unwrap();
        assert_eq!(snapshot.surface.generation, 2);
        assert!(serde_json::to_string(&snapshot.surface)
            .unwrap()
            .contains("USER REVOKES read-only; please edit now"));
    }
    #[tokio::test]
    async fn semantic_invalid_empty_failed_and_over_budget_outputs_use_explicit_bounded_fallback() {
        let (_root, sessions, _) = configured_session();
        let events = sessions.all_events("session").unwrap();
        let mut checkpoint = structured_checkpoint(
            &sessions.snapshot("session").unwrap().header,
            &events,
            events.last().unwrap().seq,
            0,
        );
        for mode in [
            "invalid",
            "empty",
            "fail",
            "partial",
            "oversize",
            "overusage",
        ] {
            let fixture = SemanticFixture::new(mode);
            let result = semantic_summarizer(fixture.clone())
                .summarize(&checkpoint, &CancellationToken::new())
                .await
                .unwrap();
            assert!(
                result
                    .failure
                    .as_deref()
                    .unwrap()
                    .contains("preserved current Surface"),
                "{mode}"
            );
            assert!(result.text.len() < 10 * 1024);
            assert!(result.text.is_empty());
            assert_eq!(
                fixture.calls.lock().unwrap().len(),
                if mode == "fail" || mode == "partial" {
                    3
                } else {
                    1
                }
            );
            assert!(!result.provenance.is_empty());
        }
        checkpoint.semantic_source = vec!["x".repeat(SUMMARY_MAX_SOURCE_BYTES + 1)];
        let fixture = SemanticFixture::new("ok");
        let result = semantic_summarizer(fixture.clone())
            .summarize(&checkpoint, &CancellationToken::new())
            .await
            .unwrap();
        assert!(result.failure.as_deref().unwrap().contains("inputBudget"));
        assert!(fixture.calls.lock().unwrap().is_empty());
    }
    #[tokio::test(start_paused = true)]
    async fn semantic_cancellation_and_total_deadline_are_bounded() {
        let (_root, sessions, _) = configured_session();
        let events = sessions.all_events("session").unwrap();
        let checkpoint = structured_checkpoint(
            &sessions.snapshot("session").unwrap().header,
            &events,
            events.last().unwrap().seq,
            0,
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let fixture = SemanticFixture::new("ok");
        assert!(semantic_summarizer(fixture.clone())
            .summarize(&checkpoint, &cancelled)
            .await
            .is_err());
        assert!(fixture.calls.lock().unwrap().is_empty());
        assert!(semantic_summarizer(SemanticFixture::new("cancel"))
            .summarize(&checkpoint, &CancellationToken::new())
            .await
            .unwrap()
            .failure
            .as_deref()
            .unwrap()
            .contains("cancelled"));
        let result = semantic_summarizer(SemanticFixture::new("wait"))
            .summarize(&checkpoint, &CancellationToken::new())
            .await
            .unwrap();
        assert!(result.failure.as_deref().unwrap().contains("deadline"));
    }

    #[tokio::test]
    async fn semantic_partial_recovery_uses_provider_policy_and_keeps_retry_provenance() {
        for limit in [1, 2] {
            let (_root, sessions, artifacts) = configured_session();
            let events = sessions.all_events("session").unwrap();
            let checkpoint = structured_checkpoint(
                &sessions.snapshot("session").unwrap().header,
                &events,
                events.last().unwrap().seq,
                0,
            );
            let fixture = SemanticFixture::new("partial-then-success");
            let mut provider = semantic_summarizer(fixture.clone()).provider;
            provider.retry_policy = Some(super::super::RetryPolicy {
                max_attempts: limit,
                initial_delay_ms: 0,
                max_delay_ms: 0,
                ..Default::default()
            });
            let manager = AgentCompactionManager::new(sessions, artifacts).with_model(
                fixture.clone(),
                provider,
                super::super::RetryPolicy::default(),
            );
            let result = manager
                .summarizer
                .summarize(&checkpoint, &CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(result.failure.is_none(), limit == 2);
            let calls = fixture.calls.lock().unwrap();
            assert_eq!(calls.len(), limit as usize);
            if limit == 2 {
                assert_ne!(calls[0].request_id, calls[1].request_id);
                assert_eq!(calls[0].messages, calls[1].messages);
            }
            assert!(result
                .provenance
                .iter()
                .any(|item| item["partialOutput"] == true));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn summary_retry_backoff_cannot_escape_total_deadline() {
        let (_root, sessions, _) = configured_session();
        let events = sessions.all_events("session").unwrap();
        let checkpoint = structured_checkpoint(
            &sessions.snapshot("session").unwrap().header,
            &events,
            events.last().unwrap().seq,
            0,
        );
        let fixture = SemanticFixture::new("partial");
        let mut summarizer = semantic_summarizer(fixture.clone());
        summarizer.retry_policy = super::super::RetryPolicy {
            initial_delay_ms: 300_000,
            max_delay_ms: 300_000,
            ..Default::default()
        };
        let result = summarizer
            .summarize(&checkpoint, &CancellationToken::new())
            .await
            .unwrap();
        assert!(result.failure.unwrap().contains("deadline"));
        assert_eq!(fixture.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn summary_retries_count_against_cumulative_input_budget() {
        let (_root, sessions, _) = configured_session();
        let events = sessions.all_events("session").unwrap();
        let mut checkpoint = structured_checkpoint(
            &sessions.snapshot("session").unwrap().header,
            &events,
            events.last().unwrap().seq,
            0,
        );
        checkpoint.semantic_source = vec!["data ".repeat(60_000)];
        let fixture = SemanticFixture::new("alternating-partial");
        let result = semantic_summarizer(fixture.clone())
            .summarize(&checkpoint, &CancellationToken::new())
            .await
            .unwrap();
        assert!(result.failure.unwrap().contains("inputBudget"));
        let calls = fixture.calls.lock().unwrap();
        assert!(
            calls.len() >= 2,
            "partial output must exercise actual retry attempts"
        );
        let bytes: u64 = calls
            .iter()
            .map(|request| {
                super::super::estimate_model_surface_budget(
                    &semantic_summarizer(fixture.clone()).provider,
                    request,
                )
                .unwrap()
                .estimated_input_bytes
            })
            .sum();
        assert!(bytes <= SUMMARY_MAX_TOTAL_INPUT_BYTES as u64);
        assert!(
            bytes > (SUMMARY_MAX_TOTAL_INPUT_BYTES - SUMMARY_MAX_REQUEST_BYTES) as u64,
            "recovery should consume the allowed input budget before refusing another request"
        );
        assert!(result.checkpoint.is_none());
    }
    #[tokio::test]
    async fn cancellation_after_artifact_write_before_batch_does_not_advance_generation() {
        let (root, sessions, artifacts) = configured_session();
        let token = CancellationToken::new();
        let mut manager = AgentCompactionManager::new(sessions.clone(), artifacts);
        manager.before_commit = Some(Arc::new({
            let token = token.clone();
            move || token.cancel()
        }));
        let before = sessions.all_events("session").unwrap().len();
        assert!(manager
            .compact(
                "session",
                "turn",
                "step",
                None,
                "test",
                &budget(),
                true,
                &token
            )
            .await
            .is_err());
        assert_eq!(sessions.snapshot("session").unwrap().surface.generation, 0);
        let events = sessions.all_events("session").unwrap();
        assert_eq!(events.len(), before + 2);
        assert!(matches!(
            events.last().map(|event| &event.payload),
            Some(AgentSessionEventPayload::CompactionEnd {
                status: AgentCompactionStatus::Cancelled,
                duration_ms: Some(_),
                ..
            })
        ));
        assert!(root
            .path()
            .join("agent-runtime/artifacts-v2/session")
            .exists());
    }
    #[tokio::test]
    async fn semantic_large_conversation_sees_early_constraints_and_explicit_tail_revocation() {
        let (_root, sessions, artifacts) = configured_session();
        append_simple_turn(&sessions, "constraint", "READ_ONLY_CONSTRAINT");
        for i in 0..12 {
            append_simple_turn(
                &sessions,
                &format!("long-{i}"),
                &"ordinary repository discussion ".repeat(330),
            );
        }
        append_simple_turn(&sessions, "revocation", "USER REVOKES read-only; edit now");
        let fixture = SemanticFixture::new("ok");
        let manager = AgentCompactionManager::with_summarizer(
            sessions.clone(),
            artifacts,
            Arc::new(semantic_summarizer(fixture.clone())),
        );
        let mut budget = surface_budget(&sessions);
        budget.compaction_target_tokens = 1000;
        manager
            .compact(
                "session",
                "maintenance",
                "step",
                None,
                "test",
                &budget,
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let requests = fixture.calls.lock().unwrap();
        assert!(requests.len() >= 3 && requests.len() <= SUMMARY_MAX_CHUNKS);
        let wire = serde_json::to_string(&*requests).unwrap();
        assert!(wire.len() > 100 * 1024);
        assert!(wire.contains("READ_ONLY_CONSTRAINT"));
        assert!(wire.contains("USER REVOKES read-only"));
        let snapshot = sessions.snapshot("session").unwrap();
        assert_eq!(snapshot.surface.generation, 1);
        assert!(serde_json::to_string(&snapshot.surface)
            .unwrap()
            .contains("USER REVOKES read-only; edit now"));
    }
    #[tokio::test]
    async fn semantic_true_budget_exhaustion_preserves_surface_and_records_failed_provenance() {
        let (_root, sessions, artifacts) = configured_session();
        append_simple_turn(&sessions, "constraint", "READ_ONLY_CONSTRAINT");
        for i in 0..12 {
            append_simple_turn(&sessions, &format!("large-{i}"), &"data ".repeat(12000));
        }
        append_simple_turn(&sessions, "tail", "USER REVOKES read-only");
        let fixture = SemanticFixture::new("ok");
        let manager = AgentCompactionManager::with_summarizer(
            sessions.clone(),
            artifacts,
            Arc::new(semantic_summarizer(fixture.clone())),
        );
        let mut budget = surface_budget(&sessions);
        budget.compaction_target_tokens = 1000;
        assert!(manager
            .compact(
                "session",
                "maintenance",
                "step",
                None,
                "test",
                &budget,
                true,
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .contains("inputBudget"));
        assert!(fixture.calls.lock().unwrap().is_empty());
        assert_eq!(sessions.snapshot("session").unwrap().surface.generation, 0);
        let events = sessions.all_events("session").unwrap();
        assert!(events.iter().any(|e| matches!(&e.payload, AgentSessionEventPayload::ContextArtifact { kind, .. } if kind == "compaction-attempt")));
        assert!(!events.iter().any(|e| matches!(
            &e.payload,
            AgentSessionEventPayload::CompactionSummary { .. }
        )));
    }
