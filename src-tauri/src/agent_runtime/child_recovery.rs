use serde::Serialize;

use super::{
    AgentInboxProjection, AgentSessionEvent, AgentSessionEventPayload as Payload,
    AgentSessionHeader, AgentSessionStatus, AgentToolResultStatus,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentChildFailureRecovery {
    pub(crate) turn_id: String,
    pub(crate) retryable: bool,
    pub(crate) retry_at: Option<u64>,
}

pub(super) fn recovery_id(turn_id: &str) -> String {
    format!("child-retry-{turn_id}")
}

/// Only model failures with fully settled tools can start another attempt.
/// A new turn retains the original Session, plan, results and cumulative budgets.
pub(super) fn child_failure_recovery(
    header: &AgentSessionHeader,
    status: AgentSessionStatus,
    archived: bool,
    events: &[AgentSessionEvent],
    inbox: &AgentInboxProjection,
) -> Option<AgentChildFailureRecovery> {
    let child = header.subagent.as_ref()?;
    if archived || !child.continuable || header.parent_session_id.is_none() {
        return None;
    }
    if !super::subagent::child_has_remaining_budget(
        &child.budget,
        events,
        child.budget.max_turns as usize,
        events.last()?.time_unix_ms,
    ) {
        return None;
    }
    let boundary = events
        .iter()
        .rev()
        .find(|event| matches!(event.payload, Payload::TurnStart | Payload::TurnEnd { .. }))?;
    let Payload::TurnEnd { reason } = &boundary.payload else {
        return None;
    };
    if !model_failure_reason(reason)
        || events
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                Payload::SessionEnded { reason, .. } => Some(reason.as_deref()),
                _ => None,
            })
            .is_some_and(|reason| reason.is_none_or(|reason| !model_failure_reason(reason)))
    {
        return None;
    }
    let turn_id = boundary.turn_id.as_deref()?;
    let id = recovery_id(turn_id);
    let pending: Vec<_> = inbox.next_turn.iter().chain(&inbox.next_step).collect();
    if !matches!(
        status,
        AgentSessionStatus::Failed | AgentSessionStatus::Idle
    ) || pending
        .iter()
        .any(|message| message.message_id != id || message.source.label != "child-failure-retry")
        || super::session::has_uncertain_tool_executions(events)
        || !settled_tool_calls(events)
    {
        return None;
    }
    let failure_event = events.iter().rev().find(|event| {
        event.turn_id.as_deref() == Some(turn_id)
            && matches!(
                event.payload,
                Payload::RequestFailure { .. }
                    | Payload::RequestUsage { .. }
                    | Payload::AssistantMessage { .. }
            )
    })?;
    let Payload::RequestFailure { failure, .. } = &failure_event.payload else {
        return None;
    };
    let code = failure
        .code
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if failure.kind == super::NormalizedModelErrorKind::Cancelled
        || code == "content_policy_violation"
    {
        return None;
    }
    let retryable = failure.retryable()
        && !matches!(failure.status, Some(401..=404))
        && !matches!(
            code.as_str(),
            "insufficient_quota"
                | "billing_hard_limit_reached"
                | "model_not_found"
                | "context_length_exceeded"
                | "invalid_request_error"
        );
    Some(AgentChildFailureRecovery {
        turn_id: turn_id.into(),
        retryable,
        retry_at: failure
            .retry_after_ms
            .map(|delay| failure_event.time_unix_ms.saturating_add(delay)),
    })
}

fn model_failure_reason(reason: &str) -> bool {
    matches!(
        reason.split(':').next(),
        Some(
            "providerRetryExhausted"
                | "providerProtocolFailure"
                | "contextTooLarge"
                | "authenticationFailed"
                | "rateLimited"
                | "providerFailure"
                | "outputLimit"
        )
    )
}

/// Pair by step AND call identity. A missing/uncertain outcome must never be
/// treated as permission to replay an already dispatched operation.
fn settled_tool_calls(events: &[AgentSessionEvent]) -> bool {
    let mut calls = std::collections::HashSet::new();
    let mut questions = std::collections::HashSet::new();
    for event in events {
        match &event.payload {
            Payload::ToolCall { call } => {
                calls.insert((event.step_id.as_deref(), call.call_id.as_str()));
            }
            Payload::ToolResult {
                call_id, status, ..
            } if *status != AgentToolResultStatus::Uncertain => {
                calls.remove(&(event.step_id.as_deref(), call_id.as_str()));
            }
            Payload::QuestionRequested { identity, .. } => {
                questions.insert(identity.question_request_id.as_str());
            }
            Payload::QuestionAnswered { submission, .. } => {
                questions.remove(submission.identity.question_request_id.as_str());
            }
            _ => {}
        }
    }
    calls.is_empty() && questions.is_empty()
}

/// Defense in depth for models that ask for an already completed write again.
/// Read operations may observe fresh state. This compares structured native
/// arguments, ignoring only the human-facing explanation.
pub(super) fn completed_recovery_operation(
    events: &[AgentSessionEvent],
    turn_id: &str,
    proposed: &super::RecordedToolCall,
) -> Option<String> {
    if matches!(
        proposed.effect,
        Some(
            super::AgentSessionEffect::None
                | super::AgentSessionEffect::ReadOnly
                | super::AgentSessionEffect::SensitiveRead
        )
    ) {
        return None;
    }
    let recovery = events
        .iter()
        .rev()
        .find(|event| matches!(event.payload, Payload::SubagentRecoveryStarted { .. }))?;
    if !events.iter().any(|event| {
        event.turn_id.as_deref() == Some(turn_id)
            && matches!(&event.payload, Payload::UserMessage { message }
            if message.source.label == "child-failure-retry")
    }) {
        return None;
    }
    let execution_arguments = |call: &super::RecordedToolCall| {
        let mut arguments = call.arguments.clone();
        if let Some(object) = arguments.as_object_mut() {
            object.remove("explanation");
        }
        arguments
    };
    events.iter().find_map(|event| {
        let Payload::ToolCall { call } = &event.payload else { return None; };
        if event.seq >= recovery.seq
            || call.native_name.as_deref().unwrap_or(&call.name) != proposed.native_name.as_deref().unwrap_or(&proposed.name)
            || call.target != proposed.target
            || execution_arguments(call) != execution_arguments(proposed)
        {
            return None;
        }
        events.iter().any(|result| result.seq > event.seq && result.seq < recovery.seq
            && result.step_id == event.step_id
            && matches!(&result.payload, Payload::ToolResult { call_id, status: AgentToolResultStatus::Completed, .. }
                if call_id == &call.call_id))
            .then(|| format!("childRecoveryReplayBlocked: operation already completed at step {} call {}. Use its saved result and continue unfinished work; do not repeat this operation.", event.step_id.as_deref().unwrap_or_default(), call.call_id))
    })
}
