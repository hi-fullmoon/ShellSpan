use super::artifact_transfer::DeploymentArtifactTransferStatus;
use super::{
    DeploymentApprovalPlanSummary, DeploymentArtifactTransferRequest,
    DeploymentArtifactTransferResult, DeploymentEventKind, DeploymentOperationKind,
    DeploymentRunStatus, DeploymentTriggerKind, DeploymentWorkflowDefinition,
};
use crate::db::{current_timestamp_ms, Database};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentWorkflowCreate {
    pub name: String,
    pub definition: DeploymentWorkflowDefinition,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentWorkflowUpdate {
    pub expected_revision: u32,
    pub name: String,
    pub definition: DeploymentWorkflowDefinition,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentWorkflowRecord {
    pub id: String,
    pub name: String,
    pub connection_profile_id: String,
    pub revision: u32,
    pub definition: DeploymentWorkflowDefinition,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunRecord {
    pub id: String,
    pub workflow_id: String,
    pub workflow_revision: u32,
    pub source_run_id: Option<String>,
    pub operation_kind: DeploymentOperationKind,
    pub trigger_kind: DeploymentTriggerKind,
    pub status: DeploymentRunStatus,
    pub approval_summary: DeploymentApprovalPlanSummary,
    pub approval_digest: String,
    pub reconciliation_required: bool,
    pub last_event_sequence: u32,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunEventRecord {
    pub run_id: String,
    pub sequence: u32,
    pub event_kind: DeploymentEventKind,
    pub status: Option<DeploymentRunStatus>,
    pub summary: String,
    pub payload: Option<serde_json::Value>,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunPage {
    pub items: Vec<DeploymentRunRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunEventPage {
    pub items: Vec<DeploymentRunEventRecord>,
    pub next_before_sequence: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunDetail {
    pub run: DeploymentRunRecord,
    pub events: Vec<DeploymentRunEventRecord>,
    pub next_before_sequence: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentNotificationKind {
    Succeeded,
    AutomaticRestoreCompleted,
    Failed,
    UserActionRequired,
}

impl DeploymentNotificationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::AutomaticRestoreCompleted => "automatic_restore_completed",
            Self::Failed => "failed",
            Self::UserActionRequired => "user_action_required",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentNotificationReceipt {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub event_sequence: u32,
    pub status: DeploymentRunStatus,
    pub kind: DeploymentNotificationKind,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentTransferReceiptRecord {
    pub operation_id: String,
    pub run_id: String,
    pub plan_id: String,
    pub plan_digest: String,
    pub request: DeploymentArtifactTransferRequest,
    pub result: DeploymentArtifactTransferResult,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
#[allow(dead_code, reason = "stage 3 consumes the atomic durable run boundary")]
pub(crate) struct DeploymentRunWrite {
    pub id: String,
    pub workflow_id: String,
    pub workflow_revision: u32,
    pub source_run_id: Option<String>,
    pub operation_kind: DeploymentOperationKind,
    pub trigger_kind: DeploymentTriggerKind,
    pub status: DeploymentRunStatus,
    pub approval_summary: DeploymentApprovalPlanSummary,
    pub approval_digest: String,
}

#[derive(Debug, Clone)]
#[allow(
    dead_code,
    reason = "stage 3 consumes the atomic durable event boundary"
)]
pub(crate) struct DeploymentEventWrite {
    pub event_kind: DeploymentEventKind,
    pub status: Option<DeploymentRunStatus>,
    pub summary: String,
    pub payload: Option<serde_json::Value>,
}

struct RawWorkflow {
    id: String,
    name: String,
    connection_profile_id: String,
    revision: i64,
    definition_json: String,
    enabled: i64,
    created_at: i64,
    updated_at: i64,
}

fn raw_workflow(row: &Row<'_>) -> rusqlite::Result<RawWorkflow> {
    Ok(RawWorkflow {
        id: row.get(0)?,
        name: row.get(1)?,
        connection_profile_id: row.get(2)?,
        revision: row.get(3)?,
        definition_json: row.get(4)?,
        enabled: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn workflow_from_raw(raw: RawWorkflow) -> Result<DeploymentWorkflowRecord, String> {
    let definition = DeploymentWorkflowDefinition::from_json(&raw.definition_json)
        .map_err(|error| format!("stored deployment workflow is invalid: {error}"))?;
    if definition.target.connection_profile_id != raw.connection_profile_id {
        return Err("stored deployment workflow profile identity is inconsistent".into());
    }
    Ok(DeploymentWorkflowRecord {
        id: raw.id,
        name: raw.name,
        connection_profile_id: raw.connection_profile_id,
        revision: raw
            .revision
            .try_into()
            .map_err(|_| "stored deployment workflow revision is invalid".to_string())?,
        definition,
        enabled: raw.enabled == 1,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    })
}

fn validate_workflow_input(
    name: &str,
    definition: &DeploymentWorkflowDefinition,
) -> Result<(), String> {
    super::validate_text("workflow name", name, 200).map_err(|error| error.to_string())?;
    definition.validate().map_err(|error| error.to_string())
}

fn ensure_profile_exists(
    connection: &rusqlite::Connection,
    profile_id: &str,
) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
            [profile_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to validate deployment profile: {error}"))?;
    if !exists {
        return Err("DEPLOYMENT_PROFILE_NOT_FOUND".into());
    }
    Ok(())
}

fn parse_wire_enum<T>(value: String, label: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(serde_json::Value::String(value))
        .map_err(|_| format!("stored deployment {label} is invalid"))
}

fn validate_digest(value: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
    {
        Ok(())
    } else {
        Err("deployment approval digest must be lowercase SHA-256 hex".into())
    }
}

fn decode_run_cursor(cursor: Option<&str>) -> Result<Option<(i64, String)>, String> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    if cursor.len() > 256 {
        return Err("deployment run cursor is invalid".into());
    }
    let (created_at, id) = cursor
        .split_once(':')
        .ok_or_else(|| "deployment run cursor is invalid".to_string())?;
    let created_at = created_at
        .parse::<i64>()
        .ok()
        .filter(|value| *value >= 0)
        .ok_or_else(|| "deployment run cursor is invalid".to_string())?;
    super::validate_identifier("deployment run cursor id", id, 128)
        .map_err(|_| "deployment run cursor is invalid".to_string())?;
    Ok(Some((created_at, id.to_string())))
}

fn encode_run_cursor(run: &DeploymentRunRecord) -> String {
    format!("{}:{}", run.created_at, run.id)
}

impl Database {
    pub(crate) fn list_deployment_startup_recovery_runs(
        &self,
        limit: u32,
    ) -> Result<Vec<DeploymentRunRecord>, String> {
        if !(1..=100).contains(&limit) {
            return Err("deployment recovery limit must be between 1 and 100".into());
        }
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, workflow_id, workflow_revision, source_run_id, operation_kind,
                            trigger_kind, status, approval_summary_json, approval_digest,
                            reconciliation_required, last_event_sequence, created_at, updated_at,
                            started_at, finished_at
                     FROM deployment_runs
                     WHERE status IN (
                        'reconciling', 'in_progress', 'verifying', 'cancel_requested', 'state_unknown'
                     )
                     ORDER BY updated_at DESC, id ASC LIMIT ?1",
                )
                .map_err(|error| format!("failed to prepare deployment recovery runs: {error}"))?;
            let raw = statement
                .query_map([limit], raw_run)
                .map_err(|error| format!("failed to query deployment recovery runs: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment recovery runs: {error}"))?;
            raw.into_iter().map(run_from_raw).collect()
        })
    }

    pub(crate) fn list_deployment_workflows(
        &self,
    ) -> Result<Vec<DeploymentWorkflowRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, name, connection_profile_id, revision, definition_json,
                            enabled, created_at, updated_at
                     FROM deployment_workflows
                     ORDER BY updated_at DESC, id ASC",
                )
                .map_err(|error| format!("failed to prepare deployment workflows: {error}"))?;
            let raw = statement
                .query_map([], raw_workflow)
                .map_err(|error| format!("failed to query deployment workflows: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment workflows: {error}"))?;
            raw.into_iter().map(workflow_from_raw).collect()
        })
    }

    pub(crate) fn get_deployment_workflow(
        &self,
        id: &str,
    ) -> Result<Option<DeploymentWorkflowRecord>, String> {
        super::validate_identifier("workflow id", id, 128).map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let raw = connection
                .query_row(
                    "SELECT id, name, connection_profile_id, revision, definition_json,
                            enabled, created_at, updated_at
                     FROM deployment_workflows WHERE id = ?1",
                    [id],
                    raw_workflow,
                )
                .optional()
                .map_err(|error| format!("failed to get deployment workflow: {error}"))?;
            raw.map(workflow_from_raw).transpose()
        })
    }

    pub(crate) fn create_deployment_workflow(
        &self,
        id: &str,
        input: &DeploymentWorkflowCreate,
    ) -> Result<DeploymentWorkflowRecord, String> {
        super::validate_identifier("workflow id", id, 128).map_err(|error| error.to_string())?;
        validate_workflow_input(&input.name, &input.definition)?;
        let definition_json = serde_json::to_string(&input.definition)
            .map_err(|error| format!("failed to serialize deployment workflow: {error}"))?;
        // `definition_version` is the v1 SQLite JSON envelope discriminator;
        // the closed workflow protocol version is validated inside the JSON.
        let profile_id = input.definition.target.connection_profile_id.clone();
        let timestamp = current_timestamp_ms();
        self.with_transaction(|transaction| {
            ensure_profile_exists(transaction, &profile_id)?;
            transaction
                .execute(
                    "INSERT INTO deployment_workflows (
                        id, name, connection_profile_id, revision, definition_version,
                        definition_json, enabled, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?7)",
                    params![
                        id,
                        input.name,
                        profile_id,
                        1,
                        definition_json,
                        i64::from(input.enabled),
                        timestamp,
                    ],
                )
                .map_err(|error| format!("failed to create deployment workflow: {error}"))?;
            Ok(())
        })?;
        self.get_deployment_workflow(id)?
            .ok_or_else(|| "created deployment workflow was not found".to_string())
    }

    pub(crate) fn update_deployment_workflow(
        &self,
        id: &str,
        input: &DeploymentWorkflowUpdate,
    ) -> Result<DeploymentWorkflowRecord, String> {
        super::validate_identifier("workflow id", id, 128).map_err(|error| error.to_string())?;
        if input.expected_revision == 0 {
            return Err("deployment workflow expected revision must be positive".into());
        }
        validate_workflow_input(&input.name, &input.definition)?;
        let definition_json = serde_json::to_string(&input.definition)
            .map_err(|error| format!("failed to serialize deployment workflow: {error}"))?;
        let profile_id = input.definition.target.connection_profile_id.clone();
        let timestamp = current_timestamp_ms();
        self.with_transaction(|transaction| {
            ensure_profile_exists(transaction, &profile_id)?;
            let changed = transaction
                .execute(
                    "UPDATE deployment_workflows
                     SET name = ?3,
                         connection_profile_id = ?4,
                         revision = revision + 1,
                         definition_version = ?5,
                         definition_json = ?6,
                         enabled = ?7,
                         updated_at = ?8
                     WHERE id = ?1 AND revision = ?2",
                    params![
                        id,
                        input.expected_revision,
                        input.name,
                        profile_id,
                        1,
                        definition_json,
                        i64::from(input.enabled),
                        timestamp,
                    ],
                )
                .map_err(|error| format!("failed to update deployment workflow: {error}"))?;
            if changed == 0 {
                let exists: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM deployment_workflows WHERE id = ?1)",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(|error| format!("failed to inspect deployment workflow: {error}"))?;
                return Err(if exists {
                    "REVISION_CONFLICT".into()
                } else {
                    "DEPLOYMENT_WORKFLOW_NOT_FOUND".into()
                });
            }
            Ok(())
        })?;
        self.get_deployment_workflow(id)?
            .ok_or_else(|| "updated deployment workflow was not found".to_string())
    }

    pub(crate) fn delete_deployment_workflow(
        &self,
        id: &str,
        expected_revision: u32,
    ) -> Result<(), String> {
        super::validate_identifier("workflow id", id, 128).map_err(|error| error.to_string())?;
        if expected_revision == 0 {
            return Err("deployment workflow expected revision must be positive".into());
        }
        self.with_transaction(|transaction| {
            let current_revision = transaction
                .query_row(
                    "SELECT revision FROM deployment_workflows WHERE id = ?1",
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("failed to inspect deployment workflow: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_NOT_FOUND".to_string())?;
            if current_revision != i64::from(expected_revision) {
                return Err("REVISION_CONFLICT".into());
            }
            let run_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM deployment_runs WHERE workflow_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("failed to inspect deployment workflow runs: {error}"))?;
            if run_count != 0 {
                return Err("DEPLOYMENT_WORKFLOW_HAS_RUNS".into());
            }
            transaction
                .execute(
                    "DELETE FROM deployment_workflows WHERE id = ?1 AND revision = ?2",
                    params![id, expected_revision],
                )
                .map_err(|error| format!("failed to delete deployment workflow: {error}"))?;
            Ok(())
        })
    }

    pub(crate) fn list_deployment_runs(
        &self,
        workflow_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<DeploymentRunRecord>, String> {
        if !(1..=200).contains(&limit) {
            return Err("deployment run limit must be between 1 and 200".into());
        }
        if let Some(workflow_id) = workflow_id {
            super::validate_identifier("workflow id", workflow_id, 128)
                .map_err(|error| error.to_string())?;
        }
        self.with_connection(|connection| {
            let sql = if workflow_id.is_some() {
                "SELECT id, workflow_id, workflow_revision, source_run_id, operation_kind,
                        trigger_kind, status, approval_summary_json, approval_digest,
                        reconciliation_required, last_event_sequence, created_at, updated_at,
                        started_at, finished_at
                 FROM deployment_runs WHERE workflow_id = ?1
                 ORDER BY created_at DESC, id ASC LIMIT ?2"
            } else {
                "SELECT id, workflow_id, workflow_revision, source_run_id, operation_kind,
                        trigger_kind, status, approval_summary_json, approval_digest,
                        reconciliation_required, last_event_sequence, created_at, updated_at,
                        started_at, finished_at
                 FROM deployment_runs
                 ORDER BY created_at DESC, id ASC LIMIT ?1"
            };
            let mut statement = connection
                .prepare(sql)
                .map_err(|error| format!("failed to prepare deployment runs: {error}"))?;
            let raw_rows = if let Some(workflow_id) = workflow_id {
                statement.query_map(params![workflow_id, limit], raw_run)
            } else {
                statement.query_map(params![limit], raw_run)
            }
            .map_err(|error| format!("failed to query deployment runs: {error}"))?;
            raw_rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment runs: {error}"))?
                .into_iter()
                .map(run_from_raw)
                .collect()
        })
    }

    pub(crate) fn list_deployment_run_page(
        &self,
        workflow_id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<DeploymentRunPage, String> {
        if !(1..=100).contains(&limit) {
            return Err("deployment run page limit must be between 1 and 100".into());
        }
        if let Some(workflow_id) = workflow_id {
            super::validate_identifier("workflow id", workflow_id, 128)
                .map_err(|error| error.to_string())?;
        }
        let decoded = decode_run_cursor(cursor)?;
        let cursor_created_at = decoded.as_ref().map(|(created_at, _)| *created_at);
        let cursor_id = decoded.as_ref().map(|(_, id)| id.as_str());
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, workflow_id, workflow_revision, source_run_id, operation_kind,
                            trigger_kind, status, approval_summary_json, approval_digest,
                            reconciliation_required, last_event_sequence, created_at, updated_at,
                            started_at, finished_at
                     FROM deployment_runs
                     WHERE (?1 IS NULL OR workflow_id = ?1)
                       AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id > ?3))
                     ORDER BY created_at DESC, id ASC LIMIT ?4",
                )
                .map_err(|error| format!("failed to prepare deployment run page: {error}"))?;
            let rows = statement
                .query_map(
                    params![
                        workflow_id,
                        cursor_created_at,
                        cursor_id,
                        i64::from(limit) + 1
                    ],
                    raw_run,
                )
                .map_err(|error| format!("failed to query deployment run page: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment run page: {error}"))?;
            let mut items = rows
                .into_iter()
                .map(run_from_raw)
                .collect::<Result<Vec<_>, _>>()?;
            let has_more = items.len() > limit as usize;
            if has_more {
                items.truncate(limit as usize);
            }
            let next_cursor = has_more && !items.is_empty();
            Ok(DeploymentRunPage {
                next_cursor: next_cursor.then(|| encode_run_cursor(items.last().expect("checked"))),
                items,
            })
        })
    }

    pub(crate) fn get_deployment_run(
        &self,
        id: &str,
    ) -> Result<Option<DeploymentRunRecord>, String> {
        super::validate_identifier("deployment run id", id, 128)
            .map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, workflow_id, workflow_revision, source_run_id, operation_kind,
                            trigger_kind, status, approval_summary_json, approval_digest,
                            reconciliation_required, last_event_sequence, created_at, updated_at,
                            started_at, finished_at
                     FROM deployment_runs WHERE id = ?1",
                    [id],
                    raw_run,
                )
                .optional()
                .map_err(|error| format!("failed to get deployment run: {error}"))?
                .map(run_from_raw)
                .transpose()
        })
    }

    pub(crate) fn get_deployment_run_by_approval_digest(
        &self,
        approval_digest: &str,
    ) -> Result<Option<DeploymentRunRecord>, String> {
        validate_digest(approval_digest)?;
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, workflow_id, workflow_revision, source_run_id, operation_kind,
                            trigger_kind, status, approval_summary_json, approval_digest,
                            reconciliation_required, last_event_sequence, created_at, updated_at,
                            started_at, finished_at
                     FROM deployment_runs WHERE approval_digest = ?1
                     ORDER BY created_at DESC, id ASC LIMIT 1",
                    [approval_digest],
                    raw_run,
                )
                .optional()
                .map_err(|error| format!("failed to get deployment plan run: {error}"))?
                .map(run_from_raw)
                .transpose()
        })
    }

    pub(crate) fn list_deployment_run_events(
        &self,
        run_id: &str,
        after_sequence: u32,
        limit: u32,
    ) -> Result<Vec<DeploymentRunEventRecord>, String> {
        if !(1..=500).contains(&limit) {
            return Err("deployment event limit must be between 1 and 500".into());
        }
        super::validate_identifier("deployment run id", run_id, 128)
            .map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT run_id, sequence, event_kind, status, summary, payload_json, recorded_at
                     FROM deployment_run_events
                     WHERE run_id = ?1 AND sequence > ?2
                     ORDER BY sequence ASC LIMIT ?3",
                )
                .map_err(|error| format!("failed to prepare deployment events: {error}"))?;
            let rows = statement
                .query_map(params![run_id, after_sequence, limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                })
                .map_err(|error| format!("failed to query deployment events: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment events: {error}"))?;
            rows.into_iter()
                .map(
                    |(run_id, sequence, event_kind, status, summary, payload_json, recorded_at)| {
                        Ok(DeploymentRunEventRecord {
                            run_id,
                            sequence: sequence.try_into().map_err(|_| {
                                "stored deployment event sequence is invalid".to_string()
                            })?,
                            event_kind: parse_wire_enum(event_kind, "event kind")?,
                            status: status
                                .map(|value| parse_wire_enum(value, "event status"))
                                .transpose()?,
                            summary,
                            payload: payload_json
                                .map(|value| {
                                    serde_json::from_str(&value).map_err(|error| {
                                        format!(
                                            "stored deployment event payload is invalid: {error}"
                                        )
                                    })
                                })
                                .transpose()?,
                            recorded_at,
                        })
                    },
                )
                .collect()
        })
    }

    pub(crate) fn list_deployment_run_events_before(
        &self,
        run_id: &str,
        before_sequence: u32,
        limit: u32,
    ) -> Result<DeploymentRunEventPage, String> {
        if before_sequence < 2 {
            return Ok(DeploymentRunEventPage {
                items: Vec::new(),
                next_before_sequence: None,
            });
        }
        if !(1..=200).contains(&limit) {
            return Err("deployment event page limit must be between 1 and 200".into());
        }
        super::validate_identifier("deployment run id", run_id, 128)
            .map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT run_id, sequence, event_kind, status, summary, payload_json, recorded_at
                     FROM deployment_run_events
                     WHERE run_id = ?1 AND sequence < ?2
                     ORDER BY sequence DESC LIMIT ?3",
                )
                .map_err(|error| format!("failed to prepare deployment event page: {error}"))?;
            let rows = statement
                .query_map(
                    params![run_id, before_sequence, i64::from(limit) + 1],
                    raw_event,
                )
                .map_err(|error| format!("failed to query deployment event page: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment event page: {error}"))?;
            let mut items = rows
                .into_iter()
                .map(event_from_raw)
                .collect::<Result<Vec<_>, _>>()?;
            let has_more = items.len() > limit as usize;
            if has_more {
                items.truncate(limit as usize);
            }
            items.reverse();
            let next_before_sequence = has_more.then(|| {
                items
                    .first()
                    .expect("bounded page contains an item")
                    .sequence
            });
            Ok(DeploymentRunEventPage {
                items,
                next_before_sequence,
            })
        })
    }

    pub(crate) fn get_deployment_run_detail(
        &self,
        id: &str,
        event_limit: u32,
    ) -> Result<Option<DeploymentRunDetail>, String> {
        if !(1..=200).contains(&event_limit) {
            return Err("deployment detail event limit must be between 1 and 200".into());
        }
        let Some(run) = self.get_deployment_run(id)? else {
            return Ok(None);
        };
        let page = self.list_deployment_run_events_before(
            id,
            run.last_event_sequence.saturating_add(1),
            event_limit,
        )?;
        Ok(Some(DeploymentRunDetail {
            run,
            events: page.items,
            next_before_sequence: page.next_before_sequence,
        }))
    }

    pub(crate) fn claim_deployment_notifications(
        &self,
        limit: u32,
    ) -> Result<Vec<DeploymentNotificationReceipt>, String> {
        if !(1..=50).contains(&limit) {
            return Err("deployment notification limit must be between 1 and 50".into());
        }
        self.with_transaction(|transaction| {
            let mut statement = transaction
                .prepare(
                    "SELECT r.id, r.workflow_id, r.workflow_revision, r.source_run_id,
                            r.operation_kind, r.trigger_kind, r.status, r.approval_summary_json,
                            r.approval_digest, r.reconciliation_required, r.last_event_sequence,
                            r.created_at, r.updated_at, r.started_at, r.finished_at, w.name
                     FROM deployment_runs r
                     JOIN deployment_workflows w ON w.id = r.workflow_id
                     JOIN deployment_run_events e
                       ON e.run_id = r.id AND e.sequence = r.last_event_sequence
                     WHERE r.last_event_sequence >= 1
                       AND (
                           r.status IN ('awaiting_approval', 'succeeded', 'failed', 'state_unknown')
                           OR (
                               r.status = 'canceled'
                               AND (
                                   json_extract(e.payload_json, '$.rollbackReleaseId') IS NOT NULL
                                   OR json_extract(e.payload_json, '$.result.evidence.rollbackReleaseVerified') = 1
                               )
                           )
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM deployment_notification_receipts n
                           WHERE n.run_id = r.id AND n.event_sequence = r.last_event_sequence
                       )
                     ORDER BY r.updated_at ASC, r.id ASC LIMIT ?1",
                )
                .map_err(|error| format!("failed to prepare deployment notifications: {error}"))?;
            let candidates = statement
                .query_map([limit], |row| Ok((raw_run(row)?, row.get::<_, String>(15)?)))
                .map_err(|error| format!("failed to query deployment notifications: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment notifications: {error}"))?;
            drop(statement);

            let mut claimed = Vec::new();
            for (raw, workflow_name) in candidates {
                let run = run_from_raw(raw)?;
                let payload_json = transaction
                    .query_row(
                        "SELECT payload_json FROM deployment_run_events
                         WHERE run_id = ?1 AND sequence = ?2",
                        params![run.id, run.last_event_sequence],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|error| format!("failed to inspect deployment notification evidence: {error}"))?
                    .flatten();
                let payload = payload_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
                let automatic_restore = payload.as_ref().is_some_and(|value| {
                    value.get("rollbackReleaseId").is_some_and(|release| !release.is_null())
                        || value.pointer("/result/evidence/rollbackReleaseVerified")
                            .and_then(serde_json::Value::as_bool) == Some(true)
                });
                let kind = match run.status {
                    DeploymentRunStatus::Succeeded => DeploymentNotificationKind::Succeeded,
                    DeploymentRunStatus::Failed if automatic_restore => {
                        DeploymentNotificationKind::AutomaticRestoreCompleted
                    }
                    DeploymentRunStatus::Failed => DeploymentNotificationKind::Failed,
                    DeploymentRunStatus::Canceled if automatic_restore => {
                        DeploymentNotificationKind::AutomaticRestoreCompleted
                    }
                    DeploymentRunStatus::AwaitingApproval | DeploymentRunStatus::StateUnknown => {
                        DeploymentNotificationKind::UserActionRequired
                    }
                    DeploymentRunStatus::Canceled => continue,
                    _ => continue,
                };
                let created_at = current_timestamp_ms();
                let inserted = transaction
                    .execute(
                        "INSERT OR IGNORE INTO deployment_notification_receipts (
                            run_id, event_sequence, notification_kind, run_status, created_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            &run.id,
                            run.last_event_sequence,
                            kind.as_str(),
                            run.status.as_str(),
                            created_at,
                        ],
                    )
                    .map_err(|error| format!("failed to claim deployment notification: {error}"))?;
                if inserted == 1 {
                    claimed.push(DeploymentNotificationReceipt {
                        run_id: run.id,
                        workflow_id: run.workflow_id,
                        workflow_name,
                        event_sequence: run.last_event_sequence,
                        status: run.status,
                        kind,
                        created_at,
                    });
                }
            }
            Ok(claimed)
        })
    }

    pub(crate) fn create_deployment_run_atomic(
        &self,
        run: &DeploymentRunWrite,
        initial_event: &DeploymentEventWrite,
    ) -> Result<(), String> {
        super::validate_identifier("deployment run id", &run.id, 128)
            .map_err(|error| error.to_string())?;
        run.approval_summary
            .validate()
            .map_err(|error| error.to_string())?;
        validate_digest(&run.approval_digest)?;
        validate_event_write(initial_event)?;
        if run.status != DeploymentRunStatus::Planned
            || initial_event.event_kind != DeploymentEventKind::RunCreated
            || initial_event.status != Some(DeploymentRunStatus::Planned)
        {
            return Err(
                "deployment runs must be created as planned with a run_created event".into(),
            );
        }
        if !matches!(
            (run.operation_kind, run.source_run_id.as_deref()),
            (DeploymentOperationKind::Deploy, None)
                | (
                    DeploymentOperationKind::Resume | DeploymentOperationKind::Rollback,
                    Some(_)
                )
        ) {
            return Err("resume and rollback require a source run; deploy forbids one".into());
        }
        if run.approval_summary.workflow_id != run.workflow_id
            || run.approval_summary.workflow_revision != run.workflow_revision
            || run.approval_summary.operation_kind != run.operation_kind
        {
            return Err("deployment run does not match its frozen approval summary".into());
        }
        let canonical_approval_json = run
            .approval_summary
            .canonical_json()
            .map_err(|error| error.to_string())?;
        if run
            .approval_summary
            .plan_digest()
            .map_err(|error| error.to_string())?
            != run.approval_digest
        {
            return Err("DEPLOYMENT_PLAN_INTEGRITY_FAILURE".into());
        }
        let payload_json = serialize_event_payload(&initial_event.payload)?;
        let timestamp = current_timestamp_ms();
        self.with_transaction(|transaction| {
            let (current_revision, enabled, connection_profile_id) = transaction
                .query_row(
                    "SELECT revision, enabled, connection_profile_id
                     FROM deployment_workflows WHERE id = ?1",
                    [&run.workflow_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("failed to inspect deployment workflow: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_NOT_FOUND".to_string())?;
            if current_revision != i64::from(run.workflow_revision) {
                return Err("REVISION_CONFLICT".into());
            }
            if enabled != 1 {
                return Err("DEPLOYMENT_WORKFLOW_DISABLED".into());
            }
            if connection_profile_id != run.approval_summary.frozen.target.profile_id {
                return Err("deployment run target does not match its workflow profile".into());
            }
            if let Some(source_run_id) = run.source_run_id.as_deref() {
                let source_workflow_id = transaction
                    .query_row(
                        "SELECT workflow_id FROM deployment_runs WHERE id = ?1",
                        [source_run_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|error| format!("failed to inspect source deployment run: {error}"))?
                    .ok_or_else(|| "DEPLOYMENT_SOURCE_RUN_NOT_FOUND".to_string())?;
                if source_workflow_id != run.workflow_id {
                    return Err("DEPLOYMENT_SOURCE_RUN_WORKFLOW_MISMATCH".into());
                }
            }
            transaction
                .execute(
                    "INSERT INTO deployment_runs (
                        id, workflow_id, workflow_revision, source_run_id, operation_kind,
                        trigger_kind, status, approval_summary_json, approval_digest,
                        reconciliation_required, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                    params![
                        run.id,
                        run.workflow_id,
                        run.workflow_revision,
                        run.source_run_id,
                        run.operation_kind.as_str(),
                        run.trigger_kind.as_str(),
                        run.status.as_str(),
                        canonical_approval_json,
                        run.approval_digest,
                        i64::from(run.status.requires_reconciliation()),
                        timestamp,
                    ],
                )
                .map_err(|error| format!("failed to create deployment run: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO deployment_run_events (
                        run_id, sequence, event_kind, status, summary, payload_json, recorded_at
                     ) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        run.id,
                        initial_event.event_kind.as_str(),
                        initial_event.status.map(DeploymentRunStatus::as_str),
                        initial_event.summary,
                        payload_json,
                        timestamp,
                    ],
                )
                .map_err(|error| format!("failed to create deployment run event: {error}"))?;
            Ok(())
        })
    }

    pub(crate) fn transition_deployment_run_atomic(
        &self,
        run_id: &str,
        expected_sequence: u32,
        expected_status: DeploymentRunStatus,
        next_status: DeploymentRunStatus,
        event: &DeploymentEventWrite,
    ) -> Result<(), String> {
        super::validate_identifier("deployment run id", run_id, 128)
            .map_err(|error| error.to_string())?;
        if expected_sequence == 0 {
            return Err("deployment expected event sequence must be positive".into());
        }
        if !expected_status.can_transition_to(next_status) {
            return Err("INVALID_DEPLOYMENT_STATUS_TRANSITION".into());
        }
        validate_event_write(event)?;
        if event.status != Some(next_status) {
            return Err("deployment transition event status does not match next status".into());
        }
        let payload_json = serialize_event_payload(&event.payload)?;
        let timestamp = current_timestamp_ms();
        self.with_transaction(|transaction| {
            let (stored_status, stored_sequence) = transaction
                .query_row(
                    "SELECT status, last_event_sequence FROM deployment_runs WHERE id = ?1",
                    [run_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
                .map_err(|error| format!("failed to inspect deployment run: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_RUN_NOT_FOUND".to_string())?;
            if stored_status != expected_status.as_str()
                || stored_sequence != i64::from(expected_sequence)
            {
                return Err("REVISION_CONFLICT".into());
            }
            let next_sequence = expected_sequence
                .checked_add(1)
                .ok_or_else(|| "deployment event sequence overflow".to_string())?;
            let finished_at = next_status.is_terminal().then_some(timestamp);
            let started_at = matches!(
                next_status,
                DeploymentRunStatus::Reconciling | DeploymentRunStatus::InProgress
            )
            .then_some(timestamp);
            transaction
                .execute(
                    "UPDATE deployment_runs
                     SET status = ?2, reconciliation_required = ?3, updated_at = ?4,
                         finished_at = COALESCE(?5, finished_at),
                         started_at = COALESCE(started_at, ?6)
                     WHERE id = ?1",
                    params![
                        run_id,
                        next_status.as_str(),
                        i64::from(next_status.requires_reconciliation()),
                        timestamp,
                        finished_at,
                        started_at,
                    ],
                )
                .map_err(|error| format!("failed to transition deployment run: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO deployment_run_events (
                        run_id, sequence, event_kind, status, summary, payload_json, recorded_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        run_id,
                        next_sequence,
                        event.event_kind.as_str(),
                        next_status.as_str(),
                        event.summary,
                        payload_json,
                        timestamp,
                    ],
                )
                .map_err(|error| format!("failed to append deployment event: {error}"))?;
            Ok(())
        })
    }

    pub(crate) fn append_deployment_run_event_atomic(
        &self,
        run_id: &str,
        expected_sequence: u32,
        expected_status: DeploymentRunStatus,
        event: &DeploymentEventWrite,
    ) -> Result<(), String> {
        super::validate_identifier("deployment run id", run_id, 128)
            .map_err(|error| error.to_string())?;
        if expected_sequence == 0 {
            return Err("deployment expected event sequence must be positive".into());
        }
        validate_event_write(event)?;
        if event.status != Some(expected_status) {
            return Err("deployment event status does not match the current run status".into());
        }
        let payload_json = serialize_event_payload(&event.payload)?;
        let timestamp = current_timestamp_ms();
        self.with_transaction(|transaction| {
            let (stored_status, stored_sequence) = transaction
                .query_row(
                    "SELECT status, last_event_sequence FROM deployment_runs WHERE id = ?1",
                    [run_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
                .map_err(|error| format!("failed to inspect deployment run: {error}"))?
                .ok_or_else(|| "DEPLOYMENT_RUN_NOT_FOUND".to_string())?;
            if stored_status != expected_status.as_str()
                || stored_sequence != i64::from(expected_sequence)
            {
                return Err("REVISION_CONFLICT".into());
            }
            let next_sequence = expected_sequence
                .checked_add(1)
                .ok_or_else(|| "deployment event sequence overflow".to_string())?;
            transaction
                .execute(
                    "INSERT INTO deployment_run_events (
                        run_id, sequence, event_kind, status, summary, payload_json, recorded_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        run_id,
                        next_sequence,
                        event.event_kind.as_str(),
                        expected_status.as_str(),
                        event.summary,
                        payload_json,
                        timestamp,
                    ],
                )
                .map_err(|error| format!("failed to append deployment event: {error}"))?;
            Ok(())
        })
    }

    pub(crate) fn record_deployment_transfer_receipt(
        &self,
        request: &DeploymentArtifactTransferRequest,
        result: &DeploymentArtifactTransferResult,
    ) -> Result<DeploymentTransferReceiptRecord, String> {
        if result.status != DeploymentArtifactTransferStatus::Succeeded
            || result.operation_id != request.operation_id
            || result.plan_id != request.plan_id
            || result.release_id != request.release_id
            || result.remote_staging_identity.is_none()
            || result.remote_digest_sha256.as_deref() != Some(&request.release_digest_sha256)
        {
            return Err("deployment transfer receipt requires an exact successful result".into());
        }
        let run = self
            .get_deployment_run_by_approval_digest(&request.plan_digest)?
            .ok_or_else(|| "DEPLOYMENT_PLAN_NOT_FOUND".to_string())?;
        if request.plan_id != format!("plan-{}", request.plan_digest)
            || run.approval_digest != request.plan_digest
        {
            return Err("DEPLOYMENT_PLAN_INTEGRITY_FAILURE".into());
        }
        let request_json = serde_json::to_string(request)
            .map_err(|error| format!("failed to serialize deployment transfer request: {error}"))?;
        let result_json = serde_json::to_string(result)
            .map_err(|error| format!("failed to serialize deployment transfer result: {error}"))?;
        if request_json.len() > 65_536
            || result_json.len() > 65_536
            || crate::runbook::contains_secret_literal(&request_json)
            || crate::runbook::contains_secret_literal(&result_json)
        {
            return Err("deployment transfer receipt is unsafe or too large".into());
        }
        let timestamp = current_timestamp_ms();
        self.with_transaction(|transaction| {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO deployment_transfer_receipts (
                        operation_id, run_id, plan_id, plan_digest, request_json, result_json,
                        created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        request.operation_id,
                        run.id,
                        request.plan_id,
                        request.plan_digest,
                        request_json,
                        result_json,
                        timestamp,
                    ],
                )
                .map_err(|error| {
                    format!("failed to record deployment transfer receipt: {error}")
                })?;
            Ok(())
        })?;
        let stored = self
            .get_deployment_transfer_receipt(&request.operation_id)?
            .ok_or_else(|| {
                "deployment transfer receipt was not found after insertion".to_string()
            })?;
        if stored.request != *request || stored.result != *result || stored.run_id != run.id {
            return Err(
                "deployment transfer operation identity conflicts with an existing receipt".into(),
            );
        }
        Ok(stored)
    }

    pub(crate) fn get_deployment_transfer_receipt(
        &self,
        operation_id: &str,
    ) -> Result<Option<DeploymentTransferReceiptRecord>, String> {
        if !super::artifact_transfer::valid_artifact_transfer_operation_id(operation_id) {
            return Err("deployment artifact transfer operation ID is invalid".into());
        }
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT operation_id, run_id, plan_id, plan_digest, request_json,
                            result_json, created_at
                     FROM deployment_transfer_receipts WHERE operation_id = ?1",
                    [operation_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, i64>(6)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("failed to get deployment transfer receipt: {error}"))?
                .map(|raw| {
                    Ok(DeploymentTransferReceiptRecord {
                        operation_id: raw.0,
                        run_id: raw.1,
                        plan_id: raw.2,
                        plan_digest: raw.3,
                        request: serde_json::from_str(&raw.4).map_err(|error| {
                            format!("stored deployment transfer request is invalid: {error}")
                        })?,
                        result: serde_json::from_str(&raw.5).map_err(|error| {
                            format!("stored deployment transfer result is invalid: {error}")
                        })?,
                        created_at: raw.6,
                    })
                })
                .transpose()
        })
    }

    pub(crate) fn get_latest_deployment_transfer_receipt_for_run(
        &self,
        run_id: &str,
    ) -> Result<Option<DeploymentTransferReceiptRecord>, String> {
        super::validate_identifier("deployment run id", run_id, 128)
            .map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT operation_id, run_id, plan_id, plan_digest, request_json,
                            result_json, created_at
                     FROM deployment_transfer_receipts
                     WHERE run_id = ?1 ORDER BY created_at DESC, operation_id ASC LIMIT 1",
                    [run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, i64>(6)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("failed to get deployment transfer receipt: {error}"))?
                .map(|raw| {
                    Ok(DeploymentTransferReceiptRecord {
                        operation_id: raw.0,
                        run_id: raw.1,
                        plan_id: raw.2,
                        plan_digest: raw.3,
                        request: serde_json::from_str(&raw.4).map_err(|error| {
                            format!("stored deployment transfer request is invalid: {error}")
                        })?,
                        result: serde_json::from_str(&raw.5).map_err(|error| {
                            format!("stored deployment transfer result is invalid: {error}")
                        })?,
                        created_at: raw.6,
                    })
                })
                .transpose()
        })
    }
}

