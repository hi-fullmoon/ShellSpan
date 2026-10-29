use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{
    AgentRecoveryStatus, AgentSessionEffect, AgentSessionEvent, AgentSessionEventPayload,
    AgentSessionStatus, AgentToolApprovalStatus,
};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRecoveryCheckpointKind {
    Idle,
    OpenModelRequest,
    WaitingApproval,
    WaitingQuestion,
    QuestionContinuation,
    AuthorizedBeforeExecute,
    ExecutionInFlight,
    ToolResultCommitted,
    CompactionInFlight,
    ArtifactIntegrity,
    Cancelled,
    Terminal,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRecoveryCheckpoint {
    pub(crate) kind: AgentRecoveryCheckpointKind,
    pub(crate) status: AgentRecoveryStatus,
    pub(crate) summary: String,
    pub(crate) last_committed_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) step_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) effect: Option<AgentSessionEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) idempotency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) command: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRecoverySessionInput {
    pub(crate) session_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRecoveryReconcileOutcome {
    Probe,
    ConfirmedApplied,
    ConfirmedNotApplied,
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRecoveryReconcileInput {
    pub(crate) session_id: String,
    pub(crate) outcome: AgentRecoveryReconcileOutcome,
    pub(crate) evidence: String,
}

type PendingExecutions<'a> = HashMap<(Option<&'a str>, &'a str), (&'a AgentSessionEvent, bool)>;

fn pending_executions(events: &[AgentSessionEvent]) -> PendingExecutions<'_> {
    let mut pending = HashMap::new();
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::ToolExecution { call_id, .. } => {
                pending.insert((event.step_id.as_deref(), call_id.as_str()), (event, false));
            }
            AgentSessionEventPayload::ToolResult {
                call_id, status, ..
            } => {
                let key = (event.step_id.as_deref(), call_id.as_str());
                if *status == super::AgentToolResultStatus::Uncertain {
                    if let Some((_, uncertain)) = pending.get_mut(&key) {
                        *uncertain = true;
                    }
                } else {
                    pending.remove(&key);
                }
            }
            _ => {}
        }
    }
    pending
}

pub(super) fn unresolved_execution_count(events: &[AgentSessionEvent]) -> usize {
    pending_executions(events).len()
}

/// Closed turns retain their uncertain outcomes, but never resume their old queue.
pub(super) fn open_turn_id(events: &[AgentSessionEvent]) -> Option<&str> {
    for event in events.iter().rev() {
        match event.payload {
            AgentSessionEventPayload::TurnStart => return event.turn_id.as_deref(),
            AgentSessionEventPayload::TurnEnd { .. }
            | AgentSessionEventPayload::SessionEnded { .. }
            | AgentSessionEventPayload::SessionResumed {}
            | AgentSessionEventPayload::SubagentRecoveryStarted { .. } => return None,
            _ => {}
        }
    }
    None
}

pub(super) fn execution_writes_restricted(events: &[AgentSessionEvent]) -> bool {
    pending_executions(events)
        .values()
        .any(|(dispatch, uncertain)| {
            *uncertain
                || events
                    .iter()
                    .rev()
                    .take_while(|event| event.seq > dispatch.seq)
                    .any(|event| match event.payload {
                        AgentSessionEventPayload::TurnEnd { .. } => {
                            event.turn_id == dispatch.turn_id
                        }
                        AgentSessionEventPayload::SessionEnded { .. }
                        | AgentSessionEventPayload::SessionResumed {} => true,
                        _ => false,
                    })
        })
}

pub(super) fn observation_effect_allowed(effect: AgentSessionEffect) -> bool {
    matches!(
        effect,
        AgentSessionEffect::None | AgentSessionEffect::ReadOnly | AgentSessionEffect::SensitiveRead
    )
}

pub(super) const UNKNOWN_EXECUTION_WRITE_BLOCKED: &str = "EXECUTION_OUTCOME_UNKNOWN: an earlier execution has an unknown outcome. Continue with non-mutating inspection; writes and automatic replay remain blocked.";

