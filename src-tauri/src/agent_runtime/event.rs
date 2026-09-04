use std::collections::BTreeMap;

use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub(crate) const AGENT_SESSION_EVENT_VERSION: u8 = 4;
pub(crate) const MAX_AGENT_MESSAGE_BYTES: usize = 128 * 1024;
pub(crate) const MAX_AGENT_STREAM_DELTA_BYTES: usize = 4 * 1024;

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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AgentMessageSourceKind {
    User,
    Runtime,
    Plugin,
    SkillCatalog,
    AgentInstructions,
    SkillInvocation,
    SessionReference,
    Form,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentMessageSource {
    pub(crate) kind: AgentMessageSourceKind,
    pub(crate) label: String,
    pub(crate) producer_id: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) metadata: BTreeMap<String, Value>,
}

impl AgentMessageSource {
    pub(crate) fn user() -> Self {
        Self {
            kind: AgentMessageSourceKind::User,
            label: "User".into(),
            producer_id: "shellspan-user".into(),
            metadata: BTreeMap::new(),
        }
    }

    pub(crate) fn runtime(label: String) -> Self {
        Self {
            kind: AgentMessageSourceKind::Runtime,
            label,
            producer_id: "shellspan-runtime".into(),
            metadata: BTreeMap::new(),
        }
    }

    pub(crate) fn runtime_context() -> Self {
        Self {
            kind: AgentMessageSourceKind::Runtime,
            label: "ShellSpan runtime context".into(),
            producer_id: "shellspan.runtime-context.v1".into(),
            metadata: BTreeMap::from([("form".into(), Value::String("snapshot".into()))]),
        }
    }

    pub(crate) fn agent_instructions(label: String) -> Self {
        Self {
            kind: AgentMessageSourceKind::AgentInstructions,
            label,
            producer_id: "shellspan.agent-instructions.v1".into(),
            metadata: BTreeMap::from([("form".into(), Value::String("instructions".into()))]),
        }
    }

    pub(crate) fn session_reference(session_id: String) -> Self {
        Self {
            kind: AgentMessageSourceKind::SessionReference,
            label: "Subagent session".into(),
            producer_id: "shellspan-subagent".into(),
            metadata: BTreeMap::from([("sessionId".into(), Value::String(session_id))]),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentInboxMessage {
    pub(crate) message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) client_submission_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) retry_policy: Option<serde_json::Value>,
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

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTokenUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) uncached_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_write_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentStopReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Cancelled,
    Error,
    Other,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRequestReason {
    Initial,
    Retry,
    ToolContinuation,
    Recovery,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRequestSnapshotReason {
    Initial,
    Change,
    Resume,
    Series,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRequestSeries {
    pub(crate) series_id: String,
    pub(crate) request_index: u32,
    pub(crate) starts_series: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRequestToolSchema {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentToolCallDelta {
    pub(crate) index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) name_delta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) arguments_delta: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentAssistantContentBlock {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_item: Option<Value>,
    },
    ToolCall {
        call: Box<RecordedToolCall>,
    },
}

pub(crate) fn assistant_content_text(content: &[AgentAssistantContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            AgentAssistantContentBlock::Text { text } => Some(text.as_str()),
            AgentAssistantContentBlock::Reasoning { .. }
            | AgentAssistantContentBlock::ToolCall { .. } => None,
        })
        .collect()
}

pub(crate) fn assistant_tool_calls(
    content: &[AgentAssistantContentBlock],
) -> Vec<RecordedToolCall> {
    content
        .iter()
        .filter_map(|block| match block {
            AgentAssistantContentBlock::ToolCall { call } => Some((**call).clone()),
            AgentAssistantContentBlock::Text { .. }
            | AgentAssistantContentBlock::Reasoning { .. } => None,
        })
        .collect()
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
    #[serde(rename = "agent/inbox/item_updated")]
    InboxItemUpdated {
        item_id: String,
        lane: AgentInboxLane,
        content: String,
        previous_revision: u64,
        client_operation_id: String,
    },
    #[serde(rename = "agent/inbox/item_removed")]
    InboxItemRemoved {
        item_id: String,
        lane: AgentInboxLane,
        previous_revision: u64,
        client_operation_id: String,
    },
    #[serde(rename = "agent/inbox/reordered")]
    InboxReordered {
        lane: AgentInboxLane,
        ordered_item_ids: Vec<String>,
        previous_revision: u64,
        client_operation_id: String,
    },
    #[serde(rename = "session/renamed")]
    SessionRenamed {
        title: String,
        previous_revision: u64,
        client_operation_id: String,
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
    AssistantChunk {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text_delta: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_delta: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_delta: Option<AgentToolCallDelta>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<AgentTokenUsage>,
    },
    #[serde(rename = "assistant/message")]
    AssistantMessage {
        message_id: String,
        content: Vec<AgentAssistantContentBlock>,
        usage: AgentTokenUsage,
        stop_reason: AgentStopReason,
        interrupted: bool,
    },
    #[serde(rename = "request/header")]
    RequestHeader {
        request_id: String,
        provider_id: String,
        model: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
        reason: AgentRequestReason,
        series: AgentRequestSeries,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot_reason: Option<AgentRequestSnapshotReason>,
        system_prompt: String,
        tool_schemas: Vec<AgentRequestToolSchema>,
        attempt: u32,
    },
    #[serde(rename = "request/start")]
    RequestStart {
        request_id: String,
        header_request_id: String,
        provider_id: String,
        model: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
        reason: AgentRequestReason,
        series: AgentRequestSeries,
        attempt: u32,
    },
    #[serde(rename = "request/context")]
    RequestContext {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context_window: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        system_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_schema_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_tokens: Option<u64>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delay_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cumulative_delay_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_retry_after_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        server_hint_capped: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_status: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
    },
    #[serde(rename = "request/failure")]
    RequestFailure {
        request_id: String,
        attempt: u32,
        max_attempts: u32,
        cumulative_delay_ms: u64,
        interrupted: bool,
        failure: super::model::NormalizedModelError,
    },
    #[serde(rename = "request/usage")]
    RequestUsage {
        request_id: String,
        usage: AgentTokenUsage,
        finish_reason: AgentStopReason,
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
    #[serde(deserialize_with = "deserialize_event_version")]
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

fn deserialize_event_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u8::deserialize(deserializer)?;
    if version == AGENT_SESSION_EVENT_VERSION {
        Ok(version)
    } else {
        Err(de::Error::custom(format!(
            "unsupported Agent Session event version {version}; expected {AGENT_SESSION_EVENT_VERSION}"
        )))
    }
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
                system_tokens: Some(8),
                tool_schema_tokens: Some(12),
                message_tokens: Some(22),
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
        assert_eq!(value["data"]["systemTokens"], 8);
        assert_eq!(value["data"]["toolSchemaTokens"], 12);
        assert_eq!(value["data"]["messageTokens"], 22);
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
                usage: AgentTokenUsage {
                    uncached_input_tokens: Some(10),
                    output_tokens: Some(2),
                    total_tokens: Some(12),
                    ..AgentTokenUsage::default()
                },
                finish_reason: AgentStopReason::ToolCalls,
            },
        ))
        .unwrap();
        assert_eq!(value["type"], "request/usage");
        assert_eq!(value["data"]["requestId"], "request-1");
        assert_eq!(value["data"]["usage"]["totalTokens"], 12);
        assert_eq!(value["data"]["finishReason"], "toolCalls");
    }