type RawRun = (
    String,
    String,
    i64,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    i64,
    Option<i64>,
    Option<i64>,
);

type RawEvent = (
    String,
    i64,
    String,
    Option<String>,
    String,
    Option<String>,
    i64,
);

fn raw_event(row: &Row<'_>) -> rusqlite::Result<RawEvent> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

fn event_from_raw(raw: RawEvent) -> Result<DeploymentRunEventRecord, String> {
    Ok(DeploymentRunEventRecord {
        run_id: raw.0,
        sequence: raw
            .1
            .try_into()
            .map_err(|_| "stored deployment event sequence is invalid".to_string())?,
        event_kind: parse_wire_enum(raw.2, "event kind")?,
        status: raw
            .3
            .map(|value| parse_wire_enum(value, "event status"))
            .transpose()?,
        summary: raw.4,
        payload: raw
            .5
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|error| format!("stored deployment event payload is invalid: {error}"))
            })
            .transpose()?,
        recorded_at: raw.6,
    })
}

fn raw_run(row: &Row<'_>) -> rusqlite::Result<RawRun> {
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
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
    ))
}

fn run_from_raw(raw: RawRun) -> Result<DeploymentRunRecord, String> {
    let approval_summary = DeploymentApprovalPlanSummary::from_json(&raw.7)
        .map_err(|error| format!("stored deployment approval is invalid: {error}"))?;
    validate_digest(&raw.8)?;
    if approval_summary
        .plan_digest()
        .map_err(|error| error.to_string())?
        != raw.8
    {
        return Err("stored deployment approval digest is inconsistent".into());
    }
    let workflow_revision = raw
        .2
        .try_into()
        .map_err(|_| "stored deployment workflow revision is invalid".to_string())?;
    let operation_kind = parse_wire_enum(raw.4, "operation kind")?;
    if approval_summary.workflow_id != raw.1
        || approval_summary.workflow_revision != workflow_revision
        || approval_summary.operation_kind != operation_kind
    {
        return Err("stored deployment approval binding is inconsistent".into());
    }
    Ok(DeploymentRunRecord {
        id: raw.0,
        workflow_id: raw.1,
        workflow_revision,
        source_run_id: raw.3,
        operation_kind,
        trigger_kind: parse_wire_enum(raw.5, "trigger kind")?,
        status: parse_wire_enum(raw.6, "run status")?,
        approval_summary,
        approval_digest: raw.8,
        reconciliation_required: raw.9 == 1,
        last_event_sequence: raw
            .10
            .try_into()
            .map_err(|_| "stored deployment event sequence is invalid".to_string())?,
        created_at: raw.11,
        updated_at: raw.12,
        started_at: raw.13,
        finished_at: raw.14,
    })
}

