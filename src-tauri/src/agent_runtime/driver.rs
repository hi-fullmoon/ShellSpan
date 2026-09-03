use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use super::{
    default_model_tools, estimate_model_surface_budget, recorded_tool_call, AgentActiveScope,
    AgentCompactionManager, AgentEntry, AgentHookBus, AgentLifecyclePhase, AgentPreStepContext,
    AgentPreStepDecision, AgentScopedPayload, AgentSessionEventPayload, AgentSessionStatus,
    AgentSessionStore, AgentToolPipeline, ModelFinishReason, ModelMessage, ModelRequest,
    ModelResponse, ModelStreamSink, NormalizedModelError, NormalizedModelErrorKind, StreamDelta,
    ToolPipelineSettlement,
};

#[cfg(test)]
use super::{AgentInboxLane, AgentInboxMessage, AgentMessageSource};

#[derive(Debug, Clone, Copy)]
pub(crate) struct AgentDriverConfig {
    pub(crate) max_steps_per_turn: usize,
    pub(crate) max_turns_per_session: usize,
    pub(crate) max_request_attempts: u32,
}

impl Default for AgentDriverConfig {
    fn default() -> Self {
        Self {
            max_steps_per_turn: 8,
            max_turns_per_session: 64,
            max_request_attempts: 3,
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
            max_request_attempts: config.max_request_attempts,
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
            )? {
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
                apply_pre_step_hooks(sessions, entry, hooks, compactions, &turn_id, &step_id, 1)?
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
            )? {
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

fn apply_pre_step_hooks(
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
    let mut request = ModelRequest::from_surface(
        "pre-step-budget".into(),
        &snapshot.surface,
        model_tools_for(entry),
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
                        source: AgentMessageSource::Runtime { label },
                    },
                )?;
            }
            AgentPreStepDecision::Compact { reason } => {
                let active_turn_id = entry.scope()?.map(|scope| scope.turn_id);
                compactions.compact(
                    &entry.session_id,
                    turn_id,
                    step_id,
                    active_turn_id.as_deref(),
                    &reason,
                    &budget,
                    false,
                )?;
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

async fn run_step(
    sessions: &AgentSessionStore,
    entry: &Arc<AgentEntry>,
    tools: &AgentToolPipeline,
    compactions: &AgentCompactionManager,
    turn_id: &str,
    step_id: &str,
    config: AgentDriverConfig,
) -> Result<StepSettlement, String> {
    let mut attempt = 1_u32;
    let mut previous_request = None;
    loop {
        let request_id = format!("request-{}", Uuid::new_v4().simple());
        if let Some((previous, retry_reason)) = previous_request.take() {
            sessions.append(
                &entry.session_id,
                Some(turn_id.to_string()),
                Some(step_id.to_string()),
                AgentSessionEventPayload::RequestRetry {
                    request_id: request_id.clone(),
                    previous_request_id: Some(previous),
                    attempt,
                    reason: retry_reason,
                },
            )?;
        }
        let surface = sessions.snapshot(&entry.session_id)?.surface;
        let mut request =
            ModelRequest::from_surface(request_id.clone(), &surface, model_tools_for(entry));
        if let Some(inherited) = sessions.inherited_surface(&entry.session_id)? {
            let mut inherited_messages = ModelRequest::from_surface(
                format!("{request_id}-inherited"),
                &inherited,
                Vec::new(),
            )
            .messages;
            inherited_messages.append(&mut request.messages);
            request.messages = inherited_messages;
        }
        let request_surface_generation = request.surface_generation;
        let budget = estimate_model_surface_budget(&entry.provider, &request);
        let estimated_input_tokens = Some(budget.estimated_input_tokens);
        sessions.append_batch(
            &entry.session_id,
            vec![
                AgentScopedPayload {
                    turn_id: Some(turn_id.to_string()),
                    step_id: Some(step_id.to_string()),
                    payload: AgentSessionEventPayload::RequestHeader {
                        request_id: request_id.clone(),
                        provider_id: entry.provider.id.clone(),
                        model: Some(entry.provider.model.clone()),
                        reasoning_effort: entry
                            .provider
                            .reasoning_effort
                            .map(|effort| format!("{effort:?}").to_ascii_lowercase()),
                        attempt: Some(attempt),
                    },
                },
                AgentScopedPayload {
                    turn_id: Some(turn_id.to_string()),
                    step_id: Some(step_id.to_string()),
                    payload: AgentSessionEventPayload::RequestContext {
                        request_id: request_id.clone(),
                        input_tokens: estimated_input_tokens,
                        context_window: Some(budget.context_window),
                        surface_generation: surface.generation,
                        limited: None,
                        omitted_messages: None,
                    },
                },
            ],
        )?;

        let collected = Arc::new(Mutex::new(String::new()));
        let sink: Arc<dyn ModelStreamSink> = Arc::new(DurableModelStreamSink {
            sessions: sessions.clone(),
            session_id: entry.session_id.clone(),
            turn_id: turn_id.to_string(),
            step_id: step_id.to_string(),
            request_id: request_id.clone(),
            collected: Arc::clone(&collected),
        });
        let cancellation = entry.cancellation();
        let response = entry
            .adapter
            .stream(request, cancellation.clone(), sink)
            .await;
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
                let partial = collected
                    .lock()
                    .map_err(|_| "model stream accumulator is unavailable".to_string())?
                    .clone();
                append_interrupted_message(sessions, entry, turn_id, step_id, partial)?;
                return Ok(StepSettlement::Cancelled);
            }
            Err(error)
                if error.kind == NormalizedModelErrorKind::ContextTooLarge
                    && attempt < config.max_request_attempts
                    && collected
                        .lock()
                        .map_err(|_| "model stream accumulator is unavailable".to_string())?
                        .is_empty() =>
            {
                let before = request_surface_generation;
                let outcome = match compactions.compact(
                    &entry.session_id,
                    turn_id,
                    step_id,
                    Some(turn_id),
                    "providerContextTooLarge",
                    &budget,
                    true,
                ) {
                    Ok(outcome) => outcome,
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
                previous_request = Some((
                    request_id,
                    format!(
                        "context compacted from generation {} to {}",
                        before, outcome.surface_generation
                    ),
                ));
                attempt += 1;
            }
            Err(error)
                if error.retryable()
                    && attempt < config.max_request_attempts
                    && collected
                        .lock()
                        .map_err(|_| "model stream accumulator is unavailable".to_string())?
                        .is_empty() =>
            {
                previous_request = Some((request_id, "retryable provider failure".into()));
                attempt += 1;
            }
            Err(error) => {
                let partial = collected
                    .lock()
                    .map_err(|_| "model stream accumulator is unavailable".to_string())?
                    .clone();
                append_interrupted_message(sessions, entry, turn_id, step_id, partial)?;
                return Ok(StepSettlement::Failed(model_error_reason(&error)));
            }
        }
    }
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
    let tool_calls = events
        .iter()
        .filter(|event| matches!(event.payload, AgentSessionEventPayload::ToolCall { .. }))
        .count() as u32;
    if tool_calls > subagent.budget.max_tool_calls {
        return Ok(Some(format!(
            "subagentToolBudgetExceeded: maximum {} calls",
            subagent.budget.max_tool_calls
        )));
    }
    let tokens = events
        .iter()
        .filter_map(|event| match event.payload {
            AgentSessionEventPayload::RequestUsage { total_tokens, .. } => total_tokens,
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
    if response.content.trim().is_empty() && response.tool_calls.is_empty() {
        return Ok(StepSettlement::Failed(
            "emptyResponse: AI provider returned no text or tool calls".into(),
        ));
    }
    if response.finish_reason == ModelFinishReason::Length {
        return Ok(StepSettlement::Failed(
            "outputLimit: AI provider reached its output token limit".into(),
        ));
    }
    let model_tool_calls = response.tool_calls;
    let tool_calls = model_tool_calls
        .iter()
        .cloned()
        .map(recorded_tool_call)
        .collect::<Vec<_>>();
    let mut payloads = vec![
        AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: AgentSessionEventPayload::AssistantMessage {
                message_id: format!("message-{}", Uuid::new_v4().simple()),
                content: response.content,
                tool_calls: tool_calls.clone(),
                interrupted: false,
            },
        },
        AgentScopedPayload {
            turn_id: Some(turn_id.to_string()),
            step_id: Some(step_id.to_string()),
            payload: AgentSessionEventPayload::RequestUsage {
                request_id: request_id.to_string(),
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens,
                total_tokens: response.usage.total_tokens,
                finish_reason: response.finish_reason.as_wire_name().into(),
            },
        },
    ];
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
    partial: String,
) -> Result<(), String> {
    if partial.is_empty() {
        return Ok(());
    }
    sessions.append(
        &entry.session_id,
        Some(turn_id.to_string()),
        Some(step_id.to_string()),
        AgentSessionEventPayload::AssistantMessage {
            message_id: format!("message-{}", Uuid::new_v4().simple()),
            content: partial,
            tool_calls: Vec::new(),
            interrupted: true,
        },
    )?;
    Ok(())
}

fn close_open_scope(
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

fn model_error_reason(error: &NormalizedModelError) -> String {
    let prefix = match error.kind {
        NormalizedModelErrorKind::Cancelled => "cancelled",
        NormalizedModelErrorKind::Retryable => "providerRetryExhausted",
        NormalizedModelErrorKind::ContextTooLarge => "contextTooLarge",
        NormalizedModelErrorKind::Authentication => "authenticationFailed",
        NormalizedModelErrorKind::RateLimited => "rateLimited",
        NormalizedModelErrorKind::Terminal => "providerFailure",
    };
    format!("{prefix}: {}", error.message)
}

struct DurableModelStreamSink {
    sessions: AgentSessionStore,
    session_id: String,
    turn_id: String,
    step_id: String,
    request_id: String,
    collected: Arc<Mutex<String>>,
}

impl ModelStreamSink for DurableModelStreamSink {
    fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
        match delta {
            StreamDelta::Text { text } => {
                self.sessions
                    .append(
                        &self.session_id,
                        Some(self.turn_id.clone()),
                        Some(self.step_id.clone()),
                        AgentSessionEventPayload::AssistantChunk {
                            request_id: self.request_id.clone(),
                            text: text.clone(),
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
                    .push_str(&text);
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
                model_error_reason(&NormalizedModelError::new(kind, "failure")).starts_with(prefix)
            );
        }
    }
}
