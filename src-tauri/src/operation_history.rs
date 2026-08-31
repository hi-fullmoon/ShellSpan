use crate::db::{current_timestamp_ms, Database};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use tauri::State;

use crate::agent_contract::AgentPermissionMode;

const DEFAULT_RETENTION_DAYS: u16 = 90;
const RETENTION_PREFERENCE_KEY: &str = "operationHistoryRetentionDays";
const MAX_STORED_EVENTS: usize = 20_000;
const MAX_EXPORTED_TASKS: usize = 5_000;
const REDACTED_COMMAND: &str = "[REDACTED COMMAND]";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationCategory {
    Agent,
    Connection,
    Terminal,
    Sftp,
    LocalFile,
    PortForward,
    RemoteHealth,
    Runbook,
    MultiHost,
}

impl OperationCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Connection => "connection",
            Self::Terminal => "terminal",
            Self::Sftp => "sftp",
            Self::LocalFile => "localFile",
            Self::PortForward => "portForward",
            Self::RemoteHealth => "remoteHealth",
            Self::Runbook => "runbook",
            Self::MultiHost => "multiHost",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "agent" => Ok(Self::Agent),
            "connection" => Ok(Self::Connection),
            "terminal" => Ok(Self::Terminal),
            "sftp" => Ok(Self::Sftp),
            "localFile" => Ok(Self::LocalFile),
            "portForward" => Ok(Self::PortForward),
            "remoteHealth" => Ok(Self::RemoteHealth),
            "runbook" => Ok(Self::Runbook),
            "multiHost" => Ok(Self::MultiHost),
            _ => Err(format!("unknown operation category: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationEventKind {
    Started,
    Approved,
    Rejected,
    Paused,
    Resumed,
    Skipped,
    RetryRequested,
    CancelRequested,
    Completed,
    Failed,
    StatusChanged,
    EvidenceLinked,
}

impl OperationEventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Paused => "paused",
            Self::Resumed => "resumed",
            Self::Skipped => "skipped",
            Self::RetryRequested => "retryRequested",
            Self::CancelRequested => "cancelRequested",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::StatusChanged => "statusChanged",
            Self::EvidenceLinked => "evidenceLinked",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "started" => Ok(Self::Started),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            "paused" => Ok(Self::Paused),
            "resumed" => Ok(Self::Resumed),
            "skipped" => Ok(Self::Skipped),
            "retryRequested" => Ok(Self::RetryRequested),
            "cancelRequested" => Ok(Self::CancelRequested),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "statusChanged" => Ok(Self::StatusChanged),
            "evidenceLinked" => Ok(Self::EvidenceLinked),
            _ => Err(format!("unknown operation event kind: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelling,
    Cancelled,
    TimedOut,
    PartialSuccess,
    IdentityMismatch,
    Unauthorized,
    Rejected,
    Skipped,
    Paused,
    Stopped,
    Recovered,
}

impl OperationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelling => "cancelling",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timedOut",
            Self::PartialSuccess => "partialSuccess",
            Self::IdentityMismatch => "identityMismatch",
            Self::Unauthorized => "unauthorized",
            Self::Rejected => "rejected",
            Self::Skipped => "skipped",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
            Self::Recovered => "recovered",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "cancelling" => Ok(Self::Cancelling),
            "cancelled" => Ok(Self::Cancelled),
            "timedOut" => Ok(Self::TimedOut),
            "partialSuccess" => Ok(Self::PartialSuccess),
            "identityMismatch" => Ok(Self::IdentityMismatch),
            "unauthorized" => Ok(Self::Unauthorized),
            "rejected" => Ok(Self::Rejected),
            "skipped" => Ok(Self::Skipped),
            "paused" => Ok(Self::Paused),
            "stopped" => Ok(Self::Stopped),
            "recovered" => Ok(Self::Recovered),
            _ => Err(format!("unknown operation status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationRisk {
    ReadOnly,
    StateChange,
    Destructive,
}

impl OperationRisk {
    fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "readOnly",
            Self::StateChange => "stateChange",
            Self::Destructive => "destructive",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "readOnly" => Ok(Self::ReadOnly),
            "stateChange" => Ok(Self::StateChange),
            "destructive" => Ok(Self::Destructive),
            _ => Err(format!("unknown operation risk: {value}")),
        }
    }
}

fn permission_mode_str(mode: AgentPermissionMode) -> &'static str {
    match mode {
        AgentPermissionMode::RequestApproval => "requestApproval",
        AgentPermissionMode::AutoApproveReadOnly => "autoApproveReadOnly",
        AgentPermissionMode::FullAccess => "fullAccess",
    }
}