fn validate_event_write(event: &DeploymentEventWrite) -> Result<(), String> {
    super::validate_text("deployment event summary", &event.summary, 4096)
        .map_err(|error| error.to_string())?;
    let _ = serialize_event_payload(&event.payload)?;
    Ok(())
}

fn serialize_event_payload(payload: &Option<serde_json::Value>) -> Result<Option<String>, String> {
    payload
        .as_ref()
        .map(|payload| {
            if !payload.is_object() {
                return Err("deployment event payload must be an object".into());
            }
            let json = serde_json::to_string(payload)
                .map_err(|error| format!("failed to serialize deployment event: {error}"))?;
            if json.len() > 65_536 {
                return Err("deployment event payload exceeds 65536 bytes".into());
            }
            if crate::runbook::contains_secret_literal(&json) {
                return Err("deployment event payload must not contain secret literals".into());
            }
            Ok(json)
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::approval::{
        DeploymentFrozenSourceRevision, DeploymentPlanCreateInput, DeploymentPreflightCheckSummary,
        DeploymentPreflightOutcome, DeploymentPreflightSummary, DeploymentReleaseIdentity,
        DeploymentTargetIdentitySnapshot,
    };
    use crate::models::{ProfileAuthMethod, ProfileRow};

    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("deployment.db")).unwrap();
        database
            .insert_profile(&ProfileRow {
                id: "profile-1".into(),
                name: "Production".into(),
                host: "example.test".into(),
                port: 22,
                username: "deploy".into(),
                auth_method: ProfileAuthMethod::Password,
                keychain_key_id: None,
                jump_host_config: None,
                organization_json: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        (directory, database)
    }

    fn definition() -> DeploymentWorkflowDefinition {
        DeploymentWorkflowDefinition {
            schema_version: 1,
            source_directory: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            build: super::super::DockerBuildxPlan {
                context: ".".into(),
                dockerfile: "Dockerfile".into(),
                platform: "linux/amd64".into(),
                image_repository: "example.test/shellspan/app".into(),
                compression: super::super::DeploymentArtifactCompression::Zstd,
            },
            target: super::super::DeploymentTarget {
                connection_profile_id: "profile-1".into(),
                remote_root: "/srv/shellspan/app".into(),
            },
            compose: super::super::DockerComposePlan {
                project_name: "app".into(),
                files: vec!["compose.yaml".into()],
                services: vec!["web".into()],
                pull_before_up: true,
            },
            health_check: None,
            reload_nginx_after_healthy: false,
            releases_to_keep: 3,
        }
    }

    fn create_workflow(database: &Database) -> DeploymentWorkflowRecord {
        database
            .create_deployment_workflow(
                "workflow-1",
                &DeploymentWorkflowCreate {
                    name: "API".into(),
                    definition: definition(),
                    enabled: true,
                },
            )
            .unwrap()
    }

    fn plan_input() -> DeploymentPlanCreateInput {
        DeploymentPlanCreateInput {
            workflow_id: "workflow-1".into(),
            expected_revision: 1,
            source_run_id: None,
            operation_kind: DeploymentOperationKind::Deploy,
            trigger_kind: DeploymentTriggerKind::Manual,
            artifact_reference: format!(
                "deployment-artifact-v1:{}:{}",
                "c".repeat(64),
                "d".repeat(64)
            ),
            source_revision: DeploymentFrozenSourceRevision {
                revision: "a".repeat(40),
                dirty: false,
            },
            target: DeploymentTargetIdentitySnapshot {
                profile_id: "profile-1".into(),
                profile_updated_at: 1,
                host: "example.test".into(),
                port: 22,
                username: "deploy".into(),
                auth_method: "password".into(),
                jump_host: None,
            },
            current_release: None,
            target_release: DeploymentReleaseIdentity {
                release_id: "release-next".into(),
                artifact_digest_sha256: "b".repeat(64),
            },
            rollback_release: None,
            preflight: DeploymentPreflightSummary {
                checked_at: 1,
                checks: vec![DeploymentPreflightCheckSummary {
                    code: "ready".into(),
                    outcome: DeploymentPreflightOutcome::Passed,
                    summary: "Inputs are ready".into(),
                }],
            },
            ttl_seconds: 60,
        }
    }

    fn distinct_plan_input(suffix: &str) -> DeploymentPlanCreateInput {
        let mut input = plan_input();
        let encoded = suffix
            .bytes()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        input.source_revision.revision = format!("{encoded:0<40}");
        input.target_release.release_id = format!("release-{suffix}");
        input
    }

    #[test]
    fn workflow_crud_uses_revision_compare_and_swap() {
        let (_directory, database) = database();
        let created = database
            .create_deployment_workflow(
                "workflow-1",
                &DeploymentWorkflowCreate {
                    name: "API".into(),
                    definition: definition(),
                    enabled: true,
                },
            )
            .unwrap();
        assert_eq!(created.revision, 1);
        let updated = database
            .update_deployment_workflow(
                &created.id,
                &DeploymentWorkflowUpdate {
                    expected_revision: 1,
                    name: "API service".into(),
                    definition: definition(),
                    enabled: false,
                },
            )
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert!(!updated.enabled);
        assert_eq!(
            database
                .update_deployment_workflow(
                    &created.id,
                    &DeploymentWorkflowUpdate {
                        expected_revision: 1,
                        name: "Stale".into(),
                        definition: definition(),
                        enabled: true,
                    },
                )
                .unwrap_err(),
            "REVISION_CONFLICT"
        );
        database.delete_deployment_workflow(&created.id, 2).unwrap();
        assert!(database
            .get_deployment_workflow(&created.id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn audit_export_reads_one_exact_run_without_mutating_run_or_events() {
        let (_directory, database) = database();
        create_workflow(&database);
        let plan =
            crate::deployment::planner::create_deployment_plan(&database, plan_input()).unwrap();
        let before_run = database.get_deployment_run(&plan.run_id).unwrap().unwrap();
        let before_events = database
            .list_deployment_run_events(&plan.run_id, 0, 500)
            .unwrap();

        let document =
            crate::deployment::audit::build_deployment_audit_document(&database, &plan.run_id)
                .unwrap();

        assert_eq!(document.run_id, plan.run_id);
        assert!(document.bytes.len() < 2 * 1024 * 1024);
        assert_eq!(
            database.get_deployment_run(&plan.run_id).unwrap().unwrap(),
            before_run
        );
        assert_eq!(
            database
                .list_deployment_run_events(&plan.run_id, 0, 500)
                .unwrap(),
            before_events
        );
    }

    #[test]
    fn workflow_profile_validation_uses_database_truth() {
        let (_directory, database) = database();
        let mut invalid = definition();
        invalid.target.connection_profile_id = "missing".into();
        assert_eq!(
            database
                .create_deployment_workflow(
                    "workflow-1",
                    &DeploymentWorkflowCreate {
                        name: "API".into(),
                        definition: invalid,
                        enabled: true,
                    },
                )
                .unwrap_err(),
            "DEPLOYMENT_PROFILE_NOT_FOUND"
        );
    }

    #[test]
    fn workflow_and_profile_deletion_are_protected_after_a_run_exists() {
        let (_directory, database) = database();
        create_workflow(&database);
        let plan =
            crate::deployment::planner::create_deployment_plan(&database, plan_input()).unwrap();

        assert_eq!(
            database
                .delete_deployment_workflow("workflow-1", 1)
                .unwrap_err(),
            "DEPLOYMENT_WORKFLOW_HAS_RUNS"
        );
        assert!(database.delete_profile("profile-1").is_err());
        assert!(database.get_deployment_run(&plan.run_id).unwrap().is_some());
    }

    #[test]
    fn run_status_and_contiguous_event_are_committed_atomically_with_cas() {
        let (_directory, database) = database();
        create_workflow(&database);
        let plan =
            crate::deployment::planner::create_deployment_plan(&database, plan_input()).unwrap();
        database
            .transition_deployment_run_atomic(
                &plan.run_id,
                1,
                DeploymentRunStatus::Planned,
                DeploymentRunStatus::AwaitingApproval,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::ApprovalRequested,
                    status: Some(DeploymentRunStatus::AwaitingApproval),
                    summary: "Approval requested".into(),
                    payload: None,
                },
            )
            .unwrap();

        let run = database.get_deployment_run(&plan.run_id).unwrap().unwrap();
        assert_eq!(run.status, DeploymentRunStatus::AwaitingApproval);
        assert_eq!(run.last_event_sequence, 2);
        let events = database
            .list_deployment_run_events(&plan.run_id, 0, 10)
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].sequence, 2);
        let window = database
            .list_deployment_run_events(&plan.run_id, 1, 1)
            .unwrap();
        assert_eq!(window.len(), 1);
        assert_eq!(window[0].sequence, 2);

        assert_eq!(
            database
                .transition_deployment_run_atomic(
                    &plan.run_id,
                    1,
                    DeploymentRunStatus::Planned,
                    DeploymentRunStatus::Canceled,
                    &DeploymentEventWrite {
                        event_kind: DeploymentEventKind::RunCanceled,
                        status: Some(DeploymentRunStatus::Canceled),
                        summary: "Stale cancellation".into(),
                        payload: None,
                    },
                )
                .unwrap_err(),
            "REVISION_CONFLICT"
        );
        let unchanged = database.get_deployment_run(&plan.run_id).unwrap().unwrap();
        assert_eq!(unchanged.status, DeploymentRunStatus::AwaitingApproval);
        assert_eq!(unchanged.last_event_sequence, 2);

        assert!(database
            .with_connection(|connection| connection
                .execute(
                    "UPDATE deployment_runs SET status = 'in_progress' WHERE id = ?1",
                    [&plan.run_id],
                )
                .map(|_| ())
                .map_err(|error| error.to_string()))
            .is_err());
    }

    #[test]
    fn restart_discovers_active_runs_and_reconciliation_cas_has_one_winner() {
        let (directory, database) = database();
        create_workflow(&database);
        let plan =
            crate::deployment::planner::create_deployment_plan(&database, plan_input()).unwrap();
        let advance = |database: &Database,
                       expected_sequence,
                       expected_status,
                       next_status,
                       summary: &str| {
            database.transition_deployment_run_atomic(
                &plan.run_id,
                expected_sequence,
                expected_status,
                next_status,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::StatusChanged,
                    status: Some(next_status),
                    summary: summary.into(),
                    payload: None,
                },
            )
        };
        advance(
            &database,
            1,
            DeploymentRunStatus::Planned,
            DeploymentRunStatus::AwaitingApproval,
            "Awaiting approval",
        )
        .unwrap();
        advance(
            &database,
            2,
            DeploymentRunStatus::AwaitingApproval,
            DeploymentRunStatus::Approved,
            "Approved",
        )
        .unwrap();
        advance(
            &database,
            3,
            DeploymentRunStatus::Approved,
            DeploymentRunStatus::InProgress,
            "Runner active",
        )
        .unwrap();
        drop(database);

        let reopened = Database::open(&directory.path().join("deployment.db")).unwrap();
        let candidates = reopened.list_deployment_startup_recovery_runs(100).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, plan.run_id);
        assert_eq!(candidates[0].status, DeploymentRunStatus::InProgress);
        assert_eq!(candidates[0].last_event_sequence, 4);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for operation in ["one", "two"] {
            let database = reopened.clone();
            let barrier = barrier.clone();
            let run_id = plan.run_id.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                database.transition_deployment_run_atomic(
                    &run_id,
                    4,
                    DeploymentRunStatus::InProgress,
                    DeploymentRunStatus::Reconciling,
                    &DeploymentEventWrite {
                        event_kind: DeploymentEventKind::ReconciliationStarted,
                        status: Some(DeploymentRunStatus::Reconciling),
                        summary: format!("Reconciliation {operation}"),
                        payload: Some(serde_json::json!({
                            "request": {
                                "operationId": format!("deployment-reconciliation:{operation}"),
                                "planId": format!("plan-{}", "a".repeat(64)),
                                "planDigest": "a".repeat(64),
                                "runId": run_id,
                                "expectedRunRevision": 4,
                                "artifactTransferOperationId": "deployment-artifact-transfer:receipt",
                                "remoteStagingIdentity": format!(
                                    "deployment-staging-v1:{}:{}",
                                    "b".repeat(64),
                                    "c".repeat(64),
                                ),
                            },
                            "previousStatus": "in_progress",
                        })),
                    },
                )
            }));
        }
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .filter(|error| error.as_str() == "REVISION_CONFLICT")
                .count(),
            1
        );
        let recovery =
            crate::deployment::remote_runner::list_deployment_startup_recovery(&reopened).unwrap();
        assert_eq!(recovery.candidates.len(), 1);
        assert_eq!(
            recovery.candidates[0].status,
            DeploymentRunStatus::InProgress
        );
        assert!(recovery.candidates[0].reconciliation_required);
    }

    #[test]
    fn run_history_uses_a_stable_cursor_and_detail_has_a_bounded_latest_window() {
        let (_directory, database) = database();
        create_workflow(&database);
        let mut run_ids = Vec::new();
        for suffix in ["one", "two", "three"] {
            let plan = crate::deployment::planner::create_deployment_plan(
                &database,
                distinct_plan_input(suffix),
            )
            .unwrap();
            run_ids.push(plan.run_id);
        }

        let first = database
            .list_deployment_run_page(Some("workflow-1"), None, 2)
            .unwrap();
        assert_eq!(first.items.len(), 2);
        assert!(first.next_cursor.is_some());
        let second = database
            .list_deployment_run_page(Some("workflow-1"), first.next_cursor.as_deref(), 2)
            .unwrap();
        assert_eq!(second.items.len(), 1);
        assert!(second.next_cursor.is_none());
        let listed = first
            .items
            .iter()
            .chain(second.items.iter())
            .map(|run| run.id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(listed, run_ids.into_iter().collect());

        let run_id = &first.items[0].id;
        database
            .transition_deployment_run_atomic(
                run_id,
                1,
                DeploymentRunStatus::Planned,
                DeploymentRunStatus::AwaitingApproval,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::ApprovalRequested,
                    status: Some(DeploymentRunStatus::AwaitingApproval),
                    summary: "Approval requested".into(),
                    payload: None,
                },
            )
            .unwrap();
        database
            .transition_deployment_run_atomic(
                run_id,
                2,
                DeploymentRunStatus::AwaitingApproval,
                DeploymentRunStatus::Approved,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::ApprovalGranted,
                    status: Some(DeploymentRunStatus::Approved),
                    summary: "Approval granted".into(),
                    payload: None,
                },
            )
            .unwrap();
        let detail = database
            .get_deployment_run_detail(run_id, 2)
            .unwrap()
            .unwrap();
        assert_eq!(
            detail
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(detail.next_before_sequence, Some(2));
        let earlier = database
            .list_deployment_run_events_before(run_id, 2, 2)
            .unwrap();
        assert_eq!(earlier.items.len(), 1);
        assert_eq!(earlier.items[0].sequence, 1);
        assert_eq!(earlier.next_before_sequence, None);
    }

    #[test]
    fn notification_receipts_survive_restart_and_distinguish_terminal_outcomes() {
        let (directory, database) = database();
        create_workflow(&database);
        let success = crate::deployment::planner::create_deployment_plan(
            &database,
            distinct_plan_input("success"),
        )
        .unwrap();
        database
            .transition_deployment_run_atomic(
                &success.run_id,
                1,
                DeploymentRunStatus::Planned,
                DeploymentRunStatus::AwaitingApproval,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::ApprovalRequested,
                    status: Some(DeploymentRunStatus::AwaitingApproval),
                    summary: "Approval requested".into(),
                    payload: None,
                },
            )
            .unwrap();
        let approval = database.claim_deployment_notifications(50).unwrap();
        assert_eq!(approval.len(), 1);
        assert_eq!(
            approval[0].kind,
            DeploymentNotificationKind::UserActionRequired
        );
        assert!(database
            .claim_deployment_notifications(50)
            .unwrap()
            .is_empty());

        for (sequence, from, to, kind) in [
            (
                2,
                DeploymentRunStatus::AwaitingApproval,
                DeploymentRunStatus::Approved,
                DeploymentEventKind::ApprovalGranted,
            ),
            (
                3,
                DeploymentRunStatus::Approved,
                DeploymentRunStatus::InProgress,
                DeploymentEventKind::StatusChanged,
            ),
            (
                4,
                DeploymentRunStatus::InProgress,
                DeploymentRunStatus::Verifying,
                DeploymentEventKind::StatusChanged,
            ),
            (
                5,
                DeploymentRunStatus::Verifying,
                DeploymentRunStatus::Succeeded,
                DeploymentEventKind::RunSucceeded,
            ),
        ] {
            database
                .transition_deployment_run_atomic(
                    &success.run_id,
                    sequence,
                    from,
                    to,
                    &DeploymentEventWrite {
                        event_kind: kind,
                        status: Some(to),
                        summary: format!("Run entered {}", to.as_str()),
                        payload: None,
                    },
                )
                .unwrap();
        }
        let succeeded = database.claim_deployment_notifications(50).unwrap();
        assert_eq!(succeeded.len(), 1);
        assert_eq!(succeeded[0].kind, DeploymentNotificationKind::Succeeded);
        assert!(database
            .with_connection(|connection| connection
                .execute(
                    "UPDATE deployment_notification_receipts SET created_at = created_at + 1
                     WHERE run_id = ?1",
                    [&success.run_id],
                )
                .map(|_| ())
                .map_err(|error| error.to_string()))
            .is_err());
        drop(database);

        let reopened = Database::open(&directory.path().join("deployment.db")).unwrap();
        assert!(reopened
            .claim_deployment_notifications(50)
            .unwrap()
            .is_empty());

        let failed = crate::deployment::planner::create_deployment_plan(
            &reopened,
            distinct_plan_input("failed"),
        )
        .unwrap();
        reopened
            .transition_deployment_run_atomic(
                &failed.run_id,
                1,
                DeploymentRunStatus::Planned,
                DeploymentRunStatus::AwaitingApproval,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::ApprovalRequested,
                    status: Some(DeploymentRunStatus::AwaitingApproval),
                    summary: "Approval requested".into(),
                    payload: None,
                },
            )
            .unwrap();
        let _ = reopened.claim_deployment_notifications(50).unwrap();
        reopened
            .transition_deployment_run_atomic(
                &failed.run_id,
                2,
                DeploymentRunStatus::AwaitingApproval,
                DeploymentRunStatus::Failed,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::RunFailed,
                    status: Some(DeploymentRunStatus::Failed),
                    summary: "Deployment failed".into(),
                    payload: Some(serde_json::json!({ "failureCategory": "healthCheckFailed" })),
                },
            )
            .unwrap();
        let failed_notification = reopened.claim_deployment_notifications(50).unwrap();
        assert_eq!(failed_notification.len(), 1);
        assert_eq!(
            failed_notification[0].kind,
            DeploymentNotificationKind::Failed
        );

        let restored = crate::deployment::planner::create_deployment_plan(
            &reopened,
            distinct_plan_input("restored"),
        )
        .unwrap();
        for (sequence, from, to, kind) in [
            (
                1,
                DeploymentRunStatus::Planned,
                DeploymentRunStatus::AwaitingApproval,
                DeploymentEventKind::ApprovalRequested,
            ),
            (
                2,
                DeploymentRunStatus::AwaitingApproval,
                DeploymentRunStatus::Approved,
                DeploymentEventKind::ApprovalGranted,
            ),
            (
                3,
                DeploymentRunStatus::Approved,
                DeploymentRunStatus::InProgress,
                DeploymentEventKind::StatusChanged,
            ),
        ] {
            reopened
                .transition_deployment_run_atomic(
                    &restored.run_id,
                    sequence,
                    from,
                    to,
                    &DeploymentEventWrite {
                        event_kind: kind,
                        status: Some(to),
                        summary: format!("Run entered {}", to.as_str()),
                        payload: None,
                    },
                )
                .unwrap();
            if to == DeploymentRunStatus::AwaitingApproval {
                let _ = reopened.claim_deployment_notifications(50).unwrap();
            }
        }
        reopened
            .transition_deployment_run_atomic(
                &restored.run_id,
                4,
                DeploymentRunStatus::InProgress,
                DeploymentRunStatus::Failed,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::RunFailed,
                    status: Some(DeploymentRunStatus::Failed),
                    summary: "Automatic restore completed".into(),
                    payload: Some(serde_json::json!({ "rollbackReleaseId": "release-previous" })),
                },
            )
            .unwrap();
        let restored_notification = reopened.claim_deployment_notifications(50).unwrap();
        assert_eq!(restored_notification.len(), 1);
        assert_eq!(
            restored_notification[0].kind,
            DeploymentNotificationKind::AutomaticRestoreCompleted
        );
    }
}
