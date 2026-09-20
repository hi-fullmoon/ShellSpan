    use super::*;
    include!("driver_stream.rs");

    #[test]
    fn output_recovery_count_survives_successful_steps_but_is_scoped_to_turn() {
        let events = [
            ("turn-1", "outputLimitContinuation"),
            ("turn-1", "toolsCompleted"),
            ("turn-2", "outputLimitContinuation"),
            ("turn-1", "outputLimitContinuation"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (turn, reason))| {
            let mut record = event(
                index as u64,
                AgentSessionEventPayload::StepEnd {
                    reason: reason.into(),
                },
            );
            record.turn_id = Some(turn.into());
            record
        })
        .collect::<Vec<_>>();
        assert_eq!(output_limit_continuation_count(&events[..2], "turn-1"), 1);
        assert_eq!(output_limit_continuation_count(&events, "turn-1"), 2);
        assert_eq!(output_limit_continuation_count(&events, "turn-2"), 1);
        assert_eq!(output_limit_continuation_count(&events, "turn-3"), 0);
    }

    #[test]
    fn settled_plan_failures_do_not_force_another_completion_attempt() {
        use super::super::AgentPlanStepStatus::{Blocked, Completed, Failed, InProgress, Pending};

        let plan = |turn: &str, statuses: &[super::super::AgentPlanStepStatus]| {
            let mut recorded = event(
                1,
                AgentSessionEventPayload::TaskPlan {
                    version: 1,
                    steps: statuses
                        .iter()
                        .enumerate()
                        .map(|(index, status)| super::super::AgentPlanStep {
                            id: format!("step-{index}"),
                            title: format!("Step {index}"),
                            status: *status,
                            detail: None,
                            evidence_refs: Vec::new(),
                        })
                        .collect(),
                },
            );
            recorded.turn_id = Some(turn.into());
            recorded
        };
        for statuses in [
            vec![Completed, Completed, Blocked, Completed],
            vec![Failed],
            vec![Blocked, Failed],
        ] {
            let events = vec![plan("current", &statuses)];
            assert!(incomplete_plan_for_turn(&events, "current"));
            assert!(!plan_needs_completion_check(&events, "current"));
        }
        for status in [Pending, InProgress] {
            let events = vec![plan("current", &[Blocked, status])];
            assert!(incomplete_plan_for_turn(&events, "current"));
            assert!(plan_needs_completion_check(&events, "current"));
        }
        let events = vec![
            plan("current", &[InProgress]),
            plan("current", &[Completed, Blocked]),
            plan("other-turn", &[Pending]),
        ];
        assert!(!plan_needs_completion_check(&events, "current"));
        assert!(!incomplete_plan_for_turn(&events, "missing-turn"));
        assert!(!plan_needs_completion_check(&[], "current"));
        assert!(!incomplete_plan_for_turn(
            &[plan("current", &[Completed])],
            "current"
        ));
    }

    #[test]
    fn root_and_delegated_step_budgets_have_distinct_settlements() {
        assert_eq!(
            AgentDriverConfig::default().max_steps_per_turn,
            Some(DEFAULT_MAX_STEPS_PER_TURN)
        );
        assert!(
            step_budget_reason(DEFAULT_MAX_STEPS_PER_TURN, true).starts_with("stepBudgetReached:")
        );
        assert!(step_budget_reason(4, false).starts_with("stepLimitExceeded:"));
        let mut child = super::super::AgentSubagentSession {
            descriptor_id: "budget-child".into(),
            parent_task_id: "budget-parent".into(),
            role: super::super::AgentSubagentRole::General,
            continuable: true,
            depth: 1,
            inheritance: super::super::AgentSubagentInheritance::Blank,
            capability_scope: super::super::AgentCapabilityScope {
                tool_names: Vec::new(),
                effects: Vec::new(),
                target_ids: Vec::new(),
            },
            target_scope: Vec::new(),
            budget: super::super::AgentSubagentBudget {
                max_steps_per_turn: 8,
                max_turns: 3,
                max_tool_calls: 12,
                max_tokens: 16_000,
                timeout_ms: 60_000,
            },
            provider: super::super::AgentSubagentModel {
                route_id: "budget-route".into(),
                model_id: "budget-model".into(),
                reasoning_effort: None,
                route_revision: None,
            },
        };
        assert!(step_budget_recoverable(None));
        assert!(step_budget_recoverable(Some(&child)));
        child.continuable = false;
        assert!(!step_budget_recoverable(Some(&child)));
    }

    #[test]
    fn child_budget_notice_counts_the_current_request_and_reserves_handoff() {
        let notice = step_budget_notice(8, 6);
        assert!(notice.contains("step 6 of 8; 2 further model steps"));
        assert!(notice.contains("Do not claim unfinished work is complete"));
        assert!(step_budget_notice(8, 8).contains("0 further model steps"));
    }

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
        let mut metrics = super::super::driver_metrics::DriverMetrics::default();
        for recorded in &events {
            metrics.observe(recorded);
        }
        assert_eq!(metrics.model_tokens, consumed_model_tokens(&events));
        assert_eq!(
            metrics.active_duration_ms(10_000),
            active_duration_ms(&events, 10_000)
        );
        let mut resumed = events;
        resumed.push(event(10_100, AgentSessionEventPayload::SessionResumed {}));
        metrics.observe(resumed.last().unwrap());
        assert_eq!(metrics.model_tokens, 0);
        assert_eq!(metrics.active_duration_ms(10_200), 0);
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
    fn failed_file_edits_stop_despite_changing_arguments_and_interleaved_reads() {
        let mut events = Vec::new();
        for index in 0..3 {
            events.extend(file_edit_step(index, "index.html", false));
            events.extend(repeated_step(
                &format!("read-step-{index}"),
                &format!("read-{index}"),
                "unchanged",
                false,
                100,
            ));
        }
        assert_eq!(failed_file_edit_streak(&events, "turn-1"), 3);
        assert!(
            no_progress_reason(&events, "turn-1", AgentDriverConfig::default())
                .unwrap()
                .contains("3 edits to the same file failed")
        );
        assert_eq!(failed_file_edit_streak(&events, "other-turn"), 0);

        // A completed edit on a different file cannot hide these failures.
        events.extend(file_edit_step(3, "other.html", true));
        assert_eq!(failed_file_edit_streak(&events, "turn-1"), 3);
        events.extend(file_edit_step(4, "index.html", true));
        assert_eq!(failed_file_edit_streak(&events, "turn-1"), 0);
        assert!(no_progress_reason(&events, "turn-1", AgentDriverConfig::default()).is_none());
    }

    #[test]
    fn rejected_patch_preparation_counts_but_permission_denials_do_not() {
        let mut events = Vec::new();
        for (index, summary) in [
            "apply_patch produces no change",
            "apply_patch diff is invalid: missing hunk",
            "apply_patch digest precondition failed",
        ]
        .into_iter()
        .enumerate()
        {
            let mut step = file_edit_step(index, "index.html", false);
            for event in &mut step {
                if let AgentSessionEventPayload::ToolResult {
                    status,
                    summary: message,
                    ..
                } = &mut event.payload
                {
                    *status = super::super::AgentToolResultStatus::Rejected;
                    *message = summary.into();
                }
            }
            events.extend(step);
        }
        assert!(no_progress_reason(&events, "turn-1", AgentDriverConfig::default()).is_some());
        for event in &mut events {
            if let AgentSessionEventPayload::ToolResult { summary, .. } = &mut event.payload {
                *summary = "Tool not started: permission denied".into();
            }
        }
        assert_eq!(failed_file_edit_streak(&events, "turn-1"), 0);
    }

    #[test]
    fn file_edit_failures_reset_only_on_verified_changes_or_user_input() {
        let mut events = file_edit_step(0, "index.html", false);
        events.extend(file_edit_step(1, "index.html", false));
        for (applied, verified, before, after) in [
            (false, false, "before", "after"), // dry run
            (true, true, "before", "before"),  // legacy no-op success
            (true, false, "before", "after"),  // unverified write
        ] {
            let mut step = file_edit_step(2, "index.html", true);
            for event in &mut step {
                if let AgentSessionEventPayload::ToolResult { data, .. } = &mut event.payload {
                    *data = Some(serde_json::json!({
                        "applied": applied, "verified": verified,
                        "files": [{ "beforeSha256": before, "afterSha256": after }]
                    }));
                }
            }
            events.extend(step);
            assert_eq!(failed_file_edit_streak(&events, "turn-1"), 2);
        }
        events.extend(repeated_step("steer", "read-steer", "unchanged", true, 200));
        assert_eq!(failed_file_edit_streak(&events, "turn-1"), 0);

        // Whole-file writes share the failure count with patches to the same path.
        events.extend(file_edit_step(4, "index.html", false));
        let mut write = file_edit_step(5, "index.html", false);
        for event in &mut write {
            if let AgentSessionEventPayload::ToolCall { call } = &mut event.payload {
                call.name = "write_file".into();
                call.arguments = serde_json::json!({ "path": "index.html", "content": "next" });
            }
        }
        events.extend(write);
        assert_eq!(failed_file_edit_streak(&events, "turn-1"), 2);
    }

    fn file_edit_step(
        index: usize,
        path: &str,
        changed: bool,
    ) -> Vec<super::super::AgentSessionEvent> {
        let call_id = format!("edit-{index}");
        let payloads = [
            AgentSessionEventPayload::ToolCall {
                call: super::super::RecordedToolCall {
                    call_id: call_id.clone(),
                    provider_call_id: None,
                    name: "apply_patch".into(),
                    native_name: None,
                    arguments: serde_json::json!({
                        "patch": diffy::create_patch("before\n", &format!("after-{index}\n")).to_string(),
                        "preconditions": [{ "path": path, "sha256": "0".repeat(64) }]
                    }),
                    title: None,
                    effect: None,
                    target: None,
                },
            },
            AgentSessionEventPayload::ToolResult {
                call_id,
                name: "apply_patch".into(),
                status: if changed {
                    super::super::AgentToolResultStatus::Completed
                } else {
                    super::super::AgentToolResultStatus::Failed
                },
                summary: if changed {
                    "Applied patch".into()
                } else {
                    "apply_patch digest precondition failed".into()
                },
                data: changed.then(|| {
                    serde_json::json!({
                        "applied": true, "verified": true,
                        "files": [{ "beforeSha256": "0".repeat(64), "afterSha256": "1".repeat(64) }]
                    })
                }),
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
            AgentSessionEventPayload::StepEnd {
                reason: "toolsCompleted".into(),
            },
        ];
        payloads
            .into_iter()
            .map(|payload| {
                let mut record = event(index as u64, payload);
                record.turn_id = Some("turn-1".into());
                record.step_id = Some(format!("edit-step-{index}"));
                record
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
    fn identical_plan_versions_do_not_reset_repetition_but_changed_plans_do() {
        let mut events = Vec::new();
        let mut alternating = Vec::new();
        for version in 1..=7 {
            let steps = vec![super::super::AgentPlanStep {
                id: "review".into(),
                title: "Review agent loop".into(),
                status: if version == 7 {
                    super::super::AgentPlanStepStatus::Completed
                } else {
                    super::super::AgentPlanStepStatus::InProgress
                },
                detail: None,
                evidence_refs: Vec::new(),
            }];
            let call_id = format!("plan-{version}");
            let mut step = repeated_step(
                &format!("step-{version}"),
                &call_id,
                "",
                false,
                version * 10,
            );
            for event in &mut step {
                match &mut event.payload {
                    AgentSessionEventPayload::ToolCall { call } => {
                        call.name = "update_plan".into();
                        call.arguments =
                            serde_json::json!({"steps": steps, "planVersion": version});
                    }
                    AgentSessionEventPayload::ToolResult {
                        name,
                        summary,
                        data,
                        ..
                    } => {
                        *name = "update_plan".into();
                        *summary = format!("Updated task plan (version {version})");
                        *data = Some(serde_json::json!({"planVersion": version}));
                    }
                    _ => {}
                }
            }
            let plan = super::super::AgentSessionEvent {
                payload: AgentSessionEventPayload::TaskPlan { version, steps },
                ..step[0].clone()
            };
            step.insert(1, plan);
            alternating.extend(step.clone());
            alternating.extend(repeated_step(
                &format!("read-step-{version}"),
                &format!("read-{version}"),
                "unchanged",
                false,
                version * 10 + 5,
            ));
            events.extend(step);
            assert_eq!(
                repeated_tool_step_streak(&events, "turn-1"),
                if version == 7 { 1 } else { version as usize }
            );
            if version == 6 {
                assert!(
                    no_progress_reason(&events, "turn-1", AgentDriverConfig::default()).is_some()
                );
                assert!(
                    no_progress_reason(&alternating, "turn-1", AgentDriverConfig::default())
                        .is_some()
                );
            }
        }
        assert!(no_progress_reason(&events, "turn-1", AgentDriverConfig::default()).is_none());
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

        let mut output_limit = NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
            "AI provider reached the configured output token limit",
        );
        output_limit.code = Some("OUTPUT_LIMIT".into());
        let reason = model_error_reason(&output_limit, 1, 3, 0);
        assert!(reason.starts_with("outputLimit:"));
        assert!(reason.contains("code=OUTPUT_LIMIT"));
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
