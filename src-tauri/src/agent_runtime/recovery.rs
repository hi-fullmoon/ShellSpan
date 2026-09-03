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

#[derive(Default)]
struct ToolBoundary {
    last_seq: u64,
    request_id: Option<String>,
    effect: Option<AgentSessionEffect>,
    approval: Option<AgentToolApprovalStatus>,
    dispatched: Option<String>,
    has_result: bool,
}

pub(crate) fn derive_recovery_checkpoint(events: &[AgentSessionEvent]) -> AgentRecoveryCheckpoint {
    let last_committed_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let mut status = AgentSessionStatus::Idle;
    let mut ended = false;
    let mut turn_id = None;
    let mut step_id = None;
    let mut open_request = None;
    let mut request_finished = false;
    let mut compaction_open = false;
    let mut tools = HashMap::<String, ToolBoundary>::new();
    let mut task_recovery = None;

    for event in events {
        match &event.payload {
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
            AgentSessionEventPayload::RequestHeader { request_id, .. } => {
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
            AgentSessionEventPayload::ToolResult { call_id, .. } => {
                let boundary = tools.entry(call_id.clone()).or_default();
                boundary.has_result = true;
                boundary.last_seq = event.seq;
            }
            AgentSessionEventPayload::CompactionStart { .. } => compaction_open = true,
            AgentSessionEventPayload::CompactionEnd { .. } => compaction_open = false,
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
    if compaction_open {
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
            return make(
                AgentRecoveryCheckpointKind::ExecutionInFlight,
                AgentRecoveryStatus::Required,
                "A native call was dispatched without a durable result; its outcome is uncertain.",
                boundary.request_id.clone(),
                Some(call_id.clone()),
                boundary.effect,
                boundary.dispatched.clone(),
            );
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
}
