use std::sync::{Arc, Mutex};
use std::time::Instant;

use uuid::Uuid;

use crate::agent_runtime::{
    cancellable_retry_delay, driver_metrics::TaskTokenBudgetDecision,
    model_tools::apply_file_edit_budget, request_budget::estimate_request_budget,
    request_log::request_events, skills::SKILL_TOOL, stream_writer::StreamWriter,
    subagent::child_budget_usage, tool_output::READ_TOOL_RESULT, AgentRequestBudget,
    AgentRequestReason, AgentSessionPermissionMode, AgentSurfaceMessage, ModelSurfaceBudget,
    RetryPlan, TaskBudgetCheckpointStage,
};

use super::*;

struct PendingRetry {
    previous_request_id: String,
    reason: String,
    plan: RetryPlan,
    error: Option<NormalizedModelError>,
    wait_for_network: bool,
}

struct StepContext<'a> {
    sessions: &'a AgentSessionStore,
    entry: &'a Arc<AgentEntry>,
    tools: &'a AgentToolPipeline,
    model: &'a crate::llm::runtime::PreparedModel,
    compactions: AgentCompactionManager,
    turn_id: &'a str,
    step_id: &'a str,
    step_index: usize,
    permission_mode: Option<AgentSessionPermissionMode>,
    config: AgentDriverConfig,
}

struct StepLoopState {
    attempt: u32,
    request_reason: AgentRequestReason,
    pending_retry: Option<PendingRetry>,
    cumulative_delay_ms: u64,
    prepared_call: Option<crate::llm::runtime::PreparedCall>,
    prepared_budget_recovery_attempted: bool,
    network_recovery_started_at: Option<Instant>,
    network_recovery_round: u32,
}

impl StepLoopState {
    fn new(step_index: usize) -> Self {
        Self {
            attempt: 1_u32,
            request_reason: if step_index == 1 {
                AgentRequestReason::Initial
            } else {
                AgentRequestReason::ToolContinuation
            },
            pending_retry: None,
            cumulative_delay_ms: 0_u64,
            prepared_call: None,
            prepared_budget_recovery_attempted: false,
            network_recovery_started_at: None,
            network_recovery_round: 0_u32,
        }
    }
}

struct PreparedStepAttempt {
    request_id: String,
    request: ModelRequest,
    budget: ModelSurfaceBudget,
    request_surface_generation: u64,
}

enum AttemptPreparation {
    Ready(Box<PreparedStepAttempt>),
    RetryLoop,
    Settle(StepSettlement),
}

enum ErrorResolution {
    Retry,
    Settle(StepSettlement),
}

fn network_transport_failure(error: &NormalizedModelError) -> bool {
    matches!(
        error.kind,
        NormalizedModelErrorKind::Transport | NormalizedModelErrorKind::Timeout
    ) && matches!(
        error.code.as_deref(),
        Some(
            "CONNECT"
                | "STREAM_READ"
                | "STREAM_DECODE"
                | "TRANSPORT_TIMEOUT"
                | "REQUEST_HEADERS_TIMEOUT"
                | "FIRST_BYTE_TIMEOUT"
                | "STREAM_IDLE_TIMEOUT"
        )
    )
}

fn retry_random_sample() -> f64 {
    let sample = Uuid::new_v4().as_u128() as u64;
    (sample as f64) / (u64::MAX as f64)
}

fn empty_model_response_error() -> NormalizedModelError {
    let mut error = NormalizedModelError::new(
        NormalizedModelErrorKind::EmptyResponse,
        "AI provider completed without answer text or tool calls",
    );
    error.code = Some("EMPTY_RESPONSE".into());
    error
}

pub(super) async fn run_step(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    tools: &AgentToolPipeline,
    model: &crate::llm::runtime::PreparedModel,
    compactions: &AgentCompactionManager,
    turn_id: &str,
    step_id: &str,
    step_index: usize,
    config: AgentDriverConfig,
) -> Result<StepSettlement, String> {
    // A step and all its retries retain one provider/adapter pair.
    let config = AgentDriverConfig {
        retry_policy: model.provider.retry_policy.unwrap_or(config.retry_policy),
        ..config
    };
    let compactions = compactions.clone().with_model(
        model.adapter.clone(),
        model.provider.clone(),
        config.retry_policy,
    );
    let permission_mode = sessions.snapshot(&entry.session_id)?.header.permission_mode;
    let ctx = StepContext {
        sessions,
        entry,
        tools,
        model,
        compactions,
        turn_id,
        step_id,
        step_index,
        permission_mode,
        config,
    };
    let mut state = StepLoopState::new(step_index);

    loop {
        if let Some(settlement) = check_attempt_preflight(&ctx)? {
            return Ok(settlement);
        }
        let request_id = format!("request-{}", Uuid::new_v4().simple());
        if !await_pending_retry(&ctx, &mut state, &request_id).await? {
            return Ok(StepSettlement::Cancelled);
        }
        let attempt_data = match prepare_step_attempt(&ctx, &mut state, request_id).await? {
            AttemptPreparation::Ready(data) => *data,
            AttemptPreparation::RetryLoop => continue,
            AttemptPreparation::Settle(settlement) => return Ok(settlement),
        };
        let call = state.prepared_call.as_ref().expect("prepared call");
        record_step_request_events(&ctx, &state, &attempt_data, call)?;
        let (response, collected) =
            execute_model_stream(&ctx, &state, call, &attempt_data.request_id).await?;
        match response {
            Ok(response) => {
                let final_wrap_up = is_final_child_step(
                    ctx.entry.subagent.as_ref(),
                    ctx.config.max_steps_per_turn,
                    ctx.step_index,
                );
                return commit_response(
                    ctx.sessions,
                    ctx.entry,
                    ctx.tools,
                    ctx.turn_id,
                    ctx.step_id,
                    &attempt_data.request_id,
                    final_wrap_up,
                    response,
                )
                .await;
            }
            Err(error) => {
                match handle_step_error(&ctx, &mut state, &attempt_data, &collected, error).await? {
                    ErrorResolution::Retry => continue,
                    ErrorResolution::Settle(settlement) => return Ok(settlement),
                }
            }
        }
    }
}

