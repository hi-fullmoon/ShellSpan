//! Durable audit boundary for Deployment Runbook execution.
//!
//! Connection requests and credentials never cross this module. Reviews store
//! only canonical semantic material; action output is deliberately omitted.

use crate::db::{current_timestamp_ms, Database};
use rusqlite::{params, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeploymentOperationKind {
    Deployment,
    Rollback,
    Cleanup,
}

impl DeploymentOperationKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Deployment => "deployment",
            Self::Rollback => "rollback",
            Self::Cleanup => "cleanup",
        }
    }
}

#[derive(Debug)]
pub(crate) struct ReviewIdentity<'a> {
    pub(crate) review_id: &'a str,
    pub(crate) operation_id: &'a str,
    pub(crate) kind: DeploymentOperationKind,
    pub(crate) source_operation_id: Option<&'a str>,
    pub(crate) document_digest: &'a str,
    pub(crate) plan_digest: &'a str,
    pub(crate) target_digest: &'a str,
    pub(crate) deployment_id: &'a str,
    pub(crate) application_id: &'a str,
    pub(crate) environment: &'a str,
    pub(crate) version: &'a str,
    pub(crate) reviewed_at: i64,
    pub(crate) expires_at: i64,
}

#[derive(Debug)]
pub(crate) struct ConsumedReview<T> {
    pub(crate) review: T,
    pub(crate) execution_token: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RollbackSourceRecord {
    pub(crate) review_json: String,
    pub(crate) source_operation_id: String,
    pub(crate) source_phase: String,
    pub(crate) previous_release: String,
    pub(crate) new_release: String,
    pub(crate) releases_directory: String,
    pub(crate) active_symlink: String,
    pub(crate) captured_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentOperationSummaryV2 {
    pub(crate) operation_id: String,
    pub(crate) review_id: String,
    pub(crate) operation_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_operation_id: Option<String>,
    pub(crate) document_digest: String,
    pub(crate) plan_digest: String,
    pub(crate) target_digest: String,
    pub(crate) deployment_id: String,
    pub(crate) application_id: String,
    pub(crate) environment: String,
    pub(crate) version: String,
    pub(crate) phase: String,
    pub(crate) terminal: bool,
    pub(crate) recovery_required: bool,
    pub(crate) started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentOperationDetailV2 {
    #[serde(flatten)]
    pub(crate) summary: DeploymentOperationSummaryV2,
    pub(crate) review: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<serde_json::Value>,
    pub(crate) actions: Vec<serde_json::Value>,
    pub(crate) health_evidence: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentOperationListRequestV2 {
    #[serde(default)]
    operation_kind: Option<String>,
    #[serde(default)]
    target_digest: Option<String>,
    #[serde(default)]
    recovery_required: Option<bool>,
    #[serde(default = "default_list_limit")]
    limit: u16,
}

fn default_list_limit() -> u16 {
    100
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentReleaseCleanupCandidateV2 {
    pub(crate) candidate_id: String,
    pub(crate) target_digest: String,
    pub(crate) release_path: String,
    pub(crate) releases_directory: String,
    pub(crate) active_symlink: String,
    pub(crate) deployment_id: String,
    pub(crate) application_id: String,
    pub(crate) environment: String,
    pub(crate) version: String,
    pub(crate) source_operation_id: String,
    pub(crate) last_verified_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentReleaseCleanupReviewRequestV2 {
    operation_id: String,
    candidate_id: String,
    profile_id: String,
    connection: crate::models::RemoteConnectionRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentReleaseCleanupReviewV2 {
    schema_version: u8,
    review_id: String,
    operation_id: String,
    candidate_id: String,
    source_operation_id: String,
    deployment_id: String,
    application_id: String,
    environment: String,
    version: String,
    release_path: String,
    releases_directory: String,
    active_symlink: String,
    target: crate::execution::FrozenTargetIdentity,
    declared_risk: crate::runbook::RunbookRisk,
    document_digest: String,
    plan_digest: String,
    action: serde_json::Value,
    executable_in_phase: bool,
    reviewed_at: i64,
    expires_at: i64,
}

fn digest(domain: &str, value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(value);
    let encoded = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256-v1:{encoded}")
}

fn json_string<T: Serialize>(value: &T, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("failed to serialize {label}: {error}"))
}

fn scrub_persisted_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                scrub_persisted_value(value);
            }
        }
        serde_json::Value::Object(object) => {
            for key in [
                "output",
                "stdout",
                "stderr",
                "password",
                "passphrase",
                "privateKeyData",
                "connection",
            ] {
                object.remove(key);
            }
            for value in object.values_mut() {
                scrub_persisted_value(value);
            }
        }
        _ => {}
    }
}

pub(crate) fn store_review<T: Serialize>(
    database: &Database,
    identity: &ReviewIdentity<'_>,
    review: &T,
    release_refs: &[(&str, &str)],
) -> Result<(), String> {
    let review_json = json_string(review, "deployment review")?;
    let parsed: serde_json::Value = serde_json::from_str(&review_json)
        .map_err(|error| format!("failed to validate deployment review JSON: {error}"))?;
    if parsed.get("connection").is_some() {
        return Err("deployment reviews must not persist connection credentials".into());
    }
    database.with_transaction(|transaction| {
        transaction
            .execute(
                "UPDATE deployment_reviews SET state='expired' \
                 WHERE state='pending' AND expires_at <= ?1",
                params![current_timestamp_ms()],
            )
            .map_err(|error| format!("failed to expire deployment reviews: {error}"))?;
        let operation_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deployment_operations WHERE operation_id=?1)",
                params![identity.operation_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to check deployment operation identity: {error}"))?;
        if operation_exists {
            return Err("deployment operation identity was already used".into());
        }
        transaction
            .execute(
                "INSERT INTO deployment_reviews (
                    review_id, operation_id, operation_kind, source_operation_id,
                    document_digest, plan_digest, target_digest, deployment_id,
                    application_id, environment, version, review_json, state,
                    reviewed_at, expires_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                           'pending', ?13, ?14)",
                params![
                    identity.review_id,
                    identity.operation_id,
                    identity.kind.as_str(),
                    identity.source_operation_id,
                    identity.document_digest,
                    identity.plan_digest,
                    identity.target_digest,
                    identity.deployment_id,
                    identity.application_id,
                    identity.environment,
                    identity.version,
                    review_json,
                    identity.reviewed_at,
                    identity.expires_at,
                ],
            )
            .map_err(|error| format!("failed to persist deployment review: {error}"))?;
        for (path, reference_kind) in release_refs {
            transaction
                .execute(
                    "INSERT INTO deployment_review_release_refs
                     (review_id, release_path, reference_kind) VALUES (?1, ?2, ?3)",
                    params![identity.review_id, path, reference_kind],
                )
                .map_err(|error| {
                    format!("failed to persist deployment release reference: {error}")
                })?;
        }
        Ok(())
    })
}

pub(crate) fn consume_review<T: DeserializeOwned, A: Serialize>(
    database: &Database,
    kind: DeploymentOperationKind,
    review_id: &str,
    operation_id: &str,
    approval: &A,
) -> Result<ConsumedReview<T>, String> {
    let approval_json = json_string(approval, "deployment approval")?;
    let approval_digest = digest("termbridge-deployment-approval", approval_json.as_bytes());
    database.with_transaction(|transaction| {
        let row = transaction
            .query_row(
                "SELECT operation_id, operation_kind, state, expires_at, review_json,
                        document_digest, plan_digest, target_digest, deployment_id,
                        application_id, environment, version, source_operation_id
                 FROM deployment_reviews WHERE review_id=?1",
                params![review_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, Option<String>>(12)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("failed to load deployment review: {error}"))?
            .ok_or_else(|| "deployment review was not found or was already consumed".to_string())?;
        let now = current_timestamp_ms();
        if row.0 != operation_id || row.1 != kind.as_str() || row.2 != "pending" || row.3 <= now {
            if row.2 == "pending" && row.3 <= now {
                transaction
                    .execute(
                        "UPDATE deployment_reviews SET state='expired' WHERE review_id=?1 AND state='pending'",
                        params![review_id],
                    )
                    .map_err(|error| format!("failed to expire deployment review: {error}"))?;
            }
            return Err("deployment review is expired, consumed, or does not bind this operation".into());
        }
        let review = serde_json::from_str::<T>(&row.4)
            .map_err(|error| format!("persisted deployment review is invalid: {error}"))?;
        let execution_token = uuid::Uuid::new_v4().to_string();
        let changed = transaction
            .execute(
                "UPDATE deployment_reviews SET state='consumed', consumed_at=?2
                 WHERE review_id=?1 AND state='pending'",
                params![review_id, now],
            )
            .map_err(|error| format!("failed to consume deployment review: {error}"))?;
        if changed != 1 {
            return Err("deployment review was already consumed".into());
        }
        if kind == DeploymentOperationKind::Rollback {
            let source_operation_id = row
                .12
                .as_deref()
                .ok_or_else(|| "rollback review has no persisted source operation".to_string())?;
            let reserved = transaction
                .execute(
                    "UPDATE deployment_rollback_snapshots
                     SET rollback_reserved_by=?2
                     WHERE operation_id=?1 AND rollback_consumed_at IS NULL
                       AND (
                         rollback_reserved_by IS NULL
                         OR EXISTS (
                           SELECT 1 FROM deployment_operations interrupted
                           WHERE interrupted.operation_id=rollback_reserved_by
                             AND interrupted.terminal=1
                             AND interrupted.recovery_required=1
                         )
                       )",
                    params![source_operation_id, operation_id],
                )
                .map_err(|error| format!("failed to reserve rollback snapshot: {error}"))?;
            if reserved != 1 {
                return Err(
                    "rollback source is consumed or reserved by another active operation".into(),
                );
            }
        }
        transaction
            .execute(
                "INSERT INTO deployment_operations (
                    operation_id, review_id, operation_kind, source_operation_id,
                    execution_token, document_digest, plan_digest, target_digest,
                    deployment_id, application_id, environment, version, phase,
                    terminal, recovery_required, started_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                           'pending', 0, 0, ?13, ?13, ?13)",
                params![
                    operation_id,
                    review_id,
                    kind.as_str(),
                    row.12,
                    execution_token,
                    row.5,
                    row.6,
                    row.7,
                    row.8,
                    row.9,
                    row.10,
                    row.11,
                    now,
                ],
            )
            .map_err(|error| format!("failed to start persisted deployment operation: {error}"))?;
        transaction
            .execute(
                "INSERT INTO deployment_approval_consumptions
                 (review_id, operation_id, operation_kind, approval_digest, consumed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![review_id, operation_id, kind.as_str(), approval_digest, now],
            )
            .map_err(|error| format!("failed to persist deployment approval consumption: {error}"))?;
        Ok(ConsumedReview {
            review,
            execution_token,
        })
    })
}

fn string_field(value: &serde_json::Value, field: &str) -> String {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

fn optional_i64_field(value: &serde_json::Value, field: &str) -> Option<i64> {
    value.get(field).and_then(serde_json::Value::as_i64)
}

pub(crate) fn checkpoint_operation<T: Serialize>(
    database: &Database,
    operation_id: &str,
    execution_token: &str,
    phase: &str,
    terminal: bool,
    result: &T,
) -> Result<(), String> {
    let mut persisted = serde_json::to_value(result)
        .map_err(|error| format!("failed to serialize deployment checkpoint: {error}"))?;
    scrub_persisted_value(&mut persisted);
    if let Some(object) = persisted.as_object_mut() {
        object.insert(
            "phase".to_string(),
            serde_json::Value::String(phase.to_string()),
        );
    }
    let result_json = persisted.to_string();
    let actions = persisted
        .get("actions")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let health = persisted
        .get("healthChecks")
        .or_else(|| persisted.get("healthEvidence"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let error_category = persisted
        .get("errorCategory")
        .and_then(serde_json::Value::as_str);
    let error = persisted.get("error").and_then(serde_json::Value::as_str);
    let completed_at = if terminal {
        persisted
            .get("completedAt")
            .and_then(serde_json::Value::as_i64)
            .or_else(|| Some(current_timestamp_ms()))
    } else {
        None
    };
    database.with_transaction(|transaction| {
        let changed = transaction
            .execute(
                "UPDATE deployment_operations SET phase=?3, terminal=?4,
                    completed_at=?5, error_category=?6, error=?7, result_json=?8,
                    updated_at=?9
                 WHERE operation_id=?1 AND execution_token=?2 AND terminal=0",
                params![
                    operation_id,
                    execution_token,
                    phase,
                    terminal,
                    completed_at,
                    error_category,
                    error,
                    result_json,
                    current_timestamp_ms(),
                ],
            )
            .map_err(|error| format!("failed to persist deployment checkpoint: {error}"))?;
        if changed != 1 {
            return Err("late or stale deployment checkpoint was rejected".into());
        }
        transaction
            .execute(
                "DELETE FROM deployment_action_results WHERE operation_id=?1",
                params![operation_id],
            )
            .map_err(|error| format!("failed to replace deployment action checkpoints: {error}"))?;
        for (index, action) in actions.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO deployment_action_results
                     (operation_id, action_index, action_id, status, action_json, started_at, completed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        operation_id,
                        index as i64,
                        string_field(action, "actionId"),
                        string_field(action, "status"),
                        action.to_string(),
                        optional_i64_field(action, "startedAt"),
                        optional_i64_field(action, "completedAt"),
                    ],
                )
                .map_err(|error| format!("failed to persist deployment action result: {error}"))?;
        }
        transaction
            .execute(
                "DELETE FROM deployment_health_evidence WHERE operation_id=?1",
                params![operation_id],
            )
            .map_err(|error| format!("failed to replace deployment health evidence: {error}"))?;
        for (index, evidence) in health.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO deployment_health_evidence
                     (operation_id, check_index, check_id, status, evidence_json, recorded_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        operation_id,
                        index as i64,
                        string_field(evidence, "checkId"),
                        string_field(evidence, "status"),
                        evidence.to_string(),
                        current_timestamp_ms(),
                    ],
                )
                .map_err(|error| format!("failed to persist deployment health evidence: {error}"))?;
        }

        let operation_kind: String = transaction
            .query_row(
                "SELECT operation_kind FROM deployment_operations WHERE operation_id=?1",
                params![operation_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to reload deployment operation kind: {error}"))?;
        if operation_kind == "deployment" {
            if let Some(snapshot) = persisted.get("rollbackSnapshot") {
                let previous = snapshot
                    .get("previousRelease")
                    .and_then(serde_json::Value::as_str);
                let new_release = string_field(snapshot, "newRelease");
                let releases_directory = string_field(snapshot, "releasesDirectory");
                let active_symlink = string_field(snapshot, "activeSymlink");
                let activation_changed = snapshot
                    .get("activationChanged")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                transaction
                    .execute(
                        "INSERT INTO deployment_rollback_snapshots
                         (operation_id, strategy, previous_release, new_release,
                          releases_directory, active_symlink, activation_changed, captured_at)
                         VALUES (?1, 'reactivatePreviousRelease', ?2, ?3, ?4, ?5, ?6, ?7)
                         ON CONFLICT(operation_id) DO UPDATE SET
                           previous_release=excluded.previous_release,
                           new_release=excluded.new_release,
                           releases_directory=excluded.releases_directory,
                           active_symlink=excluded.active_symlink,
                           activation_changed=excluded.activation_changed,
                           captured_at=excluded.captured_at",
                        params![
                            operation_id,
                            previous,
                            new_release,
                            releases_directory,
                            active_symlink,
                            activation_changed,
                            optional_i64_field(snapshot, "capturedAt"),
                        ],
                    )
                    .map_err(|error| format!("failed to persist deployment rollback snapshot: {error}"))?;
                let identity = transaction
                    .query_row(
                        "SELECT target_digest, deployment_id, application_id, environment, version
                         FROM deployment_operations WHERE operation_id=?1",
                        params![operation_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                            ))
                        },
                    )
                    .map_err(|error| format!("failed to load deployment release identity: {error}"))?;
                transaction
                    .execute(
                        "INSERT INTO deployment_release_records
                         (target_digest, release_path, releases_directory, active_symlink,
                          deployment_id, application_id, environment, version,
                          source_operation_id, verified, is_current, last_verified_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                         ON CONFLICT(target_digest, release_path) DO UPDATE SET
                           verified=MAX(verified, excluded.verified),
                           is_current=excluded.is_current,
                           last_verified_at=COALESCE(excluded.last_verified_at, last_verified_at),
                           deleted_at=NULL",
                        params![
                            identity.0,
                            new_release,
                            releases_directory,
                            active_symlink,
                            identity.1,
                            identity.2,
                            identity.3,
                            identity.4,
                            operation_id,
                            phase == "succeeded",
                            activation_changed,
                            (phase == "succeeded").then_some(current_timestamp_ms()),
                        ],
                    )
                    .map_err(|error| format!("failed to persist deployment release record: {error}"))?;
                if activation_changed {
                    transaction
                        .execute(
                            "UPDATE deployment_release_records SET is_current=0
                             WHERE target_digest=?1 AND release_path<>?2",
                            params![identity.0, new_release],
                        )
                        .map_err(|error| format!("failed to update current deployment release: {error}"))?;
                }
            }
        } else if operation_kind == "rollback" {
            let mut activation_changed = false;
            if let Some(reactivation) = persisted.get("reactivation") {
                activation_changed = reactivation
                    .get("activationChanged")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                if activation_changed {
                    let target_digest: String = transaction
                        .query_row(
                            "SELECT target_digest FROM deployment_operations WHERE operation_id=?1",
                            params![operation_id],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("failed to load rollback target identity: {error}"))?;
                    let previous_release = string_field(reactivation, "previousRelease");
                    transaction
                        .execute(
                            "UPDATE deployment_release_records SET is_current=(release_path=?2)
                             WHERE target_digest=?1",
                            params![target_digest, previous_release],
                        )
                        .map_err(|error| format!("failed to persist rollback current release: {error}"))?;
                    transaction
                        .execute(
                            "UPDATE deployment_rollback_snapshots
                             SET rollback_consumed_at=?2
                             WHERE operation_id=(
                               SELECT source_operation_id FROM deployment_operations
                               WHERE operation_id=?1
                             ) AND rollback_reserved_by=?1",
                            params![operation_id, current_timestamp_ms()],
                        )
                        .map_err(|error| format!("failed to consume rollback snapshot: {error}"))?;
                }
            }
            if terminal && !activation_changed {
                transaction
                    .execute(
                        "UPDATE deployment_rollback_snapshots SET rollback_reserved_by=NULL
                         WHERE operation_id=(
                           SELECT source_operation_id FROM deployment_operations
                           WHERE operation_id=?1
                         ) AND rollback_reserved_by=?1",
                        params![operation_id],
                    )
                    .map_err(|error| format!("failed to release rollback snapshot: {error}"))?;
            }
        }
        Ok(())
    })
}

pub(crate) fn recover_interrupted_operations(database: &Database) -> Result<usize, String> {
    let now = current_timestamp_ms();
    database.with_transaction(|transaction| {
        let operation_ids = {
            let mut statement = transaction
                .prepare("SELECT operation_id FROM deployment_operations WHERE terminal=0")
                .map_err(|error| format!("failed to prepare deployment recovery: {error}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("failed to query deployment recovery: {error}"))?;
            rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect deployment recovery: {error}"))?
        };
        for operation_id in &operation_ids {
            transaction
                .execute(
                    "UPDATE deployment_operations SET phase='interrupted', terminal=1,
                        recovery_required=1, completed_at=?2, error_category='recoveryRequired',
                        error='application restart interrupted this operation; remote state was not replayed',
                        updated_at=?2, execution_token='recovered'
                     WHERE operation_id=?1 AND terminal=0",
                    params![operation_id, now],
                )
                .map_err(|error| format!("failed to recover deployment operation: {error}"))?;
            transaction
                .execute(
                    "UPDATE deployment_action_results SET status='interrupted'
                     WHERE operation_id=?1 AND status='running'",
                    params![operation_id],
                )
                .map_err(|error| format!("failed to recover deployment action result: {error}"))?;
        }
        Ok(operation_ids.len())
    })
}

pub(crate) fn load_rollback_source(
    database: &Database,
    source_operation_id: &str,
) -> Result<RollbackSourceRecord, String> {
    load_rollback_source_with_reservation(database, source_operation_id, None)
}

pub(crate) fn load_rollback_source_for_execution(
    database: &Database,
    source_operation_id: &str,
    rollback_operation_id: &str,
) -> Result<RollbackSourceRecord, String> {
    load_rollback_source_with_reservation(
        database,
        source_operation_id,
        Some(rollback_operation_id),
    )
}

fn load_rollback_source_with_reservation(
    database: &Database,
    source_operation_id: &str,
    allowed_reservation: Option<&str>,
) -> Result<RollbackSourceRecord, String> {
    database.with_connection(|connection| {
        let row = connection
            .query_row(
                "SELECT r.review_json, o.operation_id, o.phase, s.previous_release,
                        s.new_release, s.releases_directory, s.active_symlink, s.captured_at,
                        s.activation_changed, s.rollback_consumed_at, o.operation_kind, o.terminal,
                        o.recovery_required, s.rollback_reserved_by,
                        reserved.terminal, reserved.recovery_required
                 FROM deployment_operations o
                 JOIN deployment_reviews r ON r.review_id=o.review_id
                 JOIN deployment_rollback_snapshots s ON s.operation_id=o.operation_id
                 LEFT JOIN deployment_operations reserved
                   ON reserved.operation_id=s.rollback_reserved_by
                 WHERE o.operation_id=?1",
                params![source_operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, bool>(8)?,
                        row.get::<_, Option<i64>>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, bool>(11)?,
                        row.get::<_, bool>(12)?,
                        row.get::<_, Option<String>>(13)?,
                        row.get::<_, Option<bool>>(14)?,
                        row.get::<_, Option<bool>>(15)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("failed to load rollback source: {error}"))?
            .ok_or_else(|| "rollback source deployment was not found".to_string())?;
        if row.10 != "deployment" || !row.11 || !row.8 || row.9.is_some() {
            return Err(
                "rollback source is not an unconsumed persisted activation snapshot".into(),
            );
        }
        if let Some(reserved_by) = row.13.as_deref() {
            let is_this_execution = allowed_reservation == Some(reserved_by);
            let is_recoverable_interruption = row.14 == Some(true) && row.15 == Some(true);
            if !is_this_execution && !is_recoverable_interruption {
                return Err("rollback source is reserved by another active operation".into());
            }
        }
        if row.2 != "succeeded"
            && !matches!(
                row.2.as_str(),
                "failed" | "cancelled" | "timedOut" | "identityMismatch"
            )
            && !(row.2 == "interrupted" && row.12)
        {
            return Err("rollback source terminal state is not eligible".into());
        }
        Ok(RollbackSourceRecord {
            review_json: row.0,
            source_operation_id: row.1,
            source_phase: row.2,
            previous_release: row
                .3
                .ok_or_else(|| "rollback source has no previous release".to_string())?,
            new_release: row.4,
            releases_directory: row.5,
            active_symlink: row.6,
            captured_at: row
                .7
                .ok_or_else(|| "rollback source snapshot was not fully captured".to_string())?,
        })
    })
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentOperationSummaryV2> {
    Ok(DeploymentOperationSummaryV2 {
        operation_id: row.get(0)?,
        review_id: row.get(1)?,
        operation_kind: row.get(2)?,
        source_operation_id: row.get(3)?,
        document_digest: row.get(4)?,
        plan_digest: row.get(5)?,
        target_digest: row.get(6)?,
        deployment_id: row.get(7)?,
        application_id: row.get(8)?,
        environment: row.get(9)?,
        version: row.get(10)?,
        phase: row.get(11)?,
        terminal: row.get(12)?,
        recovery_required: row.get(13)?,
        started_at: row.get(14)?,
        completed_at: row.get(15)?,
        error_category: row.get(16)?,
        error: row.get(17)?,
    })
}

const SUMMARY_COLUMNS: &str = "operation_id, review_id, operation_kind, source_operation_id,
    document_digest, plan_digest, target_digest, deployment_id, application_id,
    environment, version, phase, terminal, recovery_required, started_at,
    completed_at, error_category, error";

const ALIASED_SUMMARY_COLUMNS: &str = "o.operation_id, o.review_id, o.operation_kind,
    o.source_operation_id, o.document_digest, o.plan_digest, o.target_digest,
    o.deployment_id, o.application_id, o.environment, o.version, o.phase,
    o.terminal, o.recovery_required, o.started_at, o.completed_at,
    o.error_category, o.error";

pub(crate) fn list_operations(
    database: &Database,
    request: DeploymentOperationListRequestV2,
) -> Result<Vec<DeploymentOperationSummaryV2>, String> {
    if request.limit == 0 || request.limit > 500 {
        return Err("deployment operation list limit must be from 1 to 500".into());
    }
    if request
        .operation_kind
        .as_deref()
        .is_some_and(|kind| !matches!(kind, "deployment" | "rollback" | "cleanup"))
    {
        return Err("deployment operation kind filter is invalid".into());
    }
    database.with_connection(|connection| {
        let sql = format!(
            "SELECT {SUMMARY_COLUMNS} FROM deployment_operations
             WHERE (?1 IS NULL OR operation_kind=?1)
               AND (?2 IS NULL OR target_digest=?2)
               AND (?3 IS NULL OR recovery_required=?3)
             ORDER BY started_at DESC LIMIT ?4"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("failed to prepare deployment operation list: {error}"))?;
        let rows = statement
            .query_map(
                params![
                    request.operation_kind,
                    request.target_digest,
                    request.recovery_required,
                    request.limit,
                ],
                summary_from_row,
            )
            .map_err(|error| format!("failed to query deployment operation list: {error}"))?;
        let operations = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to collect deployment operation list: {error}"))?;
        Ok(operations)
    })
}

pub(crate) fn get_operation(
    database: &Database,
    operation_id: &str,
) -> Result<Option<DeploymentOperationDetailV2>, String> {
    database.with_connection(|connection| {
        let sql = format!(
            "SELECT {ALIASED_SUMMARY_COLUMNS}, r.review_json, o.result_json
             FROM deployment_operations o
             JOIN deployment_reviews r ON r.review_id=o.review_id
             WHERE o.operation_id=?1"
        );
        let row = connection
            .query_row(&sql, params![operation_id], |row| {
                Ok((
                    summary_from_row(row)?,
                    row.get::<_, String>(18)?,
                    row.get::<_, Option<String>>(19)?,
                ))
            })
            .optional()
            .map_err(|error| format!("failed to load deployment operation: {error}"))?;
        let Some((summary, review_json, result_json)) = row else {
            return Ok(None);
        };
        let mut action_statement = connection
            .prepare(
                "SELECT action_json FROM deployment_action_results
                 WHERE operation_id=?1 ORDER BY action_index",
            )
            .map_err(|error| format!("failed to prepare deployment actions: {error}"))?;
        let actions = action_statement
            .query_map(params![operation_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to query deployment actions: {error}"))?
            .map(|value| {
                value.and_then(|json| {
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to collect deployment actions: {error}"))?;
        let mut health_statement = connection
            .prepare(
                "SELECT evidence_json FROM deployment_health_evidence
                 WHERE operation_id=?1 ORDER BY check_index",
            )
            .map_err(|error| format!("failed to prepare deployment health evidence: {error}"))?;
        let health_evidence = health_statement
            .query_map(params![operation_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to query deployment health evidence: {error}"))?
            .map(|value| {
                value.and_then(|json| {
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to collect deployment health evidence: {error}"))?;
        Ok(Some(DeploymentOperationDetailV2 {
            summary,
            review: serde_json::from_str(&review_json)
                .map_err(|error| format!("persisted deployment review is invalid: {error}"))?,
            result: result_json
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|error| format!("persisted deployment result is invalid: {error}"))?,
            actions,
            health_evidence,
        }))
    })
}

pub(crate) fn cleanup_candidates(
    database: &Database,
    target_digest: Option<&str>,
) -> Result<Vec<DeploymentReleaseCleanupCandidateV2>, String> {
    database.with_connection(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT rr.target_digest, rr.release_path, rr.releases_directory,
                        rr.active_symlink, rr.deployment_id, rr.application_id,
                        rr.environment, rr.version, rr.source_operation_id,
                        rr.last_verified_at
                 FROM deployment_release_records rr
                 WHERE rr.verified=1 AND rr.is_current=0 AND rr.deleted_at IS NULL
                   AND (?1 IS NULL OR rr.target_digest=?1)
                   AND NOT EXISTS (
                     SELECT 1 FROM deployment_operations active
                     WHERE active.target_digest=rr.target_digest
                       AND (active.terminal=0 OR active.recovery_required=1)
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM deployment_rollback_snapshots snapshot
                     JOIN deployment_operations source ON source.operation_id=snapshot.operation_id
                     WHERE snapshot.previous_release=rr.release_path
                       AND source.target_digest=rr.target_digest
                       AND snapshot.rollback_consumed_at IS NULL
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM deployment_review_release_refs refs
                     JOIN deployment_reviews review ON review.review_id=refs.review_id
                     LEFT JOIN deployment_operations active ON active.review_id=review.review_id
                     WHERE refs.release_path=rr.release_path
                       AND ((review.state='pending' AND review.expires_at>?2)
                            OR (review.state='consumed' AND active.terminal=0))
                   )
                 ORDER BY rr.last_verified_at ASC, rr.release_path ASC",
            )
            .map_err(|error| format!("failed to prepare release cleanup candidates: {error}"))?;
        let rows = statement
            .query_map(params![target_digest, current_timestamp_ms()], |row| {
                let target_digest: String = row.get(0)?;
                let release_path: String = row.get(1)?;
                Ok(DeploymentReleaseCleanupCandidateV2 {
                    candidate_id: digest(
                        "termbridge-deployment-cleanup-candidate",
                        format!("{target_digest}\0{release_path}").as_bytes(),
                    ),
                    target_digest,
                    release_path,
                    releases_directory: row.get(2)?,
                    active_symlink: row.get(3)?,
                    deployment_id: row.get(4)?,
                    application_id: row.get(5)?,
                    environment: row.get(6)?,
                    version: row.get(7)?,
                    source_operation_id: row.get(8)?,
                    last_verified_at: row.get(9)?,
                })
            })
            .map_err(|error| format!("failed to query release cleanup candidates: {error}"))?;
        let candidates = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to collect release cleanup candidates: {error}"))?;
        Ok(candidates)
    })
}

#[tauri::command]
pub(crate) fn review_deployment_release_cleanup(
    database: tauri::State<'_, Database>,
    request: DeploymentReleaseCleanupReviewRequestV2,
) -> Result<DeploymentReleaseCleanupReviewV2, String> {
    if !crate::execution::valid_operation_id(&request.operation_id) {
        return Err("deployment cleanup operation identity is invalid".into());
    }
    let candidate = cleanup_candidates(&database, None)?
        .into_iter()
        .find(|candidate| candidate.candidate_id == request.candidate_id)
        .ok_or_else(|| {
            "deployment release is no longer an eligible cleanup candidate".to_string()
        })?;
    let target = crate::execution::FrozenTargetIdentity::from_connection(
        request.profile_id,
        &request.connection,
    )
    .map_err(|error| error.message.to_string())?;
    if target.identity_digest != candidate.target_digest {
        return Err("deployment cleanup candidate belongs to another frozen target".into());
    }
    crate::execution::revalidate_frozen_target_identity(&database, &target, &request.connection)
        .map_err(|error| error.message)?;
    let document_digest = digest(
        "termbridge-deployment-cleanup-source",
        format!(
            "{}\0{}\0{}",
            candidate.source_operation_id, candidate.deployment_id, candidate.version
        )
        .as_bytes(),
    );
    let parameters = serde_json::json!({
        "activeSymlink": candidate.active_symlink.clone(),
        "candidateId": candidate.candidate_id.clone(),
        "releasePath": candidate.release_path.clone(),
        "releasesDirectory": candidate.releases_directory.clone(),
        "requiredChecks": ["notCurrent", "notRollbackTarget", "notActiveRunReference"],
    });
    let action = serde_json::json!({
        "actionId": "cleanup-action-0",
        "kind": "removeRelease",
        "target": candidate.release_path.clone(),
        "normalizedParameters": parameters.to_string(),
        "parametersDigest": digest(
            "termbridge-deployment-cleanup-parameters",
            parameters.to_string().as_bytes(),
        ),
        "risk": "destructive",
        "mutating": true,
    });
    let plan = serde_json::json!({
        "schemaVersion": 2,
        "operationId": request.operation_id,
        "sourceOperationId": candidate.source_operation_id.clone(),
        "documentDigest": document_digest.clone(),
        "target": target.clone(),
        "action": action.clone(),
        "executionAvailable": false,
    });
    let plan_digest = digest(
        "termbridge-deployment-cleanup-plan",
        plan.to_string().as_bytes(),
    );
    let reviewed_at = current_timestamp_ms();
    let review = DeploymentReleaseCleanupReviewV2 {
        schema_version: 2,
        review_id: format!("cleanup-review:{}", uuid::Uuid::new_v4()),
        operation_id: request.operation_id,
        candidate_id: candidate.candidate_id,
        source_operation_id: candidate.source_operation_id,
        deployment_id: candidate.deployment_id,
        application_id: candidate.application_id,
        environment: candidate.environment,
        version: candidate.version,
        release_path: candidate.release_path,
        releases_directory: candidate.releases_directory,
        active_symlink: candidate.active_symlink,
        target,
        declared_risk: crate::runbook::RunbookRisk::Destructive,
        document_digest,
        plan_digest,
        action,
        executable_in_phase: false,
        reviewed_at,
        expires_at: reviewed_at + 10 * 60 * 1_000,
    };
    store_review(
        &database,
        &ReviewIdentity {
            review_id: &review.review_id,
            operation_id: &review.operation_id,
            kind: DeploymentOperationKind::Cleanup,
            source_operation_id: Some(&review.source_operation_id),
            document_digest: &review.document_digest,
            plan_digest: &review.plan_digest,
            target_digest: &review.target.identity_digest,
            deployment_id: &review.deployment_id,
            application_id: &review.application_id,
            environment: &review.environment,
            version: &review.version,
            reviewed_at: review.reviewed_at,
            expires_at: review.expires_at,
        },
        &review,
        &[(review.release_path.as_str(), "cleanupTarget")],
    )?;
    Ok(review)
}

#[tauri::command]
pub(crate) fn list_deployment_operations(
    database: tauri::State<'_, Database>,
    request: DeploymentOperationListRequestV2,
) -> Result<Vec<DeploymentOperationSummaryV2>, String> {
    list_operations(&database, request)
}

#[tauri::command]
pub(crate) fn get_deployment_operation(
    database: tauri::State<'_, Database>,
    operation_id: String,
) -> Result<Option<DeploymentOperationDetailV2>, String> {
    if !crate::execution::valid_operation_id(&operation_id) {
        return Err("deployment operation identity is invalid".into());
    }
    get_operation(&database, &operation_id)
}

#[tauri::command]
pub(crate) fn list_deployment_release_cleanup_candidates(
    database: tauri::State<'_, Database>,
    target_digest: Option<String>,
) -> Result<Vec<DeploymentReleaseCleanupCandidateV2>, String> {
    cleanup_candidates(&database, target_digest.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("termbridge.db")).unwrap();
        (directory, database)
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct ReviewFixture {
        review_id: String,
        operation_id: String,
        normalized_runbook_text: String,
    }

    fn identity<'a>(review: &'a ReviewFixture) -> ReviewIdentity<'a> {
        ReviewIdentity {
            review_id: &review.review_id,
            operation_id: &review.operation_id,
            kind: DeploymentOperationKind::Deployment,
            source_operation_id: None,
            document_digest: "sha256-v1:document",
            plan_digest: "sha256-v1:plan",
            target_digest: "sha256-v1:target",
            deployment_id: "release-1",
            application_id: "app",
            environment: "test",
            version: "1.0.0",
            reviewed_at: current_timestamp_ms(),
            expires_at: current_timestamp_ms() + 60_000,
        }
    }

    #[test]
    fn persisted_approval_consumption_is_transactional_and_one_shot() {
        let (_directory, database) = database();
        let review = ReviewFixture {
            review_id: "deployment-review:persisted".into(),
            operation_id: "deployment:persisted".into(),
            normalized_runbook_text: "{\"schemaVersion\":2}".into(),
        };
        store_review(&database, &identity(&review), &review, &[]).unwrap();
        let consumed = consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Deployment,
            &review.review_id,
            &review.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
        assert_eq!(consumed.review, review);
        assert!(consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Deployment,
            &review.review_id,
            &review.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .is_err());
    }

    #[test]
    fn restart_marks_inflight_work_recovery_required_and_rejects_late_results() {
        let (_directory, database) = database();
        let review = ReviewFixture {
            review_id: "deployment-review:restart".into(),
            operation_id: "deployment:restart".into(),
            normalized_runbook_text: "{\"schemaVersion\":2}".into(),
        };
        store_review(&database, &identity(&review), &review, &[]).unwrap();
        let consumed = consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Deployment,
            &review.review_id,
            &review.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
        checkpoint_operation(
            &database,
            &review.operation_id,
            &consumed.execution_token,
            "activatingRelease",
            false,
            &serde_json::json!({"phase": "activatingRelease", "actions": []}),
        )
        .unwrap();
        assert_eq!(recover_interrupted_operations(&database).unwrap(), 1);
        let detail = get_operation(&database, &review.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(detail.summary.phase, "interrupted");
        assert!(detail.summary.recovery_required);
        assert!(checkpoint_operation(
            &database,
            &review.operation_id,
            &consumed.execution_token,
            "succeeded",
            true,
            &serde_json::json!({"phase": "succeeded", "actions": []}),
        )
        .unwrap_err()
        .contains("late or stale"));
    }

    #[test]
    fn persisted_material_strips_output_and_connection_secrets() {
        let (_directory, database) = database();
        let review = ReviewFixture {
            review_id: "deployment-review:secret".into(),
            operation_id: "deployment:secret".into(),
            normalized_runbook_text: "{\"schemaVersion\":2}".into(),
        };
        store_review(&database, &identity(&review), &review, &[]).unwrap();
        let consumed = consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Deployment,
            &review.review_id,
            &review.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
        checkpoint_operation(
            &database,
            &review.operation_id,
            &consumed.execution_token,
            "failed",
            true,
            &serde_json::json!({
                "phase": "failed",
                "actions": [{
                    "actionId": "a",
                    "status": "failed",
                    "output": "profile-secret",
                    "connection": {"password": "profile-secret"}
                }]
            }),
        )
        .unwrap();
        let leaked: bool = database
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM deployment_operations WHERE result_json LIKE '%profile-secret%'
                           UNION ALL
                           SELECT 1 FROM deployment_action_results WHERE action_json LIKE '%profile-secret%'
                         )",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(!leaked);
    }

    #[test]
    fn approval_transaction_failure_rolls_back_consumption_and_operation_start() {
        let (_directory, database) = database();
        let review = ReviewFixture {
            review_id: "deployment-review:transaction".into(),
            operation_id: "deployment:transaction".into(),
            normalized_runbook_text: "{\"schemaVersion\":2}".into(),
        };
        store_review(&database, &identity(&review), &review, &[]).unwrap();
        database
            .with_connection(|connection| {
                connection
                    .execute("DROP TABLE deployment_approval_consumptions", [])
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        assert!(consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Deployment,
            &review.review_id,
            &review.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap_err()
        .contains("approval consumption"));
        let (state, operations): (String, i64) = database
            .with_connection(|connection| {
                let state = connection
                    .query_row(
                        "SELECT state FROM deployment_reviews WHERE review_id=?1",
                        params![review.review_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let operations = connection
                    .query_row(
                        "SELECT COUNT(*) FROM deployment_operations WHERE operation_id=?1",
                        params![review.operation_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((state, operations))
            })
            .unwrap();
        assert_eq!(state, "pending");
        assert_eq!(operations, 0);
    }

    fn persist_successful_release(
        database: &Database,
        suffix: &str,
        release: &str,
        previous: Option<&str>,
    ) {
        let review = ReviewFixture {
            review_id: format!("deployment-review:{suffix}"),
            operation_id: format!("deployment:{suffix}"),
            normalized_runbook_text: "{\"schemaVersion\":2}".into(),
        };
        let mut identity = identity(&review);
        identity.deployment_id = suffix;
        store_review(database, &identity, &review, &[]).unwrap();
        let consumed = consume_review::<ReviewFixture, _>(
            database,
            DeploymentOperationKind::Deployment,
            &review.review_id,
            &review.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
        checkpoint_operation(
            database,
            &review.operation_id,
            &consumed.execution_token,
            "succeeded",
            true,
            &serde_json::json!({
                "phase": "succeeded",
                "completedAt": current_timestamp_ms(),
                "actions": [],
                "healthChecks": [{"checkId": "health", "status": "passed"}],
                "rollbackSnapshot": {
                    "strategy": "reactivatePreviousRelease",
                    "previousRelease": previous,
                    "newRelease": release,
                    "releasesDirectory": "/srv/app/releases",
                    "activeSymlink": "/srv/app/current",
                    "activationChanged": true,
                    "capturedAt": current_timestamp_ms()
                }
            }),
        )
        .unwrap();
    }

    fn rollback_identity<'a>(
        review: &'a ReviewFixture,
        source_operation_id: &'a str,
    ) -> ReviewIdentity<'a> {
        let mut identity = identity(review);
        identity.kind = DeploymentOperationKind::Rollback;
        identity.source_operation_id = Some(source_operation_id);
        identity
    }

    #[test]
    fn rollback_source_requires_a_previous_and_unconsumed_release() {
        let (_directory, database) = database();
        persist_successful_release(
            &database,
            "without-previous",
            "/srv/app/releases/release-first",
            None,
        );
        assert!(
            load_rollback_source(&database, "deployment:without-previous")
                .unwrap_err()
                .contains("no previous release")
        );

        persist_successful_release(
            &database,
            "already-consumed",
            "/srv/app/releases/release-new",
            Some("/srv/app/releases/release-old"),
        );
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE deployment_rollback_snapshots SET rollback_consumed_at=?2
                         WHERE operation_id=?1",
                        params!["deployment:already-consumed", current_timestamp_ms()],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(
            load_rollback_source(&database, "deployment:already-consumed")
                .unwrap_err()
                .contains("unconsumed")
        );
    }

    #[test]
    fn rollback_snapshot_reservation_is_exclusive_and_recoverable_after_restart() {
        let (_directory, database) = database();
        let source_operation_id = "deployment:rollback-source";
        persist_successful_release(
            &database,
            "rollback-source",
            "/srv/app/releases/release-new",
            Some("/srv/app/releases/release-old"),
        );

        let first = ReviewFixture {
            review_id: "rollback-review:first".into(),
            operation_id: "rollback:first".into(),
            normalized_runbook_text: "{}".into(),
        };
        let second = ReviewFixture {
            review_id: "rollback-review:second".into(),
            operation_id: "rollback:second".into(),
            normalized_runbook_text: "{}".into(),
        };
        store_review(
            &database,
            &rollback_identity(&first, source_operation_id),
            &first,
            &[],
        )
        .unwrap();
        store_review(
            &database,
            &rollback_identity(&second, source_operation_id),
            &second,
            &[],
        )
        .unwrap();
        let first_consumed = consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Rollback,
            &first.review_id,
            &first.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
        assert!(consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Rollback,
            &second.review_id,
            &second.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap_err()
        .contains("reserved"));

        checkpoint_operation(
            &database,
            &first.operation_id,
            &first_consumed.execution_token,
            "failed",
            true,
            &serde_json::json!({"phase": "failed", "actions": []}),
        )
        .unwrap();
        let second_consumed = consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Rollback,
            &second.review_id,
            &second.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
        checkpoint_operation(
            &database,
            &second.operation_id,
            &second_consumed.execution_token,
            "failed",
            true,
            &serde_json::json!({"phase": "failed", "actions": []}),
        )
        .unwrap();

        let interrupted = ReviewFixture {
            review_id: "rollback-review:interrupted".into(),
            operation_id: "rollback:interrupted".into(),
            normalized_runbook_text: "{}".into(),
        };
        store_review(
            &database,
            &rollback_identity(&interrupted, source_operation_id),
            &interrupted,
            &[],
        )
        .unwrap();
        consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Rollback,
            &interrupted.review_id,
            &interrupted.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
        assert_eq!(recover_interrupted_operations(&database).unwrap(), 1);

        let retry = ReviewFixture {
            review_id: "rollback-review:recovery-retry".into(),
            operation_id: "rollback:recovery-retry".into(),
            normalized_runbook_text: "{}".into(),
        };
        store_review(
            &database,
            &rollback_identity(&retry, source_operation_id),
            &retry,
            &[],
        )
        .unwrap();
        consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Rollback,
            &retry.review_id,
            &retry.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
    }

    #[test]
    fn cleanup_candidates_protect_current_rollback_and_active_run_references() {
        let (_directory, database) = database();
        let old_release = "/srv/app/releases/release-old";
        let new_release = "/srv/app/releases/release-new";
        persist_successful_release(&database, "release-old", old_release, None);
        persist_successful_release(&database, "release-new", new_release, Some(old_release));

        assert!(
            cleanup_candidates(&database, Some("sha256-v1:target"))
                .unwrap()
                .is_empty(),
            "old is a rollback target and new is current"
        );
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE deployment_rollback_snapshots SET rollback_consumed_at=?2
                         WHERE operation_id=?1",
                        params!["deployment:release-new", current_timestamp_ms()],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let candidates = cleanup_candidates(&database, Some("sha256-v1:target")).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].release_path, old_release);

        let active_review = ReviewFixture {
            review_id: "deployment-review:active".into(),
            operation_id: "deployment:active".into(),
            normalized_runbook_text: "{\"schemaVersion\":2}".into(),
        };
        store_review(&database, &identity(&active_review), &active_review, &[]).unwrap();
        consume_review::<ReviewFixture, _>(
            &database,
            DeploymentOperationKind::Deployment,
            &active_review.review_id,
            &active_review.operation_id,
            &serde_json::json!({"authorized": true}),
        )
        .unwrap();
        assert!(cleanup_candidates(&database, Some("sha256-v1:target"))
            .unwrap()
            .is_empty());
        recover_interrupted_operations(&database).unwrap();
        assert!(
            cleanup_candidates(&database, Some("sha256-v1:target"))
                .unwrap()
                .is_empty(),
            "recovery-required target remains protected"
        );
    }
}