    #[test]
    fn usage_preserves_unknown_and_real_zero() {
        let value = serde_json::to_value(AgentTokenUsage {
            uncached_input_tokens: None,
            cache_read_tokens: Some(0),
            cache_write_tokens: None,
            output_tokens: Some(0),
            reasoning_tokens: None,
            total_tokens: Some(0),
        })
        .unwrap();
        assert!(value.get("uncachedInputTokens").is_none());
        assert_eq!(value["cacheReadTokens"], 0);
        assert_eq!(value["outputTokens"], 0);
        assert_eq!(value["totalTokens"], 0);
    }

    #[test]
    fn decoder_rejects_pre_v4_envelopes() {
        for version in [2, 3] {
            let old = serde_json::json!({
                "version": version,
                "sessionId": "session-1",
                "seq": 0,
                "timeUnixMs": 1000,
                "type": "turn/start"
            });
            let error = serde_json::from_value::<AgentSessionEvent>(old).unwrap_err();
            assert!(error.to_string().contains("expected 4"));
        }
    }

    #[test]
    fn cross_language_v4_fixture_round_trips_without_field_loss() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/test/fixtures/agent-session-v4.json"
        ));
        let expected = serde_json::from_str::<Value>(raw).unwrap();
        let events = serde_json::from_str::<Vec<AgentSessionEvent>>(raw).unwrap();
        assert_eq!(events.len(), 15);
        assert!(events
            .iter()
            .all(|event| event.version == AGENT_SESSION_EVENT_VERSION));
        assert_eq!(serde_json::to_value(events).unwrap(), expected);
    }

    #[test]
    fn wire_decoder_rejects_unknown_envelope_and_payload_fields() {
        let unknown_envelope = serde_json::json!({
            "version": 4,
            "sessionId": "session-1",
            "seq": 0,
            "timeUnixMs": 1000,
            "type": "turn/start",
            "unexpected": true
        });
        assert!(serde_json::from_value::<AgentSessionEvent>(unknown_envelope).is_err());

        let unknown_payload = serde_json::json!({
            "version": 4,
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