fn check_attempt_preflight(ctx: &StepContext<'_>) -> Result<Option<StepSettlement>, String> {
    if ctx.entry.cancellation().is_cancelled() {
        return Ok(Some(StepSettlement::Cancelled));
    }
    if let Some(reason) = ctx.sessions.read_events(&ctx.entry.session_id, |events| {
        subagent_budget_failure(ctx.entry.subagent.as_ref(), events)
    })?? {
        return Ok(Some(StepSettlement::Failed(reason)));
    }
    if let Some(reason) = task_budget_failure(
        &ctx.sessions.driver_metrics(&ctx.entry.session_id)?,
        ctx.config,
    )? {
        if reason.starts_with("taskTokenBudgetExceeded:") {
            return Ok(Some(stop_for_token_budget(
                &ctx.compactions,
                &ctx.entry.session_id,
                ctx.turn_id,
                ctx.step_id,
                ctx.config.max_model_tokens_per_session,
                &ctx.entry.cancellation(),
            )));
        }
        return Ok(Some(StepSettlement::Failed(reason)));
    }
    Ok(None)
}

async fn await_pending_retry(
    ctx: &StepContext<'_>,
    state: &mut StepLoopState,
    request_id: &str,
) -> Result<bool, String> {
    let Some(pending) = state.pending_retry.take() else {
        return Ok(true);
    };
    if pending.wait_for_network {
        append_status(
            ctx.sessions,
            ctx.entry,
            AgentSessionStatus::Waiting,
            Some("waitingForNetwork".into()),
        )?;
    }
    state.cumulative_delay_ms = state
        .cumulative_delay_ms
        .saturating_add(pending.plan.delay_ms);
    let error_kind = pending
        .error
        .as_ref()
        .map(|error| format!("{:?}", error.kind).to_ascii_lowercase());
    let error_status = pending.error.as_ref().and_then(|error| error.status);
    let error_code = pending.error.as_ref().and_then(|error| error.code.clone());
    ctx.sessions.append(
        &ctx.entry.session_id,
        Some(ctx.turn_id.to_string()),
        Some(ctx.step_id.to_string()),
        AgentSessionEventPayload::RequestRetry {
            request_id: request_id.to_string(),
            previous_request_id: Some(pending.previous_request_id),
            attempt: state.attempt,
            reason: pending.reason,
            delay_ms: Some(pending.plan.delay_ms),
            cumulative_delay_ms: Some(state.cumulative_delay_ms),
            server_retry_after_ms: pending.plan.server_retry_after_ms,
            server_hint_capped: pending.plan.server_hint_capped,
            error_kind,
            error_status,
            error_code,
        },
    )?;
    if !cancellable_retry_delay(pending.plan.delay_ms, &ctx.entry.cancellation()).await {
        return Ok(false);
    }
    if pending.wait_for_network {
        append_status(
            ctx.sessions,
            ctx.entry,
            AgentSessionStatus::Running,
            Some("networkRetry".into()),
        )?;
    }
    Ok(true)
}

