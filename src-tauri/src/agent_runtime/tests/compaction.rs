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
            select_complete_turn_prefix(&events, None, Some("turn-b"), &budget(), false).unwrap(),
            Some(2)
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
            select_complete_turn_prefix(&events, None, None, &budget(), true).unwrap(),
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
            .contains("Read-only revoked; edits authorized"));
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
        assert!(calls.len() > 8);
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
        assert_eq!(sessions.all_events("session").unwrap().len(), before);
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
            .contains("Read-only revoked; edits authorized"));
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