fn parse_permission_mode(value: &str) -> Result<AgentPermissionMode, String> {
    match value {
        "requestApproval" => Ok(AgentPermissionMode::RequestApproval),
        "autoApproveReadOnly" => Ok(AgentPermissionMode::AutoApproveReadOnly),
        "fullAccess" => Ok(AgentPermissionMode::FullAccess),
        _ => Err(format!("unknown Agent permission mode: {value}")),
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationTargetKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationTarget {
    kind: OperationTargetKind,
    profile_id: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    session_id: Option<String>,
    identity_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationEvidenceKind {
    Approval,
    ConnectionPreflight,
    HealthSnapshot,
    RunbookStep,
    TransferResult,
    Operation,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationEvidenceReference {
    operation_id: String,
    kind: OperationEvidenceKind,
    observed_at: Option<i64>,
    digest: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationErrorCategory {
    ApprovalRejected,
    Authentication,
    Timeout,
    Network,
    Permission,
    NotFound,
    Conflict,
    Storage,
    HostKey,
    Cancelled,
    IdentityMismatch,
    StaleEvidence,
    TargetChanged,
    CredentialUnavailable,
    Provider,
    StepLimit,
    ToolCallingUnsupported,
    ToolCallingUnverified,
    Unknown,
}

impl OperationErrorCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::ApprovalRejected => "approvalRejected",
            Self::Authentication => "authentication",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Permission => "permission",
            Self::NotFound => "notFound",
            Self::Conflict => "conflict",
            Self::Storage => "storage",
            Self::HostKey => "hostKey",
            Self::Cancelled => "cancelled",
            Self::IdentityMismatch => "identityMismatch",
            Self::StaleEvidence => "staleEvidence",
            Self::TargetChanged => "targetChanged",
            Self::CredentialUnavailable => "credentialUnavailable",
            Self::Provider => "provider",
            Self::StepLimit => "stepLimit",
            Self::ToolCallingUnsupported => "toolCallingUnsupported",
            Self::ToolCallingUnverified => "toolCallingUnverified",
            Self::Unknown => "unknown",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "approvalRejected" => Ok(Self::ApprovalRejected),
            "authentication" => Ok(Self::Authentication),
            "timeout" => Ok(Self::Timeout),
            "network" => Ok(Self::Network),
            "permission" => Ok(Self::Permission),
            "notFound" => Ok(Self::NotFound),
            "conflict" => Ok(Self::Conflict),
            "storage" => Ok(Self::Storage),
            "hostKey" => Ok(Self::HostKey),
            "cancelled" => Ok(Self::Cancelled),
            "identityMismatch" => Ok(Self::IdentityMismatch),
            "staleEvidence" => Ok(Self::StaleEvidence),
            "targetChanged" => Ok(Self::TargetChanged),
            "credentialUnavailable" => Ok(Self::CredentialUnavailable),
            "provider" => Ok(Self::Provider),
            "stepLimit" => Ok(Self::StepLimit),
            "toolCallingUnsupported" => Ok(Self::ToolCallingUnsupported),
            "toolCallingUnverified" => Ok(Self::ToolCallingUnverified),
            "unknown" => Ok(Self::Unknown),
            _ => Err(format!("unknown operation error category: {value}")),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordOperationEventRequest {
    event_id: String,
    task_id: String,
    operation_id: String,
    parent_operation_id: Option<String>,
    occurred_at: i64,
    category: OperationCategory,
    action: String,
    event_kind: OperationEventKind,
    status: OperationStatus,
    risk: Option<OperationRisk>,
    subject_id: Option<String>,
    #[serde(default)]
    targets: Vec<OperationTarget>,
    command_preview: Option<String>,
    #[serde(default)]
    evidence: Vec<OperationEvidenceReference>,
    error_category: Option<OperationErrorCategory>,
    retry_of_operation_id: Option<String>,
    item_count: Option<u64>,
    byte_count: Option<u64>,
    exit_code: Option<i32>,
    permission_mode: Option<AgentPermissionMode>,
    human_approved: Option<bool>,
    batch_index: Option<u32>,
    batch_total: Option<u32>,
    concurrency_limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationHistoryEvent {
    event_id: String,
    task_id: String,
    operation_id: String,
    parent_operation_id: Option<String>,
    occurred_at: i64,
    category: OperationCategory,
    action: String,
    event_kind: OperationEventKind,
    status: OperationStatus,
    risk: Option<OperationRisk>,
    subject_id: Option<String>,
    targets: Vec<OperationTarget>,
    command_preview: Option<String>,
    evidence: Vec<OperationEvidenceReference>,
    error_category: Option<OperationErrorCategory>,
    retry_of_operation_id: Option<String>,
    item_count: Option<u64>,
    byte_count: Option<u64>,
    exit_code: Option<i32>,
    permission_mode: Option<AgentPermissionMode>,
    human_approved: Option<bool>,
    batch_index: Option<u32>,
    batch_total: Option<u32>,
    concurrency_limit: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationHistoryFilter {
    category: Option<OperationCategory>,
    status: Option<OperationStatus>,
    task_id: Option<String>,
    action: Option<String>,
    profile_id: Option<String>,
    search: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListOperationHistoryRequest {
    #[serde(default)]
    filter: OperationHistoryFilter,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationHistoryPage {
    events: Vec<OperationHistoryEvent>,
    total_tasks: usize,
    truncated: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationHistoryExportFormat {
    Markdown,
    Json,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportOperationHistoryRequest {
    format: OperationHistoryExportFormat,
    #[serde(default)]
    filter: OperationHistoryFilter,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationHistorySettings {
    retention_days: u16,
    default_local_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonExport<'a> {
    schema_version: u8,
    exported_at: i64,
    redacted: bool,
    local_only: bool,
    events: &'a [OperationHistoryEvent],
}

const ALLOWED_ACTIONS: &[&str] = &[
    "detectAgentProviderCapability",
    "runAgentTask",
    "connectRemoteSession",
    "connectLocalSession",
    "closeSession",
    "connectionPreflight",
    "trustHostKey",
    "removeKnownHost",
    "connectSftp",
    "disconnectSftp",
    "createRemoteEntry",
    "renameRemotePath",
    "deleteRemotePath",
    "copyRemotePath",
    "copyRemoteToRemote",
    "uploadFiles",
    "downloadFiles",
    "updateRemotePermissions",
    "copyLocalPaths",
    "renameLocalPath",
    "pasteLocalPaths",
    "trashLocalPaths",
    "startPortForward",
    "stopPortForward",
    "stopAllPortForwards",
    "collectRemoteHealth",
    "executeRunbookStep",
    "executeAgentCommand",
    "executeMultiHostRunbook",
];

fn valid_identifier(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

fn valid_text(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len && !value.chars().any(char::is_control)
}

fn sanitize_command_preview(
    category: OperationCategory,
    action: &str,
    preview: Option<String>,
) -> Option<String> {
    let preview = preview?;
    if !(matches!(
        category,
        OperationCategory::Runbook | OperationCategory::MultiHost
    ) || matches!(
        category,
        OperationCategory::Agent | OperationCategory::Terminal
    ) && action == "executeAgentCommand")
        || preview.is_empty()
    {
        return None;
    }
    if preview.len() > 8 * 1024
        || preview
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
        || crate::runbook::contains_secret_literal(&preview)
    {
        return Some(REDACTED_COMMAND.to_string());
    }
    Some(preview)
}

fn validate_target(target: &OperationTarget) -> Result<(), String> {
    if target
        .profile_id
        .as_deref()
        .is_some_and(|value| !valid_identifier(value, 160))
        || target
            .session_id
            .as_deref()
            .is_some_and(|value| !valid_identifier(value, 160))
        || target
            .host
            .as_deref()
            .is_some_and(|value| !valid_text(value, 255))
        || target
            .username
            .as_deref()
            .is_some_and(|value| !valid_text(value, 255))
        || target
            .identity_fingerprint
            .as_deref()
            .is_some_and(|value| !valid_text(value, 512))
    {
        return Err("operation history target contains an invalid identity field".to_string());
    }
    if target.kind == OperationTargetKind::Remote
        && (target.host.is_none() || target.port.is_none())
    {
        return Err("remote operation history target is incomplete".to_string());
    }
    Ok(())
}

fn normalize_request(
    mut request: RecordOperationEventRequest,
) -> Result<OperationHistoryEvent, String> {
    if !valid_identifier(&request.event_id, 200)
        || !valid_identifier(&request.task_id, 200)
        || !valid_identifier(&request.operation_id, 200)
        || request
            .parent_operation_id
            .as_deref()
            .is_some_and(|value| !valid_identifier(value, 200))
        || request
            .retry_of_operation_id
            .as_deref()
            .is_some_and(|value| !valid_identifier(value, 200))
        || request
            .subject_id
            .as_deref()
            .is_some_and(|value| !valid_identifier(value, 160))
    {
        return Err("operation history contains an invalid identifier".to_string());
    }
    if !ALLOWED_ACTIONS.contains(&request.action.as_str()) {
        return Err("operation history action is not allowed".to_string());
    }
    if request.action == "executeAgentCommand" {
        if !matches!(
            request.category,
            OperationCategory::Agent | OperationCategory::Terminal
        ) || request.permission_mode.is_none()
            || request.human_approved.is_none()
        {
            return Err("Agent operation history is missing permission metadata".to_string());
        }
    } else if request.permission_mode.is_some() || request.human_approved.is_some() {
        return Err("permission metadata is only valid for Agent operations".to_string());
    }
    if request.occurred_at <= 0 || request.occurred_at > current_timestamp_ms() + 300_000 {
        return Err("operation history timestamp is invalid".to_string());
    }
    if request.targets.len() > 64 || request.evidence.len() > 64 {
        return Err(
            "operation history contains too many targets or evidence references".to_string(),
        );
    }
    for target in &request.targets {
        validate_target(target)?;
    }
    for evidence in &request.evidence {
        if !valid_identifier(&evidence.operation_id, 200)
            || evidence
                .digest
                .as_deref()
                .is_some_and(|value| !valid_identifier(value, 256))
        {
            return Err("operation history evidence reference is invalid".to_string());
        }
    }
    request.command_preview =
        sanitize_command_preview(request.category, &request.action, request.command_preview);
    Ok(OperationHistoryEvent {
        event_id: request.event_id,
        task_id: request.task_id,
        operation_id: request.operation_id,
        parent_operation_id: request.parent_operation_id,
        occurred_at: request.occurred_at,
        category: request.category,
        action: request.action,
        event_kind: request.event_kind,
        status: request.status,
        risk: request.risk,
        subject_id: request.subject_id,
        targets: request.targets,
        command_preview: request.command_preview,
        evidence: request.evidence,
        error_category: request.error_category,
        retry_of_operation_id: request.retry_of_operation_id,
        item_count: request.item_count,
        byte_count: request.byte_count,
        exit_code: request.exit_code,
        permission_mode: request.permission_mode,
        human_approved: request.human_approved,
        batch_index: request.batch_index,
        batch_total: request.batch_total,
        concurrency_limit: request.concurrency_limit,
    })
}

fn retention_days(database: &Database) -> Result<u16, String> {
    database.with_connection(|conn| {
        let value = conn
            .query_row(
                "SELECT value FROM preferences WHERE key=?1",
                params![RETENTION_PREFERENCE_KEY],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(value
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|days| *days == 0 || (1..=3_650).contains(days))
            .unwrap_or(DEFAULT_RETENTION_DAYS))
    })
}

fn prune(database: &Database, days: u16) -> Result<usize, String> {
    if days == 0 {
        return Ok(0);
    }
    let cutoff = current_timestamp_ms() - i64::from(days) * 86_400_000;
    database.with_connection(|conn| {
        conn.execute(
            "DELETE FROM operation_history_events WHERE occurred_at < ?1",
            params![cutoff],
        )
        .map_err(|error| format!("failed to prune operation history: {error}"))
    })
}

fn insert(database: &Database, event: &OperationHistoryEvent) -> Result<(), String> {
    let targets_json = serde_json::to_string(&event.targets)
        .map_err(|error| format!("failed to encode operation targets: {error}"))?;
    let evidence_json = serde_json::to_string(&event.evidence)
        .map_err(|error| format!("failed to encode operation evidence: {error}"))?;
    let primary_profile_id = event
        .targets
        .iter()
        .find_map(|target| target.profile_id.as_deref());
    database.with_connection(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO operation_history_events (
                event_id, task_id, operation_id, parent_operation_id, occurred_at,
                category, action, event_kind, status, risk, subject_id,
                primary_profile_id, targets_json, command_preview, evidence_json,
                error_category, retry_of_operation_id, item_count, byte_count,
                exit_code, batch_index, batch_total, concurrency_limit,
                permission_mode, human_approved, created_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
                ?25, ?26
             )",
            params![
                event.event_id,
                event.task_id,
                event.operation_id,
                event.parent_operation_id,
                event.occurred_at,
                event.category.as_str(),
                event.action,
                event.event_kind.as_str(),
                event.status.as_str(),
                event.risk.map(OperationRisk::as_str),
                event.subject_id,
                primary_profile_id,
                targets_json,
                event.command_preview,
                evidence_json,
                event.error_category.map(OperationErrorCategory::as_str),
                event.retry_of_operation_id,
                event.item_count.and_then(|value| i64::try_from(value).ok()),
                event.byte_count.and_then(|value| i64::try_from(value).ok()),
                event.exit_code,
                event.batch_index,
                event.batch_total,
                event.concurrency_limit,
                event.permission_mode.map(permission_mode_str),
                event.human_approved,
                current_timestamp_ms(),
            ],
        )
        .map(|_| ())
        .map_err(|error| format!("failed to persist operation history: {error}"))
    })
}

fn conversion_error(index: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn load_events(database: &Database) -> Result<(Vec<OperationHistoryEvent>, bool), String> {
    database.with_connection(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT event_id, task_id, operation_id, parent_operation_id, occurred_at,
                        category, action, event_kind, status, risk, subject_id,
                        targets_json, command_preview, evidence_json, error_category,
                        retry_of_operation_id, item_count, byte_count, exit_code,
                        batch_index, batch_total, concurrency_limit,
                        permission_mode, human_approved
                 FROM operation_history_events
                 ORDER BY occurred_at DESC, created_at DESC
                 LIMIT ?1",
            )
            .map_err(|error| format!("failed to prepare operation history query: {error}"))?;
        let rows = statement
            .query_map(params![(MAX_STORED_EVENTS + 1) as i64], |row| {
                let category = OperationCategory::parse(&row.get::<_, String>(5)?)
                    .map_err(|error| conversion_error(5, error))?;
                let event_kind = OperationEventKind::parse(&row.get::<_, String>(7)?)
                    .map_err(|error| conversion_error(7, error))?;
                let status = OperationStatus::parse(&row.get::<_, String>(8)?)
                    .map_err(|error| conversion_error(8, error))?;
                let risk = row
                    .get::<_, Option<String>>(9)?
                    .map(|value| OperationRisk::parse(&value))
                    .transpose()
                    .map_err(|error| conversion_error(9, error))?;
                let targets_json: String = row.get(11)?;
                let targets = serde_json::from_str(&targets_json)
                    .map_err(|error| conversion_error(11, error.to_string()))?;
                let evidence_json: String = row.get(13)?;
                let evidence = serde_json::from_str(&evidence_json)
                    .map_err(|error| conversion_error(13, error.to_string()))?;
                let error_category = row
                    .get::<_, Option<String>>(14)?
                    .map(|value| OperationErrorCategory::parse(&value))
                    .transpose()
                    .map_err(|error| conversion_error(14, error))?;
                let permission_mode = row
                    .get::<_, Option<String>>(22)?
                    .map(|value| parse_permission_mode(&value))
                    .transpose()
                    .map_err(|error| conversion_error(22, error))?;
                Ok(OperationHistoryEvent {
                    event_id: row.get(0)?,
                    task_id: row.get(1)?,
                    operation_id: row.get(2)?,
                    parent_operation_id: row.get(3)?,
                    occurred_at: row.get(4)?,
                    category,
                    action: row.get(6)?,
                    event_kind,
                    status,
                    risk,
                    subject_id: row.get(10)?,
                    targets,
                    command_preview: row.get(12)?,
                    evidence,
                    error_category,
                    retry_of_operation_id: row.get(15)?,
                    item_count: row
                        .get::<_, Option<i64>>(16)?
                        .and_then(|value| value.try_into().ok()),
                    byte_count: row
                        .get::<_, Option<i64>>(17)?
                        .and_then(|value| value.try_into().ok()),
                    exit_code: row.get(18)?,
                    permission_mode,
                    human_approved: row.get(23)?,
                    batch_index: row.get(19)?,
                    batch_total: row.get(20)?,
                    concurrency_limit: row.get(21)?,
                })
            })
            .map_err(|error| format!("failed to query operation history: {error}"))?;
        let mut events = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode operation history: {error}"))?;
        let truncated = events.len() > MAX_STORED_EVENTS;
        events.truncate(MAX_STORED_EVENTS);
        Ok((events, truncated))
    })
}

fn event_matches(event: &OperationHistoryEvent, filter: &OperationHistoryFilter) -> bool {
    if filter.category.is_some_and(|value| event.category != value)
        || filter.status.is_some_and(|value| event.status != value)
        || filter
            .task_id
            .as_deref()
            .is_some_and(|value| event.task_id != value)
        || filter
            .action
            .as_deref()
            .is_some_and(|value| event.action != value)
        || filter.from.is_some_and(|value| event.occurred_at < value)
        || filter.to.is_some_and(|value| event.occurred_at > value)
        || filter.profile_id.as_deref().is_some_and(|profile_id| {
            !event
                .targets
                .iter()
                .any(|target| target.profile_id.as_deref() == Some(profile_id))
        })
    {
        return false;
    }
    let Some(search) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    let search = search.to_lowercase();
    event.task_id.to_lowercase().contains(&search)
        || event.operation_id.to_lowercase().contains(&search)
        || event.action.to_lowercase().contains(&search)
        || event
            .subject_id
            .as_deref()
            .is_some_and(|value| value.to_lowercase().contains(&search))
        || event
            .command_preview
            .as_deref()
            .is_some_and(|value| value.to_lowercase().contains(&search))
        || event.targets.iter().any(|target| {
            [
                target.profile_id.as_deref(),
                target.host.as_deref(),
                target.username.as_deref(),
                target.session_id.as_deref(),
                target.identity_fingerprint.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_lowercase().contains(&search))
        })
}

fn filtered_page(
    database: &Database,
    filter: &OperationHistoryFilter,
    limit: usize,
) -> Result<OperationHistoryPage, String> {
    let (events, truncated) = load_events(database)?;
    let mut matching_tasks = Vec::new();
    let mut seen = HashSet::new();
    for event in &events {
        if event_matches(event, filter) && seen.insert(event.task_id.clone()) {
            matching_tasks.push(event.task_id.clone());
        }
    }
    let total_tasks = matching_tasks.len();
    matching_tasks.truncate(limit);
    let selected = matching_tasks.into_iter().collect::<HashSet<_>>();
    Ok(OperationHistoryPage {
        events: events
            .into_iter()
            .filter(|event| selected.contains(&event.task_id))
            .collect(),
        total_tasks,
        truncated,
    })
}

fn render_json(events: &[OperationHistoryEvent]) -> Result<String, String> {
    serde_json::to_string_pretty(&JsonExport {
        schema_version: 1,
        exported_at: current_timestamp_ms(),
        redacted: true,
        local_only: true,
        events,
    })
    .map_err(|error| format!("failed to render operation history JSON: {error}"))
}

fn markdown_escape(value: &str) -> String {
    value.replace('|', "\\|").replace(['\n', '\r'], " ")
}

fn render_markdown(events: &[OperationHistoryEvent]) -> String {
    let mut by_task: HashMap<&str, Vec<&OperationHistoryEvent>> = HashMap::new();
    let mut task_order = Vec::new();
    for event in events {
        if !by_task.contains_key(event.task_id.as_str()) {
            task_order.push(event.task_id.as_str());
        }
        by_task.entry(&event.task_id).or_default().push(event);
    }
    let mut output = format!(
        "# ShellSpan operation history\n\n- Exported at: {}\n- Redacted: yes\n- Storage: local only\n\n",
        current_timestamp_ms()
    );
    for task_id in task_order {
        let mut task_events = by_task.remove(task_id).unwrap_or_default();
        task_events.sort_by_key(|event| event.occurred_at);
        output.push_str(&format!("## Task `{}`\n\n", markdown_escape(task_id)));
        output.push_str(
            "| Time (Unix ms) | Operation | Action | Event | Status | Target | Evidence |\n",
        );
        output.push_str("| ---: | --- | --- | --- | --- | --- | --- |\n");
        for event in &task_events {
            let targets = event
                .targets
                .iter()
                .map(|target| match target.kind {
                    OperationTargetKind::Local => target
                        .session_id
                        .as_deref()
                        .map(|session| format!("local ({session})"))
                        .unwrap_or_else(|| "local".to_string()),
                    OperationTargetKind::Remote => format!(
                        "{}{}:{}{}",
                        target
                            .username
                            .as_deref()
                            .map(|username| format!("{username}@"))
                            .unwrap_or_default(),
                        target.host.as_deref().unwrap_or("?"),
                        target.port.unwrap_or_default(),
                        target
                            .profile_id
                            .as_deref()
                            .map(|profile| format!(" ({profile})"))
                            .unwrap_or_default()
                    ),
                })
                .collect::<Vec<_>>()
                .join(", ");
            let evidence = event
                .evidence
                .iter()
                .map(|reference| reference.operation_id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            output.push_str(&format!(
                "| {} | `{}` | {} | {} | {} | {} | {} |\n",
                event.occurred_at,
                markdown_escape(&event.operation_id),
                markdown_escape(&event.action),
                event.event_kind.as_str(),
                event.status.as_str(),
                markdown_escape(&targets),
                markdown_escape(&evidence),
            ));
            if let Some(command) = event.command_preview.as_deref() {
                output.push_str(&format!("\nCommand: `{}`\n\n", markdown_escape(command)));
            }
        }
    }
    output
}

#[tauri::command]
pub(crate) fn record_operation_event(
    database: State<'_, Database>,
    request: RecordOperationEventRequest,
) -> Result<(), String> {
    let event = normalize_request(request)?;
    insert(&database, &event)?;
    prune(&database, retention_days(&database)?)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_operation_history(
    database: State<'_, Database>,
    request: ListOperationHistoryRequest,
) -> Result<OperationHistoryPage, String> {
    filtered_page(
        &database,
        &request.filter,
        request.limit.unwrap_or(100).clamp(1, 500),
    )
}

#[tauri::command]
pub(crate) fn get_operation_history_settings(
    database: State<'_, Database>,
) -> Result<OperationHistorySettings, String> {
    Ok(OperationHistorySettings {
        retention_days: retention_days(&database)?,
        default_local_only: true,
    })
}

#[tauri::command]
pub(crate) fn set_operation_history_retention(
    database: State<'_, Database>,
    retention_days: u16,
) -> Result<usize, String> {
    if retention_days != 0 && !(1..=3_650).contains(&retention_days) {
        return Err("operation history retention must be 0 or between 1 and 3650 days".to_string());
    }
    database.with_connection(|conn| {
        conn.execute(
            "INSERT INTO preferences (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![RETENTION_PREFERENCE_KEY, retention_days.to_string()],
        )
        .map(|_| ())
        .map_err(|error| format!("failed to save operation history retention: {error}"))
    })?;
    prune(&database, retention_days)
}

#[tauri::command]
pub(crate) fn clear_operation_history(database: State<'_, Database>) -> Result<usize, String> {
    database.with_connection(|conn| {
        conn.execute("DELETE FROM operation_history_events", [])
            .map_err(|error| format!("failed to clear operation history: {error}"))
    })
}

#[tauri::command]
pub(crate) async fn export_operation_history(
    database: State<'_, Database>,
    request: ExportOperationHistoryRequest,
) -> Result<Option<String>, String> {
    let page = filtered_page(&database, &request.filter, MAX_EXPORTED_TASKS)?;
    let (extension, content) = match request.format {
        OperationHistoryExportFormat::Markdown => ("md", render_markdown(&page.events)),
        OperationHistoryExportFormat::Json => ("json", render_json(&page.events)?),
    };
    let file_name = format!(
        "shellspan-operation-history-{}.{}",
        current_timestamp_ms(),
        extension
    );
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("Export redacted operation history")
            .set_file_name(&file_name)
            .add_filter(extension.to_uppercase(), &[extension])
            .save_file();
        let Some(path) = path else {
            return Ok(None);
        };
        let temporary = temporary_export_path(&path);
        let write_result = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .and_then(|mut file| {
                file.write_all(content.as_bytes())?;
                file.sync_all()
            });
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("failed to write operation history export: {error}"));
        }
        if let Err(error) = replace_export(&temporary, &path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(Some(crate::portable_local_path(&path)))
    })
    .await
    .map_err(|error| format!("failed to join operation history export task: {error}"))?
}

fn temporary_export_path(path: &std::path::Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(format!(".shellspan-{}.tmp", uuid::Uuid::new_v4()));
    PathBuf::from(temporary)
}

#[cfg(target_os = "windows")]
fn replace_export(
    temporary: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(format!(
            "failed to finalize operation history export: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_export(
    temporary: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    std::fs::rename(temporary, destination)
        .map_err(|error| format!("failed to finalize operation history export: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn database() -> (TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("history.db")).unwrap();
        (directory, database)
    }

    fn request(
        event_id: &str,
        task_id: &str,
        status: OperationStatus,
    ) -> RecordOperationEventRequest {
        RecordOperationEventRequest {
            event_id: event_id.to_string(),
            task_id: task_id.to_string(),
            operation_id: format!("operation:{event_id}"),
            parent_operation_id: None,
            occurred_at: current_timestamp_ms(),
            category: OperationCategory::Runbook,
            action: "executeRunbookStep".to_string(),
            event_kind: if status == OperationStatus::Running {
                OperationEventKind::Started
            } else {
                OperationEventKind::Completed
            },
            status,
            risk: Some(OperationRisk::StateChange),
            subject_id: Some("restart-service".to_string()),
            targets: vec![OperationTarget {
                kind: OperationTargetKind::Remote,
                profile_id: Some("profile-1".to_string()),
                host: Some("example.test".to_string()),
                port: Some(22),
                username: Some("operator".to_string()),
                session_id: None,
                identity_fingerprint: Some("SHA256:host".to_string()),
            }],
            command_preview: Some("systemctl restart nginx".to_string()),
            evidence: vec![OperationEvidenceReference {
                operation_id: "operation:precheck".to_string(),
                kind: OperationEvidenceKind::RunbookStep,
                observed_at: Some(current_timestamp_ms()),
                digest: Some("abc123".to_string()),
            }],
            error_category: None,
            retry_of_operation_id: None,
            item_count: None,
            byte_count: None,
            exit_code: Some(0),
            permission_mode: None,
            human_approved: None,
            batch_index: None,
            batch_total: None,
            concurrency_limit: None,
        }
    }

    #[test]
    fn persists_grouped_timeline_and_filters_by_task_evidence() {
        let (_directory, database) = database();
        let started =
            normalize_request(request("event-1", "task-1", OperationStatus::Running)).unwrap();
        let finished =
            normalize_request(request("event-2", "task-1", OperationStatus::Succeeded)).unwrap();
        insert(&database, &started).unwrap();
        insert(&database, &finished).unwrap();

        let page = filtered_page(
            &database,
            &OperationHistoryFilter {
                status: Some(OperationStatus::Succeeded),
                ..OperationHistoryFilter::default()
            },
            100,
        )
        .unwrap();

        assert_eq!(page.total_tasks, 1);
        assert_eq!(page.events.len(), 2);
        assert_eq!(
            page.events[0].evidence[0].operation_id,
            "operation:precheck"
        );
    }

    #[test]
    fn redacts_suspicious_commands_and_never_exports_raw_secrets() {
        let (_directory, database) = database();
        let mut unsafe_request = request("event-secret", "task-secret", OperationStatus::Failed);
        unsafe_request.command_preview =
            Some("curl --token=top-secret https://example.test".to_string());
        let event = normalize_request(unsafe_request).unwrap();
        assert_eq!(event.command_preview.as_deref(), Some(REDACTED_COMMAND));
        insert(&database, &event).unwrap();

        let events = filtered_page(&database, &OperationHistoryFilter::default(), 100)
            .unwrap()
            .events;
        let json = render_json(&events).unwrap();
        let markdown = render_markdown(&events);
        assert!(!json.contains("top-secret"));
        assert!(!markdown.contains("top-secret"));
        assert!(json.contains(REDACTED_COMMAND));
    }

    #[test]
    fn agent_command_audit_tracks_permission_and_never_accepts_terminal_output() {
        let (_directory, database) = database();
        let mut agent = request("agent-started", "request-agent", OperationStatus::Running);
        agent.category = OperationCategory::Agent;
        agent.action = "executeAgentCommand".to_string();
        agent.operation_id = "call-agent".to_string();
        agent.parent_operation_id = Some("request-agent".to_string());
        agent.command_preview = Some("curl --api-key=top-secret https://example.test".to_string());
        agent.permission_mode = Some(AgentPermissionMode::FullAccess);
        agent.human_approved = Some(false);
        agent.evidence.clear();

        insert(&database, &normalize_request(agent).unwrap()).unwrap();
        let (events, _) = load_events(&database).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].category, OperationCategory::Agent);
        assert_eq!(events[0].task_id, "request-agent");
        assert_eq!(events[0].operation_id, "call-agent");
        assert_eq!(
            events[0].permission_mode,
            Some(AgentPermissionMode::FullAccess)
        );
        assert_eq!(events[0].human_approved, Some(false));
        assert_eq!(events[0].command_preview.as_deref(), Some(REDACTED_COMMAND));

        let encoded = serde_json::to_string(&events).unwrap();
        assert!(!encoded.contains("top-secret"));
        assert!(!encoded.contains("terminal output that must not be stored"));
        let with_output = serde_json::json!({
            "eventId": "agent-output",
            "taskId": "request-agent",
            "operationId": "call-agent",
            "parentOperationId": "request-agent",
            "occurredAt": current_timestamp_ms(),
            "category": "agent",
            "action": "executeAgentCommand",
            "eventKind": "completed",
            "status": "succeeded",
            "risk": "readOnly",
            "targets": [],
            "evidence": [],
            "permissionMode": "requestApproval",
            "humanApproved": true,
            "output": "terminal output that must not be stored"
        });
        assert!(serde_json::from_value::<RecordOperationEventRequest>(with_output).is_err());
    }

    #[test]
    fn preview_agent_classifications_are_filterable_without_command_payloads() {
        let (_directory, database) = database();
        let mut compatibility = request(
            "agent-preview-capability",
            "agent-compatibility",
            OperationStatus::Failed,
        );
        compatibility.category = OperationCategory::Agent;
        compatibility.action = "detectAgentProviderCapability".to_string();
        compatibility.risk = None;
        compatibility.subject_id =
            Some("openAiCompatible:chatCompletionsProbe:unknown".to_string());
        compatibility.command_preview = Some("secret prompt must be dropped".to_string());
        compatibility.evidence.clear();
        compatibility.error_category = Some(OperationErrorCategory::ToolCallingUnverified);

        let normalized = normalize_request(compatibility).unwrap();
        assert_eq!(normalized.command_preview, None);
        insert(&database, &normalized).unwrap();
        let page = filtered_page(
            &database,
            &OperationHistoryFilter {
                category: Some(OperationCategory::Agent),
                ..OperationHistoryFilter::default()
            },
            100,
        )
        .unwrap();

        assert_eq!(page.total_tasks, 1);
        assert_eq!(page.events[0].category, OperationCategory::Agent);
        assert_eq!(
            page.events[0].error_category,
            Some(OperationErrorCategory::ToolCallingUnverified)
        );
        assert!(!serde_json::to_string(&page.events)
            .unwrap()
            .contains("secret prompt"));
    }

    #[test]
    fn retains_reviewed_multi_host_commands_and_applies_the_same_redaction() {
        let mut approved = request("event-approved", "multi-task", OperationStatus::Running);
        approved.category = OperationCategory::MultiHost;
        approved.action = "executeMultiHostRunbook".to_string();
        approved.event_kind = OperationEventKind::Approved;
        let event = normalize_request(approved).unwrap();
        assert_eq!(
            event.command_preview.as_deref(),
            Some("systemctl restart nginx")
        );

        let mut keychain_approval =
            request("event-keychain", "multi-task", OperationStatus::Running);
        keychain_approval.category = OperationCategory::MultiHost;
        keychain_approval.action = "executeMultiHostRunbook".to_string();
        keychain_approval.event_kind = OperationEventKind::Approved;
        keychain_approval.command_preview =
            Some("curl --password '<keychain://profile/password>' host".to_string());
        let event = normalize_request(keychain_approval).unwrap();
        assert_eq!(
            event.command_preview.as_deref(),
            Some("curl --password '<keychain://profile/password>' host")
        );

        let mut unsafe_approval = request("event-unsafe", "multi-task", OperationStatus::Running);
        unsafe_approval.category = OperationCategory::MultiHost;
        unsafe_approval.action = "executeMultiHostRunbook".to_string();
        unsafe_approval.event_kind = OperationEventKind::Approved;
        unsafe_approval.command_preview = Some("curl --token=top-secret host".to_string());
        let event = normalize_request(unsafe_approval).unwrap();
        assert_eq!(event.command_preview.as_deref(), Some(REDACTED_COMMAND));
    }

    #[test]
    fn retention_clear_and_idempotent_writes_are_predictable() {
        let (_directory, database) = database();
        let event =
            normalize_request(request("event-1", "task-1", OperationStatus::Succeeded)).unwrap();
        insert(&database, &event).unwrap();
        insert(&database, &event).unwrap();
        assert_eq!(load_events(&database).unwrap().0.len(), 1);

        database
            .with_connection(|conn| {
                conn.execute(
                    "UPDATE operation_history_events SET occurred_at=?1",
                    params![current_timestamp_ms() - 2 * 86_400_000],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(prune(&database, 1).unwrap(), 1);
        assert!(load_events(&database).unwrap().0.is_empty());
    }

    #[test]
    fn rejects_arbitrary_actions_and_incomplete_remote_identity() {
        let mut invalid = request("event-1", "task-1", OperationStatus::Running);
        invalid.action = "rawShell".to_string();
        assert!(normalize_request(invalid).is_err());

        let mut incomplete = request("event-2", "task-2", OperationStatus::Running);
        incomplete.targets[0].host = None;
        assert!(normalize_request(incomplete).is_err());
    }
}