async fn assemble_fresh_step_request(
    ctx: &StepContext<'_>,
    request_id: &str,
) -> Result<ModelRequest, String> {
    let mut snapshot = ctx.sessions.snapshot(&ctx.entry.session_id)?;
    snapshot.header.permission_mode = ctx.permission_mode;
    let mut assembly = assemble_model_input(
        &snapshot.header,
        model_tools_for(
            ctx.entry,
            ctx.tools
                .terminal_interactive_tools_enabled(snapshot.header.target.as_ref()),
            ctx.tools
                .vim_bridge_available(snapshot.header.target.as_ref()),
        ),
    );
    scope_current_task_context(ctx.sessions, &snapshot, &mut assembly)?;
    ctx.tools
        .sync_terminal_execution_context(&snapshot.header, &mut assembly)?;
    append_current_task_plan_context(ctx.sessions, &snapshot, ctx.turn_id, &mut assembly)?;
    ensure_model_context(
        ctx.sessions,
        &ctx.entry.session_id,
        ctx.turn_id,
        ctx.step_id,
        &snapshot.surface,
        &assembly,
    )?;
    ctx.tools
        .skills
        .prepare_step(ctx.entry, ctx.turn_id, ctx.step_id)
        .await?;
    ctx.tools
        .skills
        .republish_if_missing(&ctx.entry.session_id, ctx.turn_id, ctx.step_id)?;
    let surface = ctx.sessions.model_surface(&ctx.entry.session_id)?;
    let mut request = ModelRequest::from_surface(
        request_id.to_string(),
        &surface,
        assembly.system_prompt,
        assembly.tools,
    );
    if let Some(mut inherited) = ctx.sessions.inherited_surface(&ctx.entry.session_id)? {
        inherited.messages.retain(|message| {
            !matches!(
                message,
                AgentSurfaceMessage::User { source, .. }
                    if is_assembled_context_source(source) || source.producer_id == "shellspan.skills.v1"
            )
        });
        inherited
            .messages
            .retain(|m| !matches!(m, AgentSurfaceMessage::Tool { name, .. } if name == SKILL_TOOL));
        for message in &mut inherited.messages {
            if let AgentSurfaceMessage::Assistant {
                content, replay, ..
            } = message
            {
                let before = content.len();
                content.retain(|b| {
                    !matches!(b, AgentAssistantContentBlock::ToolCall { call } if call.name == SKILL_TOOL)
                });
                if content.len() != before {
                    *replay = None;
                }
            }
        }
        inherited.messages.retain(
            |m| !matches!(m, AgentSurfaceMessage::Assistant { content, .. } if content.is_empty()),
        );
        if request
            .tools
            .iter()
            .any(|tool| tool.name == READ_TOOL_RESULT)
        {
            inherited = ctx
                .tools
                .materialize_inherited_results(
                    &ctx.entry.session_id,
                    ctx.turn_id,
                    ctx.step_id,
                    inherited,
                    ctx.entry.cancellation(),
                )
                .await?;
        }
        let mut inherited_messages = ModelRequest::from_surface(
            format!("{request_id}-inherited"),
            &inherited,
            String::new(),
            Vec::new(),
        )
        .messages;
        inherited_messages.append(&mut request.messages);
        request.messages = inherited_messages;
    }
    ctx.tools
        .apply_ephemeral_terminal_results(&ctx.entry.session_id, ctx.turn_id, &mut request)?;
    apply_file_edit_budget(
        &mut request,
        crate::llm::catalog::resolve(&ctx.model.provider)?.output_token_budget(),
        ctx.sessions
            .read_turn_events(&ctx.entry.session_id, |events| {
                output_limit_continuation_count(events, ctx.turn_id)
            })?,
    );
    if let Some(child) = &ctx.entry.subagent {
        let final_wrap_up =
            is_final_child_step(Some(child), ctx.config.max_steps_per_turn, ctx.step_index);
        if final_wrap_up {
            request.tool_choice = crate::llm::types::ModelToolChoice::None;
        }
        let now = current_unix_ms()?;
        let usage = ctx.sessions.read_events(&ctx.entry.session_id, |events| {
            child_budget_usage(events, now)
        })?;
        request.messages.push(ModelMessage::User {
            content: child_budget_reminder_message(
                ctx.config.max_steps_per_turn,
                ctx.step_index,
                final_wrap_up,
                &child.budget,
                &usage,
            ),
        });
    }
    Ok(request)
}

