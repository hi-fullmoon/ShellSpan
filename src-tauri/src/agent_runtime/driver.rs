use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use super::{
    assemble_model_input, default_model_tools, estimate_model_surface_budget, recorded_tool_call,
    AgentActiveScope, AgentAssistantContentBlock, AgentCompactionManager, AgentEntry, AgentHookBus,
    AgentLifecyclePhase, AgentPreStepContext, AgentPreStepDecision, AgentRequestReason,
    AgentScopedPayload, AgentSessionEventPayload, AgentSessionStatus,
    AgentSessionStore, AgentStopReason, AgentTokenUsage, AgentToolCallDelta, AgentToolPipeline,
    ModelContentBlock, ModelFinishReason, ModelMessage, ModelRequest, ModelResponse,
    ModelStreamSink, NormalizedModelError, NormalizedModelErrorKind, RetryPlan, RetryPolicy,
    StreamDelta, ToolPipelineSettlement, MAX_AGENT_STREAM_DELTA_BYTES,
};

#[cfg(test)]
use super::{AgentInboxLane, AgentInboxMessage, AgentMessageSource};

#[derive(Debug, Clone, Copy)]
pub(crate) struct AgentDriverConfig {
    pub(crate) max_steps_per_turn: usize,
    pub(crate) max_turns_per_session: usize,
    pub(crate) retry_policy: RetryPolicy,
}

