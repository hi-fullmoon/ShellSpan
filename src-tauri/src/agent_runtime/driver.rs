use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use super::{
    assemble_model_input, estimate_model_surface_budget, model_tools_with_terminal_interaction,
    recorded_tool_call, AgentActiveScope, AgentAssistantContentBlock, AgentCompactionManager,
    AgentEntry, AgentHookBus, AgentLifecyclePhase, AgentPreStepContext, AgentPreStepDecision,
    AgentRequestReason, AgentScopedPayload, AgentSessionEventPayload, AgentSessionStatus,
    AgentSessionStore, AgentStopReason, AgentTokenUsage, AgentToolCallDelta, AgentToolPipeline,
    ModelContentBlock, ModelFinishReason, ModelMessage, ModelRequest, ModelResponse,
    ModelStreamSink, NormalizedModelError, NormalizedModelErrorKind, RetryPlan, RetryPolicy,
    StreamDelta, ToolPipelineSettlement, MAX_AGENT_STREAM_DELTA_BYTES,
};

#[cfg(test)]
use super::{AgentInboxLane, AgentInboxMessage, AgentMessageSource};

const DEFAULT_MAX_STEPS_PER_TURN: usize = 128;

#[derive(Debug, Clone, Copy)]
pub(crate) struct AgentDriverConfig {
    pub(crate) max_steps_per_turn: Option<usize>,
    pub(crate) max_turns_per_session: usize,
    pub(crate) max_identical_tool_steps: usize,
    pub(crate) max_model_tokens_per_session: u64,
    pub(crate) max_active_duration_ms: u64,
    pub(crate) max_model_stream_duration_ms: u64,
    pub(crate) network_recovery_window_ms: u64,
    pub(crate) network_recovery_max_attempts: u32,
    pub(crate) network_recovery_initial_delay_ms: u64,
    pub(crate) network_recovery_max_delay_ms: u64,
    pub(crate) retry_policy: RetryPolicy,
}