async fn prepare_step_attempt(
    ctx: &StepContext<'_>,
    state: &mut StepLoopState,
    request_id: String,
) -> Result<AttemptPreparation, String> {
    let mut request = if let Some(call) = &state.prepared_call {
        call.request(request_id.clone())
    } else {
        assemble_fresh_step_request(ctx, &request_id).await?
    };
    let request_surface_generation = request.surface_generation;
    if state.prepared_call.is_none() {
        let raw_budget =
            estimate_request_budget(ctx.sessions, &ctx.entry.session_id, ctx.model, &request)?;
        if raw_budget.requires_compaction() {
            ctx.compactions.record_budget(
                &ctx.entry.session_id,
                ctx.turn_id,
                ctx.step_id,
                &request,
                &raw_budget,
            )?;
        }
        request = ctx
            .tools
            .bound_request_results(
                &ctx.entry.session_id,
                ctx.turn_id,
                ctx.step_id,
                request,
                raw_budget,
            )
            .await?;
    }
    let budget = estimate_request_budget(ctx.sessions, &ctx.entry.session_id, ctx.model, &request)?;
    // Retries retain the same prepared request. Its input was already
    // admitted; compaction is only appropriate when assembling a new call.
    if budget.requires_compaction() && state.prepared_call.is_none() {
        ctx.compactions.record_budget(
            &ctx.entry.session_id,
            ctx.turn_id,
            ctx.step_id,
            &request,
            &budget,
        )?;
        let before = request.surface_generation;
        let result = ctx
            .compactions
            .compact(
                &ctx.entry.session_id,
                ctx.turn_id,
                ctx.step_id,
                Some(ctx.turn_id),
                "skillsInputBudget",
                &budget,
                false,
                &ctx.entry.cancellation(),
            )
            .await;
        if ctx.entry.cancellation().is_cancelled() {
            return Ok(AttemptPreparation::Settle(StepSettlement::Cancelled));
        }
        if ctx
            .sessions
            .snapshot(&ctx.entry.session_id)?
            .surface
            .generation
            != before
        {
            return Ok(AttemptPreparation::RetryLoop);
        }
        if !budget.fits_hard_limit() {
            let detail = result
                .err()
                .unwrap_or_else(|| "No smaller safe context was available".into());
            let reason = format!("contextBudgetExceeded: {}; {detail}. Select a larger-context model or reduce attached input, then continue; completed work is preserved.", budget.diagnostic());
            pause_context_budget(ctx.sessions, ctx.entry, &ctx.compactions, &reason)?;
            return Ok(AttemptPreparation::Settle(StepSettlement::Waiting));
        }
    }
    // Preserve the existing early stop when even the unprepared input has
    // exhausted the task budget; otherwise admit using the final input below.
    if matches!(
        ctx.sessions
            .driver_metrics(&ctx.entry.session_id)?
            .token_budget_decision(
                budget
                    .estimated_input_tokens
                    .saturating_add(budget.output_reserve_tokens),
                ctx.config.max_model_tokens_per_session
            ),
        TaskTokenBudgetDecision::Stop
    ) {
        return Ok(AttemptPreparation::Settle(stop_for_token_budget(
            &ctx.compactions,
            &ctx.entry.session_id,
            ctx.turn_id,
            ctx.step_id,
            ctx.config.max_model_tokens_per_session,
            &ctx.entry.cancellation(),
        )));
    }
    if state.prepared_call.is_none() {
        state.prepared_call = Some(ctx.model.prepare_request(
            request,
            "step",
            &ctx.entry.cancellation(),
        )?);
    }
    request = state
        .prepared_call
        .as_ref()
        .expect("prepared call")
        .request(request_id.clone());
    let budget = estimate_request_budget(ctx.sessions, &ctx.entry.session_id, ctx.model, &request)?;
    if !budget.fits_hard_limit() {
        ctx.compactions.record_budget(
            &ctx.entry.session_id,
            ctx.turn_id,
            ctx.step_id,
            &request,
            &budget,
        )?;
        let recovery = compact_prepared_budget(
            &ctx.compactions,
            &ctx.entry.session_id,
            ctx.turn_id,
            ctx.step_id,
            request.surface_generation,
            &budget,
            &mut state.prepared_budget_recovery_attempted,
            &ctx.entry.cancellation(),
        )
        .await;
        if ctx.entry.cancellation().is_cancelled() {
            return Ok(AttemptPreparation::Settle(StepSettlement::Cancelled));
        }
        if matches!(recovery, Ok(true)) {
            state.prepared_call = None;
            return Ok(AttemptPreparation::RetryLoop);
        }
        let detail = recovery
            .err()
            .unwrap_or_else(|| "bounded prepared-input recovery was exhausted".into());
        let reason = format!("contextBudgetExceeded: prepared provider input exceeds the available context; {}; {detail}. Select a larger-context model or reduce attached input, then continue; completed work is preserved.", budget.diagnostic());
        pause_context_budget(ctx.sessions, ctx.entry, &ctx.compactions, &reason)?;
        return Ok(AttemptPreparation::Settle(StepSettlement::Waiting));
    }
    // Admission uses the prepared request, including private replay overhead.
    match ctx
        .sessions
        .driver_metrics(&ctx.entry.session_id)?
        .token_budget_decision(
            budget
                .estimated_input_tokens
                .saturating_add(budget.output_reserve_tokens),
            ctx.config.max_model_tokens_per_session,
        ) {
        TaskTokenBudgetDecision::Stop => {
            return Ok(AttemptPreparation::Settle(stop_for_token_budget(
                &ctx.compactions,
                &ctx.entry.session_id,
                ctx.turn_id,
                ctx.step_id,
                ctx.config.max_model_tokens_per_session,
                &ctx.entry.cancellation(),
            )));
        }
        TaskTokenBudgetDecision::Checkpoint => {
            if ctx
                .compactions
                .checkpoint_task_budget(
                    &ctx.entry.session_id,
                    ctx.turn_id,
                    ctx.step_id,
                    ctx.config.max_model_tokens_per_session,
                    TaskBudgetCheckpointStage::Approaching,
                    &ctx.entry.cancellation(),
                )
                .is_err()
            {
                if ctx.entry.cancellation().is_cancelled() {
                    return Ok(AttemptPreparation::Settle(StepSettlement::Cancelled));
                }
                // Existing committed history remains the recovery source.
                // Record the failed attempt so a storage error cannot cause
                // an unbounded checkpoint retry on every subsequent step.
                append_status(
                    ctx.sessions,
                    ctx.entry,
                    AgentSessionStatus::Running,
                    Some("taskBudgetCheckpointUnavailable".into()),
                )?;
            }
        }
        TaskTokenBudgetDecision::Continue => {}
    }
    if ctx.entry.cancellation().is_cancelled() {
        return Ok(AttemptPreparation::Settle(StepSettlement::Cancelled));
    }
    Ok(AttemptPreparation::Ready(Box::new(PreparedStepAttempt {
        request_id,
        request,
        budget,
        request_surface_generation,
    })))
}

