use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const AGENT_CONTRACT_V3_VERSION: u8 = 3;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentPermissionModeV3 {
    RequestApproval,
    ScopedAutopilot,
    Operator,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRequestSourceV3 {
    V3,
    V2Compatibility,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AgentTargetKindV3 {
    Local,
    Remote,
    Process,
    Ui,
    Task,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentToolTargetV3 {
    Local {
        target_id: String,
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    Remote {
        target_id: String,
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
        host: String,
        port: u16,
        username: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        local_root: Option<String>,
    },
    Process {
        target_id: String,
        owner_target_id: String,
        process_handle: String,
    },
    Ui {
        target_id: String,
        surface_id: String,
    },
    Task {
        target_id: String,
        task_id: String,
    },
}

impl AgentToolTargetV3 {
    pub fn target_id(&self) -> &str {
        match self {
            Self::Local { target_id, .. }
            | Self::Remote { target_id, .. }
            | Self::Process { target_id, .. }
            | Self::Ui { target_id, .. }
            | Self::Task { target_id, .. } => target_id,
        }
    }

    pub fn kind(&self) -> AgentTargetKindV3 {
        match self {
            Self::Local { .. } => AgentTargetKindV3::Local,
            Self::Remote { .. } => AgentTargetKindV3::Remote,
            Self::Process { .. } => AgentTargetKindV3::Process,
            Self::Ui { .. } => AgentTargetKindV3::Ui,
            Self::Task { .. } => AgentTargetKindV3::Task,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequestV3 {
    pub contract_version: u8,
    pub request_id: String,
    pub user_session_id: String,
    pub task_id: String,
    pub goal: String,
    pub success_criteria: Vec<String>,
    pub targets: Vec<AgentToolTargetV3>,
    pub permission_mode: AgentPermissionModeV3,
    pub source_contract: AgentRequestSourceV3,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolCallV3 {
    pub request_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub arguments: Value,
    pub target: AgentToolTargetV3,
    pub capability_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AgentEffectKindV3 {
    None,
    ReadOnly,
    SensitiveRead,
    StateChange,
    Destructive,
    ExternalSideEffect,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentObservedEffectV3 {
    pub kind: AgentEffectKindV3,
    pub target_id: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network_destinations: Vec<AgentNetworkDestinationV3>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentNetworkDestinationV3 {
    pub protocol: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentArtifactRefV3 {
    pub artifact_id: String,
    pub kind: AgentArtifactKindV3,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentArtifactKindV3 {
    Text,
    Binary,
    Diff,
    Log,
    Report,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentToolResultStatusV3 {
    Completed,
    Rejected,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolResultV3 {
    pub request_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub target_id: String,
    pub status: AgentToolResultStatusV3,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<AgentArtifactRefV3>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<AgentObservedEffectV3>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentExecutionChannelV3 {
    Pty,
    Direct,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecCommandArgumentsV3 {
    pub command: String,
    pub explanation: String,
    pub channel: AgentExecutionChannelV3,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub background: Option<bool>,
    #[serde(default)]
    pub elevated: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteStdinArgumentsV3 {
    pub input: String,
    #[serde(default)]
    pub close: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitProcessArgumentsV3 {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_output_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProcessSignalV3 {
    Interrupt,
    Terminate,
    Kill,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KillProcessArgumentsV3 {
    pub signal: ProcessSignalV3,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileEncodingV3 {
    Utf8,
    Base64,
    MetadataOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadFileArgumentsV3 {
    pub path: String,
    pub encoding: FileEncodingV3,
    #[serde(default)]
    pub offset: Option<u64>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
    #[serde(default)]
    pub expected_sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListDirectoryArgumentsV3 {
    pub path: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub page_size: Option<u16>,
    #[serde(default)]
    pub include_hidden: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SearchModeV3 {
    Content,
    FileName,
    Both,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchTextArgumentsV3 {
    pub path: String,
    pub query: String,
    pub mode: SearchModeV3,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    pub globs: Vec<String>,
    #[serde(default)]
    pub max_results: Option<u16>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchPreconditionV3 {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyPatchArgumentsV3 {
    pub patch: String,
    pub preconditions: Vec<PatchPreconditionV3>,
    #[serde(default)]
    pub dry_run: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirectionV3 {
    Upload,
    Download,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferFileArgumentsV3 {
    pub direction: TransferDirectionV3,
    pub source_path: String,
    pub destination_path: String,
    pub overwrite: bool,
    #[serde(default)]
    pub expected_sha256: Option<String>,
    #[serde(default)]
    pub destination_sha256: Option<String>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HostSnapshotSectionV3 {
    Os,
    Resources,
    Services,
    Network,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSnapshotArgumentsV3 {
    pub sections: Vec<HostSnapshotSectionV3>,
    #[serde(default)]
    pub include_sensitive: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskUserChoiceV3 {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskUserArgumentsV3 {
    pub prompt: String,
    #[serde(default)]
    pub choices: Vec<AskUserChoiceV3>,
    pub allow_free_text: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlanStepStatusV3 {
    Pending,
    InProgress,
    Completed,
    Blocked,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStepV3 {
    pub id: String,
    pub description: String,
    pub dependencies: Vec<String>,
    pub target_ids: Vec<String>,
    pub required_tools: Vec<String>,
    pub expected_effect: AgentEffectKindV3,
    pub status: PlanStepStatusV3,
    pub success_criteria: Vec<String>,
    pub rollback_or_compensation: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePlanArgumentsV3 {
    pub plan_version: u64,
    #[serde(default)]
    pub explanation: Option<String>,
    pub steps: Vec<PlanStepV3>,
}
