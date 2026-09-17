use super::canonicalization::{canonical_json_bytes, canonical_sha256};
use super::compiler::{
    compile_workflow_definition, validate_artifact_handle, validate_artifact_manifest,
    validate_layout_json,
};
use super::node_registry::DeploymentNodeRegistry;
use super::security::{
    validate_bounded_safe_json, validate_summary_key, MAX_APPROVAL_SUMMARY_BYTES,
    MAX_EFFECT_RECEIPT_BYTES, MAX_EVENT_PAYLOAD_BYTES, MAX_IMMUTABLE_PLAN_BYTES,
    MAX_NODE_SUMMARY_BYTES, MAX_RUN_OUTPUT_BYTES,
};
use super::workflow_schema::{
    ArtifactBundleManifest, ArtifactHandle, DeploymentWorkflowDefinition, DeploymentWorkflowLayout,
    EffectReceipt, FrozenReleaseIdentity, ImmutableRunPlan, NodeAttemptStatus,
    WorkflowRunOperationKind, WorkflowRunTriggerKind,
};
use crate::db::{current_timestamp_ms, Database};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

const MAX_WORKFLOW_NAME_BYTES: usize = 200;
const MAX_PAGE_SIZE: u32 = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateDeploymentWorkflowInput {
    pub name: String,
    pub definition: DeploymentWorkflowDefinition,
    #[serde(default)]
    pub layout: Option<DeploymentWorkflowLayout>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateDeploymentWorkflowInput {
    pub name: String,
    pub definition: DeploymentWorkflowDefinition,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateDeploymentWorkflowLayoutInput {
    pub layout: DeploymentWorkflowLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentWorkflowRecord {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub archived: bool,
    pub revision: u64,
    pub definition_digest: String,
    pub definition: DeploymentWorkflowDefinition,
    pub layout_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<DeploymentWorkflowLayout>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentWorkflowPage {
    pub items: Vec<DeploymentWorkflowRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentWorkflowLayoutRecord {
    pub workflow_id: String,
    pub layout_revision: u64,
    pub layout_digest: String,
    pub layout: DeploymentWorkflowLayout,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunNodeRecord {
    pub run_id: String,
    pub node_id: String,
    pub node_type: String,
    pub node_type_version: u32,
    pub status: String,
    pub last_attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_summary: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentNodeAttemptRecord {
    pub schema_version: u32,
    pub run_id: String,
    pub node_id: String,
    pub attempt: u32,
    pub node_type: String,
    pub node_type_version: u32,
    pub executor_version: String,
    pub idempotency_key: String,
    pub status: NodeAttemptStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentNodeAttemptPage {
    pub items: Vec<DeploymentNodeAttemptRecord>,
    pub next_before_attempt: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunEventPage {
    pub items: Vec<DeploymentRunEventRecord>,
    pub next_before_sequence: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeploymentRunEventWrite {
    pub node_id: Option<String>,
    pub attempt: Option<u32>,
    pub event_kind: String,
    pub status: Option<String>,
    pub summary_key: String,
    pub payload: Option<Value>,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunEventRecord {
    pub run_id: String,
    pub sequence: u32,
    pub node_id: Option<String>,
    pub attempt: Option<u32>,
    pub event_kind: String,
    pub status: Option<String>,
    pub summary_key: String,
    pub payload: Option<Value>,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeploymentArtifactWrite {
    pub artifact_reference: String,
    pub manifest_digest: String,
    pub content_digest: String,
    pub artifact_type: String,
    pub manifest_json: String,
    pub component_count: u32,
    pub total_size: u64,
    pub created_at: i64,
    pub verified_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactRetention {
    pub reference_count: u32,
    pub lease_count: u32,
    pub current_release: bool,
    pub previous_release: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_until: Option<i64>,
    pub protected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactReferenceRecord {
    pub workflow_id: Option<String>,
    pub run_id: Option<String>,
    pub node_id: Option<String>,
    pub reference_kind: String,
    pub owner_id: String,
    pub lease_active: bool,
    pub retain_until: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentReleaseRecord {
    pub workflow_id: String,
    pub release_id: String,
    pub position: String,
    pub artifact_reference: String,
    pub manifest_digest: String,
    pub content_digest: String,
    pub artifact_type: String,
    pub identity: Option<FrozenReleaseIdentity>,
    pub source_run_id: Option<String>,
    pub activated_at: Option<i64>,
    pub rollbackable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DeploymentRunRecordPage {
    pub items: Vec<DeploymentRunRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DeploymentRunWrite {
    pub id: String,
    pub workflow_id: String,
    pub workflow_revision: u64,
    pub operation_kind: WorkflowRunOperationKind,
    pub trigger_kind: WorkflowRunTriggerKind,
    pub definition_digest: String,
    pub plan_digest: String,
    pub plan: Value,
    pub approval_summary: Option<Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DeploymentRunRecord {
    pub id: String,
    pub workflow_id: String,
    pub workflow_revision: u64,
    pub operation_kind: WorkflowRunOperationKind,
    pub trigger_kind: WorkflowRunTriggerKind,
    pub status: DeploymentRunStatus,
    pub definition_digest: String,
    pub plan_digest: String,
    pub plan: Value,
    pub approval_summary: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DeploymentWorkflowRevisionRecord {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub archived: bool,
    pub revision: u64,
    pub definition_digest: String,
    pub definition: DeploymentWorkflowDefinition,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DeploymentRunOutputRecord {
    pub run_id: String,
    pub node_id: String,
    pub output_name: String,
    pub output_kind: DeploymentRunOutputKind,
    pub value: Value,
    pub artifact_reference: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeploymentRunNodeSeed {
    pub node_id: String,
    pub node_type: String,
    pub node_type_version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeploymentRunStatus {
    Planned,
    AwaitingApproval,
    Approved,
    Reconciling,
    InProgress,
    Verifying,
    Succeeded,
    CancelRequested,
    Canceled,
    Failed,
    StateUnknown,
}

impl DeploymentRunStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Approved => "approved",
            Self::Reconciling => "reconciling",
            Self::InProgress => "in_progress",
            Self::Verifying => "verifying",
            Self::Succeeded => "succeeded",
            Self::CancelRequested => "cancel_requested",
            Self::Canceled => "canceled",
            Self::Failed => "failed",
            Self::StateUnknown => "state_unknown",
        }
    }

    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "planned" => Ok(Self::Planned),
            "awaiting_approval" => Ok(Self::AwaitingApproval),
            "approved" => Ok(Self::Approved),
            "reconciling" => Ok(Self::Reconciling),
            "in_progress" => Ok(Self::InProgress),
            "verifying" => Ok(Self::Verifying),
            "succeeded" => Ok(Self::Succeeded),
            "cancel_requested" => Ok(Self::CancelRequested),
            "canceled" => Ok(Self::Canceled),
            "failed" => Ok(Self::Failed),
            "state_unknown" => Ok(Self::StateUnknown),
            _ => Err("stored deployment run status is invalid".into()),
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Canceled | Self::Failed)
    }

    fn can_transition_to(self, next: Self) -> bool {
        use DeploymentRunStatus::*;
        matches!(
            (self, next),
            (Planned, AwaitingApproval | Canceled)
                | (
                    AwaitingApproval,
                    Approved | Canceled | Failed | StateUnknown
                )
                | (
                    Approved,
                    AwaitingApproval
                        | Reconciling
                        | InProgress
                        | CancelRequested
                        | Failed
                        | StateUnknown
                )
                | (
                    Reconciling,
                    Approved
                        | InProgress
                        | Verifying
                        | Succeeded
                        | CancelRequested
                        | Canceled
                        | Failed
                        | StateUnknown
                )
                | (
                    InProgress,
                    Reconciling | Verifying | CancelRequested | Failed | StateUnknown
                )
                | (
                    Verifying,
                    Reconciling | Succeeded | CancelRequested | Failed | StateUnknown
                )
                | (
                    CancelRequested,
                    Reconciling | Canceled | Failed | StateUnknown
                )
                | (StateUnknown, Reconciling)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeploymentRunNodeStatus {
    Pending,
    Ready,
    Running,
    AwaitingApproval,
    Succeeded,
    Skipped,
    RetryWaiting,
    CancelRequested,
    Canceled,
    Failed,
    StateUnknown,
    Compensating,
    Compensated,
}

impl DeploymentRunNodeStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Succeeded => "succeeded",
            Self::Skipped => "skipped",
            Self::RetryWaiting => "retry_waiting",
            Self::CancelRequested => "cancel_requested",
            Self::Canceled => "canceled",
            Self::Failed => "failed",
            Self::StateUnknown => "state_unknown",
            Self::Compensating => "compensating",
            Self::Compensated => "compensated",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeploymentNodeAttemptWrite {
    pub run_id: String,
    pub node_id: String,
    pub attempt: u32,
    pub node_type: String,
    pub node_type_version: u32,
    pub executor_version: String,
    pub idempotency_key: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeploymentRunOutputKind {
    Scalar,
    Artifact,
    Receipt,
    Evidence,
}

impl DeploymentRunOutputKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Scalar => "scalar",
            Self::Artifact => "artifact",
            Self::Receipt => "receipt",
            Self::Evidence => "evidence",
        }
    }

    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "scalar" => Ok(Self::Scalar),
            "artifact" => Ok(Self::Artifact),
            "receipt" => Ok(Self::Receipt),
            "evidence" => Ok(Self::Evidence),
            _ => Err("stored deployment output kind is invalid".into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DeploymentRunOutputWrite {
    pub run_id: String,
    pub node_id: String,
    pub output_name: String,
    pub output_kind: DeploymentRunOutputKind,
    pub value: Value,
    pub artifact_reference: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeploymentArtifactRefKind {
    Run,
    Node,
    ReleaseCurrent,
    ReleasePrevious,
    Audit,
}

impl DeploymentArtifactRefKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Node => "node",
            Self::ReleaseCurrent => "release_current",
            Self::ReleasePrevious => "release_previous",
            Self::Audit => "audit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeploymentArtifactRefWrite {
    pub id: String,
    pub artifact_reference: String,
    pub workflow_id: Option<String>,
    pub run_id: Option<String>,
    pub node_id: Option<String>,
    pub ref_kind: DeploymentArtifactRefKind,
    pub owner_id: String,
    pub lease_active: bool,
    pub retain_until: Option<i64>,
    pub created_at: i64,
}

fn operation_kind(value: WorkflowRunOperationKind) -> &'static str {
    match value {
        WorkflowRunOperationKind::Deploy => "deploy",
        WorkflowRunOperationKind::Rollback => "rollback",
    }
}

fn parse_operation_kind(value: &str) -> Result<WorkflowRunOperationKind, String> {
    match value {
        "deploy" => Ok(WorkflowRunOperationKind::Deploy),
        "rollback" => Ok(WorkflowRunOperationKind::Rollback),
        _ => Err("stored deployment operation kind is invalid".into()),
    }
}

fn trigger_kind(value: WorkflowRunTriggerKind) -> &'static str {
    match value {
        WorkflowRunTriggerKind::Manual => "manual",
        WorkflowRunTriggerKind::Agent => "agent",
        WorkflowRunTriggerKind::QuickAction => "quick_action",
        WorkflowRunTriggerKind::Recovery => "recovery",
    }
}

fn parse_trigger_kind(value: &str) -> Result<WorkflowRunTriggerKind, String> {
    match value {
        "manual" => Ok(WorkflowRunTriggerKind::Manual),
        "agent" => Ok(WorkflowRunTriggerKind::Agent),
        "quick_action" => Ok(WorkflowRunTriggerKind::QuickAction),
        "recovery" => Ok(WorkflowRunTriggerKind::Recovery),
        _ => Err("stored deployment trigger kind is invalid".into()),
    }
}

fn attempt_status(value: NodeAttemptStatus) -> &'static str {
    match value {
        NodeAttemptStatus::Pending => "pending",
        NodeAttemptStatus::Running => "running",
        NodeAttemptStatus::Succeeded => "succeeded",
        NodeAttemptStatus::Failed => "failed",
        NodeAttemptStatus::Canceled => "canceled",
        NodeAttemptStatus::StateUnknown => "state_unknown",
        NodeAttemptStatus::Compensated => "compensated",
    }
}

fn validate_workflow_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.as_bytes().len() > MAX_WORKFLOW_NAME_BYTES || name.trim() != name {
        return Err("DEPLOYMENT_WORKFLOW_INVALID_NAME".into());
    }
    Ok(())
}

fn ensure_target_profiles_exist(
    connection: &rusqlite::Connection,
    definition: &DeploymentWorkflowDefinition,
) -> Result<(), String> {
    for target in &definition.targets {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
                [&target.connection_profile_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to validate deployment target profile: {error}"))?;
        if !exists {
            return Err("DEPLOYMENT_WORKFLOW_PROFILE_NOT_FOUND".into());
        }
    }
    Ok(())
}

fn canonical_json_string<T: Serialize>(value: &T) -> Result<String, String> {
    String::from_utf8(canonical_json_bytes(value).map_err(|error| error.to_string())?)
        .map_err(|_| "canonical deployment JSON is not UTF-8".to_string())
}

fn parse_definition(json: &str) -> Result<DeploymentWorkflowDefinition, String> {
    serde_json::from_str(json)
        .map_err(|error| format!("stored deployment definition is invalid: {error}"))
}

fn parse_layout(json: Option<String>) -> Result<Option<DeploymentWorkflowLayout>, String> {
    json.map(|json| {
        serde_json::from_str(&json)
            .map_err(|error| format!("stored deployment layout is invalid: {error}"))
    })
    .transpose()
}

fn workflow_record(
    row: &Row<'_>,
) -> rusqlite::Result<(
    String,
    String,
    i64,
    i64,
    i64,
    String,
    String,
    i64,
    Option<String>,
    i64,
    i64,
)> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
    ))
}

fn decode_workflow_record(
    raw: (
        String,
        String,
        i64,
        i64,
        i64,
        String,
        String,
        i64,
        Option<String>,
        i64,
        i64,
    ),
) -> Result<DeploymentWorkflowRecord, String> {
    let (
        id,
        name,
        enabled,
        archived,
        revision,
        definition_digest,
        definition_json,
        layout_revision,
        layout_json,
        created_at,
        updated_at,
    ) = raw;
    Ok(DeploymentWorkflowRecord {
        id,
        name,
        enabled: enabled == 1,
        archived: archived == 1,
        revision: revision
            .try_into()
            .map_err(|_| "stored deployment revision is invalid".to_string())?,
        definition_digest,
        definition: parse_definition(&definition_json)?,
        layout_revision: layout_revision
            .try_into()
            .map_err(|_| "stored deployment layout revision is invalid".to_string())?,
        layout: parse_layout(layout_json)?,
        created_at,
        updated_at,
    })
}

const WORKFLOW_RECORD_QUERY: &str = "
SELECT w.id, w.name, w.enabled, w.archived, w.head_revision,
       r.definition_digest, r.definition_json, w.head_layout_revision,
       l.layout_json, w.created_at, w.updated_at
FROM deployment_workflows w
JOIN deployment_workflow_revisions r
  ON r.workflow_id = w.id AND r.revision = w.head_revision
LEFT JOIN deployment_workflow_layouts l
  ON l.workflow_id = w.id AND l.layout_revision = w.head_layout_revision
";

fn encode_cursor(updated_at: i64, id: &str) -> String {
    format!("{updated_at}:{id}")
}

fn decode_cursor(cursor: Option<&str>) -> Result<Option<(i64, String)>, String> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    if cursor.len() > 256 {
        return Err("DEPLOYMENT_WORKFLOW_INVALID_CURSOR".into());
    }
    let (updated_at, id) = cursor
        .split_once(':')
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_INVALID_CURSOR".to_string())?;
    let updated_at = updated_at
        .parse::<i64>()
        .map_err(|_| "DEPLOYMENT_WORKFLOW_INVALID_CURSOR".to_string())?;
    if updated_at < 0 || id.is_empty() {
        return Err("DEPLOYMENT_WORKFLOW_INVALID_CURSOR".into());
    }
    Ok(Some((updated_at, id.to_string())))
}

impl Database {
    pub(crate) fn create_deployment_workflow(
        &self,
        input: &CreateDeploymentWorkflowInput,
    ) -> Result<DeploymentWorkflowRecord, String> {
        validate_workflow_name(&input.name)?;
        let registry = DeploymentNodeRegistry::mvp();
        let compiled = compile_workflow_definition(&input.definition, &registry)
            .map_err(|error| error.to_string())?;
        let definition_json = canonical_json_string(&input.definition)?;
        let layout = input
            .layout
            .as_ref()
            .map(|layout| {
                let json = canonical_json_string(layout)?;
                let validated = validate_layout_json(&json).map_err(|error| error.to_string())?;
                let digest = canonical_sha256(&validated).map_err(|error| error.to_string())?;
                Ok::<_, String>((json, digest))
            })
            .transpose()?;
        let id = format!("workflow-{}", uuid::Uuid::new_v4());
        let now = current_timestamp_ms();
        self.with_transaction(|transaction| {
            ensure_target_profiles_exist(transaction, &input.definition)?;
            transaction
                .execute(
                    "INSERT INTO deployment_workflows (
                        id, name, enabled, archived, head_revision, head_layout_revision,
                        created_at, updated_at
                     ) VALUES (?1, ?2, ?3, 0, 1, ?4, ?5, ?5)",
                    params![
                        id,
                        input.name,
                        i64::from(input.enabled),
                        i64::from(layout.is_some()),
                        now
                    ],
                )
                .map_err(|error| format!("failed to create deployment workflow: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO deployment_workflow_revisions (
                        workflow_id, revision, schema_version, definition_json,
                        definition_digest, created_at
                     ) VALUES (?1, 1, 3, ?2, ?3, ?4)",
                    params![id, definition_json, compiled.definition_digest, now],
                )
                .map_err(|error| {
                    format!("failed to store deployment workflow revision: {error}")
                })?;
            if let Some((layout_json, layout_digest)) = &layout {
                transaction
                    .execute(
                        "INSERT INTO deployment_workflow_layouts (
                            workflow_id, layout_revision, schema_version, layout_json,
                            layout_digest, created_at
                         ) VALUES (?1, 1, 1, ?2, ?3, ?4)",
                        params![id, layout_json, layout_digest, now],
                    )
                    .map_err(|error| {
                        format!("failed to store deployment workflow layout: {error}")
                    })?;
            }
            Ok(())
        })?;
        self.get_deployment_workflow(&id)?
            .ok_or_else(|| "created deployment workflow is missing".to_string())
    }

    pub(crate) fn get_deployment_workflow(
        &self,
        id: &str,
    ) -> Result<Option<DeploymentWorkflowRecord>, String> {
        self.with_connection(|connection| {
            let sql = format!("{WORKFLOW_RECORD_QUERY} WHERE w.id = ?1");
            connection
                .query_row(&sql, [id], workflow_record)
                .optional()
                .map_err(|error| format!("failed to read deployment workflow: {error}"))?
                .map(decode_workflow_record)
                .transpose()
        })
    }

    pub(crate) fn get_deployment_workflow_revision(
        &self,
        id: &str,
        revision: u64,
    ) -> Result<Option<DeploymentWorkflowRevisionRecord>, String> {
        let revision_sql = i64::try_from(revision)
            .map_err(|_| "DEPLOYMENT_WORKFLOW_REVISION_OVERFLOW".to_string())?;
        self.with_connection(|connection| {
            let raw = connection
                .query_row(
                    "SELECT w.id, w.name, w.enabled, w.archived, r.revision,
                            r.definition_digest, r.definition_json
                     FROM deployment_workflows w
                     JOIN deployment_workflow_revisions r ON r.workflow_id = w.id
                     WHERE w.id = ?1 AND r.revision = ?2",
                    params![id, revision_sql],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("failed to read deployment workflow revision: {error}"))?;
            raw.map(
                |(id, name, enabled, archived, revision, definition_digest, definition_json)| {
                    Ok(DeploymentWorkflowRevisionRecord {
                        id,
                        name,
                        enabled: enabled == 1,
                        archived: archived == 1,
                        revision: revision
                            .try_into()
                            .map_err(|_| "stored deployment revision is invalid".to_string())?,
                        definition_digest,
                        definition: parse_definition(&definition_json)?,
                    })
                },
            )
            .transpose()
        })
    }

    pub(crate) fn list_deployment_workflows(
        &self,
        cursor: Option<&str>,
        limit: u32,
        include_archived: bool,
    ) -> Result<DeploymentWorkflowPage, String> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err("DEPLOYMENT_WORKFLOW_INVALID_PAGE_SIZE".into());
        }
        let cursor = decode_cursor(cursor)?;
        self.with_connection(|connection| {
            let archived_filter = if include_archived { "" } else { "w.archived = 0 AND" };
            let sql = format!(
                "{WORKFLOW_RECORD_QUERY}
                 WHERE {archived_filter} (?1 IS NULL OR w.updated_at < ?1 OR (w.updated_at = ?1 AND w.id < ?2))
                 ORDER BY w.updated_at DESC, w.id DESC LIMIT ?3"
            );
            let cursor_time = cursor.as_ref().map(|value| value.0);
            let cursor_id = cursor.as_ref().map(|value| value.1.as_str());
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("failed to prepare deployment workflow page: {error}"))?;
            let rows = statement
                .query_map(
                    params![cursor_time, cursor_id, i64::from(limit) + 1],
                    workflow_record,
                )
                .map_err(|error| format!("failed to query deployment workflow page: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment workflow page: {error}"))?;
            let mut items = rows
                .into_iter()
                .map(decode_workflow_record)
                .collect::<Result<Vec<_>, _>>()?;
            let has_more = items.len() > limit as usize;
            items.truncate(limit as usize);
            let next_cursor = has_more
                .then(|| items.last().map(|item| encode_cursor(item.updated_at, &item.id)))
                .flatten();
            Ok(DeploymentWorkflowPage {
                items,
                next_cursor,
            })
        })
    }

    pub(crate) fn update_deployment_workflow(
        &self,
        id: &str,
        expected_revision: u64,
        input: &UpdateDeploymentWorkflowInput,
    ) -> Result<DeploymentWorkflowRecord, String> {
        validate_workflow_name(&input.name)?;
        let registry = DeploymentNodeRegistry::mvp();
        let compiled = compile_workflow_definition(&input.definition, &registry)
            .map_err(|error| error.to_string())?;
        let definition_json = canonical_json_string(&input.definition)?;
        let next_revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| "DEPLOYMENT_WORKFLOW_REVISION_OVERFLOW".to_string())?;
        let expected_revision_sql = i64::try_from(expected_revision)
            .map_err(|_| "DEPLOYMENT_WORKFLOW_REVISION_OVERFLOW".to_string())?;
        let next_revision_sql = i64::try_from(next_revision)
            .map_err(|_| "DEPLOYMENT_WORKFLOW_REVISION_OVERFLOW".to_string())?;
        let now = current_timestamp_ms();
        self.with_transaction(|transaction| {
            ensure_target_profiles_exist(transaction, &input.definition)?;
            let updated = transaction
                .execute(
                    "UPDATE deployment_workflows
                     SET name = ?3, enabled = ?4, head_revision = ?5, updated_at = ?6
                     WHERE id = ?1 AND head_revision = ?2 AND archived = 0",
                    params![
                        id,
                        expected_revision_sql,
                        input.name,
                        i64::from(input.enabled),
                        next_revision_sql,
                        now
                    ],
                )
                .map_err(|error| format!("failed to update deployment workflow: {error}"))?;
            if updated != 1 {
                return Err("DEPLOYMENT_WORKFLOW_REVISION_CONFLICT".into());
            }
            transaction
                .execute(
                    "INSERT INTO deployment_workflow_revisions (
                        workflow_id, revision, schema_version, definition_json,
                        definition_digest, created_at
                     ) VALUES (?1, ?2, 3, ?3, ?4, ?5)",
                    params![
                        id,
                        next_revision_sql,
                        definition_json,
                        compiled.definition_digest,
                        now
                    ],
                )
                .map_err(|error| {
                    format!("failed to store deployment workflow revision: {error}")
                })?;
            Ok(())
        })?;
        self.get_deployment_workflow(id)?
            .ok_or_else(|| "updated deployment workflow is missing".to_string())
    }

    pub(crate) fn update_deployment_workflow_layout(
        &self,
        id: &str,
        expected_layout_revision: u64,
        input: &UpdateDeploymentWorkflowLayoutInput,
    ) -> Result<DeploymentWorkflowLayoutRecord, String> {
        let layout_json = canonical_json_string(&input.layout)?;
        let layout = validate_layout_json(&layout_json).map_err(|error| error.to_string())?;
        let layout_digest = canonical_sha256(&layout).map_err(|error| error.to_string())?;
        let next_revision = expected_layout_revision
            .checked_add(1)
            .ok_or_else(|| "DEPLOYMENT_WORKFLOW_LAYOUT_REVISION_OVERFLOW".to_string())?;
        let expected_revision_sql = i64::try_from(expected_layout_revision)
            .map_err(|_| "DEPLOYMENT_WORKFLOW_LAYOUT_REVISION_OVERFLOW".to_string())?;
        let next_revision_sql = i64::try_from(next_revision)
            .map_err(|_| "DEPLOYMENT_WORKFLOW_LAYOUT_REVISION_OVERFLOW".to_string())?;
        let now = current_timestamp_ms();
        self.with_transaction(|transaction| {
            let updated = transaction
                .execute(
                    "UPDATE deployment_workflows
                     SET head_layout_revision = ?3, updated_at = ?4
                     WHERE id = ?1 AND head_layout_revision = ?2 AND archived = 0",
                    params![id, expected_revision_sql, next_revision_sql, now],
                )
                .map_err(|error| {
                    format!("failed to update deployment workflow layout head: {error}")
                })?;
            if updated != 1 {
                return Err("DEPLOYMENT_WORKFLOW_LAYOUT_REVISION_CONFLICT".into());
            }
            transaction
                .execute(
                    "INSERT INTO deployment_workflow_layouts (
                        workflow_id, layout_revision, schema_version, layout_json,
                        layout_digest, created_at
                     ) VALUES (?1, ?2, 1, ?3, ?4, ?5)",
                    params![id, next_revision_sql, layout_json, layout_digest, now],
                )
                .map_err(|error| format!("failed to store deployment workflow layout: {error}"))?;
            Ok(())
        })?;
        Ok(DeploymentWorkflowLayoutRecord {
            workflow_id: id.to_string(),
            layout_revision: next_revision,
            layout_digest,
            layout,
            created_at: now,
        })
    }

    pub(crate) fn archive_deployment_workflow(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<(), String> {
        let now = current_timestamp_ms();
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "DEPLOYMENT_WORKFLOW_REVISION_OVERFLOW".to_string())?;
        self.with_connection(|connection| {
            let updated = connection
                .execute(
                    "UPDATE deployment_workflows
                     SET archived = 1, enabled = 0, updated_at = ?3
                     WHERE id = ?1 AND head_revision = ?2 AND archived = 0",
                    params![id, expected_revision, now],
                )
                .map_err(|error| format!("failed to archive deployment workflow: {error}"))?;
            if updated == 1 {
                Ok(())
            } else {
                Err("DEPLOYMENT_WORKFLOW_REVISION_CONFLICT".into())
            }
        })
    }

    pub(crate) fn list_deployment_run_nodes(
        &self,
        run_id: &str,
    ) -> Result<Vec<DeploymentRunNodeRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT run_id, node_id, node_type, node_type_version, status,
                            last_attempt, output_summary_json, started_at, finished_at, updated_at
                     FROM deployment_run_nodes WHERE run_id = ?1 ORDER BY node_id",
                )
                .map_err(|error| format!("failed to prepare deployment run nodes: {error}"))?;
            let rows = statement
                .query_map([run_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                        row.get::<_, i64>(9)?,
                    ))
                })
                .map_err(|error| format!("failed to query deployment run nodes: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment run nodes: {error}"))?;
            rows.into_iter()
                .map(
                    |(
                        run_id,
                        node_id,
                        node_type,
                        node_type_version,
                        status,
                        last_attempt,
                        output_summary_json,
                        started_at,
                        finished_at,
                        updated_at,
                    )| {
                        Ok(DeploymentRunNodeRecord {
                            run_id,
                            node_id,
                            node_type,
                            node_type_version: node_type_version.try_into().map_err(|_| {
                                "stored deployment node version is invalid".to_string()
                            })?,
                            status,
                            last_attempt: last_attempt.try_into().map_err(|_| {
                                "stored deployment last attempt is invalid".to_string()
                            })?,
                            output_summary: output_summary_json
                                .map(|json| serde_json::from_str(&json))
                                .transpose()
                                .map_err(|error| {
                                    format!("stored deployment output summary is invalid: {error}")
                                })?,
                            started_at,
                            finished_at,
                            updated_at,
                        })
                    },
                )
                .collect()
        })
    }

    pub(crate) fn list_deployment_node_attempts(
        &self,
        run_id: &str,
        node_id: &str,
        before_attempt: Option<u32>,
        limit: u32,
    ) -> Result<DeploymentNodeAttemptPage, String> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err("DEPLOYMENT_WORKFLOW_INVALID_PAGE_SIZE".into());
        }
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT schema_version, run_id, node_id, attempt, node_type,
                            node_type_version, executor_version, idempotency_key, status,
                            failure_category, started_at, finished_at, created_at, updated_at
                     FROM deployment_node_attempts
                     WHERE run_id = ?1 AND node_id = ?2
                       AND (?3 IS NULL OR attempt < ?3)
                     ORDER BY attempt DESC LIMIT ?4",
                )
                .map_err(|error| format!("failed to prepare deployment attempt page: {error}"))?;
            let rows = statement
                .query_map(
                    params![run_id, node_id, before_attempt, i64::from(limit) + 1],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, Option<String>>(9)?,
                            row.get::<_, Option<i64>>(10)?,
                            row.get::<_, Option<i64>>(11)?,
                            row.get::<_, i64>(12)?,
                            row.get::<_, i64>(13)?,
                        ))
                    },
                )
                .map_err(|error| format!("failed to query deployment attempt page: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment attempt page: {error}"))?;
            let mut items = rows
                .into_iter()
                .map(
                    |(
                        schema_version,
                        run_id,
                        node_id,
                        attempt,
                        node_type,
                        node_type_version,
                        executor_version,
                        idempotency_key,
                        status,
                        failure_category,
                        started_at,
                        finished_at,
                        created_at,
                        updated_at,
                    )| {
                        let status = match status.as_str() {
                            "pending" => NodeAttemptStatus::Pending,
                            "running" => NodeAttemptStatus::Running,
                            "succeeded" => NodeAttemptStatus::Succeeded,
                            "failed" => NodeAttemptStatus::Failed,
                            "canceled" => NodeAttemptStatus::Canceled,
                            "state_unknown" => NodeAttemptStatus::StateUnknown,
                            "compensated" => NodeAttemptStatus::Compensated,
                            _ => {
                                return Err(
                                    "stored deployment attempt status is invalid".to_string()
                                )
                            }
                        };
                        Ok(DeploymentNodeAttemptRecord {
                            schema_version: schema_version.try_into().map_err(|_| {
                                "stored deployment attempt schema is invalid".to_string()
                            })?,
                            run_id,
                            node_id,
                            attempt: attempt.try_into().map_err(|_| {
                                "stored deployment attempt number is invalid".to_string()
                            })?,
                            node_type,
                            node_type_version: node_type_version.try_into().map_err(|_| {
                                "stored deployment attempt node version is invalid".to_string()
                            })?,
                            executor_version,
                            idempotency_key,
                            status,
                            failure_category,
                            started_at,
                            finished_at,
                            created_at,
                            updated_at,
                        })
                    },
                )
                .collect::<Result<Vec<_>, String>>()?;
            let has_more = items.len() > limit as usize;
            items.truncate(limit as usize);
            let next_before_attempt = has_more
                .then(|| items.last().map(|item| item.attempt))
                .flatten();
            Ok(DeploymentNodeAttemptPage {
                items,
                next_before_attempt,
            })
        })
    }

    pub(crate) fn create_deployment_run(
        &self,
        run: &DeploymentRunWrite,
        nodes: &[DeploymentRunNodeSeed],
    ) -> Result<(), String> {
        if nodes.is_empty() || nodes.len() > 64 {
            return Err("DEPLOYMENT_WORKFLOW_INVALID_RUN_NODE_COUNT".into());
        }
        let workflow_revision = i64::try_from(run.workflow_revision)
            .map_err(|_| "DEPLOYMENT_WORKFLOW_REVISION_OVERFLOW".to_string())?;
        let plan_json = validate_bounded_safe_json(
            &run.plan,
            MAX_IMMUTABLE_PLAN_BYTES,
            "DEPLOYMENT_WORKFLOW_IMMUTABLE_PLAN_TOO_LARGE",
        )?;
        let approval_summary_json = run
            .approval_summary
            .as_ref()
            .map(|summary| {
                validate_bounded_safe_json(
                    summary,
                    MAX_APPROVAL_SUMMARY_BYTES,
                    "DEPLOYMENT_WORKFLOW_APPROVAL_SUMMARY_TOO_LARGE",
                )
            })
            .transpose()?;
        self.with_transaction(|transaction| {
            transaction
                .execute(
                    "INSERT INTO deployment_runs (
                        id, workflow_id, workflow_revision, operation_kind, trigger_kind,
                        status, definition_digest, plan_digest, plan_json,
                        approval_summary_json, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 'planned', ?6, ?7, ?8, ?9, ?10, ?10)",
                    params![
                        run.id,
                        run.workflow_id,
                        workflow_revision,
                        operation_kind(run.operation_kind),
                        trigger_kind(run.trigger_kind),
                        run.definition_digest,
                        run.plan_digest,
                        plan_json,
                        approval_summary_json,
                        run.created_at
                    ],
                )
                .map_err(|error| format!("failed to create deployment run: {error}"))?;
            for node in nodes {
                transaction
                    .execute(
                        "INSERT INTO deployment_run_nodes (
                            run_id, node_id, node_type, node_type_version, status,
                            last_attempt, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5)",
                        params![
                            run.id,
                            node.node_id,
                            node.node_type,
                            node.node_type_version,
                            run.created_at
                        ],
                    )
                    .map_err(|error| {
                        format!("failed to create deployment run node projection: {error}")
                    })?;
            }
            transaction
                .execute(
                    "INSERT INTO deployment_run_events (
                        run_id, sequence, event_kind, status, summary_key, recorded_at
                     ) VALUES (?1, 1, 'run_created', 'planned',
                               'deployment.run.created', ?2)",
                    params![run.id, run.created_at],
                )
                .map_err(|error| format!("failed to create deployment run event: {error}"))?;
            Ok(())
        })
    }

    pub(crate) fn get_deployment_run(
        &self,
        run_id: &str,
    ) -> Result<Option<DeploymentRunRecord>, String> {
        self.with_connection(|connection| {
            let raw = connection
                .query_row(
                    "SELECT id, workflow_id, workflow_revision, operation_kind, trigger_kind,
                            status, definition_digest, plan_digest, plan_json,
                            approval_summary_json, created_at, updated_at, started_at, finished_at
                     FROM deployment_runs WHERE id = ?1",
                    [run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, Option<String>>(9)?,
                            row.get::<_, i64>(10)?,
                            row.get::<_, i64>(11)?,
                            row.get::<_, Option<i64>>(12)?,
                            row.get::<_, Option<i64>>(13)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("failed to read deployment run: {error}"))?;
            raw.map(
                |(
                    id,
                    workflow_id,
                    workflow_revision,
                    operation,
                    trigger,
                    status,
                    definition_digest,
                    plan_digest,
                    plan_json,
                    approval_summary_json,
                    created_at,
                    updated_at,
                    started_at,
                    finished_at,
                )| {
                    Ok(DeploymentRunRecord {
                        id,
                        workflow_id,
                        workflow_revision: workflow_revision.try_into().map_err(|_| {
                            "stored deployment workflow revision is invalid".to_string()
                        })?,
                        operation_kind: parse_operation_kind(&operation)?,
                        trigger_kind: parse_trigger_kind(&trigger)?,
                        status: DeploymentRunStatus::from_str(&status)?,
                        definition_digest,
                        plan_digest,
                        plan: serde_json::from_str(&plan_json).map_err(|error| {
                            format!("stored deployment plan is invalid: {error}")
                        })?,
                        approval_summary: approval_summary_json
                            .map(|json| {
                                serde_json::from_str(&json).map_err(|error| {
                                    format!(
                                        "stored deployment approval summary is invalid: {error}"
                                    )
                                })
                            })
                            .transpose()?,
                        created_at,
                        updated_at,
                        started_at,
                        finished_at,
                    })
                },
            )
            .transpose()
        })
    }

    pub(crate) fn list_deployment_runs(
        &self,
        workflow_id: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<DeploymentRunRecordPage, String> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err("DEPLOYMENT_WORKFLOW_INVALID_PAGE_SIZE".into());
        }
        let cursor = decode_cursor(cursor)?;
        let ids = self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, created_at FROM deployment_runs
                     WHERE workflow_id = ?1
                       AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
                     ORDER BY created_at DESC, id DESC LIMIT ?4",
                )
                .map_err(|error| format!("failed to prepare deployment run page: {error}"))?;
            let rows = statement
                .query_map(
                    params![
                        workflow_id,
                        cursor.as_ref().map(|value| value.0),
                        cursor.as_ref().map(|value| value.1.as_str()),
                        i64::from(limit) + 1
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .map_err(|error| format!("failed to query deployment run page: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment run page: {error}"))?;
            Ok(rows)
        })?;
        let has_more = ids.len() > limit as usize;
        let visible = ids.into_iter().take(limit as usize).collect::<Vec<_>>();
        let next_cursor = has_more
            .then(|| {
                visible
                    .last()
                    .map(|(id, created_at)| encode_cursor(*created_at, id))
            })
            .flatten();
        let items = visible
            .into_iter()
            .map(|(id, _)| {
                self.get_deployment_run(&id)?
                    .ok_or_else(|| "deployment run disappeared during pagination".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(DeploymentRunRecordPage { items, next_cursor })
    }

    pub(crate) fn list_unfinished_deployment_runs(
        &self,
    ) -> Result<Vec<DeploymentRunRecord>, String> {
        let ids = self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id FROM deployment_runs
                     WHERE status NOT IN ('succeeded', 'canceled', 'failed')
                     ORDER BY created_at ASC, id ASC",
                )
                .map_err(|error| format!("failed to prepare deployment recovery list: {error}"))?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("failed to query deployment recovery list: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment recovery list: {error}"))?;
            Ok(ids)
        })?;
        ids.into_iter()
            .map(|id| {
                self.get_deployment_run(&id)?.ok_or_else(|| {
                    "deployment recovery run disappeared during projection".to_string()
                })
            })
            .collect()
    }

    pub(crate) fn list_deployment_run_events(
        &self,
        run_id: &str,
        before_sequence: Option<u32>,
        limit: u32,
    ) -> Result<DeploymentRunEventPage, String> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err("DEPLOYMENT_WORKFLOW_INVALID_PAGE_SIZE".into());
        }
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT run_id, sequence, node_id, attempt, event_kind, status,
                            summary_key, payload_json, recorded_at
                     FROM deployment_run_events
                     WHERE run_id = ?1 AND (?2 IS NULL OR sequence < ?2)
                     ORDER BY sequence DESC LIMIT ?3",
                )
                .map_err(|error| format!("failed to prepare deployment event page: {error}"))?;
            let rows = statement
                .query_map(
                    params![run_id, before_sequence, i64::from(limit) + 1],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, Option<String>>(7)?,
                            row.get::<_, i64>(8)?,
                        ))
                    },
                )
                .map_err(|error| format!("failed to query deployment event page: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment event page: {error}"))?;
            let mut items = rows
                .into_iter()
                .map(
                    |(
                        run_id,
                        sequence,
                        node_id,
                        attempt,
                        event_kind,
                        status,
                        summary_key,
                        payload_json,
                        recorded_at,
                    )| {
                        Ok(DeploymentRunEventRecord {
                            run_id,
                            sequence: sequence.try_into().map_err(|_| {
                                "stored deployment event sequence is invalid".to_string()
                            })?,
                            node_id,
                            attempt: attempt.map(|value| value.try_into()).transpose().map_err(
                                |_| "stored deployment event attempt is invalid".to_string(),
                            )?,
                            event_kind,
                            status,
                            summary_key,
                            payload: payload_json
                                .map(|json| serde_json::from_str(&json))
                                .transpose()
                                .map_err(|error| {
                                    format!("stored deployment event payload is invalid: {error}")
                                })?,
                            recorded_at,
                        })
                    },
                )
                .collect::<Result<Vec<_>, String>>()?;
            let has_more = items.len() > limit as usize;
            items.truncate(limit as usize);
            let next_before_sequence = has_more
                .then(|| items.last().map(|item| item.sequence))
                .flatten();
            Ok(DeploymentRunEventPage {
                items,
                next_before_sequence,
            })
        })
    }

    pub(crate) fn list_deployment_run_outputs(
        &self,
        run_id: &str,
    ) -> Result<Vec<DeploymentRunOutputRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT run_id, node_id, output_name, output_kind, value_json,
                            artifact_reference, created_at
                     FROM deployment_run_outputs WHERE run_id = ?1
                     ORDER BY node_id ASC, output_name ASC",
                )
                .map_err(|error| format!("failed to prepare deployment outputs: {error}"))?;
            let raw = statement
                .query_map([run_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                })
                .map_err(|error| format!("failed to query deployment outputs: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment outputs: {error}"))?;
            raw.into_iter()
                .map(
                    |(
                        run_id,
                        node_id,
                        output_name,
                        output_kind,
                        value_json,
                        artifact_reference,
                        created_at,
                    )| {
                        Ok(DeploymentRunOutputRecord {
                            run_id,
                            node_id,
                            output_name,
                            output_kind: DeploymentRunOutputKind::from_str(&output_kind)?,
                            value: serde_json::from_str(&value_json).map_err(|error| {
                                format!("stored deployment output is invalid: {error}")
                            })?,
                            artifact_reference,
                            created_at,
                        })
                    },
                )
                .collect()
        })
    }

    pub(crate) fn list_deployment_effect_receipts(
        &self,
        run_id: &str,
    ) -> Result<Vec<EffectReceipt>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT receipt_json FROM deployment_effect_receipts
                     WHERE run_id = ?1 ORDER BY created_at ASC, operation_id ASC",
                )
                .map_err(|error| format!("failed to prepare deployment receipts: {error}"))?;
            let receipts = statement
                .query_map([run_id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("failed to query deployment receipts: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment receipts: {error}"))?;
            receipts
                .into_iter()
                .map(|json| {
                    serde_json::from_str(&json)
                        .map_err(|error| format!("stored deployment receipt is invalid: {error}"))
                })
                .collect()
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn transition_deployment_run(
        &self,
        run_id: &str,
        expected_status: DeploymentRunStatus,
        next_status: DeploymentRunStatus,
        approval_summary: Option<&Value>,
        summary_key: &str,
        payload: Option<&Value>,
        started_at: Option<i64>,
        finished_at: Option<i64>,
        updated_at: i64,
    ) -> Result<(), String> {
        if !expected_status.can_transition_to(next_status) {
            return Err("DEPLOYMENT_WORKFLOW_INVALID_RUN_STATUS_TRANSITION".into());
        }
        validate_summary_key(summary_key)?;
        let approval_summary = approval_summary
            .map(|summary| {
                validate_bounded_safe_json(
                    summary,
                    MAX_APPROVAL_SUMMARY_BYTES,
                    "DEPLOYMENT_WORKFLOW_APPROVAL_SUMMARY_TOO_LARGE",
                )
            })
            .transpose()?;
        let payload = payload
            .map(|payload| {
                validate_bounded_safe_json(
                    payload,
                    MAX_EVENT_PAYLOAD_BYTES,
                    "DEPLOYMENT_WORKFLOW_EVENT_PAYLOAD_TOO_LARGE",
                )
            })
            .transpose()?;
        self.with_transaction(|transaction| {
            let last_sequence = transaction
                .query_row(
                    "SELECT last_event_sequence FROM deployment_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("failed to read deployment event head: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
            let updated = transaction
                .execute(
                    "UPDATE deployment_runs
                     SET status = ?3,
                         approval_summary_json = COALESCE(?4, approval_summary_json),
                         started_at = COALESCE(started_at, ?5), finished_at = ?6,
                         updated_at = ?7
                     WHERE id = ?1 AND status = ?2",
                    params![
                        run_id,
                        expected_status.as_str(),
                        next_status.as_str(),
                        approval_summary,
                        started_at,
                        finished_at,
                        updated_at
                    ],
                )
                .map_err(|error| format!("failed to transition deployment run: {error}"))?;
            if updated == 1 {
                transaction
                    .execute(
                        "INSERT INTO deployment_run_events (
                            run_id, sequence, event_kind, status, summary_key,
                            payload_json, recorded_at
                         ) VALUES (?1, ?2, 'status_changed', ?3, ?4, ?5, ?6)",
                        params![
                            run_id,
                            last_sequence + 1,
                            next_status.as_str(),
                            summary_key,
                            payload,
                            updated_at
                        ],
                    )
                    .map_err(|error| {
                        format!("failed to append deployment status event: {error}")
                    })?;
                Ok(())
            } else {
                Err("DEPLOYMENT_WORKFLOW_RUN_STATUS_CONFLICT".into())
            }
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn transition_deployment_run_node(
        &self,
        run_id: &str,
        node_id: &str,
        expected_status: DeploymentRunNodeStatus,
        next_status: DeploymentRunNodeStatus,
        output_summary: Option<&Value>,
        summary_key: &str,
        payload: Option<&Value>,
        started_at: Option<i64>,
        finished_at: Option<i64>,
        updated_at: i64,
    ) -> Result<(), String> {
        validate_summary_key(summary_key)?;
        let output_summary = output_summary
            .map(|summary| {
                validate_bounded_safe_json(
                    summary,
                    MAX_NODE_SUMMARY_BYTES,
                    "DEPLOYMENT_WORKFLOW_NODE_SUMMARY_TOO_LARGE",
                )
            })
            .transpose()?;
        let payload = payload
            .map(|payload| {
                validate_bounded_safe_json(
                    payload,
                    MAX_EVENT_PAYLOAD_BYTES,
                    "DEPLOYMENT_WORKFLOW_EVENT_PAYLOAD_TOO_LARGE",
                )
            })
            .transpose()?;
        self.with_transaction(|transaction| {
            let last_sequence = transaction
                .query_row(
                    "SELECT last_event_sequence FROM deployment_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("failed to read deployment event head: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
            let updated = transaction
                .execute(
                    "UPDATE deployment_run_nodes
                     SET status = ?4,
                         output_summary_json = COALESCE(?5, output_summary_json),
                         started_at = COALESCE(started_at, ?6), finished_at = ?7,
                         updated_at = ?8
                     WHERE run_id = ?1 AND node_id = ?2 AND status = ?3",
                    params![
                        run_id,
                        node_id,
                        expected_status.as_str(),
                        next_status.as_str(),
                        output_summary,
                        started_at,
                        finished_at,
                        updated_at
                    ],
                )
                .map_err(|error| format!("failed to transition deployment run node: {error}"))?;
            if updated == 1 {
                transaction
                    .execute(
                        "INSERT INTO deployment_run_events (
                            run_id, sequence, node_id, event_kind, status,
                            summary_key, payload_json, recorded_at
                         ) VALUES (?1, ?2, ?3, 'node_status_changed', ?4, ?5, ?6, ?7)",
                        params![
                            run_id,
                            last_sequence + 1,
                            node_id,
                            next_status.as_str(),
                            summary_key,
                            payload,
                            updated_at
                        ],
                    )
                    .map_err(|error| {
                        format!("failed to append deployment node status event: {error}")
                    })?;
                Ok(())
            } else {
                Err("DEPLOYMENT_WORKFLOW_RUN_NODE_STATUS_CONFLICT".into())
            }
        })
    }

    pub(crate) fn create_deployment_node_attempt(
        &self,
        attempt: &DeploymentNodeAttemptWrite,
    ) -> Result<(), String> {
        if attempt.attempt == 0 {
            return Err("DEPLOYMENT_WORKFLOW_INVALID_ATTEMPT".into());
        }
        self.with_transaction(|transaction| {
            let last_attempt = transaction
                .query_row(
                    "SELECT last_attempt FROM deployment_run_nodes
                     WHERE run_id = ?1 AND node_id = ?2",
                    params![attempt.run_id, attempt.node_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("failed to read deployment attempt head: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NODE_NOT_FOUND".to_string())?;
            let last_event_sequence = transaction
                .query_row(
                    "SELECT last_event_sequence FROM deployment_runs WHERE id = ?1",
                    [&attempt.run_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| format!("failed to read deployment event head: {error}"))?;
            if i64::from(attempt.attempt) != last_attempt + 1 {
                return Err("DEPLOYMENT_WORKFLOW_ATTEMPT_SEQUENCE_CONFLICT".into());
            }
            transaction
                .execute(
                    "INSERT INTO deployment_node_attempts (
                        run_id, node_id, attempt, schema_version, node_type,
                        node_type_version, executor_version, idempotency_key,
                        status, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)",
                    params![
                        attempt.run_id,
                        attempt.node_id,
                        attempt.attempt,
                        attempt.node_type,
                        attempt.node_type_version,
                        attempt.executor_version,
                        attempt.idempotency_key,
                        attempt.created_at
                    ],
                )
                .map_err(|error| format!("failed to create deployment attempt: {error}"))?;
            let updated = transaction
                .execute(
                    "UPDATE deployment_run_nodes
                     SET last_attempt = ?3, updated_at = ?4
                     WHERE run_id = ?1 AND node_id = ?2 AND last_attempt = ?5",
                    params![
                        attempt.run_id,
                        attempt.node_id,
                        attempt.attempt,
                        attempt.created_at,
                        last_attempt
                    ],
                )
                .map_err(|error| {
                    format!("failed to advance deployment attempt projection: {error}")
                })?;
            if updated != 1 {
                return Err("DEPLOYMENT_WORKFLOW_ATTEMPT_SEQUENCE_CONFLICT".into());
            }
            transaction
                .execute(
                    "INSERT INTO deployment_run_events (
                        run_id, sequence, node_id, attempt, event_kind, status,
                        summary_key, recorded_at
                     ) VALUES (?1, ?2, ?3, ?4, 'attempt_created', 'pending',
                               'deployment.attempt.created', ?5)",
                    params![
                        attempt.run_id,
                        last_event_sequence + 1,
                        attempt.node_id,
                        attempt.attempt,
                        attempt.created_at
                    ],
                )
                .map_err(|error| format!("failed to append deployment attempt event: {error}"))?;
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn transition_deployment_node_attempt(
        &self,
        run_id: &str,
        node_id: &str,
        attempt: u32,
        expected_status: NodeAttemptStatus,
        next_status: NodeAttemptStatus,
        failure_category: Option<&str>,
        started_at: Option<i64>,
        finished_at: Option<i64>,
        updated_at: i64,
    ) -> Result<(), String> {
        self.with_transaction(|transaction| {
            let last_event_sequence = transaction
                .query_row(
                    "SELECT last_event_sequence FROM deployment_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("failed to read deployment event head: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
            let updated = transaction
                .execute(
                    "UPDATE deployment_node_attempts
                     SET status = ?5, failure_category = ?6,
                         started_at = COALESCE(started_at, ?7), finished_at = ?8, updated_at = ?9
                     WHERE run_id = ?1 AND node_id = ?2 AND attempt = ?3 AND status = ?4",
                    params![
                        run_id,
                        node_id,
                        attempt,
                        attempt_status(expected_status),
                        attempt_status(next_status),
                        failure_category,
                        started_at,
                        finished_at,
                        updated_at
                    ],
                )
                .map_err(|error| format!("failed to transition deployment attempt: {error}"))?;
            if updated == 1 {
                transaction
                    .execute(
                        "INSERT INTO deployment_run_events (
                            run_id, sequence, node_id, attempt, event_kind, status,
                            summary_key, recorded_at
                         ) VALUES (?1, ?2, ?3, ?4, 'attempt_status_changed', ?5,
                                   'deployment.attempt.statusChanged', ?6)",
                        params![
                            run_id,
                            last_event_sequence + 1,
                            node_id,
                            attempt,
                            attempt_status(next_status),
                            updated_at
                        ],
                    )
                    .map_err(|error| {
                        format!("failed to append deployment attempt status event: {error}")
                    })?;
                Ok(())
            } else {
                Err("DEPLOYMENT_WORKFLOW_ATTEMPT_STATUS_CONFLICT".into())
            }
        })
    }

    pub(crate) fn record_deployment_run_output(
        &self,
        output: &DeploymentRunOutputWrite,
    ) -> Result<String, String> {
        let value_json = validate_bounded_safe_json(
            &output.value,
            MAX_RUN_OUTPUT_BYTES,
            "DEPLOYMENT_WORKFLOW_RUN_OUTPUT_TOO_LARGE",
        )?;
        let value_digest = canonical_sha256(&output.value).map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO deployment_run_outputs (
                        run_id, node_id, output_name, output_kind, value_json,
                        value_digest, artifact_reference, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        output.run_id,
                        output.node_id,
                        output.output_name,
                        output.output_kind.as_str(),
                        value_json,
                        value_digest,
                        output.artifact_reference,
                        output.created_at
                    ],
                )
                .map_err(|error| format!("failed to record deployment output: {error}"))?;
            Ok(value_digest)
        })
    }

    pub(crate) fn record_deployment_effect_receipt(
        &self,
        receipt: &EffectReceipt,
        created_at: i64,
    ) -> Result<(), String> {
        let receipt_json = validate_bounded_safe_json(
            receipt,
            MAX_EFFECT_RECEIPT_BYTES,
            "DEPLOYMENT_WORKFLOW_RECEIPT_TOO_LARGE",
        )?;
        self.with_connection(|connection| {
            let run_plan_digest = connection
                .query_row(
                    "SELECT plan_digest FROM deployment_runs WHERE id = ?1",
                    [&receipt.run_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("failed to read deployment receipt run: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
            if run_plan_digest != receipt.plan_digest {
                return Err("DEPLOYMENT_WORKFLOW_RECEIPT_PLAN_MISMATCH".into());
            }
            connection
                .execute(
                    "INSERT INTO deployment_effect_receipts (
                        operation_id, schema_version, receipt_type, run_id, node_id,
                        attempt, target_id, plan_digest, payload_digest,
                        receipt_json, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        receipt.operation_id,
                        receipt.schema_version,
                        receipt.receipt_type,
                        receipt.run_id,
                        receipt.node_id,
                        receipt.attempt,
                        receipt.target_id,
                        receipt.plan_digest,
                        receipt.payload_digest,
                        receipt_json,
                        created_at
                    ],
                )
                .map(|_| ())
                .map_err(|error| format!("failed to record deployment effect receipt: {error}"))
        })
    }

    pub(crate) fn add_deployment_artifact_ref(
        &self,
        reference: &DeploymentArtifactRefWrite,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO deployment_artifact_refs (
                        id, artifact_reference, workflow_id, run_id, node_id,
                        ref_kind, owner_id, lease_active, retain_until, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                    params![
                        reference.id,
                        reference.artifact_reference,
                        reference.workflow_id,
                        reference.run_id,
                        reference.node_id,
                        reference.ref_kind.as_str(),
                        reference.owner_id,
                        i64::from(reference.lease_active),
                        reference.retain_until,
                        reference.created_at
                    ],
                )
                .map(|_| ())
                .map_err(|error| format!("failed to add deployment artifact reference: {error}"))
        })
    }

    pub(crate) fn set_deployment_artifact_ref_lease(
        &self,
        reference_id: &str,
        lease_active: bool,
        updated_at: i64,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let updated = connection
                .execute(
                    "UPDATE deployment_artifact_refs
                     SET lease_active = ?2, updated_at = ?3 WHERE id = ?1",
                    params![reference_id, i64::from(lease_active), updated_at],
                )
                .map_err(|error| format!("failed to update deployment artifact lease: {error}"))?;
            if updated == 1 {
                Ok(())
            } else {
                Err("DEPLOYMENT_WORKFLOW_ARTIFACT_REF_NOT_FOUND".into())
            }
        })
    }

    pub(crate) fn commit_deployment_release_artifact(
        &self,
        workflow_id: &str,
        run_id: &str,
        artifact_reference: &str,
        release_id: &str,
        updated_at: i64,
    ) -> Result<(), String> {
        self.with_transaction(|transaction| {
            let previous = transaction
                .query_row(
                    "SELECT artifact_reference, owner_id
                     FROM deployment_artifact_refs
                     WHERE workflow_id = ?1 AND ref_kind = 'release_current'
                     ORDER BY created_at DESC LIMIT 1",
                    [workflow_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|error| {
                    format!("failed to read deployment current release reference: {error}")
                })?;
            transaction
                .execute(
                    "DELETE FROM deployment_artifact_refs
                     WHERE workflow_id = ?1 AND ref_kind IN ('release_current', 'release_previous')",
                    [workflow_id],
                )
                .map_err(|error| {
                    format!("failed to rotate deployment release references: {error}")
                })?;
            if let Some((previous_artifact, previous_owner)) = previous
                .filter(|(previous_artifact, _)| previous_artifact != artifact_reference)
            {
                transaction
                    .execute(
                        "INSERT INTO deployment_artifact_refs (
                            id, artifact_reference, workflow_id, run_id, node_id,
                            ref_kind, owner_id, lease_active, retain_until,
                            created_at, updated_at
                         ) VALUES (?1, ?2, ?3, NULL, NULL, 'release_previous', ?4, 0, NULL, ?5, ?5)",
                        params![
                            format!("release-previous-{workflow_id}"),
                            previous_artifact,
                            workflow_id,
                            previous_owner,
                            updated_at
                        ],
                    )
                    .map_err(|error| {
                        format!("failed to retain deployment previous release: {error}")
                    })?;
            }
            transaction
                .execute(
                    "INSERT INTO deployment_artifact_refs (
                        id, artifact_reference, workflow_id, run_id, node_id,
                        ref_kind, owner_id, lease_active, retain_until,
                        created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, NULL, 'release_current', ?5, 0, NULL, ?6, ?6)",
                    params![
                        format!("release-current-{workflow_id}"),
                        artifact_reference,
                        workflow_id,
                        run_id,
                        release_id,
                        updated_at
                    ],
                )
                .map_err(|error| {
                    format!("failed to commit deployment current release: {error}")
                })?;
            Ok(())
        })
    }

    pub(crate) fn append_deployment_run_event(
        &self,
        run_id: &str,
        event: &DeploymentRunEventWrite,
    ) -> Result<DeploymentRunEventRecord, String> {
        validate_summary_key(&event.summary_key)?;
        let payload_json = event
            .payload
            .as_ref()
            .map(|payload| {
                validate_bounded_safe_json(
                    payload,
                    MAX_EVENT_PAYLOAD_BYTES,
                    "DEPLOYMENT_WORKFLOW_EVENT_PAYLOAD_TOO_LARGE",
                )
            })
            .transpose()?;
        self.with_transaction(|transaction| {
            let last_sequence = transaction
                .query_row(
                    "SELECT last_event_sequence FROM deployment_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("failed to read deployment event head: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
            let sequence = last_sequence
                .checked_add(1)
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EVENT_SEQUENCE_OVERFLOW".to_string())?;
            transaction
                .execute(
                    "INSERT INTO deployment_run_events (
                        run_id, sequence, node_id, attempt, event_kind, status,
                        summary_key, payload_json, recorded_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        run_id,
                        sequence,
                        event.node_id,
                        event.attempt,
                        event.event_kind,
                        event.status,
                        event.summary_key,
                        payload_json,
                        event.recorded_at
                    ],
                )
                .map_err(|error| format!("failed to append deployment event: {error}"))?;
            Ok(DeploymentRunEventRecord {
                run_id: run_id.to_string(),
                sequence: sequence
                    .try_into()
                    .map_err(|_| "deployment event sequence is invalid".to_string())?,
                node_id: event.node_id.clone(),
                attempt: event.attempt,
                event_kind: event.event_kind.clone(),
                status: event.status.clone(),
                summary_key: event.summary_key.clone(),
                payload: event.payload.clone(),
                recorded_at: event.recorded_at,
            })
        })
    }

    pub(crate) fn record_verified_deployment_artifact(
        &self,
        artifact: &DeploymentArtifactWrite,
    ) -> Result<(), String> {
        let manifest: ArtifactBundleManifest = serde_json::from_str(&artifact.manifest_json)
            .map_err(|error| format!("deployment artifact manifest is invalid: {error}"))?;
        validate_artifact_manifest(&manifest).map_err(|error| error.to_string())?;
        let canonical_manifest = canonical_json_string(&manifest)?;
        let manifest_digest = canonical_sha256(&manifest).map_err(|error| error.to_string())?;
        let mut components = manifest.components.clone();
        components.sort_by(|left, right| left.name.cmp(&right.name));
        let content_digest = canonical_sha256(&components).map_err(|error| error.to_string())?;
        let handle = ArtifactHandle {
            artifact_reference: artifact.artifact_reference.clone(),
            manifest_digest: artifact.manifest_digest.clone(),
            content_digest: artifact.content_digest.clone(),
        };
        validate_artifact_handle(&handle).map_err(|error| error.to_string())?;
        let total_size = manifest
            .components
            .iter()
            .try_fold(0_u64, |total, component| total.checked_add(component.size))
            .ok_or_else(|| "deployment artifact size overflow".to_string())?;
        if artifact.manifest_json != canonical_manifest
            || artifact.manifest_digest != manifest_digest
            || artifact.content_digest != content_digest
            || artifact.artifact_reference != format!("deployment-artifact:{manifest_digest}")
            || artifact.artifact_type != manifest.artifact_type
            || artifact.component_count as usize != manifest.components.len()
            || artifact.total_size != total_size
        {
            return Err("DEPLOYMENT_WORKFLOW_ARTIFACT_IDENTITY_CONFLICT".into());
        }
        let total_size = i64::try_from(artifact.total_size)
            .map_err(|_| "deployment artifact size does not fit SQLite".to_string())?;
        self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO deployment_artifacts (
                        artifact_reference, manifest_digest, content_digest, artifact_type,
                        manifest_json, component_count, total_size, created_at, verified_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(artifact_reference) DO NOTHING",
                    params![
                        artifact.artifact_reference,
                        artifact.manifest_digest,
                        artifact.content_digest,
                        artifact.artifact_type,
                        artifact.manifest_json,
                        artifact.component_count,
                        total_size,
                        artifact.created_at,
                        artifact.verified_at
                    ],
                )
                .map_err(|error| format!("failed to record deployment artifact: {error}"))?;
            let stored = connection
                .query_row(
                    "SELECT manifest_digest, content_digest, artifact_type, manifest_json,
                            component_count, total_size
                     FROM deployment_artifacts WHERE artifact_reference = ?1",
                    [&artifact.artifact_reference],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )
                .map_err(|error| format!("failed to verify deployment artifact record: {error}"))?;
            let expected_count = i64::from(artifact.component_count);
            let expected_size = total_size;
            if stored
                != (
                    artifact.manifest_digest.clone(),
                    artifact.content_digest.clone(),
                    artifact.artifact_type.clone(),
                    artifact.manifest_json.clone(),
                    expected_count,
                    expected_size,
                )
            {
                return Err("DEPLOYMENT_WORKFLOW_ARTIFACT_IDENTITY_CONFLICT".into());
            }
            Ok(())
        })
    }

    pub(crate) fn deployment_artifact_retention(
        &self,
        artifact_reference: &str,
        now: i64,
    ) -> Result<DeploymentArtifactRetention, String> {
        self.with_connection(|connection| {
            let (reference_count, lease_count, current_release, previous_release, retained_until) =
                connection
                    .query_row(
                        "SELECT COUNT(*),
                                COALESCE(SUM(CASE WHEN lease_active = 1 THEN 1 ELSE 0 END), 0),
                                COALESCE(MAX(CASE WHEN ref_kind = 'release_current' THEN 1 ELSE 0 END), 0),
                                COALESCE(MAX(CASE WHEN ref_kind = 'release_previous' THEN 1 ELSE 0 END), 0),
                                MAX(retain_until)
                         FROM deployment_artifact_refs WHERE artifact_reference = ?1",
                        [artifact_reference],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, Option<i64>>(4)?,
                            ))
                        },
                    )
                    .map_err(|error| {
                        format!("failed to project deployment artifact retention: {error}")
                    })?;
            let unfinished_run_reference: bool = connection
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM deployment_artifact_refs ar
                        JOIN deployment_runs r ON r.id = ar.run_id
                        WHERE ar.artifact_reference = ?1
                          AND r.status NOT IN ('succeeded', 'canceled', 'failed')
                     )",
                    [artifact_reference],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("failed to project deployment run retention: {error}")
                })?;
            let protected = lease_count > 0
                || current_release == 1
                || previous_release == 1
                || retained_until.is_some_and(|until| until >= now)
                || unfinished_run_reference;
            Ok(DeploymentArtifactRetention {
                reference_count: reference_count
                    .try_into()
                    .map_err(|_| "deployment artifact reference count overflow".to_string())?,
                lease_count: lease_count
                    .try_into()
                    .map_err(|_| "deployment artifact lease count overflow".to_string())?,
                current_release: current_release == 1,
                previous_release: previous_release == 1,
                retained_until,
                protected,
            })
        })
    }

    pub(crate) fn get_deployment_artifact_handle(
        &self,
        artifact_reference: &str,
    ) -> Result<Option<ArtifactHandle>, String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT artifact_reference, manifest_digest, content_digest
                     FROM deployment_artifacts WHERE artifact_reference = ?1",
                    [artifact_reference],
                    |row| {
                        Ok(ArtifactHandle {
                            artifact_reference: row.get(0)?,
                            manifest_digest: row.get(1)?,
                            content_digest: row.get(2)?,
                        })
                    },
                )
                .optional()
                .map_err(|error| format!("failed to read deployment artifact handle: {error}"))
        })
    }

    pub(crate) fn list_deployment_artifact_references(
        &self,
        artifact_reference: &str,
    ) -> Result<Vec<DeploymentArtifactReferenceRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT workflow_id, run_id, node_id, ref_kind, owner_id,
                            lease_active, retain_until, created_at
                     FROM deployment_artifact_refs
                     WHERE artifact_reference = ?1
                     ORDER BY created_at DESC, ref_kind ASC, owner_id ASC",
                )
                .map_err(|error| {
                    format!("failed to prepare deployment artifact references: {error}")
                })?;
            let references = statement
                .query_map([artifact_reference], |row| {
                    Ok(DeploymentArtifactReferenceRecord {
                        workflow_id: row.get(0)?,
                        run_id: row.get(1)?,
                        node_id: row.get(2)?,
                        reference_kind: row.get(3)?,
                        owner_id: row.get(4)?,
                        lease_active: row.get::<_, i64>(5)? == 1,
                        retain_until: row.get(6)?,
                        created_at: row.get(7)?,
                    })
                })
                .map_err(|error| {
                    format!("failed to query deployment artifact references: {error}")
                })?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    format!("failed to collect deployment artifact references: {error}")
                })?;
            Ok(references)
        })
    }

    pub(crate) fn list_deployment_releases(
        &self,
        workflow_id: &str,
    ) -> Result<Vec<DeploymentReleaseRecord>, String> {
        let (references, successful_runs) = self.with_connection(|connection| {
            let mut reference_statement = connection
                .prepare(
                    "SELECT ar.owner_id, ar.ref_kind, ar.artifact_reference,
                            a.manifest_digest, a.content_digest, a.artifact_type,
                            ar.run_id, ar.created_at
                     FROM deployment_artifact_refs ar
                     JOIN deployment_artifacts a
                       ON a.artifact_reference = ar.artifact_reference
                     WHERE ar.workflow_id = ?1
                       AND ar.ref_kind IN ('release_current', 'release_previous')
                     ORDER BY CASE ar.ref_kind WHEN 'release_current' THEN 0 ELSE 1 END",
                )
                .map_err(|error| format!("failed to prepare deployment releases: {error}"))?;
            let references = reference_statement
                .query_map([workflow_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                })
                .map_err(|error| format!("failed to query deployment releases: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment releases: {error}"))?;
            let mut run_statement = connection
                .prepare(
                    "SELECT id, plan_json, finished_at
                     FROM deployment_runs
                     WHERE workflow_id = ?1 AND status = 'succeeded'
                     ORDER BY finished_at DESC, id DESC",
                )
                .map_err(|error| format!("failed to prepare deployment release runs: {error}"))?;
            let successful_runs = run_statement
                .query_map([workflow_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                })
                .map_err(|error| format!("failed to query deployment release runs: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment release runs: {error}"))?;
            Ok((references, successful_runs))
        })?;
        let successful_runs = successful_runs
            .into_iter()
            .map(|(run_id, plan_json, finished_at)| {
                let plan: ImmutableRunPlan = serde_json::from_str(&plan_json).map_err(|error| {
                    format!("stored deployment release plan is invalid: {error}")
                })?;
                Ok((run_id, plan, finished_at))
            })
            .collect::<Result<Vec<_>, String>>()?;
        references
            .into_iter()
            .map(
                |(
                    release_id,
                    ref_kind,
                    artifact_reference,
                    manifest_digest,
                    content_digest,
                    artifact_type,
                    ref_run_id,
                    reference_created_at,
                )| {
                    let matching = successful_runs.iter().find(|(_, plan, _)| {
                        plan.target_release.release_id == release_id
                            && plan.target_release.artifact_content_digest == content_digest
                    });
                    let identity = matching.map(|(_, plan, _)| plan.target_release.clone());
                    let source_run_id =
                        ref_run_id.or_else(|| matching.map(|(run_id, _, _)| run_id.clone()));
                    let activated_at = matching
                        .and_then(|(_, _, finished_at)| *finished_at)
                        .or(Some(reference_created_at));
                    let position = ref_kind
                        .strip_prefix("release_")
                        .unwrap_or(&ref_kind)
                        .to_string();
                    Ok(DeploymentReleaseRecord {
                        workflow_id: workflow_id.to_string(),
                        release_id,
                        position: position.clone(),
                        artifact_reference,
                        manifest_digest,
                        content_digest,
                        artifact_type,
                        rollbackable: position == "previous" && identity.is_some(),
                        identity,
                        source_run_id,
                        activated_at,
                    })
                },
            )
            .collect()
    }

    pub(crate) fn get_deployment_release(
        &self,
        workflow_id: &str,
        release_id: &str,
    ) -> Result<Option<DeploymentReleaseRecord>, String> {
        Ok(self
            .list_deployment_releases(workflow_id)?
            .into_iter()
            .find(|release| release.release_id == release_id))
    }

    pub(crate) fn protected_deployment_artifact_manifests(
        &self,
        now: i64,
    ) -> Result<BTreeSet<String>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT DISTINCT a.manifest_digest
                     FROM deployment_artifacts a
                     JOIN deployment_artifact_refs ar
                       ON ar.artifact_reference = a.artifact_reference
                     LEFT JOIN deployment_runs r ON r.id = ar.run_id
                     WHERE ar.lease_active = 1
                        OR ar.ref_kind IN ('release_current', 'release_previous')
                        OR ar.retain_until >= ?1
                        OR (r.id IS NOT NULL AND r.status NOT IN ('succeeded', 'canceled', 'failed'))",
                )
                .map_err(|error| {
                    format!("failed to prepare deployment retention projection: {error}")
                })?;
            let rows = statement
                .query_map([now], |row| row.get::<_, String>(0))
                .map_err(|error| {
                    format!("failed to query deployment retention projection: {error}")
                })?
                .collect::<Result<BTreeSet<_>, _>>()
                .map_err(|error| {
                    format!("failed to collect deployment retention projection: {error}")
                })?;
            Ok(rows)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::test_db;

    const STATIC_SITE: &str =
        include_str!("../../../protocol/deployment/fixtures/static-site-workflow.json");

    fn definition() -> DeploymentWorkflowDefinition {
        serde_json::from_str(STATIC_SITE).unwrap()
    }

    fn database() -> Database {
        let database = test_db();
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO profiles (
                            id, name, host, port, username, auth_method, created_at, updated_at
                         ) VALUES (
                            'profile-production', 'Production', 'example.com', 22,
                            'deploy', 'password', 1, 1
                         )",
                        [],
                    )
                    .unwrap();
                Ok(())
            })
            .unwrap();
        database
    }

    fn layout(x: f64) -> DeploymentWorkflowLayout {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "nodes": { "source": { "x": x, "y": 10.0 } },
            "groups": []
        }))
        .unwrap()
    }

    #[test]
    fn semantic_and_layout_revisions_are_independent_and_reopen_exactly() {
        let database = database();
        let created = database
            .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                name: "Static site".into(),
                definition: definition(),
                layout: Some(layout(1.0)),
                enabled: true,
            })
            .unwrap();
        assert_eq!(created.revision, 1);
        assert_eq!(created.layout_revision, 1);

        let moved = database
            .update_deployment_workflow_layout(
                &created.id,
                1,
                &UpdateDeploymentWorkflowLayoutInput {
                    layout: layout(40.0),
                },
            )
            .unwrap();
        assert_eq!(moved.layout_revision, 2);
        let reopened = database
            .get_deployment_workflow(&created.id)
            .unwrap()
            .unwrap();
        assert_eq!(reopened.revision, 1);
        assert_eq!(reopened.layout_revision, 2);
        assert_eq!(reopened.layout, Some(layout(40.0)));
        assert!(database
            .update_deployment_workflow_layout(
                &created.id,
                1,
                &UpdateDeploymentWorkflowLayoutInput {
                    layout: layout(50.0),
                },
            )
            .unwrap_err()
            .contains("LAYOUT_REVISION_CONFLICT"));

        let updated = database
            .update_deployment_workflow(
                &created.id,
                1,
                &UpdateDeploymentWorkflowInput {
                    name: "Static production".into(),
                    definition: definition(),
                    enabled: true,
                },
            )
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.layout_revision, 2);
        assert!(database
            .update_deployment_workflow(
                &created.id,
                1,
                &UpdateDeploymentWorkflowInput {
                    name: "stale".into(),
                    definition: definition(),
                    enabled: true,
                },
            )
            .unwrap_err()
            .contains("REVISION_CONFLICT"));
        database
            .with_connection(|connection| {
                assert!(connection
                    .execute("DELETE FROM profiles WHERE id = 'profile-production'", [],)
                    .is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn workflow_pages_are_stable_and_archive_replaces_delete() {
        let database = database();
        let mut ids = Vec::new();
        for name in ["A", "B", "C"] {
            ids.push(
                database
                    .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                        name: name.into(),
                        definition: definition(),
                        layout: None,
                        enabled: true,
                    })
                    .unwrap()
                    .id,
            );
        }
        let first = database.list_deployment_workflows(None, 2, false).unwrap();
        assert_eq!(first.items.len(), 2);
        let second = database
            .list_deployment_workflows(first.next_cursor.as_deref(), 2, false)
            .unwrap();
        assert_eq!(second.items.len(), 1);
        database.archive_deployment_workflow(&ids[0], 1).unwrap();
        assert!(
            database
                .get_deployment_workflow(&ids[0])
                .unwrap()
                .unwrap()
                .archived
        );
        assert_eq!(
            database
                .list_deployment_workflows(None, 10, false)
                .unwrap()
                .items
                .len(),
            2
        );
    }

    #[test]
    fn workflow_persistence_rejects_missing_target_profiles() {
        let database = test_db();
        let error = database
            .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                name: "Static".into(),
                definition: definition(),
                layout: None,
                enabled: false,
            })
            .unwrap_err();
        assert_eq!(error, "DEPLOYMENT_WORKFLOW_PROFILE_NOT_FOUND");
    }

    #[test]
    fn semantic_revision_compare_and_swap_has_one_concurrent_winner() {
        let database = database();
        let workflow = database
            .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                name: "Static".into(),
                definition: definition(),
                layout: None,
                enabled: true,
            })
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let outcomes = std::thread::scope(|scope| {
            let threads = ["A", "B"].map(|suffix| {
                let database = database.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                let workflow_id = workflow.id.clone();
                scope.spawn(move || {
                    barrier.wait();
                    database.update_deployment_workflow(
                        &workflow_id,
                        1,
                        &UpdateDeploymentWorkflowInput {
                            name: format!("Static {suffix}"),
                            definition: definition(),
                            enabled: true,
                        },
                    )
                })
            });
            barrier.wait();
            threads.map(|thread| thread.join().unwrap())
        });
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|result| result
                    .as_ref()
                    .is_err_and(|error| error.contains("REVISION_CONFLICT")))
                .count(),
            1
        );
    }

    fn insert_run_fixture(database: &Database, workflow: &DeploymentWorkflowRecord) {
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO deployment_runs (
                            id, workflow_id, workflow_revision, operation_kind, trigger_kind,
                            status, definition_digest, plan_digest, plan_json, created_at, updated_at
                         ) VALUES ('run', ?1, 1, 'deploy', 'manual', 'planned', ?2, ?3, '{}', 10, 10)",
                        params![workflow.id, workflow.definition_digest, format!("sha256:{}", "1".repeat(64))],
                    )
                    .unwrap();
                connection
                    .execute(
                        "INSERT INTO deployment_run_nodes (
                            run_id, node_id, node_type, node_type_version, status,
                            last_attempt, updated_at
                         ) VALUES ('run', 'source', 'source.snapshot', 1, 'pending', 0, 10)",
                        [],
                    )
                    .unwrap();
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn attempt_identity_and_events_are_immutable_and_contiguous() {
        let database = database();
        let workflow = database
            .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                name: "Static".into(),
                definition: definition(),
                layout: None,
                enabled: true,
            })
            .unwrap();
        insert_run_fixture(&database, &workflow);
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO deployment_node_attempts (
                            run_id, node_id, attempt, schema_version, node_type,
                            node_type_version, executor_version, idempotency_key, status,
                            created_at, updated_at
                         ) VALUES (
                            'run', 'source', 1, 1, 'source.snapshot', 1,
                            'executor@1', 'idem-1', 'pending', 10, 10
                         )",
                        [],
                    )
                    .unwrap();
                assert!(connection
                    .execute(
                        "UPDATE deployment_node_attempts SET idempotency_key = 'changed'
                         WHERE run_id = 'run' AND node_id = 'source' AND attempt = 1",
                        [],
                    )
                    .is_err());
                Ok(())
            })
            .unwrap();
        let event = DeploymentRunEventWrite {
            node_id: Some("source".into()),
            attempt: Some(1),
            event_kind: "attempt_started".into(),
            status: Some("running".into()),
            summary_key: "deployment.attempt.started".into(),
            payload: Some(serde_json::json!({"bounded": true})),
            recorded_at: 11,
        };
        let mut unsafe_event = event.clone();
        unsafe_event.payload = Some(serde_json::json!({"stdout": "token=must-not-persist"}));
        assert_eq!(
            database
                .append_deployment_run_event("run", &unsafe_event)
                .unwrap_err(),
            "DEPLOYMENT_WORKFLOW_SECRET_LITERAL_FORBIDDEN"
        );
        let mut oversized_event = event.clone();
        oversized_event.payload = Some(serde_json::json!({
            "bounded": "x".repeat(super::MAX_EVENT_PAYLOAD_BYTES + 1)
        }));
        assert_eq!(
            database
                .append_deployment_run_event("run", &oversized_event)
                .unwrap_err(),
            "DEPLOYMENT_WORKFLOW_EVENT_PAYLOAD_TOO_LARGE"
        );
        assert_eq!(
            database
                .append_deployment_run_event("run", &event)
                .unwrap()
                .sequence,
            1
        );
        database
            .with_connection(|connection| {
                assert!(connection
                    .execute(
                        "INSERT INTO deployment_run_events (
                            run_id, sequence, event_kind, summary_key, recorded_at
                         ) VALUES ('run', 3, 'gap', 'deployment.gap', 12)",
                        [],
                    )
                    .is_err());
                assert!(connection
                    .execute(
                        "UPDATE deployment_run_events SET summary_key = 'changed'
                         WHERE run_id = 'run' AND sequence = 1",
                        [],
                    )
                    .is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn run_and_event_pages_are_stable() {
        let database = database();
        let workflow = database
            .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                name: "Static".into(),
                definition: definition(),
                layout: None,
                enabled: true,
            })
            .unwrap();
        for index in 1..=3 {
            database
                .create_deployment_run(
                    &DeploymentRunWrite {
                        id: format!("run-page-{index}"),
                        workflow_id: workflow.id.clone(),
                        workflow_revision: workflow.revision,
                        operation_kind: WorkflowRunOperationKind::Deploy,
                        trigger_kind: WorkflowRunTriggerKind::Manual,
                        definition_digest: workflow.definition_digest.clone(),
                        plan_digest: format!("sha256:{index:064x}"),
                        plan: serde_json::json!({"schemaVersion": 1}),
                        approval_summary: None,
                        created_at: 100 + index,
                    },
                    &[DeploymentRunNodeSeed {
                        node_id: "source".into(),
                        node_type: "source.snapshot".into(),
                        node_type_version: 1,
                    }],
                )
                .unwrap();
        }
        let first = database
            .list_deployment_runs(&workflow.id, None, 2)
            .unwrap();
        assert_eq!(
            first
                .items
                .iter()
                .map(|run| run.id.as_str())
                .collect::<Vec<_>>(),
            vec!["run-page-3", "run-page-2"]
        );
        let second = database
            .list_deployment_runs(&workflow.id, first.next_cursor.as_deref(), 2)
            .unwrap();
        assert_eq!(second.items[0].id, "run-page-1");
        assert!(second.next_cursor.is_none());

        for recorded_at in 104..=106 {
            database
                .append_deployment_run_event(
                    "run-page-3",
                    &DeploymentRunEventWrite {
                        node_id: Some("source".into()),
                        attempt: None,
                        event_kind: "projection".into(),
                        status: Some("pending".into()),
                        summary_key: "deployment.projection".into(),
                        payload: None,
                        recorded_at,
                    },
                )
                .unwrap();
        }
        let events = database
            .list_deployment_run_events("run-page-3", None, 2)
            .unwrap();
        assert_eq!(
            events
                .items
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![4, 3]
        );
        let older = database
            .list_deployment_run_events("run-page-3", events.next_before_sequence, 2)
            .unwrap();
        assert_eq!(
            older
                .items
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
    }

    #[test]
    fn run_attempt_output_artifact_receipt_and_retention_boundaries_are_durable() {
        let database = database();
        let workflow = database
            .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                name: "Static".into(),
                definition: definition(),
                layout: None,
                enabled: true,
            })
            .unwrap();
        let plan_digest = format!("sha256:{}", "1".repeat(64));
        database
            .create_deployment_run(
                &DeploymentRunWrite {
                    id: "run-durable".into(),
                    workflow_id: workflow.id.clone(),
                    workflow_revision: workflow.revision,
                    operation_kind: WorkflowRunOperationKind::Deploy,
                    trigger_kind: WorkflowRunTriggerKind::Manual,
                    definition_digest: workflow.definition_digest.clone(),
                    plan_digest: plan_digest.clone(),
                    plan: serde_json::json!({"schemaVersion": 1}),
                    approval_summary: None,
                    created_at: 100,
                },
                &[DeploymentRunNodeSeed {
                    node_id: "transfer".into(),
                    node_type: "transfer.sftp".into(),
                    node_type_version: 2,
                }],
            )
            .unwrap();
        database
            .transition_deployment_run(
                "run-durable",
                DeploymentRunStatus::Planned,
                DeploymentRunStatus::AwaitingApproval,
                Some(&serde_json::json!({"summary": "bounded"})),
                "deployment.run.awaitingApproval",
                None,
                None,
                None,
                101,
            )
            .unwrap();
        database
            .transition_deployment_run_node(
                "run-durable",
                "transfer",
                DeploymentRunNodeStatus::Pending,
                DeploymentRunNodeStatus::Ready,
                None,
                "deployment.node.ready",
                None,
                None,
                None,
                101,
            )
            .unwrap();
        database
            .create_deployment_node_attempt(&DeploymentNodeAttemptWrite {
                run_id: "run-durable".into(),
                node_id: "transfer".into(),
                attempt: 1,
                node_type: "transfer.sftp".into(),
                node_type_version: 2,
                executor_version: "native@1".into(),
                idempotency_key: "run-durable/transfer/1".into(),
                created_at: 101,
            })
            .unwrap();
        assert!(database
            .create_deployment_node_attempt(&DeploymentNodeAttemptWrite {
                run_id: "run-durable".into(),
                node_id: "transfer".into(),
                attempt: 3,
                node_type: "transfer.sftp".into(),
                node_type_version: 2,
                executor_version: "native@1".into(),
                idempotency_key: "skipped-attempt".into(),
                created_at: 101,
            })
            .unwrap_err()
            .contains("SEQUENCE_CONFLICT"));
        database
            .transition_deployment_node_attempt(
                "run-durable",
                "transfer",
                1,
                NodeAttemptStatus::Pending,
                NodeAttemptStatus::Running,
                None,
                Some(102),
                None,
                102,
            )
            .unwrap();
        database
            .transition_deployment_node_attempt(
                "run-durable",
                "transfer",
                1,
                NodeAttemptStatus::Running,
                NodeAttemptStatus::Failed,
                Some("transport"),
                None,
                Some(103),
                103,
            )
            .unwrap();
        assert!(database
            .create_deployment_node_attempt(&DeploymentNodeAttemptWrite {
                run_id: "run-durable".into(),
                node_id: "transfer".into(),
                attempt: 2,
                node_type: "transfer.sftp".into(),
                node_type_version: 2,
                executor_version: "native@1".into(),
                idempotency_key: "run-durable/transfer/1".into(),
                created_at: 103,
            })
            .unwrap_err()
            .contains("idempotency"));
        database
            .create_deployment_node_attempt(&DeploymentNodeAttemptWrite {
                run_id: "run-durable".into(),
                node_id: "transfer".into(),
                attempt: 2,
                node_type: "transfer.sftp".into(),
                node_type_version: 2,
                executor_version: "native@1".into(),
                idempotency_key: "run-durable/transfer/2".into(),
                created_at: 104,
            })
            .unwrap();
        let first_page = database
            .list_deployment_node_attempts("run-durable", "transfer", None, 1)
            .unwrap();
        assert_eq!(first_page.items[0].attempt, 2);
        assert_eq!(first_page.next_before_attempt, Some(2));
        assert_eq!(
            database
                .list_deployment_node_attempts(
                    "run-durable",
                    "transfer",
                    first_page.next_before_attempt,
                    1,
                )
                .unwrap()
                .items[0]
                .attempt,
            1
        );

        let component_digest = format!("sha256:{}", "2".repeat(64));
        let artifact_manifest: ArtifactBundleManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "artifactType": "application/vnd.shellspan.file-tree",
            "source": {
                "revision": "abc123",
                "dirty": false,
                "snapshotDigest": format!("sha256:{}", "6".repeat(64))
            },
            "components": [{
                "name": "dist.tar",
                "role": "application",
                "mediaType": "application/octet-stream",
                "digest": component_digest,
                "size": 12,
                "annotations": {}
            }],
            "producer": {
                "nodeType": "artifact.collect",
                "nodeTypeVersion": 1,
                "configDigest": format!("sha256:{}", "7".repeat(64))
            },
            "annotations": {}
        }))
        .unwrap();
        let manifest_json = canonical_json_string(&artifact_manifest).unwrap();
        let manifest_digest = canonical_sha256(&artifact_manifest).unwrap();
        let content_digest = canonical_sha256(&artifact_manifest.components).unwrap();
        let artifact_reference = format!("deployment-artifact:{manifest_digest}");
        database
            .record_verified_deployment_artifact(&DeploymentArtifactWrite {
                artifact_reference: artifact_reference.clone(),
                manifest_digest: manifest_digest.clone(),
                content_digest,
                artifact_type: "application/vnd.shellspan.file-tree".into(),
                manifest_json,
                component_count: 1,
                total_size: 12,
                created_at: 100,
                verified_at: 103,
            })
            .unwrap();
        let output_digest = database
            .record_deployment_run_output(&DeploymentRunOutputWrite {
                run_id: "run-durable".into(),
                node_id: "transfer".into(),
                output_name: "bundle".into(),
                output_kind: DeploymentRunOutputKind::Artifact,
                value: serde_json::json!({"artifactReference": artifact_reference}),
                artifact_reference: Some(artifact_reference.clone()),
                created_at: 104,
            })
            .unwrap();
        assert!(output_digest.starts_with("sha256:"));
        database
            .record_deployment_effect_receipt(
                &EffectReceipt {
                    schema_version: 1,
                    receipt_type: "transfer".into(),
                    operation_id: "operation-1".into(),
                    run_id: "run-durable".into(),
                    node_id: "transfer".into(),
                    attempt: 1,
                    target_id: "production".into(),
                    plan_digest: plan_digest.clone(),
                    payload_digest: format!("sha256:{}", "4".repeat(64)),
                },
                105,
            )
            .unwrap();
        database
            .add_deployment_artifact_ref(&DeploymentArtifactRefWrite {
                id: "artifact-ref-1".into(),
                artifact_reference: artifact_reference.clone(),
                workflow_id: Some(workflow.id.clone()),
                run_id: Some("run-durable".into()),
                node_id: Some("transfer".into()),
                ref_kind: DeploymentArtifactRefKind::Run,
                owner_id: "run-durable".into(),
                lease_active: true,
                retain_until: None,
                created_at: 106,
            })
            .unwrap();
        database
            .add_deployment_artifact_ref(&DeploymentArtifactRefWrite {
                id: "artifact-ref-current".into(),
                artifact_reference: artifact_reference.clone(),
                workflow_id: Some(workflow.id.clone()),
                run_id: None,
                node_id: None,
                ref_kind: DeploymentArtifactRefKind::ReleaseCurrent,
                owner_id: "release-current".into(),
                lease_active: false,
                retain_until: None,
                created_at: 106,
            })
            .unwrap();
        database
            .add_deployment_artifact_ref(&DeploymentArtifactRefWrite {
                id: "artifact-ref-previous".into(),
                artifact_reference: artifact_reference.clone(),
                workflow_id: Some(workflow.id.clone()),
                run_id: None,
                node_id: None,
                ref_kind: DeploymentArtifactRefKind::ReleasePrevious,
                owner_id: "release-previous".into(),
                lease_active: false,
                retain_until: Some(500),
                created_at: 106,
            })
            .unwrap();
        let retention = database
            .deployment_artifact_retention(&artifact_reference, 107)
            .unwrap();
        assert_eq!(retention.reference_count, 3);
        assert_eq!(retention.lease_count, 1);
        assert!(retention.current_release);
        assert!(retention.previous_release);
        assert_eq!(retention.retained_until, Some(500));
        assert!(retention.protected);
        assert!(database
            .protected_deployment_artifact_manifests(107)
            .unwrap()
            .contains(&manifest_digest));
        database
            .set_deployment_artifact_ref_lease("artifact-ref-1", false, 108)
            .unwrap();
        assert!(
            database
                .deployment_artifact_retention(&artifact_reference, 109)
                .unwrap()
                .protected,
            "unfinished run references remain protected"
        );

        database
            .with_connection(|connection| {
                assert_eq!(
                    connection
                        .query_row(
                            "SELECT last_event_sequence FROM deployment_runs
                             WHERE id = 'run-durable'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap(),
                    7
                );
                assert!(connection
                    .execute(
                        "UPDATE deployment_run_outputs SET value_json = '{}'
                         WHERE run_id = 'run-durable' AND node_id = 'transfer'",
                        [],
                    )
                    .is_err());
                assert!(connection
                    .execute(
                        "UPDATE deployment_effect_receipts SET target_id = 'other'
                         WHERE operation_id = 'operation-1'",
                        [],
                    )
                    .is_err());
                assert!(connection
                    .execute(
                        "UPDATE deployment_artifacts SET content_digest = ?1
                         WHERE artifact_reference = ?2",
                        params![format!("sha256:{}", "5".repeat(64)), artifact_reference],
                    )
                    .is_err());
                Ok(())
            })
            .unwrap();
        database
            .archive_deployment_workflow(&workflow.id, workflow.revision)
            .unwrap();
        database
            .with_connection(|connection| {
                assert!(connection
                    .execute(
                        "DELETE FROM deployment_workflows WHERE id = ?1",
                        [&workflow.id],
                    )
                    .is_err());
                Ok(())
            })
            .unwrap();
    }
}