fn record_step_request_events(
    ctx: &StepContext<'_>,
    state: &StepLoopState,
    attempt: &PreparedStepAttempt,
    call: &crate::llm::runtime::PreparedCall,
) -> Result<(), String> {
    let estimated_input_tokens = Some(attempt.budget.estimated_input_tokens);
    let mut events = ctx
        .sessions
        .read_events(&ctx.entry.session_id, |events| {
            request_events(
                events,
                ctx.entry,
                &ctx.model.provider,
                &attempt.request,
                &call.snapshot,
                state.request_reason,
                state.attempt,
            )
        })?
        .into_iter()
        .map(|payload| AgentScopedPayload {
            turn_id: Some(ctx.turn_id.to_string()),
            step_id: Some(ctx.step_id.to_string()),
            payload,
        })
        .collect::<Vec<_>>();
    events.push(AgentScopedPayload {
        turn_id: Some(ctx.turn_id.to_string()),
        step_id: Some(ctx.step_id.to_string()),
        payload: AgentSessionEventPayload::RequestContext {
            request_id: attempt.request_id.clone(),
            input_tokens: estimated_input_tokens,
            context_window: Some(attempt.budget.context_window),
            request_budget: Some(AgentRequestBudget {
                output_tokens: attempt.budget.output_reserve_tokens,
                safety_tokens: attempt.budget.safety_reserve_tokens,
                usable_input_tokens: attempt.budget.usable_input_tokens,
                compaction_threshold_tokens: attempt.budget.compaction_threshold_tokens,
                compaction_target_tokens: attempt.budget.compaction_target_tokens,
                input_measurement: attempt.budget.input_measurement.clone(),
            }),
            system_tokens: Some(attempt.budget.system_tokens),
            tool_schema_tokens: Some(attempt.budget.tool_schema_tokens),
            message_tokens: Some(attempt.budget.message_tokens),
            surface_generation: attempt.request.surface_generation,
            limited: None,
            omitted_messages: None,
        },
    });
    ctx.sessions.append_batch(&ctx.entry.session_id, events)?;
    Ok(())
}

async fn execute_model_stream(
    ctx: &StepContext<'_>,
    state: &StepLoopState,
    call: &crate::llm::runtime::PreparedCall,
    request_id: &str,
) -> Result<
    (
        Result<ModelResponse, NormalizedModelError>,
        Arc<Mutex<PartialContentAccumulator>>,
    ),
    String,