impl Default for AgentDriverConfig {
    fn default() -> Self {
        Self {
            max_steps_per_turn: 8,
            max_turns_per_session: 64,
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
    // The entry owns an immutable Provider snapshot for this drive and its children.
    let config = AgentDriverConfig {
        retry_policy: entry.provider.retry_policy.unwrap_or(config.retry_policy),
        ..config
    };
    let compactions = compactions.with_model(
        entry.adapter.clone(),
        entry.provider.clone(),
        config.retry_policy,
    );
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
            max_steps_per_turn: config
                .max_steps_per_turn
                .min(subagent.budget.max_steps_per_turn as usize),
            max_turns_per_session: config
                .max_turns_per_session
                .min(subagent.budget.max_turns as usize),
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
        let all_events = sessions.all_events(&entry.session_id)?;
        if let Some(reason) = subagent_budget_failure(entry, &all_events)? {
            close_open_scope(sessions, entry, &reason)?;
            sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
            entry.set_phase(AgentLifecyclePhase::Stopping)?;
            return Ok(AgentDriverSettlement::Failed);
        }
        let completed_turns = all_events
            .iter()
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
            .count();
        let snapshot = sessions.snapshot(&entry.session_id)?;
        if completed_turns >= config.max_turns_per_session
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

        let existing_scope = entry.scope()?;
        let (turn_id, step_id, mut step_index) = if let Some(AgentActiveScope {
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
            if step_index > config.max_steps_per_turn {
                let reason = format!(
                    "stepLimitExceeded: maximum {} Steps per Turn",
                    config.max_steps_per_turn
                );
                close_open_scope(sessions, entry, &reason)?;
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
            let step_id = format!("step-{}", Uuid::new_v4().simple());
            if let Some(reason) = apply_pre_step_hooks(
                sessions,
                entry,
                hooks,
                compactions,
                &turn_id,
                &step_id,
                step_index,
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
            if snapshot.inbox.next_turn.is_empty() && snapshot.inbox.next_step.is_empty() {
                entry.set_phase(AgentLifecyclePhase::Idle)?;
                append_status(sessions, entry, AgentSessionStatus::Idle, None)?;
                return Ok(AgentDriverSettlement::Idle);
            }
            let turn_id = format!("turn-{}", Uuid::new_v4().simple());
            let step_id = format!("step-{}", Uuid::new_v4().simple());
            if let Some(reason) =
                apply_pre_step_hooks(sessions, entry, hooks, compactions, &turn_id, &step_id, 1)
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
            let continue_after_tools = match run_step(
                sessions,
                entry,
                tools,
                compactions,
                &turn_id,
                &current_step_id,
                step_index,
                config,
            )
            .await?
            {
                StepSettlement::Completed => false,
                StepSettlement::ToolsCompleted => true,
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
            let snapshot = sessions.snapshot(&entry.session_id)?;
            if snapshot.inbox.next_step.is_empty() && !continue_after_tools {
                sessions.append(
                    &entry.session_id,
                    Some(turn_id.clone()),
                    None,
                    AgentSessionEventPayload::TurnEnd {
                        reason: "completed".into(),
                    },
                )?;
                entry.set_scope(None)?;
                break;
            }
            if step_index >= config.max_steps_per_turn {
                let reason = format!(
                    "stepLimitExceeded: maximum {} Steps per Turn",
                    config.max_steps_per_turn
                );
                close_open_scope(sessions, entry, &reason)?;
                sessions.terminate(&entry.session_id, AgentSessionStatus::Failed, reason)?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
                return Ok(AgentDriverSettlement::Failed);
            }
            step_index += 1;
            current_step_id = format!("step-{}", Uuid::new_v4().simple());
            if let Some(reason) = apply_pre_step_hooks(
                sessions,
                entry,
                hooks,
                compactions,
                &turn_id,
                &current_step_id,
                step_index,
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
            } else {
                let claimed = sessions.begin_step(
                    &entry.session_id,
                    turn_id.clone(),
                    current_step_id.clone(),
                )?;
                if claimed.is_none() {
                    continue;
                }
            }
            entry.set_scope(Some(AgentActiveScope {
                turn_id: turn_id.clone(),
                step_id: Some(current_step_id.clone()),
            }))?;
        }
    }
}

async fn apply_pre_step_hooks(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    hooks: &AgentHookBus,
    compactions: &AgentCompactionManager,
    turn_id: &str,
    step_id: &str,
    step_index: usize,
) -> Result<Option<String>, String> {
    let snapshot = sessions.snapshot(&entry.session_id)?;
    let surface_generation = snapshot.surface.generation;
    let assembly = assemble_model_input(&snapshot.header, model_tools_for(entry));
    let mut request = ModelRequest::from_surface(
        "pre-step-budget".into(),
        &snapshot.surface,
        assembly.system_prompt,
        assembly.tools,
    );
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
        .extend(pending.into_iter().map(|message| ModelMessage::User {
            content: message.content,
        }));
    let budget = estimate_model_surface_budget(&entry.provider, &request);
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
                        message_id,
                        client_submission_id: None,
                        content,
                        source: AgentMessageSource::runtime(label),
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
}

fn retry_random_sample() -> f64 {
    let sample = Uuid::new_v4().as_u128() as u64;
    (sample as f64) / (u64::MAX as f64)
}

fn model_response_has_output(response: &ModelResponse) -> bool {
    response.content.iter().any(|block| match block {
        ModelContentBlock::Text { text } | ModelContentBlock::Reasoning { text, .. } => {
            !text.is_empty()
        }
        ModelContentBlock::ToolCall { .. } => true,
    })
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
    compactions: &AgentCompactionManager,
    turn_id: &str,
    step_id: &str,
    step_index: usize,
    config: AgentDriverConfig,
) -> Result<StepSettlement, String> {
    let mut attempt = 1_u32;
    let mut request_reason = if step_index == 1 {
        AgentRequestReason::Initial
    } else {
        AgentRequestReason::ToolContinuation
    };
    let mut pending_retry: Option<PendingRetry> = None;
    let mut cumulative_delay_ms = 0_u64;
    loop {
        if entry.cancellation().is_cancelled() {
            return Ok(StepSettlement::Cancelled);
        }
        let request_id = format!("request-{}", Uuid::new_v4().simple());
        if let Some(pending) = pending_retry.take() {
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
        }
        let snapshot = sessions.snapshot(&entry.session_id)?;
        let assembly = assemble_model_input(&snapshot.header, model_tools_for(entry));
        ensure_model_context(
            sessions,
            entry,
            turn_id,
            step_id,
            &snapshot.surface,
            &assembly,
        )?;
        let surface = sessions.snapshot(&entry.session_id)?.surface;
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
                        if is_assembled_context_source(source)
                )
            });
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
        let request_surface_generation = request.surface_generation;
        let budget = estimate_model_surface_budget(&entry.provider, &request);
        let estimated_input_tokens = Some(budget.estimated_input_tokens);
        if entry.cancellation().is_cancelled() {
            return Ok(StepSettlement::Cancelled);
        }
        let mut request_events = super::request_log::request_events(
            &sessions.all_events(&entry.session_id)?,
            entry,
            &request,
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
        let response = entry
            .adapter
            .stream(request, cancellation.clone(), sink)
            .await;
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
                if error.kind == NormalizedModelErrorKind::ContextTooLarge
                    && attempt < config.retry_policy.max_attempts()
                    && collected
                        .lock()
                        .map_err(|_| "model stream accumulator is unavailable".to_string())?
                        .is_empty() =>
            {
                let before = request_surface_generation;
                sessions.append(
                    &entry.session_id,
                    Some(turn_id.to_string()),
                    Some(step_id.to_string()),
                    request_failure_payload(
                        &request_id,
                        &error,
                        attempt,
                        config.retry_policy.max_attempts(),
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
                });
                attempt += 1;
                request_reason = AgentRequestReason::Recovery;
            }
            Err(error) if error.retryable() => {
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
                        config.retry_policy.max_attempts(),
                        cumulative_delay_ms,
                        !partial_is_empty,
                    ),
                )?;
                if !cancellation.is_cancelled() {
                    if let Some(plan) =
                        config
                            .retry_policy
                            .plan(&error, attempt, retry_random_sample())
                    {
                        pending_retry = Some(PendingRetry {
                            previous_request_id: request_id,
                            reason: format!(
                                "retryable model failure: kind={:?} code={}",
                                error.kind,
                                error.code.as_deref().unwrap_or("unspecified")
                            ),
                            plan,
                            error: Some(error),
                        });
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
                    config.retry_policy.max_attempts(),
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
                        config.retry_policy.max_attempts(),
                        cumulative_delay_ms,
                        had_output,
                    ),
                )?;
                return Ok(StepSettlement::Failed(model_error_reason(
                    &error,
                    attempt,
                    config.retry_policy.max_attempts(),
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
    let existing_producers = surface
        .messages
        .iter()
        .filter_map(|message| match message {
            super::AgentSurfaceMessage::User { source, .. } => Some(source.producer_id.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let payloads = assembly
        .context
        .iter()
        .filter(|injection| {
            !existing_producers
                .iter()
                .any(|producer| *producer == injection.source.producer_id)
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

fn model_tools_for(entry: &AgentEntry) -> Vec<super::ModelToolDefinition> {
    let tools = default_model_tools();
    let Some(scope) = &entry.capability_scope else {
        return tools;
    };
    tools
        .into_iter()
        .filter(|tool| scope.tool_names.iter().any(|name| name == &tool.name))
        .collect()
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
    } = response;
    let has_content = model_content.iter().any(|block| match block {
        ModelContentBlock::Text { text } | ModelContentBlock::Reasoning { text, .. } => {
            !text.is_empty()
        }
        ModelContentBlock::ToolCall { .. } => true,
    });
    if !has_content {
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
    let usage = token_usage(model_usage);
    let stop_reason = stop_reason(finish_reason);
    let content = model_content
        .into_iter()
        .map(|block| match block {
            ModelContentBlock::Text { text } => AgentAssistantContentBlock::Text { text },
            ModelContentBlock::Reasoning {
                text,
                provider_item,
            } => AgentAssistantContentBlock::Reasoning {
                text,
                provider_item,
            },
            ModelContentBlock::ToolCall { call } => AgentAssistantContentBlock::ToolCall {
                call: Box::new(recorded_tool_call(call)),
            },
        })
        .collect();
    let mut payloads = vec![
        AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: AgentSessionEventPayload::AssistantMessage {
                message_id: format!("message-{}", Uuid::new_v4().simple()),
                content,
                usage,
                stop_reason,
                interrupted: false,
            },
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
        payloads.push(AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: AgentSessionEventPayload::StepEnd {
                reason: "completed".into(),
            },
        });
        sessions.append_batch(&entry.session_id, payloads)?;
        entry.set_scope(Some(AgentActiveScope {
            turn_id: turn_id.to_string(),
            step_id: None,
        }))?;
        return Ok(StepSettlement::Completed);
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
    let prefix = match error.kind {
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
                PartialContentBlock::Text(text) if !text.is_empty() => {
                    Some(AgentAssistantContentBlock::Text { text: text.clone() })
                }
                PartialContentBlock::Reasoning(text) if !text.is_empty() => {
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
            AgentSessionEventPayload::TurnEnd { .. } => {
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
    if entry.phase()? == AgentLifecyclePhase::Waiting {
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
    use super::*;

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
}
