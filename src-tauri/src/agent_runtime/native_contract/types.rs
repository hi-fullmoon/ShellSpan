use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const NATIVE_TOOL_CONTRACT_VERSION: u8 = 3;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentPermissionModeNative {
    RequestApproval,
    ScopedAutopilot,
    Operator,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AgentTargetKindNative {
    Local,
    Remote,
    Process,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentToolTargetNative {
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
}

impl AgentToolTargetNative {
    pub fn target_id(&self) -> &str {
        match self {
            Self::Local { target_id, .. }
            | Self::Remote { target_id, .. }
            | Self::Process { target_id, .. } => target_id,
        }
    }

    pub fn kind(&self) -> AgentTargetKindNative {
        match self {
            Self::Local { .. } => AgentTargetKindNative::Local,
            Self::Remote { .. } => AgentTargetKindNative::Remote,
            Self::Process { .. } => AgentTargetKindNative::Process,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequestNative {
    pub contract_version: u8,
    pub request_id: String,
    pub user_session_id: String,
    pub task_id: String,
    pub goal: String,
    pub success_criteria: Vec<String>,
    pub targets: Vec<AgentToolTargetNative>,
    pub permission_mode: AgentPermissionModeNative,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolCallNative {
    pub request_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub arguments: Value,
    pub target: AgentToolTargetNative,
    pub capability_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AgentEffectKindNative {
    None,
    ReadOnly,
    SensitiveRead,
    StateChange,
    Destructive,
    ExternalSideEffect,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentObservedEffectNative {
    pub kind: AgentEffectKindNative,
    pub target_id: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network_destinations: Vec<AgentNetworkDestinationNative>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentNetworkDestinationNative {
    pub protocol: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentArtifactRefNative {
    pub artifact_id: String,
    pub kind: AgentArtifactKindNative,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentArtifactKindNative {
    Text,
    Binary,
    Diff,
    Log,
    Report,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentToolResultStatusNative {
    Completed,
    Rejected,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolResultNative {
    pub request_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub target_id: String,
    pub status: AgentToolResultStatusNative,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<AgentArtifactRefNative>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<AgentObservedEffectNative>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentExecutionChannelNative {
    Pty,
    Direct,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecCommandArgumentsNative {
    pub command: String,
    pub explanation: String,
    pub channel: AgentExecutionChannelNative,
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
pub struct WriteStdinArgumentsNative {
    pub input: String,
    #[serde(default)]
    pub close: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitProcessArgumentsNative {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_output_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProcessSignalNative {
    Interrupt,
    Terminate,
    Kill,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KillProcessArgumentsNative {
    pub signal: ProcessSignalNative,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileEncodingNative {
    Utf8,
    Base64,
    MetadataOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadFileArgumentsNative {
    pub path: String,
    pub encoding: FileEncodingNative,
    #[serde(default)]
    pub offset: Option<u64>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
    #[serde(default)]
    pub expected_sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListDirectoryArgumentsNative {
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
pub enum SearchModeNative {
    Content,
    FileName,
    Both,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchTextArgumentsNative {
    pub path: String,
    pub query: String,
    pub mode: SearchModeNative,
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
pub struct PatchPreconditionNative {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyPatchArgumentsNative {
    pub patch: String,
    pub preconditions: Vec<PatchPreconditionNative>,
    #[serde(default)]
    pub dry_run: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirectionNative {
    Upload,
    Download,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferFileArgumentsNative {
    pub direction: TransferDirectionNative,
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