> {
    let collected = Arc::new(Mutex::new(PartialContentAccumulator::default()));
    let cancellation = ctx.entry.cancellation();
    let stream_cancellation = cancellation.child_token();
    let sink = Arc::new(DurableModelStreamSink {
        #[cfg(test)]
        sessions: ctx.sessions.clone(),
        turn_id: ctx.turn_id.to_string(),
        step_id: ctx.step_id.to_string(),
        request_id: request_id.to_string(),
        collected: Arc::clone(&collected),
        cancellation: stream_cancellation.clone(),
        pending: Mutex::new(StreamBatch::default()),
        dirty: std::sync::atomic::AtomicBool::new(false),
        writer: StreamWriter::new(ctx.sessions.clone(), ctx.entry.session_id.clone())?,
    });
    let remaining_active_ms = ctx.config.max_active_duration_ms.saturating_sub(
        ctx.sessions
            .driver_metrics(&ctx.entry.session_id)?
            .active_duration_ms(current_unix_ms()?),
    );
    let remaining_network_ms = state
        .network_recovery_started_at
        .map_or(u64::MAX, |started| {
            ctx.config
                .network_recovery_window_ms
                .saturating_sub(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
        });
    let stream_limit_ms = remaining_active_ms
        .min(ctx.config.max_model_stream_duration_ms)
        .min(remaining_network_ms);
    let deadline_code = if remaining_network_ms <= remaining_active_ms
        && remaining_network_ms <= ctx.config.max_model_stream_duration_ms
    {
        "NETWORK_RECOVERY_TIMEOUT"
    } else if remaining_active_ms <= ctx.config.max_model_stream_duration_ms {
        "TASK_ACTIVE_TIME_EXCEEDED"
    } else {
        "MODEL_STREAM_TOTAL_TIMEOUT"
    };
    let deadline_error = || {
        let mut error = NormalizedModelError::new(
            NormalizedModelErrorKind::Timeout,
            format!("model stream exceeded its {stream_limit_ms} ms total deadline"),
        );
        error.code = Some(deadline_code.into());
        error
    };
    let response = if stream_limit_ms == 0 {
        Err(deadline_error())
    } else {
        // ModelStreamSink is synchronous. Poll the adapter on a blocking
        // worker so bounded writer backpressure cannot block the scheduler.
        let runtime = tokio::runtime::Handle::current();
        let prepared = call.clone();
        let worker_sink = sink.clone();
        let worker_token = stream_cancellation.clone();
        let worker_request = request_id.to_string();
        let mut worker = tokio::task::spawn_blocking(move || {
            runtime.block_on(async move {
                let response = prepared.stream(worker_request, worker_token.clone(), worker_sink);
                let result = tokio::select! {
                    biased;
                    _ = worker_token.cancelled() => Err(NormalizedModelError::cancelled()),
                    result = response => result,
                };
                // A provider may cancel while returning an already-ready
                // response/error. Cancellation still wins before any retry.
                if worker_token.is_cancelled() {
                    Err(NormalizedModelError::cancelled())
                } else {
                    result
                }
            })
        });
        let deadline = tokio::time::sleep(std::time::Duration::from_millis(stream_limit_ms));
        tokio::pin!(deadline);
        let mut joined = false;
        let mut flush_interval =
            tokio::time::interval(std::time::Duration::from_millis(STREAM_FLUSH_INTERVAL_MS));
        flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let response = loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => break Err(NormalizedModelError::cancelled()),
                _ = &mut deadline => break Err(deadline_error()),
                result = &mut worker => {
                    joined = true;
                    break result.unwrap_or_else(|error| Err(stream_storage_error(format!("model stream worker failed: {error}"))));
                }
                _ = flush_interval.tick() => {
                    if let Err(error) = sink.flush_async(false).await {
                        break Err(stream_storage_error(error));
                    }
                }
            }
        };
        if !joined {
            stream_cancellation.cancel();
            // Join before closing the sink: no accepted callback can race
            // the final persistence fence or a subsequent model request.
            let _ = worker.await;
        }
        response
    };
    // No response, retry, cancellation settlement or tool dispatch may pass
    // buffered deltas. Close the sink as well, rejecting late provider emits.
    sink.flush_async(true).await?;
    let response = match response {
        _ if cancellation.is_cancelled() => Err(NormalizedModelError::cancelled()),
        Ok(response) if !model_response_has_output(&response) => Err(empty_model_response_error()),
        other => other,
    };
    Ok((response, collected))
}

