use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const AGENT_SESSION_EVENT_VERSION: u8 = 2;
pub(crate) const MAX_AGENT_MESSAGE_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentSessionStatus {
    Idle,
    Running,
    Waiting,
    Cancelled,
    Completed,
    Failed,
}

impl AgentSessionStatus {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Cancelled | Self::Completed | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentInboxLane {
    NextTurn,
    NextStep,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentInboxOperation {
    Enqueued,
    Claimed,
    Discarded,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentMessageSource {
    User,
    Runtime { label: String },
    Subagent { session_id: String },
    LegacyImport,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentInboxMessage {
    pub(crate) message_id: String,
    pub(crate) content: String,
    pub(crate) source: AgentMessageSource,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentSessionEffect {
    None,
    ReadOnly,
    SensitiveRead,
    StateChange,
    Destructive,
    ExternalSideEffect,
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentSessionPermissionMode {
    RequestApproval,
    ScopedAutopilot,
    Operator,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionTarget {
    pub(crate) kind: String,
    pub(crate) target_id: String,
    pub(crate) session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) root_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) local_root: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentCapabilityScope {
    pub(crate) tool_names: Vec<String>,
    pub(crate) effects: Vec<AgentSessionEffect>,
    pub(crate) target_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentSubagentRole {
    General,
    Explorer,
    Diagnostician,
    Operator,
    Verifier,
    Reviewer,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentSubagentInheritance {
    Blank,
    SafePrefix {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_through_seq: Option<u64>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSubagentBudget {
    pub(crate) max_steps_per_turn: u16,
    pub(crate) max_turns: u16,
    pub(crate) max_tool_calls: u32,
    pub(crate) max_tokens: u64,
    pub(crate) timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSubagentModel {
    pub(crate) provider_id: String,
    pub(crate) provider_kind: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) requires_api_key: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSubagentSession {
    pub(crate) descriptor_id: String,
    pub(crate) parent_task_id: String,
    pub(crate) role: AgentSubagentRole,
    pub(crate) continuable: bool,
    pub(crate) depth: u16,
    pub(crate) inheritance: AgentSubagentInheritance,
    pub(crate) capability_scope: AgentCapabilityScope,
    pub(crate) target_scope: Vec<AgentSessionTarget>,
    pub(crate) budget: AgentSubagentBudget,
    pub(crate) provider: AgentSubagentModel,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFleetTargetState {
    pub(crate) target_id: String,
    pub(crate) task_id: String,
    pub(crate) goal: String,
    pub(crate) wave: u32,
    pub(crate) state: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) child_session_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) evidence_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recovery: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordedToolCall {
    pub(crate) call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) provider_call_id: Option<String>,
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) native_name: Option<String>,
    pub(crate) arguments: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) effect: Option<AgentSessionEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) target: Option<AgentSessionTarget>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolApprovalStatus {
    Requested,
    Approved,
    Rejected,
    Expired,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolResultStatus {
    Completed,
    Rejected,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPlanStep {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: AgentPlanStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRecoveryStatus {
    None,
    Available,
    Required,
    Reconciling,
    Completed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolExecutionStatus {
    Dispatched,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRecoveryState {
    pub(crate) status: AgentRecoveryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFleetState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fleet_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    pub(crate) wave: u32,
    pub(crate) total_waves: u32,
    pub(crate) targets_completed: u32,
    pub(crate) targets_total: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) canary_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) wave_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) failure_threshold: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) failures: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) targets: Vec<AgentFleetTargetState>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentCompactionStatus {
    Completed,
    Failed,
}

#[allow(clippy::large_enum_variant)] // Wire vocabulary intentionally keeps session/created self-contained.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    content = "data",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentSessionEventPayload {
    #[serde(rename = "session/created")]
    SessionCreated {
        task_id: String,
        goal: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<AgentSessionTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        permission_mode: Option<AgentSessionPermissionMode>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        success_criteria: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capability_scope: Option<AgentCapabilityScope>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent: Option<AgentSubagentSession>,
    },
    #[serde(rename = "agent/created")]
    AgentCreated {
        agent_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_agent_id: Option<String>,
    },
    #[serde(rename = "agent/status")]
    AgentStatus {
        status: AgentSessionStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "session/ended")]
    SessionEnded {
        status: AgentSessionStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "agent/inbox/spliced")]
    InboxSpliced {
        operation: AgentInboxOperation,
        lane: AgentInboxLane,
        messages: Vec<AgentInboxMessage>,
    },
    #[serde(rename = "turn/start")]
    TurnStart,
    #[serde(rename = "turn/end")]
    TurnEnd { reason: String },
    #[serde(rename = "step/start")]
    StepStart,
    #[serde(rename = "step/end")]
    StepEnd { reason: String },
    #[serde(rename = "user/message")]
    UserMessage { message: AgentInboxMessage },
    #[serde(rename = "assistant/chunk")]
    AssistantChunk { request_id: String, text: String },
    #[serde(rename = "assistant/message")]
    AssistantMessage {
        message_id: String,
        content: String,
        #[serde(default)]
        tool_calls: Vec<RecordedToolCall>,
        #[serde(default)]
        interrupted: bool,
    },
    #[serde(rename = "request/header")]
    RequestHeader {
        request_id: String,
        provider_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt: Option<u32>,
    },
    #[serde(rename = "request/context")]
    RequestContext {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context_window: Option<u64>,
        surface_generation: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limited: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        omitted_messages: Option<u64>,
    },
    #[serde(rename = "request/retry")]
    RequestRetry {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous_request_id: Option<String>,
        attempt: u32,
        reason: String,
    },
    #[serde(rename = "request/usage")]
    RequestUsage {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_tokens: Option<u64>,
        finish_reason: String,
    },
    #[serde(rename = "tool/call")]
    ToolCall { call: RecordedToolCall },
    #[serde(rename = "tool/approval")]
    ToolApproval {
        request_id: String,
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        approval_id: Option<String>,
        status: AgentToolApprovalStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        risk: Option<AgentSessionEffect>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires_at_unix_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
    #[serde(rename = "tool/execution")]
    ToolExecution {
        call_id: String,
        status: AgentToolExecutionStatus,
        idempotency: String,
    },
    #[serde(rename = "tool/result")]
    ToolResult {
        call_id: String,
        name: String,
        status: AgentToolResultStatus,
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        evidence_refs: Vec<String>,
    },
    #[serde(rename = "context/artifact")]
    ContextArtifact {
        artifact_id: String,
        kind: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size_bytes: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sensitivity: Option<super::AgentArtifactSensitivity>,
    },
    #[serde(rename = "compaction/start")]
    CompactionStart { reason: String },
    #[serde(rename = "compaction/summary")]
    CompactionSummary {
        summary: String,
        replaced_through_seq: u64,
        surface_generation: u64,
    },
    #[serde(rename = "compaction/end")]
    CompactionEnd {
        surface_generation: u64,
        replaced_through_seq: u64,
        status: AgentCompactionStatus,
    },
    #[serde(rename = "subagent/descriptor")]
    SubagentDescriptor {
        descriptor_id: String,
        child_session_id: String,
        parent_session_id: String,
        parent_task_id: String,
        role: AgentSubagentRole,
        continuable: bool,
        depth: u16,
        inheritance: AgentSubagentInheritance,
        capability_scope: AgentCapabilityScope,
        target_scope: Vec<AgentSessionTarget>,
        budget: AgentSubagentBudget,
    },
    #[serde(rename = "subagent/message")]
    SubagentMessage {
        descriptor_id: String,
        child_session_id: String,
        direction: String,
        route: String,
        summary: String,
    },
    #[serde(rename = "subagent/settled")]
    SubagentSettled {
        descriptor_id: String,
        settlement_id: String,
        child_session_id: String,
        status: AgentSessionStatus,
        summary: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        evidence_refs: Vec<String>,
    },
    #[serde(rename = "subagent/detached")]
    SubagentDetached {
        descriptor_id: String,
        child_session_id: String,
        reason: String,
    },
    #[serde(rename = "task/linked")]
    TaskLinked {
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        goal: Option<String>,
    },
    #[serde(rename = "task/plan")]
    TaskPlan {
        version: u64,
        steps: Vec<AgentPlanStep>,
    },
    #[serde(rename = "task/state")]
    TaskState {
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        progress: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<AgentRecoveryState>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fleet: Option<AgentFleetState>,
    },
    #[serde(rename = "task/evidence")]
    TaskEvidence {
        evidence_id: String,
        kind: String,
        summary: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionEvent {
    pub(crate) version: u8,
    pub(crate) session_id: String,
    pub(crate) seq: u64,
    pub(crate) time_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) step_id: Option<String>,
    #[serde(flatten)]
    pub(crate) payload: AgentSessionEventPayload,
}

impl AgentSessionEvent {
    pub(crate) fn new(
        session_id: String,
        seq: u64,
        time_unix_ms: u64,
        turn_id: Option<String>,
        step_id: Option<String>,
        payload: AgentSessionEventPayload,
    ) -> Self {
        Self {
            version: AGENT_SESSION_EVENT_VERSION,
            session_id,
            seq,
            time_unix_ms,
            turn_id,
            step_id,
            payload,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_envelope_and_payload_fields_are_camel_case() {
        let event = AgentSessionEvent::new(
            "session-1".into(),
            7,
            1_000,
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::RequestContext {
                request_id: "request-1".into(),
                input_tokens: Some(42),
                context_window: Some(128),
                surface_generation: 3,
                limited: Some(true),
                omitted_messages: Some(2),
            },
        );
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["turnId"], "turn-1");
        assert_eq!(value["type"], "request/context");
        assert_eq!(value["data"]["requestId"], "request-1");
        assert_eq!(value["data"]["surfaceGeneration"], 3);
        assert!(value["data"].get("request_id").is_none());
    }

    #[test]
    fn payload_free_events_omit_data() {
        let value = serde_json::to_value(AgentSessionEvent::new(
            "session-1".into(),
            1,
            1_000,
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        ))
        .unwrap();
        assert_eq!(value["type"], "turn/start");
        assert!(value.get("data").is_none());
    }

    #[test]
    fn normalized_usage_has_the_same_discriminated_wire_shape_as_typescript() {
        let value = serde_json::to_value(AgentSessionEvent::new(
            "session-1".into(),
            1,
            1_000,
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::RequestUsage {
                request_id: "request-1".into(),
                input_tokens: Some(10),
                output_tokens: Some(2),
                total_tokens: Some(12),
                finish_reason: "toolCalls".into(),
            },
        ))
        .unwrap();
        assert_eq!(value["type"], "request/usage");
        assert_eq!(value["data"]["requestId"], "request-1");
        assert_eq!(value["data"]["totalTokens"], 12);
        assert_eq!(value["data"]["finishReason"], "toolCalls");
    }

    #[test]
    fn wire_decoder_rejects_unknown_envelope_and_payload_fields() {
        let unknown_envelope = serde_json::json!({
            "version": 1,
            "sessionId": "session-1",
            "seq": 0,
            "timeUnixMs": 1000,
            "type": "turn/start",
            "unexpected": true
        });
        assert!(serde_json::from_value::<AgentSessionEvent>(unknown_envelope).is_err());

        let unknown_payload = serde_json::json!({
            "version": 1,
            "sessionId": "session-1",
            "seq": 0,
            "timeUnixMs": 1000,
            "type": "request/context",
            "turnId": "turn-1",
            "stepId": "step-1",
            "data": {
                "requestId": "request-1",
                "surfaceGeneration": 0,
                "unexpected": true
            }
        });
        assert!(serde_json::from_value::<AgentSessionEvent>(unknown_payload).is_err());
    }
}