impl Default for AgentDriverConfig {
    fn default() -> Self {
        Self {
            // Root sessions treat this as a recoverable turn boundary, while
            // delegated sessions keep their explicit hard per-turn budget.
            max_steps_per_turn: Some(DEFAULT_MAX_STEPS_PER_TURN),
            max_turns_per_session: 64,
            max_identical_tool_steps: 6,
            max_model_tokens_per_session: 2_000_000,
            max_active_duration_ms: 60 * 60 * 1_000,
            max_model_stream_duration_ms: 15 * 60 * 1_000,
            network_recovery_window_ms: 2 * 60 * 1_000,
            network_recovery_max_attempts: 8,
            network_recovery_initial_delay_ms: 3_000,
            network_recovery_max_delay_ms: 30_000,
            retry_policy: RetryPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentDriverSettlement {
    Idle,
    Waiting,
    Cancelled,
    Failed,
}

pub(crate) async fn drive_agent(
    sessions: AgentSessionStore,
    entry: Arc<AgentEntry>,
    hooks: AgentHookBus,
    tools: AgentToolPipeline,
    compactions: AgentCompactionManager,
    config: AgentDriverConfig,
) -> AgentDriverSettlement {
    match drive_agent_inner(&sessions, &entry, &hooks, &tools, &compactions, config).await {
        Ok(settlement) => settlement,
        Err(message) if message.starts_with("toolSchedulerFailure:") => {
            let _ = tools.mark_scheduler_failure(&entry, &message);
            AgentDriverSettlement::Waiting
        }
        Err(_) if entry.cancellation().is_cancelled() => {
            let _ = close_open_scope(&sessions, &entry, "cancelled");
            AgentDriverSettlement::Cancelled
        }
        Err(message) => {
            let reason = format!("runtimeFailure: {message}");
            let _ = close_open_scope(&sessions, &entry, &reason);
            let _ = sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason);
            let _ = entry.set_phase(AgentLifecyclePhase::Stopping);
            AgentDriverSettlement::Failed
        }
    }
}

async fn drive_agent_inner(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    hooks: &AgentHookBus,
    tools: &AgentToolPipeline,
    compactions: &AgentCompactionManager,
    config: AgentDriverConfig,
) -> Result<AgentDriverSettlement, String> {
    let config = if let Some(subagent) = &entry.subagent {
        AgentDriverConfig {
            max_steps_per_turn: Some(
                config
                    .max_steps_per_turn
                    .map_or(subagent.budget.max_steps_per_turn as usize, |limit| {
                        limit.min(subagent.budget.max_steps_per_turn as usize)
                    }),
            ),
            max_turns_per_session: config
                .max_turns_per_session
                .min(subagent.budget.max_turns as usize),
            max_identical_tool_steps: config.max_identical_tool_steps,
            max_model_tokens_per_session: config.max_model_tokens_per_session,
            max_active_duration_ms: config.max_active_duration_ms,
            max_model_stream_duration_ms: config.max_model_stream_duration_ms,
            network_recovery_window_ms: config.network_recovery_window_ms,
            network_recovery_max_attempts: config.network_recovery_max_attempts,
            network_recovery_initial_delay_ms: config.network_recovery_initial_delay_ms,
            network_recovery_max_delay_ms: config.network_recovery_max_delay_ms,
            retry_policy: config.retry_policy,
        }
    } else {
        config
    };
    loop {
        if entry.cancellation().is_cancelled() {
            close_open_scope(sessions, entry, "cancelled")?;
            return Ok(AgentDriverSettlement::Cancelled);
        }
        if let Some(settlement) = tools.continue_questions(entry).await? {
            match settlement {
                ToolPipelineSettlement::Completed => continue,
                ToolPipelineSettlement::Waiting => return Ok(AgentDriverSettlement::Waiting),
                ToolPipelineSettlement::Cancelled => {
                    close_open_scope(sessions, entry, "cancelled")?;
                    return Ok(AgentDriverSettlement::Cancelled);
                }
            }
        }
        if let Some(settlement) = tools.continue_skills(entry).await? {
            match settlement {
                ToolPipelineSettlement::Completed => continue,
                ToolPipelineSettlement::Waiting => return Ok(AgentDriverSettlement::Waiting),
                ToolPipelineSettlement::Cancelled => return Ok(AgentDriverSettlement::Cancelled),
            }
        }
        let all_events = sessions.all_events(&entry.session_id)?;
        if let Some(reason) = subagent_budget_failure(entry, &all_events)? {
            close_open_scope(sessions, entry, &reason)?;
            sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
            entry.set_phase(AgentLifecyclePhase::Stopping)?;
            return Ok(AgentDriverSettlement::Failed);
        }
        let started_turns = all_events
            .iter()
            .rev()
            .take_while(|event| {
                !matches!(event.payload, AgentSessionEventPayload::SessionResumed {})
            })
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
            .count();
        let snapshot = sessions.snapshot(&entry.session_id)?;
        let existing_scope = entry.scope()?;
        if let Some(scope) = &existing_scope {
            if scope.step_id.is_none()
                && !snapshot
                    .inbox
                    .next_step
                    .iter()
                    .any(|message| message.source.kind == super::AgentMessageSourceKind::User)
                && config.max_identical_tool_steps > 0
                && repeated_tool_step_streak(&all_events, &scope.turn_id)
                    >= config.max_identical_tool_steps
            {
                let reason = format!(
                    "noProgress: {} repeated tool steps produced no new evidence",
                    config.max_identical_tool_steps
                );
                close_open_scope(sessions, entry, &reason)?;
                if !snapshot.inbox.next_turn.is_empty() {
                    continue;
                }
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
        }
        // A waiting tool/question can resume inside the already admitted Turn.
        if existing_scope.is_none()
            && started_turns >= config.max_turns_per_session
            && (!snapshot.inbox.next_turn.is_empty() || !snapshot.inbox.next_step.is_empty())
        {
            let reason = format!(
                "turnLimitExceeded: maximum {} Turns per Session",
                config.max_turns_per_session
            );
            sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
            entry.set_phase(AgentLifecyclePhase::Stopping)?;
            return Ok(AgentDriverSettlement::Failed);
        }

        // Descendant cancellation may still be joining. Never claim another
        // queued turn after the user has requested a stop.
        if existing_scope.is_none() && !entry.is_admitting() {
            return Ok(AgentDriverSettlement::Cancelled);
        }
        if existing_scope.is_none() && !sessions.has_ready_input(&entry.session_id)? {
            entry.set_phase(AgentLifecyclePhase::Idle)?;
            append_status(sessions, entry, AgentSessionStatus::Idle, None)?;
            return Ok(AgentDriverSettlement::Idle);
        }
        let mut prepared_model = entry.prepare_model()?;
        let (turn_id, step_id, mut step_index) = if let Some(AgentActiveScope {
            turn_id,
            step_id: Some(step_id),
        }) = existing_scope.clone()
        {
            let index = all_events
                .iter()
                .filter(|e| {
                    e.turn_id.as_deref() == Some(&turn_id)
                        && matches!(e.payload, AgentSessionEventPayload::StepStart)
                })
                .count();
            (turn_id, step_id, index)
        } else if let Some(AgentActiveScope {
            turn_id,
            step_id: None,
        }) = existing_scope
        {
            let step_index = sessions
                .all_events(&entry.session_id)?
                .iter()
                .filter(|event| {
                    event.turn_id.as_deref() == Some(&turn_id)
                        && matches!(event.payload, AgentSessionEventPayload::StepStart)
                })
                .count()
                .saturating_add(1);
            if let Some(limit) = config
                .max_steps_per_turn
                .filter(|limit| step_index > *limit)
            {
                let root_budget_boundary = entry.subagent.is_none();
                let reason = step_budget_reason(limit, root_budget_boundary);
                close_open_scope(sessions, entry, &reason)?;
                if root_budget_boundary {
                    continue;
                }
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
            let step_id = format!("step-{}", Uuid::new_v4().simple());
            if let Some(reason) = apply_pre_step_hooks(
                sessions,
                entry,
                hooks,
                tools,
                &prepared_model,
                compactions,
                &turn_id,
                &step_id,
                step_index,
                config.retry_policy,
            )
            .await?
            {
                close_open_scope(sessions, entry, &reason)?;
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
            entry.set_phase(AgentLifecyclePhase::Running)?;
            sessions.begin_continuation_step(
                &entry.session_id,
                turn_id.clone(),
                step_id.clone(),
            )?;
            (turn_id, step_id, step_index)
        } else {
            let turn_id = format!("turn-{}", Uuid::new_v4().simple());
            let step_id = format!("step-{}", Uuid::new_v4().simple());
            if let Some(reason) = apply_pre_step_hooks(
                sessions,
                entry,
                hooks,
                tools,
                &prepared_model,
                compactions,
                &turn_id,
                &step_id,
                1,
                config.retry_policy,
            )
            .await?
            {
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
            entry.set_phase(AgentLifecyclePhase::Running)?;
            let Some(_) =
                sessions.begin_turn_step(&entry.session_id, turn_id.clone(), step_id.clone())?
            else {
                entry.set_phase(AgentLifecyclePhase::Idle)?;
                append_status(sessions, entry, AgentSessionStatus::Idle, None)?;
                return Ok(AgentDriverSettlement::Idle);
            };
            append_status(sessions, entry, AgentSessionStatus::Running, None)?;
            (turn_id, step_id, 1)
        };
        entry.set_scope(Some(AgentActiveScope {
            turn_id: turn_id.clone(),
            step_id: Some(step_id.clone()),
        }))?;

        let mut current_step_id = step_id;
        loop {
            let (continue_after_tools, turn_end_reason) = match run_step(
                sessions,
                entry,
                tools,
                &prepared_model,
                compactions,
                &turn_id,
                &current_step_id,
                step_index,
                config,
            )
            .await?
            {
                StepSettlement::Completed => (false, "completed"),
                StepSettlement::Incomplete => (false, "incomplete"),
                StepSettlement::ToolsCompleted => (true, "completed"),
                StepSettlement::Waiting => return Ok(AgentDriverSettlement::Waiting),
                StepSettlement::Cancelled => {
                    close_open_scope(sessions, entry, "cancelled")?;
                    return Ok(AgentDriverSettlement::Cancelled);
                }
                StepSettlement::Failed(reason) => {
                    close_open_scope(sessions, entry, &reason)?;
                    sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                    entry.set_phase(AgentLifecyclePhase::Stopping)?;
                    return Ok(AgentDriverSettlement::Failed);
                }
            };

            if entry.cancellation().is_cancelled() {
                close_open_scope(sessions, entry, "cancelled")?;
                return Ok(AgentDriverSettlement::Cancelled);
            }
            if continue_after_tools
                && config.max_identical_tool_steps > 0
                && !sessions
                    .snapshot(&entry.session_id)?
                    .inbox
                    .next_step
                    .iter()
                    .any(|message| message.source.kind == super::AgentMessageSourceKind::User)
                && repeated_tool_step_streak(&sessions.all_events(&entry.session_id)?, &turn_id)
                    >= config.max_identical_tool_steps
            {
                let reason = format!(
                    "noProgress: {} repeated tool steps produced no new evidence",
                    config.max_identical_tool_steps
                );
                close_open_scope(sessions, entry, &reason)?;
                if !sessions
                    .snapshot(&entry.session_id)?
                    .inbox
                    .next_turn
                    .is_empty()
                {
                    break;
                }
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
            if !continue_after_tools
                && sessions.end_turn_if_no_step_input(
                    &entry.session_id,
                    &turn_id,
                    turn_end_reason,
                )?
            {
                entry.set_scope(None)?;
                break;
            }
            if let Some(limit) = config
                .max_steps_per_turn
                .filter(|limit| step_index >= *limit)
            {
                let root_budget_boundary = entry.subagent.is_none();
                let reason = step_budget_reason(limit, root_budget_boundary);
                close_open_scope(sessions, entry, &reason)?;
                if root_budget_boundary {
                    break;
                }
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
            step_index += 1;
            prepared_model = entry.prepare_model()?;
            current_step_id = format!("step-{}", Uuid::new_v4().simple());
            if let Some(reason) = apply_pre_step_hooks(
                sessions,
                entry,
                hooks,
                tools,
                &prepared_model,
                compactions,
                &turn_id,
                &current_step_id,
                step_index,
                config.retry_policy,
            )
            .await?
            {
                close_open_scope(sessions, entry, &reason)?;
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
            if continue_after_tools {
                sessions.begin_continuation_step(
                    &entry.session_id,
                    turn_id.clone(),
                    current_step_id.clone(),
                )?;
            } else if sessions
                .begin_step_or_end_turn(
                    &entry.session_id,
                    turn_id.clone(),
                    current_step_id.clone(),
                    turn_end_reason,
                )?
                .is_none()
            {
                // An operator may remove the final queued input while hooks
                // run. End atomically instead of running a nonexistent step.
                entry.set_scope(None)?;
                break;
            }
            entry.set_scope(Some(AgentActiveScope {
                turn_id: turn_id.clone(),
                step_id: Some(current_step_id.clone()),
            }))?;
        }
    }
}

fn step_budget_reason(limit: usize, recoverable: bool) -> String {
    if recoverable {
        format!("stepBudgetReached: maximum {} Steps per Turn", limit)
    } else {
        format!("stepLimitExceeded: maximum {} Steps per Turn", limit)
    }
}

async fn apply_pre_step_hooks(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    hooks: &AgentHookBus,
    tools: &AgentToolPipeline,
    model: &crate::llm::runtime::PreparedModel,
    compactions: &AgentCompactionManager,
    turn_id: &str,
    step_id: &str,
    step_index: usize,
    retry_policy: RetryPolicy,
) -> Result<Option<String>, String> {
    let compactions = compactions.clone().with_model(
        model.adapter.clone(),
        model.provider.clone(),
        model.provider.retry_policy.unwrap_or(retry_policy),
    );
    let snapshot = sessions.snapshot(&entry.session_id)?;
    let surface_generation = snapshot.surface.generation;
    let assembly = assemble_model_input(
        &snapshot.header,
        model_tools_for(
            entry,
            tools.terminal_interactive_tools_enabled(snapshot.header.target.as_ref()),
        ),
    );
    let mut request = ModelRequest::from_surface(
        "pre-step-budget".into(),
        &snapshot.surface,
        assembly.system_prompt,
        assembly.tools,
    );
    tools.apply_ephemeral_terminal_results(&entry.session_id, turn_id, &mut request)?;
    request.messages.extend(
        assembly
            .context
            .into_iter()
            .map(|injection| ModelMessage::User {
                content: injection.content,
            }),
    );
    let pending = if entry.scope()?.is_some() {
        snapshot.inbox.next_step
    } else {
        snapshot
            .inbox
            .next_turn
            .into_iter()
            .take(1)
            .chain(snapshot.inbox.next_step)
            .collect()
    };
    request
        .messages
        .extend(pending.into_iter().flat_map(|message| {
            let mut messages = Vec::with_capacity(2);
            if let Some(context) = message.terminal_context {
                messages.push(ModelMessage::User {
                    content: context.model_content(),
                });
            }
            messages.push(ModelMessage::User {
                content: message.content,
            });
            messages
        }));
    let budget = estimate_model_surface_budget(&model.provider, &request)?;
    let context = AgentPreStepContext {
        session_id: entry.session_id.clone(),
        turn_id: turn_id.to_string(),
        step_id: step_id.to_string(),
        step_index,
        surface_generation,
        budget: budget.clone(),
    };
    let decisions = hooks
        .pre_step(&context)
        .map_err(|error| format!("preStepHookFailed: {error}"))?;
    for decision in decisions {
        match decision {
            AgentPreStepDecision::Continue => {}
            #[cfg(test)]
            AgentPreStepDecision::Reject { reason } => {
                return Ok(Some(format!("preStepRejected: {reason}")))
            }
            #[cfg(test)]
            AgentPreStepDecision::AppendContext {
                message_id,
                label,
                content,
            } => {
                sessions.enqueue(
                    &entry.session_id,
                    AgentInboxLane::NextStep,
                    AgentInboxMessage {
                        images: Vec::new(),
                        message_id,
                        client_submission_id: None,
                        content,
                        source: AgentMessageSource::runtime(label),
                        terminal_context: None,
                    },
                )?;
            }
            AgentPreStepDecision::Compact { reason } => {
                let active_turn_id = entry.scope()?.map(|scope| scope.turn_id);
                let cancellation = entry.cancellation();
                compactions
                    .compact(
                        &entry.session_id,
                        turn_id,
                        step_id,
                        active_turn_id.as_deref(),
                        &reason,
                        &budget,
                        false,
                        &cancellation,
                    )
                    .await?;
            }
        }
    }
    Ok(None)
}

enum StepSettlement {
    Completed,
    Incomplete,
    ToolsCompleted,
    Waiting,
    Cancelled,
    Failed(String),
}

struct PendingRetry {
    previous_request_id: String,
    reason: String,
    plan: RetryPlan,
    error: Option<NormalizedModelError>,
    wait_for_network: bool,
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

fn model_block_has_output(block: &ModelContentBlock) -> bool {
    crate::llm::replay::model_block_has_output(block)
}

fn model_response_has_output(response: &ModelResponse) -> bool {
    response.content.iter().any(model_block_has_output)
}

fn empty_model_response_error() -> NormalizedModelError {
    let mut error = NormalizedModelError::new(
        NormalizedModelErrorKind::EmptyResponse,
        "AI provider completed without text, reasoning, or tool calls",
    );
    error.code = Some("EMPTY_RESPONSE".into());
    error
}

async fn run_step(
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
    let mut attempt = 1_u32;
    let mut request_reason = if step_index == 1 {
        AgentRequestReason::Initial
    } else {
        AgentRequestReason::ToolContinuation
    };
    let mut pending_retry: Option<PendingRetry> = None;
    let mut cumulative_delay_ms = 0_u64;
    let mut prepared_call: Option<crate::llm::runtime::PreparedCall> = None;
    let mut network_recovery_started_at: Option<Instant> = None;
    let mut network_recovery_round = 0_u32;
    loop {
        if entry.cancellation().is_cancelled() {
            return Ok(StepSettlement::Cancelled);
        }
        let task_events = sessions.all_events(&entry.session_id)?;
        if let Some(reason) = task_budget_failure(&task_events, config)? {
            return Ok(StepSettlement::Failed(reason));
        }
        let request_id = format!("request-{}", Uuid::new_v4().simple());
        if let Some(pending) = pending_retry.take() {
            if pending.wait_for_network {
                append_status(
                    sessions,
                    entry,
                    AgentSessionStatus::Waiting,
                    Some("waitingForNetwork".into()),
                )?;
            }
            cumulative_delay_ms = cumulative_delay_ms.saturating_add(pending.plan.delay_ms);
            let error_kind = pending
                .error
                .as_ref()
                .map(|error| format!("{:?}", error.kind).to_ascii_lowercase());
            let error_status = pending.error.as_ref().and_then(|error| error.status);
            let error_code = pending.error.as_ref().and_then(|error| error.code.clone());
            sessions.append(
                &entry.session_id,
                Some(turn_id.to_string()),
                Some(step_id.to_string()),
                AgentSessionEventPayload::RequestRetry {
                    request_id: request_id.clone(),
                    previous_request_id: Some(pending.previous_request_id),
                    attempt,
                    reason: pending.reason,
                    delay_ms: Some(pending.plan.delay_ms),
                    cumulative_delay_ms: Some(cumulative_delay_ms),
                    server_retry_after_ms: pending.plan.server_retry_after_ms,
                    server_hint_capped: pending.plan.server_hint_capped,
                    error_kind,
                    error_status,
                    error_code,
                },
            )?;
            if !super::cancellable_retry_delay(pending.plan.delay_ms, &entry.cancellation()).await {
                return Ok(StepSettlement::Cancelled);
            }
            if pending.wait_for_network {
                append_status(
                    sessions,
                    entry,
                    AgentSessionStatus::Running,
                    Some("networkRetry".into()),
                )?;
            }
        }
        let mut request = if let Some(call) = &prepared_call {
            call.request(request_id.clone())
        } else {
            let mut snapshot = sessions.snapshot(&entry.session_id)?;
            snapshot.header.permission_mode = permission_mode;
            let assembly = assemble_model_input(
                &snapshot.header,
                model_tools_for(
                    entry,
                    tools.terminal_interactive_tools_enabled(snapshot.header.target.as_ref()),
                ),
            );
            ensure_model_context(
                sessions,
                entry,
                turn_id,
                step_id,
                &snapshot.surface,
                &assembly,
            )?;
            tools.skills.prepare_step(entry, turn_id, step_id).await?;
            tools
                .skills
                .republish_if_missing(&entry.session_id, turn_id, step_id)?;
            let surface = sessions.model_surface(&entry.session_id)?;
            let mut request = ModelRequest::from_surface(
                request_id.clone(),
                &surface,
                assembly.system_prompt,
                assembly.tools,
            );
            if let Some(mut inherited) = sessions.inherited_surface(&entry.session_id)? {
                inherited.messages.retain(|message| {
                !matches!(
                    message,
                    super::AgentSurfaceMessage::User { source, .. }
                        if is_assembled_context_source(source) || source.producer_id == "shellspan.skills.v1"
                )
            });
                inherited.messages.retain(|m| !matches!(m, super::AgentSurfaceMessage::Tool { name, .. } if name == super::skills::SKILL_TOOL));
                for message in &mut inherited.messages {
                    if let super::AgentSurfaceMessage::Assistant { content, .. } = message {
                        content.retain(|b| !matches!(b, AgentAssistantContentBlock::ToolCall { call } if call.name == super::skills::SKILL_TOOL));
                    }
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
            tools.apply_ephemeral_terminal_results(&entry.session_id, turn_id, &mut request)?;
            request
        };
        let request_surface_generation = request.surface_generation;
        let budget = estimate_model_surface_budget(&model.provider, &request)?;
        if budget.requires_compaction() {
            let before = request.surface_generation;
            compactions
                .compact(
                    &entry.session_id,
                    turn_id,
                    step_id,
                    Some(turn_id),
                    "skillsInputBudget",
                    &budget,
                    false,
                    &entry.cancellation(),
                )
                .await?;
            if sessions.snapshot(&entry.session_id)?.surface.generation != before {
                continue;
            }
            if budget.estimated_input_tokens > budget.usable_input_tokens
                || budget.estimated_input_bytes > budget.maximum_input_bytes
            {
                return Ok(StepSettlement::Failed(
                    "complete Skill input exceeds model budget".into(),
                ));
            }
        }
        let projected_tokens = consumed_model_tokens(&sessions.all_events(&entry.session_id)?)
            .saturating_add(budget.estimated_input_tokens)
            .saturating_add(budget.output_reserve_tokens);
        if projected_tokens > config.max_model_tokens_per_session {
            return Ok(StepSettlement::Failed(format!(
                "taskTokenBudgetExceeded: maximum {} estimated model tokens",
                config.max_model_tokens_per_session
            )));
        }
        if prepared_call.is_none() {
            prepared_call = Some(model.prepare_request(request, "step", &entry.cancellation())?);
        }
        let call = prepared_call.as_ref().expect("prepared call");
        request = call.request(request_id.clone());
        let estimated_input_tokens = Some(budget.estimated_input_tokens);
        if entry.cancellation().is_cancelled() {
            return Ok(StepSettlement::Cancelled);
        }
        let mut request_events = super::request_log::request_events(
            &sessions.all_events(&entry.session_id)?,
            entry,
            &model.provider,
            &request,
            &call.snapshot,
            request_reason,
            attempt,
        )
        .into_iter()
        .map(|payload| AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload,
        })
        .collect::<Vec<_>>();
        request_events.push(AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: AgentSessionEventPayload::RequestContext {
                request_id: request_id.clone(),
                input_tokens: estimated_input_tokens,
                context_window: Some(budget.context_window),
                system_tokens: Some(budget.system_tokens),
                tool_schema_tokens: Some(budget.tool_schema_tokens),
                message_tokens: Some(budget.message_tokens),
                surface_generation: request.surface_generation,
                limited: None,
                omitted_messages: None,
            },
        });
        sessions.append_batch(&entry.session_id, request_events)?;
        let collected = Arc::new(Mutex::new(PartialContentAccumulator::default()));
        let cancellation = entry.cancellation();
        let sink: Arc<dyn ModelStreamSink> = Arc::new(DurableModelStreamSink {
            sessions: sessions.clone(),
            session_id: entry.session_id.clone(),
            turn_id: turn_id.to_string(),
            step_id: step_id.to_string(),
            request_id: request_id.clone(),
            collected: Arc::clone(&collected),
            cancellation: cancellation.clone(),
        });
        let remaining_active_ms = config
            .max_active_duration_ms
            .saturating_sub(active_duration_ms(
                &sessions.all_events(&entry.session_id)?,
                current_unix_ms()?,
            ));
        let remaining_network_ms = network_recovery_started_at.map_or(u64::MAX, |started| {
            config
                .network_recovery_window_ms
                .saturating_sub(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
        });
        let stream_limit_ms = remaining_active_ms
            .min(config.max_model_stream_duration_ms)
            .min(remaining_network_ms);
        let deadline_code = if remaining_network_ms <= remaining_active_ms
            && remaining_network_ms <= config.max_model_stream_duration_ms
        {
            "NETWORK_RECOVERY_TIMEOUT"
        } else if remaining_active_ms <= config.max_model_stream_duration_ms {
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
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(NormalizedModelError::cancelled()),
                result = tokio::time::timeout(
                    std::time::Duration::from_millis(stream_limit_ms),
                    call.stream(request_id.clone(), cancellation.clone(), sink),
                ) => match result {
                    Ok(response) => response,
                    Err(_) => Err(deadline_error()),
                },
            }
        };
        let response = match response {
            _ if cancellation.is_cancelled() => Err(NormalizedModelError::cancelled()),
            Ok(response) if !model_response_has_output(&response) => {
                Err(empty_model_response_error())
            }
            other => other,
        };
        match response {
            Ok(response) => {
                return commit_response(
                    sessions,
                    entry,
                    tools,
                    turn_id,
                    step_id,
                    &request_id,
                    response,
                )
                .await
            }
            Err(error) if error.kind == NormalizedModelErrorKind::Cancelled => {
                let (had_output, partial) = {
                    let collected = collected
                        .lock()
                        .map_err(|_| "model stream accumulator is unavailable".to_string())?;
                    (!collected.is_empty(), collected.content())
                };
                if had_output {
                    append_interrupted_message(
                        sessions,
                        entry,
                        turn_id,
                        step_id,
                        partial,
                        AgentStopReason::Cancelled,
                    )?;
                }
                return Ok(StepSettlement::Cancelled);
            }
            Err(error)
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
                        sessions,
                        entry,
                        turn_id,
                        step_id,
                        partial,
                        AgentStopReason::Other,
                    )?;
                }
                sessions.append(
                    &entry.session_id,
                    Some(turn_id.to_string()),
                    Some(step_id.to_string()),
                    request_failure_payload(
                        &request_id,
                        &error,
                        attempt,
                        config.retry_policy.max_attempts().max(attempt),
                        cumulative_delay_ms,
                        had_output,
                    ),
                )?;
                return Ok(StepSettlement::Failed(format!(
                    "{}: {}",
                    match error.code.as_deref() {
                        Some("TASK_ACTIVE_TIME_EXCEEDED") => "taskActiveTimeExceeded",
                        Some("NETWORK_RECOVERY_TIMEOUT") => "networkRecoveryTimeout",
                        _ => "modelStreamTotalTimeout",
                    },
                    error.message
                )));
            }
            Err(error)
                if error.kind == NormalizedModelErrorKind::ContextTooLarge
                    && attempt < config.retry_policy.max_attempts()
                    && collected
                        .lock()
                        .map_err(|_| "model stream accumulator is unavailable".to_string())?
                        .is_empty() =>
            {
                prepared_call = None;
                let before = request_surface_generation;
                sessions.append(
                    &entry.session_id,
                    Some(turn_id.to_string()),
                    Some(step_id.to_string()),
                    request_failure_payload(
                        &request_id,
                        &error,
                        attempt,
                        config.retry_policy.max_attempts().max(attempt),
                        cumulative_delay_ms,
                        false,
                    ),
                )?;
                let outcome = match compactions
                    .compact(
                        &entry.session_id,
                        turn_id,
                        step_id,
                        Some(turn_id),
                        "providerContextTooLarge",
                        &budget,
                        true,
                        &cancellation,
                    )
                    .await
                {
                    Ok(outcome) => outcome,
                    Err(_) if cancellation.is_cancelled() => return Ok(StepSettlement::Cancelled),
                    Err(compaction_error) => {
                        return Ok(StepSettlement::Failed(format!(
                            "contextTooLargeRecoveryFailed: {compaction_error}"
                        )))
                    }
                };
                if outcome.previous_generation != before || outcome.surface_generation <= before {
                    return Ok(StepSettlement::Failed(
                        "contextTooLargeRecoveryFailed: Model Surface generation did not advance"
                            .into(),
                    ));
                }
                pending_retry = Some(PendingRetry {
                    previous_request_id: request_id,
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
                attempt += 1;
                request_reason = AgentRequestReason::Recovery;
            }
            Err(error) if error.retryable() => {
                let network_failure = network_transport_failure(&error);
                if network_failure && network_recovery_started_at.is_none() {
                    network_recovery_started_at = Some(Instant::now());
                }
                let max_attempts = if network_failure {
                    config
                        .network_recovery_max_attempts
                        .max(config.retry_policy.max_attempts())
                } else {
                    config.retry_policy.max_attempts()
                }
                .max(attempt);
                let partial_is_empty = collected
                    .lock()
                    .map_err(|_| "model stream accumulator is unavailable".to_string())?
                    .is_empty();
                sessions.append(
                    &entry.session_id,
                    Some(turn_id.to_string()),
                    Some(step_id.to_string()),
                    request_failure_payload(
                        &request_id,
                        &error,
                        attempt,
                        max_attempts,
                        cumulative_delay_ms,
                        !partial_is_empty,
                    ),
                )?;
                if !cancellation.is_cancelled() {
                    let ordinary = config
                        .retry_policy
                        .plan(&error, attempt, retry_random_sample());
                    let recovery =
                        if ordinary.is_none() && network_failure && attempt < max_attempts {
                            network_recovery_started_at.and_then(|started| {
                                let remaining = config.network_recovery_window_ms.saturating_sub(
                                    u64::try_from(started.elapsed().as_millis())
                                        .unwrap_or(u64::MAX),
                                );
                                if remaining == 0 {
                                    return None;
                                }
                                let delay_ms = config
                                    .network_recovery_initial_delay_ms
                                    .saturating_mul(1_u64 << network_recovery_round.min(20))
                                    .min(config.network_recovery_max_delay_ms)
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
                        && attempt < max_attempts
                        && recovery.is_none()
                        && network_recovery_started_at.is_some_and(|started| {
                            u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
                                >= config.network_recovery_window_ms
                        });
                    if network_window_expired {
                        return Ok(StepSettlement::Failed(format!(
                            "networkRecoveryTimeout: model network recovery window of {} ms expired",
                            config.network_recovery_window_ms
                        )));
                    }
                    let wait_for_network = recovery.is_some();
                    if let Some(plan) = ordinary.or(recovery) {
                        pending_retry = Some(PendingRetry {
                            previous_request_id: request_id,
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
                            network_recovery_round = network_recovery_round.saturating_add(1);
                        }
                        attempt += 1;
                        request_reason = AgentRequestReason::Retry;
                        continue;
                    }
                }
                if cancellation.is_cancelled() {
                    return Ok(StepSettlement::Cancelled);
                }
                return Ok(StepSettlement::Failed(model_error_reason(
                    &error,
                    attempt,
                    max_attempts,
                    cumulative_delay_ms,
                )));
            }
            Err(error) => {
                let had_output = {
                    let collected = collected
                        .lock()
                        .map_err(|_| "model stream accumulator is unavailable".to_string())?;
                    !collected.is_empty()
                };
                sessions.append(
                    &entry.session_id,
                    Some(turn_id.to_string()),
                    Some(step_id.to_string()),
                    request_failure_payload(
                        &request_id,
                        &error,
                        attempt,
                        config.retry_policy.max_attempts().max(attempt),
                        cumulative_delay_ms,
                        had_output,
                    ),
                )?;
                return Ok(StepSettlement::Failed(model_error_reason(
                    &error,
                    attempt,
                    config.retry_policy.max_attempts().max(attempt),
                    cumulative_delay_ms,
                )));
            }
        }
    }
}

fn is_assembled_context_source(source: &super::AgentMessageSource) -> bool {
    matches!(
        source.producer_id.as_str(),
        "shellspan.runtime-context.v1" | "shellspan.agent-instructions.v1"
    )
}

fn ensure_model_context(
    sessions: &AgentSessionStore,
    entry: &AgentEntry,
    turn_id: &str,
    step_id: &str,
    surface: &super::AgentSurfaceSnapshot,
    assembly: &super::ModelInputAssembly,
) -> Result<(), String> {
    let payloads = assembly
        .context
        .iter()
        .filter(|injection| {
            surface
                .messages
                .iter()
                .rev()
                .find_map(|message| match message {
                    super::AgentSurfaceMessage::User {
                        source, content, ..
                    } if source.producer_id == injection.source.producer_id => Some(content),
                    _ => None,
                })
                != Some(&injection.content)
        })
        .cloned()
        .map(|injection| AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: AgentSessionEventPayload::UserMessage {
                message: injection.into_message(format!("message-{}", Uuid::new_v4().simple())),
            },
        })
        .collect::<Vec<_>>();
    if !payloads.is_empty() {
        sessions.append_batch(&entry.session_id, payloads)?;
    }
    Ok(())
}

fn model_tools_for(
    entry: &AgentEntry,
    interactive_terminal_enabled: bool,
) -> Vec<super::ModelToolDefinition> {
    let tools = model_tools_with_terminal_interaction(interactive_terminal_enabled);
    let Some(scope) = &entry.capability_scope else {
        return tools;
    };
    tools
        .into_iter()
        // Human input has its own live-root admission boundary, independent of
        // historical native capability scopes retained by a resumed root.
        .filter(|tool| {
            tool.name == super::user_questions::TOOL_NAME
                || scope.tool_names.iter().any(|name| name == &tool.name)
        })
        .collect()
}

fn current_unix_ms() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch".to_string())?
        .as_millis() as u64)
}

fn current_task_events(events: &[super::AgentSessionEvent]) -> &[super::AgentSessionEvent] {
    let start = events
        .iter()
        .rposition(|event| matches!(event.payload, AgentSessionEventPayload::SessionResumed {}))
        .map_or(0, |index| index + 1);
    &events[start..]
}

fn consumed_model_tokens(events: &[super::AgentSessionEvent]) -> u64 {
    current_task_events(events)
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::RequestContext { input_tokens, .. } => *input_tokens,
            AgentSessionEventPayload::RequestUsage { usage, .. } => usage.output_tokens,
            _ => None,
        })
        .fold(0_u64, u64::saturating_add)
}

fn active_duration_ms(events: &[super::AgentSessionEvent], now: u64) -> u64 {
    let mut running_since = None;
    let mut total = 0_u64;
    for event in current_task_events(events) {
        if let AgentSessionEventPayload::AgentStatus { status, .. } = event.payload {
            if status == AgentSessionStatus::Running {
                running_since.get_or_insert(event.time_unix_ms);
            } else if let Some(start) = running_since.take() {
                total = total.saturating_add(event.time_unix_ms.saturating_sub(start));
            }
        }
    }
    if let Some(start) = running_since {
        total = total.saturating_add(now.saturating_sub(start));
    }
    total
}

fn task_budget_failure(
    events: &[super::AgentSessionEvent],
    config: AgentDriverConfig,
) -> Result<Option<String>, String> {
    if consumed_model_tokens(events) >= config.max_model_tokens_per_session {
        return Ok(Some(format!(
            "taskTokenBudgetExceeded: maximum {} estimated model tokens",
            config.max_model_tokens_per_session
        )));
    }
    if active_duration_ms(events, current_unix_ms()?) >= config.max_active_duration_ms {
        return Ok(Some(format!(
            "taskActiveTimeExceeded: maximum {} active ms",
            config.max_active_duration_ms
        )));
    }
    Ok(None)
}

fn repeated_tool_step_streak(events: &[super::AgentSessionEvent], turn_id: &str) -> usize {
    let mut signatures = Vec::new();
    for event in events.iter().rev() {
        if event.turn_id.as_deref() != Some(turn_id) {
            continue;
        }
        let AgentSessionEventPayload::StepEnd { reason } = &event.payload else {
            continue;
        };
        if reason != "toolsCompleted" {
            break;
        }
        let Some(step_id) = event.step_id.as_deref() else {
            break;
        };
        let Some((signature, had_user_or_plan)) = tool_step_signature(events, step_id) else {
            break;
        };
        signatures.push(signature);
        if had_user_or_plan {
            break;
        }
    }
    let mut longest = 0;
    for period in 1..=3.min(signatures.len() / 2) {
        let count = signatures
            .iter()
            .enumerate()
            .take_while(|(index, signature)| *signature == &signatures[index % period])
            .count();
        if count >= 2 * period {
            longest = longest.max(count);
        }
    }
    longest.max(signatures.len().min(1))
}

fn tool_step_signature(
    events: &[super::AgentSessionEvent],
    step_id: &str,
) -> Option<(Vec<serde_json::Value>, bool)> {
    let step_events = events
        .iter()
        .filter(|event| event.step_id.as_deref() == Some(step_id))
        .collect::<Vec<_>>();
    let had_user_or_plan = step_events.iter().any(|event| match &event.payload {
        AgentSessionEventPayload::UserMessage { message } => {
            message.source.kind == super::AgentMessageSourceKind::User
        }
        AgentSessionEventPayload::TaskPlan { .. }
        | AgentSessionEventPayload::TaskEvidence { .. } => true,
        AgentSessionEventPayload::ToolApproval {
            status: super::AgentToolApprovalStatus::Approved,
            approval_id: Some(_),
            ..
        }
        | AgentSessionEventPayload::QuestionAnswered { .. } => true,
        _ => false,
    });
    let mut signature = Vec::new();
    for event in &step_events {
        let AgentSessionEventPayload::ToolCall { call } = &event.payload else {
            continue;
        };
        let result = step_events
            .iter()
            .find_map(|candidate| match &candidate.payload {
                AgentSessionEventPayload::ToolResult {
                    call_id,
                    name,
                    status,
                    summary,
                    data,
                    ..
                } if call_id == &call.call_id => Some((name, status, summary, data)),
                _ => None,
            })?;
        signature.push(serde_json::json!([
            call.name,
            call.arguments,
            call.target.as_ref().map(|target| &target.target_id),
            result.0,
            result.1,
            result.2,
            result.3.as_ref().map(normalize_tool_data),
        ]));
    }
    (!signature.is_empty()).then_some((signature, had_user_or_plan))
}

fn normalize_tool_data(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(fields) => serde_json::Value::Object(
            fields
                .iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "callId"
                            | "processHandle"
                            | "durationMs"
                            | "startedAtUnixMs"
                            | "completedAtUnixMs"
                    )
                })
                .map(|(key, value)| (key.clone(), normalize_tool_data(value)))
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(normalize_tool_data).collect())
        }
        _ => value.clone(),
    }
}

fn subagent_budget_failure(
    entry: &AgentEntry,
    events: &[super::AgentSessionEvent],
) -> Result<Option<String>, String> {
    let Some(subagent) = &entry.subagent else {
        return Ok(None);
    };
    let tool_calls = super::tool_pipeline::admitted_tool_calls(events);
    if tool_calls > subagent.budget.max_tool_calls {
        return Ok(Some(format!(
            "subagentToolBudgetExceeded: maximum {} calls",
            subagent.budget.max_tool_calls
        )));
    }
    let tokens = events
        .iter()
        .filter_map(|event| match event.payload {
            AgentSessionEventPayload::RequestUsage { usage, .. } => usage.total_tokens,
            _ => None,
        })
        .fold(0_u64, u64::saturating_add);
    if tokens > subagent.budget.max_tokens {
        return Ok(Some(format!(
            "subagentTokenBudgetExceeded: maximum {} tokens",
            subagent.budget.max_tokens
        )));
    }
    let created = events
        .first()
        .map(|event| event.time_unix_ms)
        .ok_or_else(|| "subagent Session log is empty".to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch".to_string())?
        .as_millis() as u64;
    if now.saturating_sub(created) > subagent.budget.timeout_ms {
        return Ok(Some(format!(
            "subagentTimeout: maximum {} ms",
            subagent.budget.timeout_ms
        )));
    }
    Ok(None)
}

async fn commit_response(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    tools: &AgentToolPipeline,
    turn_id: &str,
    step_id: &str,
    request_id: &str,
    response: ModelResponse,
) -> Result<StepSettlement, String> {
    if entry.cancellation().is_cancelled() {
        return Ok(StepSettlement::Cancelled);
    }
    let ModelResponse {
        content: model_content,
        finish_reason,
        usage: model_usage,
        replay: _,
        replay_envelope,
    } = response;
    let replay = replay_envelope.ok_or_else(|| {
        "REPLAY_CAPTURE_MISSING: successful prepared response has no replay envelope".to_string()
    })?;
    // Providers may emit whitespace-only text beside valid reasoning/tool calls.
    // Drop only empty blocks before durable validation; retain all whitespace in
    // meaningful content, including code and formatted answers.
    let model_content = model_content
        .into_iter()
        .filter(model_block_has_output)
        .collect::<Vec<_>>();
    if model_content.is_empty() {
        return Ok(StepSettlement::Failed(
            "emptyResponse: AI provider returned no text or tool calls".into(),
        ));
    }
    if finish_reason == ModelFinishReason::Length {
        return Ok(StepSettlement::Failed(
            "outputLimit: AI provider reached its output token limit".into(),
        ));
    }
    let model_tool_calls = model_content
        .iter()
        .filter_map(|block| match block {
            ModelContentBlock::ToolCall { call } => Some(call.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let tool_calls = model_tool_calls
        .iter()
        .cloned()
        .map(recorded_tool_call)
        .collect::<Vec<_>>();
    let has_ephemeral_tool_arguments = model_tool_calls
        .iter()
        .any(|call| super::model::tool_call_arguments_are_ephemeral(&call.name, &call.arguments));
    let usage = token_usage(model_usage);
    let stop_reason = stop_reason(finish_reason);
    // The Assistant event and its replay envelope bind the same redacted
    // projection. Raw tool arguments remain above for policy/collision checks.
    let committed_model_content = crate::llm::replay::committed_model_content(&model_content)
        .map_err(crate::llm::replay::replay_error_string)?;
    let content = committed_model_content
        .into_iter()
        .map(|block| match block {
            ModelContentBlock::Text { text } => AgentAssistantContentBlock::Text { text },
            ModelContentBlock::Reasoning { text, .. } => AgentAssistantContentBlock::Reasoning {
                text,
                provider_item: None,
            },
            ModelContentBlock::ToolCall { call } => AgentAssistantContentBlock::ToolCall {
                call: Box::new(recorded_tool_call(call)),
            },
        })
        .collect();
    let message_id = format!("message-{}", Uuid::new_v4().simple());
    let mut assistant_payload = AgentSessionEventPayload::AssistantMessage {
        message_id,
        content,
        usage,
        stop_reason,
        interrupted: false,
        replay: (!has_ephemeral_tool_arguments)
            .then(|| super::AgentStoredReplay::inline(replay.clone())),
    };
    if !super::event_payload_fits_storage_boundary(
        &entry.session_id,
        Some(turn_id),
        Some(step_id),
        &assistant_payload,
    )? && !has_ephemeral_tool_arguments
    {
        let stored = tools.store_replay_artifact(&entry.session_id, &replay)?;
        let AgentSessionEventPayload::AssistantMessage {
            replay: destination,
            ..
        } = &mut assistant_payload
        else {
            unreachable!("assistant payload remains an assistant message");
        };
        *destination = Some(stored);
    }
    if !super::event_payload_fits_storage_boundary(
        &entry.session_id,
        Some(turn_id),
        Some(step_id),
        &assistant_payload,
    )? {
        return Err(
            "assistantResponseTooLarge: assistant content exceeds the durable event boundary"
                .into(),
        );
    }
    let mut payloads = vec![
        AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: assistant_payload,
        },
        AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: AgentSessionEventPayload::RequestUsage {
                request_id: request_id.to_string(),
                usage,
                finish_reason: stop_reason,
            },
        },
    ];
    if entry.cancellation().is_cancelled() {
        return Ok(StepSettlement::Cancelled);
    }
    if tool_calls.is_empty() {
        let events = sessions.all_events(&entry.session_id)?;
        let incomplete = incomplete_plan_for_turn(&events, turn_id);
        let checked = events.iter().any(|event| {
            event.turn_id.as_deref() == Some(turn_id)
                && matches!(&event.payload, AgentSessionEventPayload::StepEnd { reason } if reason == "completionCheck")
        });
        if incomplete && !checked {
            payloads.push(AgentScopedPayload {
                turn_id: Some(turn_id.to_string()),
                step_id: Some(step_id.to_string()),
                payload: AgentSessionEventPayload::UserMessage {
                    message: super::AgentInboxMessage {
                        images: Vec::new(),
                        message_id: format!("message-{}", Uuid::new_v4().simple()),
                        client_submission_id: None,
                        content: "The recorded task plan still has unfinished steps. Continue the task with the available tools, update the plan when work is done, or clearly explain what blocks completion. Do not claim the task is complete while plan steps remain open.".into(),
                        source: super::AgentMessageSource::runtime("completion-check".into()),
                        terminal_context: None,
                    },
                },
            });
        }
        payloads.push(AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: AgentSessionEventPayload::StepEnd {
                reason: if incomplete {
                    if checked {
                        "incomplete"
                    } else {
                        "completionCheck"
                    }
                } else {
                    "completed"
                }
                .into(),
            },
        });
        sessions.append_batch(&entry.session_id, payloads)?;
        entry.set_scope(Some(AgentActiveScope {
            turn_id: turn_id.to_string(),
            step_id: None,
        }))?;
        return Ok(if incomplete {
            if checked {
                StepSettlement::Incomplete
            } else {
                StepSettlement::ToolsCompleted
            }
        } else {
            StepSettlement::Completed
        });
    }

    sessions.append_batch(&entry.session_id, payloads)?;
    match tools
        .process_model_calls(entry, turn_id, step_id, request_id, model_tool_calls)
        .await?
    {
        ToolPipelineSettlement::Completed => Ok(StepSettlement::ToolsCompleted),
        ToolPipelineSettlement::Waiting => Ok(StepSettlement::Waiting),
        ToolPipelineSettlement::Cancelled => Ok(StepSettlement::Cancelled),
    }
}

pub(super) fn incomplete_plan_for_turn(events: &[super::AgentSessionEvent], turn_id: &str) -> bool {
    events
        .iter()
        .rev()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::TaskPlan { steps, .. }
                if event.turn_id.as_deref() == Some(turn_id) =>
            {
                Some(
                    steps
                        .iter()
                        .any(|step| step.status != super::AgentPlanStepStatus::Completed),
                )
            }
            _ => None,
        })
        .unwrap_or(false)
}

fn append_interrupted_message(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    turn_id: &str,
    step_id: &str,
    partial: Vec<AgentAssistantContentBlock>,
    stop_reason: AgentStopReason,
) -> Result<(), String> {
    sessions.append(
        &entry.session_id,
        Some(turn_id.to_string()),
        Some(step_id.to_string()),
        AgentSessionEventPayload::AssistantMessage {
            message_id: format!("message-{}", Uuid::new_v4().simple()),
            content: partial,
            usage: AgentTokenUsage::default(),
            stop_reason,
            interrupted: true,
            replay: None,
        },
    )?;
    Ok(())
}

fn token_usage(usage: super::ModelUsage) -> AgentTokenUsage {
    AgentTokenUsage {
        uncached_input_tokens: usage.uncached_input_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        output_tokens: usage.output_tokens,
        reasoning_tokens: usage.reasoning_tokens,
        total_tokens: usage.total_tokens,
    }
}

fn stop_reason(reason: ModelFinishReason) -> AgentStopReason {
    match reason {
        ModelFinishReason::Stop => AgentStopReason::Stop,
        ModelFinishReason::ToolCalls => AgentStopReason::ToolCalls,
        ModelFinishReason::Length => AgentStopReason::Length,
        ModelFinishReason::ContentFilter => AgentStopReason::ContentFilter,
        ModelFinishReason::Other => AgentStopReason::Other,
    }
}

pub(crate) fn close_open_scope(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    reason: &str,
) -> Result<(), String> {
    let Some(scope) = entry.scope()? else {
        return Ok(());
    };
    let mut payloads = Vec::new();
    if let Some(step_id) = scope.step_id {
        payloads.push(AgentScopedPayload {
            turn_id: Some(scope.turn_id.clone()),
            step_id: Some(step_id),
            payload: AgentSessionEventPayload::StepEnd {
                reason: reason.to_string(),
            },
        });
    }
    payloads.push(AgentScopedPayload {
        turn_id: Some(scope.turn_id),
        step_id: None,
        payload: AgentSessionEventPayload::TurnEnd {
            reason: reason.to_string(),
        },
    });
    sessions.append_batch(&entry.session_id, payloads)?;
    entry.set_scope(None)
}

fn append_status(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    status: AgentSessionStatus,
    reason: Option<String>,
) -> Result<(), String> {
    let snapshot = sessions.snapshot(&entry.session_id)?;
    if snapshot.status == status {
        return Ok(());
    }
    sessions.append(
        &entry.session_id,
        None,
        None,
        AgentSessionEventPayload::AgentStatus { status, reason },
    )?;
    Ok(())
}

fn request_failure_payload(
    request_id: &str,
    error: &NormalizedModelError,
    attempt: u32,
    max_attempts: u32,
    cumulative_delay_ms: u64,
    interrupted: bool,
) -> AgentSessionEventPayload {
    AgentSessionEventPayload::RequestFailure {
        request_id: request_id.to_string(),
        attempt,
        max_attempts,
        cumulative_delay_ms,
        interrupted,
        failure: error.clone(),
    }
}

fn model_error_reason(
    error: &NormalizedModelError,
    attempt: u32,
    max_attempts: u32,
    cumulative_delay_ms: u64,
) -> String {
    let prefix = if error.code.as_deref() == Some("OUTPUT_LIMIT") {
        "outputLimit"
    } else {
        match error.kind {
            NormalizedModelErrorKind::Cancelled => "cancelled",
            NormalizedModelErrorKind::Retryable
            | NormalizedModelErrorKind::Transport
            | NormalizedModelErrorKind::Timeout
            | NormalizedModelErrorKind::EmptyResponse => "providerRetryExhausted",
            NormalizedModelErrorKind::Protocol => "providerProtocolFailure",
            NormalizedModelErrorKind::ContextTooLarge => "contextTooLarge",
            NormalizedModelErrorKind::Authentication => "authenticationFailed",
            NormalizedModelErrorKind::RateLimited => "rateLimited",
            NormalizedModelErrorKind::Terminal => "providerFailure",
        }
    };
    format!(
        "{prefix}: attempt={attempt} maxAttempts={max_attempts} cumulativeDelayMs={cumulative_delay_ms} kind={:?} status={} code={} message={}",
        error.kind,
        error
            .status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "none".into()),
        error.code.as_deref().unwrap_or("none"),
        error.message
    )
}

enum PartialContentBlock {
    Text(String),
    Reasoning(String),
}

#[derive(Default)]
struct PartialContentAccumulator {
    blocks: BTreeMap<u32, PartialContentBlock>,
    has_output: bool,
}

impl PartialContentAccumulator {
    fn push_text(&mut self, index: u32, text: &str) {
        self.has_output = true;
        match self
            .blocks
            .entry(index)
            .or_insert_with(|| PartialContentBlock::Text(String::new()))
        {
            PartialContentBlock::Text(value) => value.push_str(text),
            PartialContentBlock::Reasoning(_) => {}
        }
    }