async fn handle_step_error(
    ctx: &StepContext<'_>,
    state: &mut StepLoopState,
    attempt: &PreparedStepAttempt,
    collected: &Arc<Mutex<PartialContentAccumulator>>,
    error: NormalizedModelError,
) -> Result<ErrorResolution, String> {
    let request_id = &attempt.request_id;
    match error {
        error if error.kind == NormalizedModelErrorKind::Cancelled => {
            let (had_output, partial) = {
                let collected = collected
                    .lock()
                    .map_err(|_| "model stream accumulator is unavailable".to_string())?;
                (!collected.is_empty(), collected.content())
            };
            if had_output {
                append_interrupted_message(
                    ctx.sessions,
                    ctx.entry,
                    ctx.turn_id,
                    ctx.step_id,
                    partial,
                    AgentStopReason::Cancelled,
                )?;
            }
            Ok(ErrorResolution::Settle(StepSettlement::Cancelled))
        }
        error
            if matches!(
                error.code.as_deref(),
                Some(
                    "TASK_ACTIVE_TIME_EXCEEDED"
                        | "MODEL_STREAM_TOTAL_TIMEOUT"
                        | "NETWORK_RECOVERY_TIMEOUT"
                )
            ) =>
        {
            let (had_output, partial) = {
                let collected = collected
                    .lock()
                    .map_err(|_| "model stream accumulator is unavailable".to_string())?;
                (!collected.is_empty(), collected.content())
            };
            if had_output {
                append_interrupted_message(
                    ctx.sessions,
                    ctx.entry,
                    ctx.turn_id,
                    ctx.step_id,
                    partial,
                    AgentStopReason::Other,
                )?;
            }
            ctx.sessions.append(
                &ctx.entry.session_id,
                Some(ctx.turn_id.to_string()),
                Some(ctx.step_id.to_string()),
                request_failure_payload(
                    request_id,
                    &error,
                    state.attempt,
                    ctx.config.retry_policy.max_attempts().max(state.attempt),
                    state.cumulative_delay_ms,
                    had_output,
                ),
            )?;
            Ok(ErrorResolution::Settle(StepSettlement::Failed(format!(
                "{}: {}",
                match error.code.as_deref() {
                    Some("TASK_ACTIVE_TIME_EXCEEDED") => "taskActiveTimeExceeded",
                    Some("NETWORK_RECOVERY_TIMEOUT") => "networkRecoveryTimeout",
                    _ => "modelStreamTotalTimeout",
                },
                error.message
            ))))
        }
        error
            if error.kind == NormalizedModelErrorKind::ContextTooLarge
                && state.attempt < ctx.config.retry_policy.max_attempts()
                && collected
                    .lock()
                    .map_err(|_| "model stream accumulator is unavailable".to_string())?
                    .is_empty() =>
        {
            recover_context_too_large(ctx, state, attempt, error).await
        }
        error if error.kind == NormalizedModelErrorKind::ContextTooLarge => {
            let partial = collected
                .lock()
                .map_err(|_| "model stream accumulator is unavailable".to_string())?
                .content();
            let had_output = !partial.is_empty();
            if had_output {
                append_interrupted_message(
                    ctx.sessions,
                    ctx.entry,
                    ctx.turn_id,
                    ctx.step_id,
                    partial,
                    AgentStopReason::Other,
                )?;
            }
            ctx.sessions.append(
                &ctx.entry.session_id,
                Some(ctx.turn_id.into()),
                Some(ctx.step_id.into()),
                request_failure_payload(
                    request_id,
                    &error,
                    state.attempt,
                    ctx.config.retry_policy.max_attempts().max(state.attempt),
                    state.cumulative_delay_ms,
                    had_output,
                ),
            )?;
            let reason = format!("contextBudgetExceeded: provider rejected the context after bounded recovery; {}. Select a larger-context model or reduce attached input, then continue; completed work is preserved.", attempt.budget.diagnostic());
            pause_context_budget(ctx.sessions, ctx.entry, &ctx.compactions, &reason)?;
            Ok(ErrorResolution::Settle(StepSettlement::Waiting))
        }
        error if error.retryable() => {
            handle_retryable_step_error(ctx, state, request_id, collected, error)
        }
        error if error.code.as_deref() == Some("OUTPUT_LIMIT") => {
            let partial = collected
                .lock()
                .map_err(|_| "model stream accumulator is unavailable".to_string())?
                .content();
            ctx.sessions.append(
                &ctx.entry.session_id,
                Some(ctx.turn_id.to_string()),
                Some(ctx.step_id.to_string()),
                request_failure_payload(
                    request_id,
                    &error,
                    state.attempt,
                    ctx.config.retry_policy.max_attempts().max(state.attempt),
                    state.cumulative_delay_ms,
                    !partial.is_empty(),
                ),
            )?;
            Ok(ErrorResolution::Settle(settle_output_limit(
                ctx.sessions,
                ctx.entry,
                ctx.turn_id,
                ctx.step_id,
                request_id,
                partial,
                None,
            )?))
        }
        error => {
            let had_output = {
                let collected = collected
                    .lock()
                    .map_err(|_| "model stream accumulator is unavailable".to_string())?;
                !collected.is_empty()
            };
            ctx.sessions.append(
                &ctx.entry.session_id,
                Some(ctx.turn_id.to_string()),
                Some(ctx.step_id.to_string()),
                request_failure_payload(
                    request_id,
                    &error,
                    state.attempt,
                    ctx.config.retry_policy.max_attempts().max(state.attempt),
                    state.cumulative_delay_ms,
                    had_output,
                ),
            )?;
            Ok(ErrorResolution::Settle(StepSettlement::Failed(
                model_error_reason(
                    &error,
                    state.attempt,
                    ctx.config.retry_policy.max_attempts().max(state.attempt),
                    state.cumulative_delay_ms,
                ),
            )))
        }
    }
}