/// A later step, cancellation, or restart never proves an earlier dispatch settled.
pub(super) fn unresolved_execution(
    events: &[AgentSessionEvent],
) -> Option<AgentRecoveryCheckpoint> {
    let ((_, call_id), (dispatch, uncertain)) = pending_executions(events)
        .into_iter()
        .max_by_key(|(_, (e, _))| e.seq)?;
    let call = events.iter().rev().find_map(|event| {
        if event.step_id != dispatch.step_id || event.turn_id != dispatch.turn_id {
            return None;
        }
        match &event.payload {
            AgentSessionEventPayload::ToolCall { call } if call.call_id == call_id => Some(call),
            _ => None,
        }
    });
    let AgentSessionEventPayload::ToolExecution { idempotency, .. } = &dispatch.payload else {
        return None;
    };
    Some(AgentRecoveryCheckpoint {
        kind: AgentRecoveryCheckpointKind::ExecutionInFlight,
        status: AgentRecoveryStatus::Required,
        summary: if uncertain {
            "The visible terminal reported an explicit uncertain outcome; reconcile it before continuing."
        } else {
            "A native call was dispatched without a durable result; its outcome is uncertain."
        }.into(),
        last_committed_seq: events.last().map_or(0, |event| event.seq),
        turn_id: dispatch.turn_id.clone(),
        step_id: dispatch.step_id.clone(),
        request_id: events.iter().rev().find_map(|event| {
            if event.step_id != dispatch.step_id || event.turn_id != dispatch.turn_id {
                return None;
            }
            match &event.payload {
                AgentSessionEventPayload::ToolApproval { request_id, call_id: approved, .. } if approved == call_id => Some(request_id.clone()),
                _ => None,
            }
        }),
        call_id: Some(call_id.into()),
        effect: call.and_then(|call| call.effect),
        idempotency: Some(idempotency.clone()),
        tool_name: call.map(|call| call.name.clone()),
        command: call.and_then(|call| call.arguments.get("command")?.as_str())
            .map(crate::redaction::redact_sensitive_text),
    })
}

#[derive(Default)]
struct ToolBoundary {
    turn_id: Option<String>,
    step_id: Option<String>,
    last_seq: u64,
    request_id: Option<String>,
    effect: Option<AgentSessionEffect>,
    approval: Option<AgentToolApprovalStatus>,
    dispatched: Option<String>,
    has_result: bool,
    uncertain_result: bool,
}