    fn push_reasoning(&mut self, index: u32, text: &str) {
        self.has_output = true;
        match self
            .blocks
            .entry(index)
            .or_insert_with(|| PartialContentBlock::Reasoning(String::new()))
        {
            PartialContentBlock::Reasoning(value) => value.push_str(text),
            PartialContentBlock::Text(_) => {}
        }
    }

    fn mark_output(&mut self) {
        self.has_output = true;
    }

    fn is_empty(&self) -> bool {
        !self.has_output
    }

    fn content(&self) -> Vec<AgentAssistantContentBlock> {
        self.blocks
            .values()
            .filter_map(|block| match block {
                PartialContentBlock::Text(text) if !text.trim().is_empty() => {
                    Some(AgentAssistantContentBlock::Text { text: text.clone() })
                }
                PartialContentBlock::Reasoning(text) if !text.trim().is_empty() => {
                    Some(AgentAssistantContentBlock::Reasoning {
                        text: text.clone(),
                        provider_item: None,
                    })
                }
                _ => None,
            })
            .collect()
    }
}

struct DurableModelStreamSink {
    sessions: AgentSessionStore,
    session_id: String,
    turn_id: String,
    step_id: String,
    request_id: String,
    collected: Arc<Mutex<PartialContentAccumulator>>,
    cancellation: tokio_util::sync::CancellationToken,
}

fn utf8_chunks(value: &str, max_bytes: usize) -> Vec<&str> {
    assert!(
        max_bytes >= 4,
        "UTF-8 chunk limits must fit one scalar value"
    );
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = (start + max_bytes).min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&value[start..end]);
        start = end;
    }
    chunks
}