async fn recover_context_too_large(
    ctx: &StepContext<'_>,
    state: &mut StepLoopState,
    attempt: &PreparedStepAttempt,
    error: NormalizedModelError,
) -> Result<ErrorResolution, String> {
    let cancellation = ctx.entry.cancellation();
    state.prepared_call = None;
    let before = attempt.request_surface_generation;
    ctx.sessions.append(
        &ctx.entry.session_id,
        Some(ctx.turn_id.to_string()),
        Some(ctx.step_id.to_string()),
        request_failure_payload(
            &attempt.request_id,
            &error,
            state.attempt,
            ctx.config.retry_policy.max_attempts().max(state.attempt),
            state.cumulative_delay_ms,
            false,
        ),
    )?;
    let outcome = match ctx
        .compactions
        .compact(
            &ctx.entry.session_id,
            ctx.turn_id,
            ctx.step_id,
            Some(ctx.turn_id),
            "providerContextTooLarge",
            &attempt.budget,
            true,
            &cancellation,
        )
        .await
    {
        Ok(outcome) => outcome,
        Err(_) if cancellation.is_cancelled() => {
            return Ok(ErrorResolution::Settle(StepSettlement::Cancelled));
        }
        Err(compaction_error) => {
            let reason = format!("contextBudgetExceeded: provider rejected the context; {}; {compaction_error}. Select a larger-context model or reduce attached input, then continue; completed work is preserved.", attempt.budget.diagnostic());
            pause_context_budget(ctx.sessions, ctx.entry, &ctx.compactions, &reason)?;
            return Ok(ErrorResolution::Settle(StepSettlement::Waiting));
        }
    };
    if outcome.previous_generation != before || outcome.surface_generation <= before {
        return Ok(ErrorResolution::Settle(StepSettlement::Failed(
            "contextTooLargeRecoveryFailed: Model Surface generation did not advance".into(),
        )));
    }
    state.pending_retry = Some(PendingRetry {
        previous_request_id: attempt.request_id.clone(),
        reason: format!(
            "context compacted from generation {} to {}",
            before, outcome.surface_generation
        ),
        plan: RetryPlan {
            delay_ms: 0,
            server_retry_after_ms: None,
            server_hint_capped: false,
        },
        error: Some(error),
        wait_for_network: false,
    });
    state.attempt += 1;
    state.request_reason = AgentRequestReason::Recovery;
    Ok(ErrorResolution::Retry)
}

fn handle_retryable_step_error(
    ctx: &StepContext<'_>,
    state: &mut StepLoopState,
    request_id: &str,
    collected: &Arc<Mutex<PartialContentAccumulator>>,
    error: NormalizedModelError,
) -> Result<ErrorResolution, String> {
    let cancellation = ctx.entry.cancellation();
    let network_failure = network_transport_failure(&error);
    if network_failure && state.network_recovery_started_at.is_none() {
        state.network_recovery_started_at = Some(Instant::now());
    }
    let max_attempts = if network_failure {
        ctx.config
            .network_recovery_max_attempts
            .max(ctx.config.retry_policy.max_attempts())
    } else {
        ctx.config.retry_policy.max_attempts()
    }
    .max(state.attempt);
    let partial_is_empty = collected
        .lock()
        .map_err(|_| "model stream accumulator is unavailable".to_string())?
        .is_empty();
    ctx.sessions.append(
        &ctx.entry.session_id,
        Some(ctx.turn_id.to_string()),
        Some(ctx.step_id.to_string()),
        request_failure_payload(
            request_id,
            &error,
            state.attempt,
            max_attempts,
            state.cumulative_delay_ms,
            !partial_is_empty,
        ),
    )?;
    if !cancellation.is_cancelled() {
        let ordinary = ctx
            .config
            .retry_policy
            .plan(&error, state.attempt, retry_random_sample());
        let recovery = if ordinary.is_none() && network_failure && state.attempt < max_attempts {
            state.network_recovery_started_at.and_then(|started| {
                let remaining = ctx.config.network_recovery_window_ms.saturating_sub(
                    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                );
                if remaining == 0 {
                    return None;
                }
                let delay_ms = ctx
                    .config
                    .network_recovery_initial_delay_ms
                    .saturating_mul(1_u64 << state.network_recovery_round.min(20))
                    .min(ctx.config.network_recovery_max_delay_ms)
                    .min(remaining);
                Some(RetryPlan {
                    delay_ms,
                    server_retry_after_ms: None,
                    server_hint_capped: false,
                })
            })
        } else {
            None
        };
        let network_window_expired = ordinary.is_none()
            && network_failure
            && state.attempt < max_attempts
            && recovery.is_none()
            && state.network_recovery_started_at.is_some_and(|started| {
                u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
                    >= ctx.config.network_recovery_window_ms
            });
        if network_window_expired {
            return Ok(ErrorResolution::Settle(StepSettlement::Failed(format!(
                "networkRecoveryTimeout: model network recovery window of {} ms expired",
                ctx.config.network_recovery_window_ms
            ))));
        }
        let wait_for_network = recovery.is_some();
        if let Some(plan) = ordinary.or(recovery) {
            state.pending_retry = Some(PendingRetry {
                previous_request_id: request_id.to_string(),
                reason: if wait_for_network {
                    "network recovery after model transport failure".into()
                } else {
                    format!(
                        "retryable model failure: kind={:?} code={}",
                        error.kind,
                        error.code.as_deref().unwrap_or("unspecified")
                    )
                },
                plan,
                error: Some(error),
                wait_for_network,
            });
            if wait_for_network {
                state.network_recovery_round = state.network_recovery_round.saturating_add(1);
            }
            state.attempt += 1;
            state.request_reason = AgentRequestReason::Retry;
            return Ok(ErrorResolution::Retry);
        }
    }
    if cancellation.is_cancelled() {
        return Ok(ErrorResolution::Settle(StepSettlement::Cancelled));
    }
    Ok(ErrorResolution::Settle(StepSettlement::Failed(
        model_error_reason(
            &error,
            state.attempt,
            max_attempts,
            state.cumulative_delay_ms,
        ),
    )))
}