pub(crate) fn derive_recovery_checkpoint(events: &[AgentSessionEvent]) -> AgentRecoveryCheckpoint {
    if let Some(checkpoint) = unresolved_execution(events) {
        return checkpoint;
    }
    let last_committed_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let mut status = AgentSessionStatus::Idle;
    let mut ended = false;
    let mut turn_id = None;
    let mut step_id = None;
    let mut open_request = None;
    let mut request_finished = false;
    let mut tools = HashMap::<String, ToolBoundary>::new();
    let mut task_recovery = None;

    for event in events {
        match &event.payload {
            AgentSessionEventPayload::SessionResumed {}
            | AgentSessionEventPayload::SubagentRecoveryStarted { .. } => {
                status = AgentSessionStatus::Idle;
                ended = false;
                turn_id = None;
                step_id = None;
                open_request = None;
                request_finished = false;
                tools.clear();
                task_recovery = None;
            }
            AgentSessionEventPayload::AgentStatus { status: value, .. } => status = *value,
            AgentSessionEventPayload::SessionEnded { status: value, .. } => {
                status = *value;
                ended = true;
            }
            AgentSessionEventPayload::TurnStart => turn_id.clone_from(&event.turn_id),
            AgentSessionEventPayload::TurnEnd { .. } => {
                turn_id = None;
                step_id = None;
                open_request = None;
                request_finished = false;
                tools.clear();
            }
            AgentSessionEventPayload::StepStart => {
                step_id.clone_from(&event.step_id);
                open_request = None;
                request_finished = false;
                tools.clear();
            }
            AgentSessionEventPayload::StepEnd { .. } => step_id = None,
            AgentSessionEventPayload::RequestHeader { request_id, .. }
            | AgentSessionEventPayload::RequestStart { request_id, .. } => {
                open_request = Some(request_id.clone());
                request_finished = false;
            }
            AgentSessionEventPayload::RequestUsage { request_id, .. }
                if open_request.as_deref() == Some(request_id) =>
            {
                request_finished = true;
            }
            AgentSessionEventPayload::ToolCall { call } => {
                let boundary = tools.entry(call.call_id.clone()).or_default();
                boundary.turn_id.clone_from(&event.turn_id);
                boundary.step_id.clone_from(&event.step_id);
                boundary.effect = call.effect;
                boundary.last_seq = event.seq;
            }
            AgentSessionEventPayload::ToolApproval {
                request_id,
                call_id,
                status,
                ..
            } => {
                let boundary = tools.entry(call_id.clone()).or_default();
                boundary.request_id = Some(request_id.clone());
                boundary.approval = Some(*status);
                boundary.last_seq = event.seq;
            }
            AgentSessionEventPayload::ToolExecution {
                call_id,
                idempotency,
                ..
            } => {
                let boundary = tools.entry(call_id.clone()).or_default();
                boundary.dispatched = Some(idempotency.clone());
                boundary.last_seq = event.seq;
            }
            AgentSessionEventPayload::ToolResult {
                call_id, status, ..
            } if event.turn_id == turn_id => {
                let boundary = tools.entry(call_id.clone()).or_default();
                boundary.has_result = *status != super::AgentToolResultStatus::Uncertain;
                boundary.uncertain_result = *status == super::AgentToolResultStatus::Uncertain;
                boundary.last_seq = event.seq;
            }
            AgentSessionEventPayload::TaskState { recovery, .. } => {
                task_recovery.clone_from(recovery);
            }
            _ => {}
        }
    }

    let make = |kind, recovery_status, summary: &str, request_id, call_id, effect, idempotency| {
        AgentRecoveryCheckpoint {
            kind,
            status: recovery_status,
            summary: summary.into(),
            last_committed_seq,
            turn_id: turn_id.clone(),
            step_id: step_id.clone(),
            request_id,
            call_id,
            effect,
            idempotency,
            tool_name: None,
            command: None,
        }
    };

    if ended {
        return make(
            AgentRecoveryCheckpointKind::Terminal,
            AgentRecoveryStatus::None,
            "Session reached a durable terminal event.",
            None,
            None,
            None,
            None,
        );
    }
    if status == AgentSessionStatus::Cancelled {
        return make(
            AgentRecoveryCheckpointKind::Cancelled,
            AgentRecoveryStatus::None,
            "Session cancellation is durable.",
            None,
            None,
            None,
            None,
        );
    }
    if super::compaction::has_compaction_in_flight(events) {
        return make(
            AgentRecoveryCheckpointKind::CompactionInFlight,
            AgentRecoveryStatus::Required,
            "Compaction did not reach a durable end marker.",
            None,
            None,
            None,
            None,
        );
    }
    if let Some(recovery) = task_recovery.as_ref().filter(|recovery| {
        matches!(
            recovery.status,
            AgentRecoveryStatus::Required | AgentRecoveryStatus::Reconciling
        ) && recovery
            .summary
            .as_deref()
            .is_some_and(|summary| summary.contains("Artifact"))
    }) {
        return make(
            AgentRecoveryCheckpointKind::ArtifactIntegrity,
            recovery.status,
            recovery
                .summary
                .as_deref()
                .unwrap_or("Artifact integrity recovery is required."),
            None,
            None,
            None,
            None,
        );
    }
    let mut ordered_tools = tools.iter().collect::<Vec<_>>();
    let question = super::user_questions::records(events)
        .into_iter()
        .rev()
        .find(|q| {
            turn_id.as_deref() == Some(&q.identity.turn_id)
                && events
                    .iter()
                    .rev()
                    .find(|e| matches!(e.payload, AgentSessionEventPayload::StepStart))
                    .and_then(|e| e.step_id.as_deref())
                    == Some(&q.identity.step_id)
        });
    // A question never erases a later native dispatch or authorization boundary.
    let native_unresolved = tools
        .values()
        .any(|t| !t.has_result && (t.dispatched.is_some() || t.approval.is_some()));
    if !native_unresolved && super::user_questions::question_queue(events).is_some() {
        if let Some(recovery) = task_recovery.as_ref().filter(|r| {
            matches!(
                r.status,
                AgentRecoveryStatus::Required | AgentRecoveryStatus::Reconciling
            )
        }) {
            return make(
                AgentRecoveryCheckpointKind::OpenModelRequest,
                recovery.status,
                recovery
                    .summary
                    .as_deref()
                    .unwrap_or("Question queue requires reconciliation."),
                open_request,
                None,
                None,
                None,
            );
        }
    }
    if let Some(question) = question.filter(|_| !native_unresolved) {
        let pending = question.answer.is_none() && !question.cancelled;
        return make(
            if pending {
                AgentRecoveryCheckpointKind::WaitingQuestion
            } else {
                AgentRecoveryCheckpointKind::QuestionContinuation
            },
            AgentRecoveryStatus::Available,
            if pending {
                "Waiting for a durable user answer; no approval timeout applies."
            } else {
                "Continue the original tool queue from its committed question answer."
            },
            Some(question.identity.request_id),
            Some(question.identity.call_id),
            None,
            None,
        );
    }
    if let Some((_, _, request)) =
        super::user_questions::question_queue(events).filter(|_| !native_unresolved)
    {
        return make(
            AgentRecoveryCheckpointKind::QuestionContinuation,
            AgentRecoveryStatus::Available,
            "Resume the committed assistant question queue without repeating completed tools.",
            Some(request),
            None,
            None,
            None,
        );
    }
    // A later completed sibling must never hide an earlier unresolved dispatch.
    ordered_tools.sort_by_key(|(_, boundary)| {
        (
            boundary.has_result,
            boundary.dispatched.is_none(),
            std::cmp::Reverse(boundary.last_seq),
        )
    });
    for (call_id, boundary) in ordered_tools {
        if boundary.has_result {
            if let Some(recovery) = task_recovery.as_ref().filter(|recovery| {
                recovery.status == AgentRecoveryStatus::Required
                    && recovery
                        .summary
                        .as_deref()
                        .is_some_and(|text| text.starts_with("toolSchedulerFailure:"))
            }) {
                return make(
                    AgentRecoveryCheckpointKind::OpenModelRequest,
                    AgentRecoveryStatus::Required,
                    recovery.summary.as_deref().unwrap_or_default(),
                    None,
                    None,
                    None,
                    None,
                );
            }
            return make(
                AgentRecoveryCheckpointKind::ToolResultCommitted,
                AgentRecoveryStatus::Available,
                "The native result is durable; continuation may resume without re-execution.",
                boundary.request_id.clone(),
                Some(call_id.clone()),
                boundary.effect,
                boundary.dispatched.clone(),
            );
        }
        if boundary.dispatched.is_some() {
            // Waiting for approval may have ended the model Step already.
            // Reconciliation still needs the original tool's complete scope.
            return AgentRecoveryCheckpoint {
                turn_id: boundary.turn_id.clone(),
                step_id: boundary.step_id.clone(),
                ..make(
                    AgentRecoveryCheckpointKind::ExecutionInFlight,
                    AgentRecoveryStatus::Required,
                    if boundary.uncertain_result {
                        "The visible terminal reported an explicit uncertain outcome; reconcile it before continuing."
                    } else {
                        "A native call was dispatched without a durable result; its outcome is uncertain."
                    },
                    boundary.request_id.clone(),
                    Some(call_id.clone()),
                    boundary.effect,
                    boundary.dispatched.clone(),
                )
            };
        }
        if boundary.approval == Some(AgentToolApprovalStatus::Approved) {
            return make(
                AgentRecoveryCheckpointKind::AuthorizedBeforeExecute,
                AgentRecoveryStatus::Available,
                "Authorization is durable and no dispatch marker exists; explicit resume is safe.",
                boundary.request_id.clone(),
                Some(call_id.clone()),
                boundary.effect,
                None,
            );
        }
        if boundary.approval == Some(AgentToolApprovalStatus::Requested) {
            return make(
                AgentRecoveryCheckpointKind::WaitingApproval,
                AgentRecoveryStatus::None,
                "The approval request is durable and remains pending.",
                boundary.request_id.clone(),
                Some(call_id.clone()),
                boundary.effect,
                None,
            );
        }
    }
    if turn_id.is_some() && (!request_finished || step_id.is_some()) && open_request.is_some() {
        return make(
            AgentRecoveryCheckpointKind::OpenModelRequest,
            AgentRecoveryStatus::Available,
            "The Model Step can be retried from the last committed Model Surface.",
            open_request,
            None,
            None,
            None,
        );
    }
    make(
        AgentRecoveryCheckpointKind::Idle,
        AgentRecoveryStatus::None,
        "No recovery action is pending.",
        None,
        None,
        None,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{AgentToolExecutionStatus, AgentToolResultStatus, RecordedToolCall};
    use serde_json::json;

    fn event(seq: u64, payload: AgentSessionEventPayload) -> AgentSessionEvent {
        AgentSessionEvent::new(
            "session".into(),
            seq,
            1_000 + seq,
            Some("turn".into()),
            Some("step".into()),
            payload,
        )
    }

    #[test]
    fn execution_without_result_is_uncertain_and_never_resumable() {
        let checkpoint = derive_recovery_checkpoint(&[
            event(0, AgentSessionEventPayload::TurnStart),
            event(1, AgentSessionEventPayload::StepStart),
            event(
                2,
                AgentSessionEventPayload::ToolCall {
                    call: RecordedToolCall {
                        call_id: "call".into(),
                        provider_call_id: None,
                        name: "exec".into(),
                        native_name: Some("exec".into()),
                        arguments: json!({}),
                        title: None,
                        effect: Some(AgentSessionEffect::ExternalSideEffect),
                        target: None,
                    },
                },
            ),
            event(
                3,
                AgentSessionEventPayload::ToolApproval {
                    request_id: "request".into(),
                    call_id: "call".into(),
                    approval_id: None,
                    status: AgentToolApprovalStatus::Approved,
                    risk: None,
                    reason: None,
                    expires_at_unix_ms: None,
                    prompt: None,
                },
            ),
            event(
                4,
                AgentSessionEventPayload::ToolExecution {
                    call_id: "call".into(),
                    status: AgentToolExecutionStatus::Dispatched,
                    idempotency: "no".into(),
                },
            ),
        ]);
        assert_eq!(
            checkpoint.kind,
            AgentRecoveryCheckpointKind::ExecutionInFlight
        );
        assert_eq!(checkpoint.status, AgentRecoveryStatus::Required);
    }

    #[test]
    fn durable_result_is_a_continuation_boundary() {
        let mut events = vec![
            event(0, AgentSessionEventPayload::TurnStart),
            event(1, AgentSessionEventPayload::StepStart),
        ];
        events.push(event(
            2,
            AgentSessionEventPayload::ToolResult {
                call_id: "call".into(),
                name: "exec".into(),
                status: AgentToolResultStatus::Completed,
                summary: "done".into(),
                data: None,
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
        ));
        assert_eq!(
            derive_recovery_checkpoint(&events).kind,
            AgentRecoveryCheckpointKind::ToolResultCommitted
        );
    }

    #[test]
    fn stopped_recovery_retains_each_unresolved_scope_until_its_own_confirmation() {
        let mut events = vec![event(0, AgentSessionEventPayload::TurnStart)];
        for (index, step) in ["step-one", "step-two"].into_iter().enumerate() {
            let mut dispatch = event(
                1 + index as u64,
                AgentSessionEventPayload::ToolExecution {
                    call_id: "repeated-call".into(),
                    status: AgentToolExecutionStatus::Dispatched,
                    idempotency: "no".into(),
                },
            );
            dispatch.step_id = Some(step.into());
            events.push(dispatch);
        }
        events.push(event(
            3,
            AgentSessionEventPayload::TurnEnd {
                reason: "cancelled".into(),
            },
        ));
        events.push(event(
            4,
            AgentSessionEventPayload::SessionEnded {
                status: AgentSessionStatus::Cancelled,
                reason: Some("cancelled by user".into()),
            },
        ));
        assert_eq!(
            derive_recovery_checkpoint(&events).step_id.as_deref(),
            Some("step-two")
        );
        assert_eq!(unresolved_execution_count(&events), 2);
        let mut result = event(
            5,
            AgentSessionEventPayload::ToolResult {
                call_id: "repeated-call".into(),
                name: "run_terminal_command".into(),
                status: AgentToolResultStatus::Cancelled,
                summary: "Manually confirmed not applied".into(),
                data: None,
                duration_ms: None,
                evidence_refs: vec![],
            },
        );
        result.step_id = Some("step-two".into());
        events.push(result.clone());
        assert_eq!(
            derive_recovery_checkpoint(&events).step_id.as_deref(),
            Some("step-one")
        );
        assert_eq!(unresolved_execution_count(&events), 1);
        result.seq = 6;
        result.step_id = Some("step-one".into());
        events.push(result);
        assert_eq!(
            derive_recovery_checkpoint(&events).kind,
            AgentRecoveryCheckpointKind::Terminal
        );
        assert_eq!(unresolved_execution_count(&events), 0);
    }

    #[test]
    fn explicit_terminal_uncertainty_requires_reconciliation_and_is_not_replayed() {
        let events = vec![
            event(0, AgentSessionEventPayload::TurnStart),
            event(1, AgentSessionEventPayload::StepStart),
            event(
                2,
                AgentSessionEventPayload::ToolCall {
                    call: RecordedToolCall {
                        call_id: "call".into(),
                        provider_call_id: None,
                        name: "run_terminal_command".into(),
                        native_name: Some("terminal_execute".into()),
                        arguments: json!({"command":"side-effect"}),
                        title: None,
                        effect: Some(AgentSessionEffect::ExternalSideEffect),
                        target: None,
                    },
                },
            ),
            event(
                3,
                AgentSessionEventPayload::ToolExecution {
                    call_id: "call".into(),
                    status: AgentToolExecutionStatus::Dispatched,
                    idempotency: "conditional".into(),
                },
            ),
            event(
                4,
                AgentSessionEventPayload::ToolResult {
                    call_id: "call".into(),
                    name: "run_terminal_command".into(),
                    status: AgentToolResultStatus::Uncertain,
                    summary: "completion unavailable".into(),
                    data: Some(json!({"state":"uncertain","noAutoReplay":true})),
                    duration_ms: None,
                    evidence_refs: Vec::new(),
                },
            ),
        ];
        let checkpoint = derive_recovery_checkpoint(&events);
        assert_eq!(
            checkpoint.kind,
            AgentRecoveryCheckpointKind::ExecutionInFlight
        );
        assert_eq!(checkpoint.status, AgentRecoveryStatus::Required);
        assert!(checkpoint.summary.contains("explicit uncertain"));
    }
}