impl ModelStreamSink for DurableModelStreamSink {
    fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
        if self.cancellation.is_cancelled() {
            return Err(NormalizedModelError::cancelled());
        }
        match delta {
            StreamDelta::Text { index, text } => {
                for chunk in utf8_chunks(&text, MAX_AGENT_STREAM_DELTA_BYTES) {
                    if self.cancellation.is_cancelled() {
                        return Err(NormalizedModelError::cancelled());
                    }
                    self.sessions
                        .append(
                            &self.session_id,
                            Some(self.turn_id.clone()),
                            Some(self.step_id.clone()),
                            AgentSessionEventPayload::AssistantChunk {
                                request_id: self.request_id.clone(),
                                text_delta: Some(chunk.to_owned()),
                                reasoning_delta: None,
                                tool_call_delta: None,
                                usage: None,
                            },
                        )
                        .map_err(|error| {
                            NormalizedModelError::new(
                                NormalizedModelErrorKind::Terminal,
                                format!("failed to commit model stream chunk: {error}"),
                            )
                        })?;
                    self.collected
                        .lock()
                        .map_err(|_| {
                            NormalizedModelError::new(
                                NormalizedModelErrorKind::Terminal,
                                "model stream accumulator is unavailable",
                            )
                        })?
                        .push_text(index, chunk);
                }
            }
            StreamDelta::Reasoning { index, text } => {
                for chunk in utf8_chunks(&text, MAX_AGENT_STREAM_DELTA_BYTES) {
                    if self.cancellation.is_cancelled() {
                        return Err(NormalizedModelError::cancelled());
                    }
                    self.sessions
                        .append(
                            &self.session_id,
                            Some(self.turn_id.clone()),
                            Some(self.step_id.clone()),
                            AgentSessionEventPayload::AssistantChunk {
                                request_id: self.request_id.clone(),
                                text_delta: None,
                                reasoning_delta: Some(chunk.to_owned()),
                                tool_call_delta: None,
                                usage: None,
                            },
                        )
                        .map_err(|error| {
                            NormalizedModelError::new(
                                NormalizedModelErrorKind::Terminal,
                                format!("failed to commit model reasoning chunk: {error}"),
                            )
                        })?;
                    self.collected
                        .lock()
                        .map_err(|_| {
                            NormalizedModelError::new(
                                NormalizedModelErrorKind::Terminal,
                                "model stream accumulator is unavailable",
                            )
                        })?
                        .push_reasoning(index, chunk);
                }
            }
            StreamDelta::ToolCall {
                index,
                call_id,
                name_delta,
                arguments_delta,
            } => {
                let argument_chunks = arguments_delta
                    .as_deref()
                    .map(|arguments| utf8_chunks(arguments, MAX_AGENT_STREAM_DELTA_BYTES))
                    .unwrap_or_default();
                let chunk_count = argument_chunks.len().max(1);
                for position in 0..chunk_count {
                    if self.cancellation.is_cancelled() {
                        return Err(NormalizedModelError::cancelled());
                    }
                    self.sessions
                        .append(
                            &self.session_id,
                            Some(self.turn_id.clone()),
                            Some(self.step_id.clone()),
                            AgentSessionEventPayload::AssistantChunk {
                                request_id: self.request_id.clone(),
                                text_delta: None,
                                reasoning_delta: None,
                                tool_call_delta: Some(AgentToolCallDelta {
                                    index,
                                    call_id: if position == 0 { call_id.clone() } else { None },
                                    name_delta: if position == 0 {
                                        name_delta.clone()
                                    } else {
                                        None
                                    },
                                    arguments_delta: argument_chunks
                                        .get(position)
                                        .map(|chunk| (*chunk).to_owned()),
                                }),
                                usage: None,
                            },
                        )
                        .map_err(|error| {
                            NormalizedModelError::new(
                                NormalizedModelErrorKind::Terminal,
                                format!("failed to commit model tool-call chunk: {error}"),
                            )
                        })?;
                    self.collected
                        .lock()
                        .map_err(|_| {
                            NormalizedModelError::new(
                                NormalizedModelErrorKind::Terminal,
                                "model stream accumulator is unavailable",
                            )
                        })?
                        .mark_output();
                }
            }
            StreamDelta::Usage { usage } => {
                self.sessions
                    .append(
                        &self.session_id,
                        Some(self.turn_id.clone()),
                        Some(self.step_id.clone()),
                        AgentSessionEventPayload::AssistantChunk {
                            request_id: self.request_id.clone(),
                            text_delta: None,
                            reasoning_delta: None,
                            tool_call_delta: None,
                            usage: Some(token_usage(usage)),
                        },
                    )
                    .map_err(|error| {
                        NormalizedModelError::new(
                            NormalizedModelErrorKind::Terminal,
                            format!("failed to commit model usage update: {error}"),
                        )
                    })?;
            }
        }
        Ok(())
    }
}

pub(crate) fn recover_open_scope(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
) -> Result<(), String> {
    let events = sessions.all_events(&entry.session_id)?;
    let mut turn_id = None;
    let mut step_id = None;
    for event in events {
        match event.payload {
            AgentSessionEventPayload::TurnStart => turn_id = event.turn_id,
            AgentSessionEventPayload::TurnEnd { .. }
            | AgentSessionEventPayload::SessionResumed {} => {
                turn_id = None;
                step_id = None;
            }
            AgentSessionEventPayload::StepStart => step_id = event.step_id,
            AgentSessionEventPayload::StepEnd { .. } => step_id = None,
            _ => {}
        }
    }
    let Some(turn_id) = turn_id else {
        return Ok(());
    };
    entry.set_scope(Some(AgentActiveScope {
        turn_id,
        step_id: step_id.clone(),
    }))?;
    let events = sessions.all_events(&entry.session_id)?;
    if let Some(step_id) = step_id.as_deref() {
        let step_events: Vec<_> = events
            .iter()
            .filter(|e| e.step_id.as_deref() == Some(step_id))
            .collect();
        if step_events
            .iter()
            .any(|e| matches!(e.payload, AgentSessionEventPayload::StepInputClaim { .. }))
            && !step_events.iter().any(|e| {
                matches!(
                    e.payload,
                    AgentSessionEventPayload::AssistantMessage { .. }
                        | AgentSessionEventPayload::ToolCall { .. }
                )
            })
        {
            entry.set_phase(AgentLifecyclePhase::Running)?;
            return Ok(());
        }
    }
    if entry.phase()? == AgentLifecyclePhase::Waiting
        || super::skill_runtime::resumable_skill_queue(&events).is_some()
    {
        return Ok(());
    }
    let reason = "runtimeRestarted: an in-flight Model Step was not replayed";
    close_open_scope(sessions, entry, reason)?;
    sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason.into())?;
    entry.set_phase(AgentLifecyclePhase::Stopping)?;
    Err(reason.into())
}

#[cfg(test)]
mod tests {
    include!("tests/driver.rs");
}
