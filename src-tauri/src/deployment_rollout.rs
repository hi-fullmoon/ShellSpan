//! Deterministic multi-host canary/rolling coordinator for Deployment Runbook v2.
//!
//! Target work is delegated exclusively to `deployment_execution`; this module
//! owns only frozen ordering, batch approvals, bounded parallel scheduling,
//! circuit breaking, durable coordination state, and restart recovery.

use crate::deployment_execution::{
    execute_deployment_for_request, review_deployment_execution_for_request,
    DeploymentExecutionApprovalV2, DeploymentExecutionPolicyV2, DeploymentExecutionRegistry,
    DeploymentExecutionRequestV2, DeploymentExecutionResultV2, DeploymentExecutionReviewRequestV2,
    DeploymentExecutionReviewV2,
};
use crate::execution::{valid_operation_id, ExecutionCancellationRegistry};
use crate::keychain::CredentialManager;
use crate::models::RemoteConnectionRequest;
use crate::runbook::RunbookRisk;
use crate::sftp_pool::SftpPool;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

const REVIEW_TTL_MS: i64 = 10 * 60 * 1_000;
const MAX_TARGETS: usize = 500;
const MAX_BATCH_SIZE: usize = 100;
const MAX_PARALLEL: usize = 32;

fn now_ms() -> i64 {
    crate::db::current_timestamp_ms()
}

fn sqlite_usize(value: usize) -> i64 {
    i64::try_from(value).expect("deployment rollout integer is bounded")
}

fn usize_from_row(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<usize> {
    let value = row.get::<_, i64>(index)?;
    usize::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn optional_usize_from_row(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<usize>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            usize::try_from(value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Integer,
                    Box::new(error),
                )
            })
        })
        .transpose()
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

fn json_digest<T: Serialize>(domain: &str, value: &T) -> Result<String, String> {
    let json = serde_json::to_vec(value)
        .map_err(|error| format!("failed to serialize rollout digest material: {error}"))?;
    Ok(digest(domain, &json))
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum CanaryModeV2 {
    Count,
    Percentage,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentRolloutCanaryV2 {
    mode: CanaryModeV2,
    value: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRolloutPolicyV2 {
    strategy: String,
    canary: DeploymentRolloutCanaryV2,
    batch_size: u16,
    max_parallel: u16,
    require_batch_approval: bool,
    min_healthy_percent: u8,
    max_failures_per_batch: u16,
    stop_policy: String,
    rollback_suggestion: String,
}

impl DeploymentRolloutPolicyV2 {
    fn validate(&self, target_count: usize) -> Result<usize, String> {
        if self.strategy != "canaryRolling" {
            return Err("deployment rollout strategy must be canaryRolling".into());
        }
        if self.stop_policy != "pause" {
            return Err("deployment rollout stopPolicy must be pause".into());
        }
        if !self.require_batch_approval {
            return Err("deployment rollout phase 4 requires an approval between batches".into());
        }
        if !matches!(
            self.rollback_suggestion.as_str(),
            "none" | "successfulTargets"
        ) {
            return Err("deployment rollout rollbackSuggestion is invalid".into());
        }
        if self.batch_size == 0 || self.batch_size as usize > MAX_BATCH_SIZE {
            return Err("deployment rollout batchSize must be from 1 to 100".into());
        }
        if self.max_parallel == 0
            || self.max_parallel as usize > MAX_PARALLEL
            || self.max_parallel > self.batch_size
        {
            return Err("deployment rollout maxParallel exceeds its bounded batch limit".into());
        }
        if self.min_healthy_percent == 0 || self.min_healthy_percent > 100 {
            return Err("deployment rollout minHealthyPercent must be from 1 to 100".into());
        }
        if self.max_failures_per_batch > self.batch_size {
            return Err("deployment rollout maxFailuresPerBatch exceeds batchSize".into());
        }
        let canary = match self.canary.mode {
            CanaryModeV2::Count => {
                if self.canary.value == 0 || self.canary.value as usize >= target_count {
                    return Err("deployment rollout canary count must leave rolling targets".into());
                }
                self.canary.value as usize
            }
            CanaryModeV2::Percentage => {
                if self.canary.value == 0 || self.canary.value >= 100 {
                    return Err("deployment rollout canary percentage must be from 1 to 99".into());
                }
                ((target_count * self.canary.value as usize).div_ceil(100))
                    .clamp(1, target_count - 1)
            }
        };
        Ok(canary)
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentRolloutTargetRequestV2 {
    profile_id: String,
    environment: String,
    connection: RemoteConnectionRequest,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRolloutReviewRequestV2 {
    rollout_id: String,
    runbook_text: String,
    profile_ids: Vec<String>,
    targets: Vec<DeploymentRolloutTargetRequestV2>,
    policy: DeploymentRolloutPolicyV2,
    deployment_policy: DeploymentExecutionPolicyV2,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DeploymentRolloutBatchKindV2 {
    Canary,
    Rolling,
}

impl DeploymentRolloutBatchKindV2 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Canary => "canary",
            Self::Rolling => "rolling",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentRolloutBatchPlanV2 {
    batch_index: usize,
    kind: DeploymentRolloutBatchKindV2,
    profile_ids: Vec<String>,
    target_indexes: Vec<usize>,
    required_healthy: usize,
    maximum_failures: usize,
    approval_required: bool,
    batch_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentRolloutReviewedTargetV2 {
    target_index: usize,
    batch_index: usize,
    profile_id: String,
    environment: String,
    operation_id: String,
    target: crate::execution::FrozenTargetIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    deployment_review: Option<DeploymentExecutionReviewV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_operation_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRolloutReviewV2 {
    schema_version: u8,
    rollout_id: String,
    review_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_of_review_id: Option<String>,
    normalized_runbook_text: String,
    document_digest: String,
    plan_digest: String,
    deployment_id: String,
    application_id: String,
    environment: String,
    version: String,
    declared_risk: RunbookRisk,
    policy: DeploymentRolloutPolicyV2,
    deployment_policy: DeploymentExecutionPolicyV2,
    profile_ids: Vec<String>,
    targets: Vec<DeploymentRolloutReviewedTargetV2>,
    batches: Vec<DeploymentRolloutBatchPlanV2>,
    reviewed_at: i64,
    expires_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentRolloutTargetApprovalV2 {
    profile_id: String,
    batch_index: usize,
    target_index: usize,
    #[serde(flatten)]
    approval: DeploymentExecutionApprovalV2,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentRolloutBatchApprovalV2 {
    rollout_id: String,
    rollout_review_id: String,
    rollout_plan_digest: String,
    batch_index: usize,
    batch_digest: String,
    target_approvals: Vec<DeploymentRolloutTargetApprovalV2>,
    authorized: bool,
    destructive_confirmed: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentRolloutTargetConnectionV2 {
    profile_id: String,
    connection: RemoteConnectionRequest,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRolloutStartRequestV2 {
    rollout_id: String,
    review_id: String,
    plan_digest: String,
    batch_approval: DeploymentRolloutBatchApprovalV2,
    connections: Vec<DeploymentRolloutTargetConnectionV2>,
}

type DeploymentRolloutApproveBatchRequestV2 = DeploymentRolloutStartRequestV2;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRolloutCancelRequestV2 {
    rollout_id: String,
    review_id: String,
    plan_digest: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRolloutRecoverRequestV2 {
    source_review_id: String,
    rollout_id: String,
    runbook_text: String,
    profile_ids: Vec<String>,
    targets: Vec<DeploymentRolloutTargetRequestV2>,
    policy: DeploymentRolloutPolicyV2,
    deployment_policy: DeploymentExecutionPolicyV2,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRolloutListRequestV2 {
    #[serde(default)]
    phase: Option<String>,
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
pub(crate) struct DeploymentRolloutSummaryV2 {
    rollout_id: String,
    review_id: String,
    plan_digest: String,
    deployment_id: String,
    application_id: String,
    environment: String,
    version: String,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_batch_index: Option<usize>,
    circuit_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    circuit_reason: Option<String>,
    recovery_required: bool,
    total_targets: usize,
    succeeded_targets: usize,
    failed_targets: usize,
    not_started_targets: usize,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentRolloutHealthSummaryV2 {
    total: usize,
    healthy: usize,
    failed: usize,
    healthy_percent: usize,
    threshold_met: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentRolloutBatchStateV2 {
    #[serde(flatten)]
    plan: DeploymentRolloutBatchPlanV2,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_review_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_consumed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<i64>,
    health: DeploymentRolloutHealthSummaryV2,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentRolloutTargetStateV2 {
    #[serde(flatten)]
    reviewed: DeploymentRolloutReviewedTargetV2,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<i64>,
    recovery_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentRolloutRollbackSuggestionV2 {
    profile_id: String,
    target_digest: String,
    source_operation_id: String,
    reason: &'static str,
    requires_separate_approval: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRolloutDetailV2 {
    #[serde(flatten)]
    summary: DeploymentRolloutSummaryV2,
    review: DeploymentRolloutReviewV2,
    policy: DeploymentRolloutPolicyV2,
    batches: Vec<DeploymentRolloutBatchStateV2>,
    targets: Vec<DeploymentRolloutTargetStateV2>,
    rollback_suggestions: Vec<DeploymentRolloutRollbackSuggestionV2>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRolloutBatchExecutionResultV2 {
    schema_version: u8,
    rollout_id: String,
    rollout_review_id: String,
    rollout_plan_digest: String,
    batch_index: usize,
    batch_digest: String,
    phase: String,
    circuit_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    circuit_reason: Option<String>,
    target_results: Vec<serde_json::Value>,
    detail: DeploymentRolloutDetailV2,
}

#[derive(Default)]
struct RolloutRegistryInner {
    active: HashMap<String, (Arc<AtomicBool>, Vec<String>)>,
}

#[derive(Clone, Default)]
pub(crate) struct DeploymentRolloutRegistry {
    inner: Arc<Mutex<RolloutRegistryInner>>,
}

impl DeploymentRolloutRegistry {
    fn start(&self, rollout_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "deployment rollout registry is unavailable".to_string())?;
        if inner.active.contains_key(rollout_id) {
            return Err("deployment rollout is already active".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        inner
            .active
            .insert(rollout_id.to_string(), (Arc::clone(&cancelled), Vec::new()));
        Ok(cancelled)
    }

    fn set_operations(&self, rollout_id: &str, operation_ids: Vec<String>) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "deployment rollout registry is unavailable".to_string())?;
        let active = inner
            .active
            .get_mut(rollout_id)
            .ok_or_else(|| "deployment rollout is not active".to_string())?;
        active.1 = operation_ids;
        Ok(())
    }

    fn cancel(&self, rollout_id: &str) -> Result<Vec<String>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "deployment rollout registry is unavailable".to_string())?;
        let (flag, operation_ids) = inner
            .active
            .get(rollout_id)
            .ok_or_else(|| "deployment rollout is not active".to_string())?;
        flag.store(true, Ordering::SeqCst);
        Ok(operation_ids.clone())
    }

    fn finish(&self, rollout_id: &str, expected: &Arc<AtomicBool>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner
            .active
            .get(rollout_id)
            .is_some_and(|(current, _)| Arc::ptr_eq(current, expected))
        {
            inner.active.remove(rollout_id);
        }
    }
}

struct RolloutGuard<'a> {
    registry: &'a DeploymentRolloutRegistry,
    rollout_id: &'a str,
    cancelled: Arc<AtomicBool>,
}

impl Drop for RolloutGuard<'_> {
    fn drop(&mut self) {
        self.registry.finish(self.rollout_id, &self.cancelled);
    }
}

fn normalize_batches(
    profile_ids: &[String],
    policy: &DeploymentRolloutPolicyV2,
) -> Result<Vec<DeploymentRolloutBatchPlanV2>, String> {
    let canary = policy.validate(profile_ids.len())?;
    let mut batches = Vec::new();
    let mut start = 0;
    while start < profile_ids.len() {
        let batch_index = batches.len();
        let size = if batch_index == 0 {
            canary
        } else {
            policy.batch_size as usize
        };
        let end = (start + size).min(profile_ids.len());
        let kind = if batch_index == 0 {
            DeploymentRolloutBatchKindV2::Canary
        } else {
            DeploymentRolloutBatchKindV2::Rolling
        };
        let required_healthy = if kind == DeploymentRolloutBatchKindV2::Canary {
            end - start
        } else {
            ((end - start) * policy.min_healthy_percent as usize).div_ceil(100)
        };
        let maximum_failures = if kind == DeploymentRolloutBatchKindV2::Canary {
            0
        } else {
            (policy.max_failures_per_batch as usize).min(end - start)
        };
        let mut batch = DeploymentRolloutBatchPlanV2 {
            batch_index,
            kind,
            profile_ids: profile_ids[start..end].to_vec(),
            target_indexes: (start..end).collect(),
            required_healthy,
            maximum_failures,
            approval_required: true,
            batch_digest: String::new(),
        };
        batch.batch_digest = json_digest(
            "termbridge-deployment-rollout-batch",
            &serde_json::json!({
                "batchIndex": batch.batch_index,
                "kind": batch.kind,
                "profileIds": batch.profile_ids,
                "targetIndexes": batch.target_indexes,
                "requiredHealthy": batch.required_healthy,
                "maximumFailures": batch.maximum_failures,
                "approvalRequired": batch.approval_required,
            }),
        )?;
        batches.push(batch);
        start = end;
    }
    Ok(batches)
}

fn child_operation_id(rollout_id: &str, target_index: usize, recovery: bool) -> String {
    let material = if recovery {
        format!(
            "{rollout_id}:recovery:{}:{target_index}",
            uuid::Uuid::new_v4()
        )
    } else {
        format!("{rollout_id}:{target_index}")
    };
    let hash = digest("termbridge-deployment-rollout-child", material.as_bytes());
    format!("deployment-rollout:{}:{target_index}", &hash[10..34])
}

fn validate_review_request(request: &DeploymentRolloutReviewRequestV2) -> Result<(), String> {
    if !valid_operation_id(&request.rollout_id) {
        return Err("deployment rollout identity is invalid".into());
    }
    if request.profile_ids.len() < 2 || request.profile_ids.len() > MAX_TARGETS {
        return Err("deployment rollout requires from 2 to 500 explicit profile IDs".into());
    }
    if request.targets.len() != request.profile_ids.len() {
        return Err("deployment rollout targets must map one-to-one to profileIds".into());
    }
    request.policy.validate(request.profile_ids.len())?;
    let mut profiles = HashSet::new();
    let mut hosts = HashSet::new();
    for (index, (profile_id, target)) in request
        .profile_ids
        .iter()
        .zip(request.targets.iter())
        .enumerate()
    {
        if profile_id != &target.profile_id || !valid_operation_id(profile_id) {
            return Err(format!(
                "deployment rollout target order differs at index {index}"
            ));
        }
        if !profiles.insert(profile_id) {
            return Err(format!(
                "deployment rollout duplicates profile {profile_id}"
            ));
        }
        let host = (
            target.connection.host.clone(),
            target.connection.port,
            target.connection.username.clone(),
        );
        if !hosts.insert(host) {
            return Err(format!(
                "deployment rollout duplicates a host at index {index}"
            ));
        }
    }
    Ok(())
}

fn store_rollout_review(
    database: &crate::db::Database,
    review: &DeploymentRolloutReviewV2,
) -> Result<(), String> {
    let json = serde_json::to_string(review)
        .map_err(|error| format!("failed to serialize deployment rollout review: {error}"))?;
    if json.contains("\"connection\"") || json.contains("\"password\"") {
        return Err("deployment rollout review must not persist connection credentials".into());
    }
    database.with_connection(|connection| {
        connection
            .execute(
                "INSERT INTO deployment_rollout_reviews
                 (review_id, rollout_id, recovery_of_review_id, document_digest, plan_digest,
                  environment, review_json, state, reviewed_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)",
                params![
                    review.review_id,
                    review.rollout_id,
                    review.recovery_of_review_id,
                    review.document_digest,
                    review.plan_digest,
                    review.environment,
                    json,
                    review.reviewed_at,
                    review.expires_at,
                ],
            )
            .map_err(|error| format!("failed to persist deployment rollout review: {error}"))?;
        Ok(())
    })
}

fn build_rollout_review(
    database: &crate::db::Database,
    request: DeploymentRolloutReviewRequestV2,
    recovery_of_review_id: Option<String>,
    completed: &HashMap<String, String>,
) -> Result<DeploymentRolloutReviewV2, String> {
    validate_review_request(&request)?;
    let batches = normalize_batches(&request.profile_ids, &request.policy)?;
    let mut targets = Vec::with_capacity(request.targets.len());
    let mut canonical_text: Option<String> = None;
    let mut document_digest: Option<String> = None;
    let mut deployment_id: Option<String> = None;
    let mut application_id: Option<String> = None;
    let mut environment: Option<String> = None;
    let mut version: Option<String> = None;
    let mut declared_risk: Option<RunbookRisk> = None;
    for (index, target_request) in request.targets.iter().enumerate() {
        let batch_index = batches
            .iter()
            .find(|batch| batch.target_indexes.contains(&index))
            .expect("normalized batch contains every target")
            .batch_index;
        if let Some(operation_id) = completed.get(&target_request.profile_id) {
            let frozen = crate::execution::FrozenTargetIdentity::from_connection(
                target_request.profile_id.clone(),
                &target_request.connection,
            )
            .map_err(|error| error.message.to_string())?;
            crate::execution::revalidate_frozen_target_identity(
                database,
                &frozen,
                &target_request.connection,
            )
            .map_err(|error| error.message)?;
            targets.push(DeploymentRolloutReviewedTargetV2 {
                target_index: index,
                batch_index,
                profile_id: target_request.profile_id.clone(),
                environment: target_request.environment.clone(),
                operation_id: operation_id.clone(),
                target: frozen,
                deployment_review: None,
                completed_operation_id: Some(operation_id.clone()),
            });
            continue;
        }
        let child = review_deployment_execution_for_request(
            database,
            DeploymentExecutionReviewRequestV2 {
                operation_id: child_operation_id(
                    &request.rollout_id,
                    index,
                    recovery_of_review_id.is_some(),
                ),
                runbook_text: request.runbook_text.clone(),
                profile_id: target_request.profile_id.clone(),
                connection: target_request.connection.clone(),
                policy: request.deployment_policy.clone(),
            },
        )?;
        if target_request.environment != child.environment {
            return Err(format!(
                "deployment rollout target {} mixes environment {} with {}",
                target_request.profile_id, target_request.environment, child.environment
            ));
        }
        if let Some(expected) = canonical_text.as_deref() {
            if expected != child.normalized_runbook_text {
                return Err("deployment rollout child document normalization drifted".into());
            }
        } else {
            canonical_text = Some(child.normalized_runbook_text.clone());
            document_digest = Some(child.document_digest.clone());
            deployment_id = Some(child.deployment_id.clone());
            application_id = Some(child.application_id.clone());
            environment = Some(child.environment.clone());
            version = Some(child.version.clone());
            declared_risk = Some(child.declared_risk);
        }
        targets.push(DeploymentRolloutReviewedTargetV2 {
            target_index: index,
            batch_index,
            profile_id: target_request.profile_id.clone(),
            environment: target_request.environment.clone(),
            operation_id: child.operation_id.clone(),
            target: child.target.clone(),
            deployment_review: Some(child),
            completed_operation_id: None,
        });
    }
    // A recovery may have completed every target; take canonical deployment
    // identity from the source review in that case before reaching this helper.
    let normalized_runbook_text = canonical_text
        .ok_or_else(|| "deployment rollout has no unfinished target to review".to_string())?;
    let reviewed_at = now_ms();
    let mut review = DeploymentRolloutReviewV2 {
        schema_version: 2,
        rollout_id: request.rollout_id,
        review_id: format!("deployment-rollout-review:{}", uuid::Uuid::new_v4()),
        recovery_of_review_id,
        normalized_runbook_text,
        document_digest: document_digest.unwrap(),
        plan_digest: String::new(),
        deployment_id: deployment_id.unwrap(),
        application_id: application_id.unwrap(),
        environment: environment.unwrap(),
        version: version.unwrap(),
        declared_risk: declared_risk.unwrap(),
        policy: request.policy,
        deployment_policy: request.deployment_policy,
        profile_ids: request.profile_ids,
        targets,
        batches,
        reviewed_at,
        expires_at: reviewed_at + REVIEW_TTL_MS,
    };
    review.expires_at = review
        .targets
        .iter()
        .filter_map(|target| {
            target
                .deployment_review
                .as_ref()
                .map(|child| child.expires_at)
        })
        .min()
        .unwrap_or(review.expires_at)
        .min(review.expires_at);
    review.plan_digest = json_digest(
        "termbridge-deployment-rollout-plan",
        &serde_json::json!({
            "schemaVersion": review.schema_version,
            "rolloutId": review.rollout_id,
            "documentDigest": review.document_digest,
            "deploymentId": review.deployment_id,
            "applicationId": review.application_id,
            "environment": review.environment,
            "version": review.version,
            "declaredRisk": review.declared_risk,
            "policy": review.policy,
            "deploymentPolicy": review.deployment_policy,
            "profileIds": review.profile_ids,
            "targets": review.targets,
            "batches": review.batches,
        }),
    )?;
    Ok(review)
}

#[tauri::command]
pub(crate) fn review_deployment_rollout(
    database: State<'_, crate::db::Database>,
    request: DeploymentRolloutReviewRequestV2,
) -> Result<DeploymentRolloutReviewV2, String> {
    let review = build_rollout_review(&database, request, None, &HashMap::new())?;
    store_rollout_review(&database, &review)?;
    Ok(review)
}

fn load_rollout_review(
    database: &crate::db::Database,
    rollout_id: &str,
    review_id: &str,
) -> Result<DeploymentRolloutReviewV2, String> {
    database.with_connection(|connection| {
        let json = connection
            .query_row(
                "SELECT review_json FROM deployment_rollout_reviews
                 WHERE rollout_id=?1 AND review_id=?2",
                params![rollout_id, review_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("failed to load deployment rollout review: {error}"))?
            .ok_or_else(|| "deployment rollout review was not found".to_string())?;
        serde_json::from_str(&json)
            .map_err(|error| format!("persisted deployment rollout review is invalid: {error}"))
    })
}

fn approval_matches(
    review: &DeploymentRolloutReviewV2,
    approval: &DeploymentRolloutBatchApprovalV2,
) -> bool {
    let Some(batch) = review.batches.get(approval.batch_index) else {
        return false;
    };
    if !approval.authorized
        || approval.rollout_id != review.rollout_id
        || approval.rollout_review_id != review.review_id
        || approval.rollout_plan_digest != review.plan_digest
        || approval.batch_digest != batch.batch_digest
    {
        return false;
    }
    let pending_indexes = batch
        .target_indexes
        .iter()
        .filter(|target_index| review.targets[**target_index].deployment_review.is_some())
        .copied()
        .collect::<Vec<_>>();
    if approval.target_approvals.len() != pending_indexes.len() {
        return false;
    }
    pending_indexes
        .iter()
        .zip(approval.target_approvals.iter())
        .all(|(target_index, target_approval)| {
            let Some(target) = review.targets.get(*target_index) else {
                return false;
            };
            let Some(child) = target.deployment_review.as_ref() else {
                return false;
            };
            target_approval.profile_id == target.profile_id
                && target_approval.batch_index == batch.batch_index
                && target_approval.target_index == *target_index
                && target_approval.approval.review_id == child.review_id
                && target_approval.approval.operation_id == child.operation_id
                && target_approval.approval.document_digest == child.document_digest
                && target_approval.approval.plan_digest == child.plan_digest
                && target_approval.approval.target_digest == child.target.identity_digest
                && target_approval.approval.approved_risk == child.declared_risk
                && target_approval.approval.authorized
                && target_approval.approval.destructive_confirmed == approval.destructive_confirmed
        })
}

fn connections_for_batch(
    review: &DeploymentRolloutReviewV2,
    batch_index: usize,
    connections: Vec<DeploymentRolloutTargetConnectionV2>,
) -> Result<HashMap<String, RemoteConnectionRequest>, String> {
    let batch = review
        .batches
        .get(batch_index)
        .ok_or_else(|| "deployment rollout batch does not exist".to_string())?;
    let pending_profile_ids = batch
        .target_indexes
        .iter()
        .filter_map(|index| {
            review.targets[*index]
                .deployment_review
                .as_ref()
                .map(|_| review.targets[*index].profile_id.as_str())
        })
        .collect::<Vec<_>>();
    if connections.len() != pending_profile_ids.len() {
        return Err("deployment rollout connections must match the exact batch".into());
    }
    let mut mapped = HashMap::new();
    for connection in connections {
        if mapped
            .insert(connection.profile_id.clone(), connection.connection)
            .is_some()
        {
            return Err("deployment rollout connection profile is duplicated".into());
        }
    }
    if pending_profile_ids
        .iter()
        .any(|profile_id| !mapped.contains_key(*profile_id))
    {
        return Err("deployment rollout connection order or membership drifted".into());
    }
    Ok(mapped)
}

fn revalidate_batch_connections(
    database: &crate::db::Database,
    review: &DeploymentRolloutReviewV2,
    batch_index: usize,
    connections: &HashMap<String, RemoteConnectionRequest>,
) -> Result<(), String> {
    let batch = review
        .batches
        .get(batch_index)
        .ok_or_else(|| "deployment rollout batch does not exist".to_string())?;
    for target_index in &batch.target_indexes {
        let target = &review.targets[*target_index];
        if target.deployment_review.is_none() {
            continue;
        }
        let connection = connections
            .get(&target.profile_id)
            .ok_or_else(|| "deployment rollout target connection is missing".to_string())?;
        crate::execution::revalidate_frozen_target_identity(database, &target.target, connection)
            .map_err(|error| error.message)?;
    }
    Ok(())
}

fn scrub_persisted_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => values.iter_mut().for_each(scrub_persisted_value),
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
            object.values_mut().for_each(scrub_persisted_value);
        }
        _ => {}
    }
}

fn create_rollout_state(
    database: &crate::db::Database,
    review: &DeploymentRolloutReviewV2,
    approval: &DeploymentRolloutBatchApprovalV2,
) -> Result<(), String> {
    let now = now_ms();
    let approval_digest = json_digest("termbridge-deployment-rollout-approval", approval)?;
    database.with_transaction(|transaction| {
        let state = transaction
            .query_row(
                "SELECT state, expires_at FROM deployment_rollout_reviews WHERE review_id=?1",
                params![review.review_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|error| format!("failed to validate deployment rollout review: {error}"))?
            .ok_or_else(|| "deployment rollout review was not found".to_string())?;
        if state.0 != "pending" || state.1 <= now {
            return Err("deployment rollout review is consumed or expired".into());
        }
        if review.recovery_of_review_id.is_some() {
            let recovery_required: Option<bool> = transaction
                .query_row(
                    "SELECT recovery_required FROM deployment_rollouts WHERE rollout_id=?1",
                    params![review.rollout_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("failed to validate rollout recovery state: {error}"))?;
            if recovery_required != Some(true) {
                return Err("deployment rollout recovery source is not recoveryRequired".into());
            }
            transaction
                .execute(
                    "UPDATE deployment_rollouts SET review_id=?2, plan_digest=?3,
                     phase='running', current_batch_index=?4, circuit_open=0,
                     circuit_reason=NULL, recovery_required=0, cancellation_requested=0,
                     updated_at=?5 WHERE rollout_id=?1",
                    params![review.rollout_id, review.review_id, review.plan_digest, sqlite_usize(approval.batch_index), now],
                )
                .map_err(|error| format!("failed to start recovered deployment rollout: {error}"))?;
            transaction
                .execute("DELETE FROM deployment_rollout_batches WHERE rollout_id=?1", params![review.rollout_id])
                .map_err(|error| format!("failed to replace recovered rollout batches: {error}"))?;
            transaction
                .execute("DELETE FROM deployment_rollout_targets WHERE rollout_id=?1 AND status<>'succeeded'", params![review.rollout_id])
                .map_err(|error| format!("failed to replace recovered rollout targets: {error}"))?;
        } else {
            transaction
                .execute(
                    "INSERT INTO deployment_rollouts
                     (rollout_id, review_id, plan_digest, document_digest, deployment_id,
                      application_id, environment, version, phase, current_batch_index,
                      circuit_open, recovery_required, cancellation_requested, detail_json,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running', ?9,
                             0, 0, 0, '{}', ?10, ?10)",
                    params![
                        review.rollout_id,
                        review.review_id,
                        review.plan_digest,
                        review.document_digest,
                        review.deployment_id,
                        review.application_id,
                        review.environment,
                        review.version,
                        sqlite_usize(approval.batch_index),
                        now,
                    ],
                )
                .map_err(|error| format!("failed to create deployment rollout: {error}"))?;
        }
        for batch in &review.batches {
            let completed_count = batch
                .target_indexes
                .iter()
                .filter(|index| review.targets[**index].completed_operation_id.is_some())
                .count();
            let completed = completed_count == batch.target_indexes.len();
            let status = if completed {
                "succeeded"
            } else if batch.batch_index == approval.batch_index {
                "running"
            } else {
                "pending"
            };
            transaction
                .execute(
                    "INSERT INTO deployment_rollout_batches
                     (rollout_id, batch_index, batch_digest, batch_kind, status, target_count,
                      required_healthy, maximum_failures, healthy_count, failed_count,
                      approval_review_id, approval_consumed_at, started_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?11)",
                    params![
                        review.rollout_id,
                        sqlite_usize(batch.batch_index),
                        batch.batch_digest,
                        batch.kind.as_str(),
                        status,
                        sqlite_usize(batch.target_indexes.len()),
                        sqlite_usize(batch.required_healthy),
                        sqlite_usize(batch.maximum_failures),
                        sqlite_usize(completed_count),
                        (batch.batch_index == approval.batch_index).then_some(review.review_id.as_str()),
                        (batch.batch_index == approval.batch_index).then_some(now),
                    ],
                )
                .map_err(|error| format!("failed to persist deployment rollout batch: {error}"))?;
        }
        for target in &review.targets {
            if target.completed_operation_id.is_some() {
                continue;
            }
            transaction
                .execute(
                    "INSERT INTO deployment_rollout_targets
                     (rollout_id, target_index, batch_index, profile_id, target_digest,
                      operation_id, deployment_review_id, status, recovery_required)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'notStarted', 0)",
                    params![
                        review.rollout_id,
                        sqlite_usize(target.target_index),
                        sqlite_usize(target.batch_index),
                        target.profile_id,
                        target.target.identity_digest,
                        target.operation_id,
                        target.deployment_review.as_ref().map(|child| child.review_id.as_str()),
                    ],
                )
                .map_err(|error| format!("failed to persist deployment rollout target: {error}"))?;
        }
        transaction
            .execute(
                "UPDATE deployment_rollout_reviews SET state='consumed', consumed_at=?2
                 WHERE review_id=?1 AND state='pending'",
                params![review.review_id, now],
            )
            .map_err(|error| format!("failed to consume deployment rollout review: {error}"))?;
        transaction
            .execute(
                "INSERT INTO deployment_rollout_approval_consumptions
                 (rollout_review_id, rollout_id, batch_index, batch_digest,
                  approval_digest, consumed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    review.review_id,
                    review.rollout_id,
                    sqlite_usize(approval.batch_index),
                    approval.batch_digest,
                    approval_digest,
                    now,
                ],
            )
            .map_err(|error| format!("failed to consume deployment rollout approval: {error}"))?;
        Ok(())
    })
}

fn consume_next_batch_approval(
    database: &crate::db::Database,
    review: &DeploymentRolloutReviewV2,
    approval: &DeploymentRolloutBatchApprovalV2,
) -> Result<(), String> {
    let now = now_ms();
    let approval_digest = json_digest("termbridge-deployment-rollout-approval", approval)?;
    database.with_transaction(|transaction| {
        let state = transaction
            .query_row(
                "SELECT phase, current_batch_index, circuit_open, recovery_required,
                        cancellation_requested, review_id, plan_digest
                 FROM deployment_rollouts WHERE rollout_id=?1",
                params![review.rollout_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        optional_usize_from_row(row, 1)?,
                        row.get::<_, bool>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, bool>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .map_err(|error| format!("failed to load deployment rollout gate: {error}"))?;
        if state.0 != "awaitingBatchApproval"
            || state.1 != Some(approval.batch_index)
            || state.2
            || state.3
            || state.4
            || state.5 != review.review_id
            || state.6 != review.plan_digest
        {
            return Err("deployment rollout is not at the exact approved batch gate".into());
        }
        transaction
            .execute(
                "INSERT INTO deployment_rollout_approval_consumptions
                 (rollout_review_id, rollout_id, batch_index, batch_digest,
                  approval_digest, consumed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    review.review_id,
                    review.rollout_id,
                    sqlite_usize(approval.batch_index),
                    approval.batch_digest,
                    approval_digest,
                    now,
                ],
            )
            .map_err(|error| {
                format!("deployment rollout batch approval was already consumed: {error}")
            })?;
        transaction
            .execute(
                "UPDATE deployment_rollouts SET phase='running', updated_at=?2 WHERE rollout_id=?1",
                params![review.rollout_id, now],
            )
            .map_err(|error| format!("failed to advance deployment rollout gate: {error}"))?;
        transaction
            .execute(
                "UPDATE deployment_rollout_batches SET status='running', approval_review_id=?3,
                 approval_consumed_at=?4, started_at=?4
                 WHERE rollout_id=?1 AND batch_index=?2 AND status='awaitingApproval'",
                params![
                    review.rollout_id,
                    sqlite_usize(approval.batch_index),
                    review.review_id,
                    now
                ],
            )
            .map_err(|error| format!("failed to advance deployment rollout batch: {error}"))?;
        Ok(())
    })
}

fn result_succeeded(value: &serde_json::Value) -> bool {
    value.get("phase").and_then(serde_json::Value::as_str) == Some("succeeded")
        && value
            .get("healthChecks")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|checks| {
                !checks.is_empty()
                    && checks.iter().all(|check| {
                        check.get("status").and_then(serde_json::Value::as_str) == Some("passed")
                    })
            })
}

fn persist_target_result(
    database: &crate::db::Database,
    rollout_id: &str,
    target_index: usize,
    result: Result<DeploymentExecutionResultV2, String>,
) -> Result<Option<serde_json::Value>, String> {
    let now = now_ms();
    let (status, mut persisted, error_category, error, returned) = match result {
        Ok(result) => {
            let returned = serde_json::to_value(&result).map_err(|error| {
                format!("failed to serialize deployment target result: {error}")
            })?;
            let success = result_succeeded(&returned);
            let mut persisted = returned.clone();
            scrub_persisted_value(&mut persisted);
            let error_category = returned
                .get("errorCategory")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let error = returned
                .get("error")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            (
                if success { "succeeded" } else { "failed" },
                Some(persisted),
                error_category,
                error,
                Some(returned),
            )
        }
        Err(error) => (
            "failed",
            None,
            Some("deployment".to_string()),
            Some(error),
            None,
        ),
    };
    let persisted_json = persisted
        .take()
        .map(|value| serde_json::to_string(&value))
        .transpose()
        .map_err(|error| format!("failed to encode deployment target checkpoint: {error}"))?;
    database.with_connection(|connection| {
        connection
            .execute(
                "UPDATE deployment_rollout_targets SET status=?3, result_json=?4,
                 error_category=?5, error=?6, completed_at=?7
                 WHERE rollout_id=?1 AND target_index=?2 AND status='running'",
                params![
                    rollout_id,
                    sqlite_usize(target_index),
                    status,
                    persisted_json,
                    error_category,
                    error,
                    now,
                ],
            )
            .map_err(|error| {
                format!("failed to persist deployment rollout target result: {error}")
            })?;
        Ok(())
    })?;
    Ok(returned)
}

fn batch_counts(
    database: &crate::db::Database,
    rollout_id: &str,
    batch_index: usize,
) -> Result<(usize, usize, usize), String> {
    database.with_connection(|connection| {
        connection
            .query_row(
                "SELECT COUNT(*),
                        SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN status IN ('failed','cancelled','interrupted') THEN 1 ELSE 0 END)
                 FROM deployment_rollout_targets WHERE rollout_id=?1 AND batch_index=?2",
                params![rollout_id, sqlite_usize(batch_index)],
                |row| {
                    Ok((
                        usize_from_row(row, 0)?,
                        usize_from_row(row, 1)?,
                        usize_from_row(row, 2)?,
                    ))
                },
            )
            .map_err(|error| format!("failed to summarize deployment rollout batch: {error}"))
    })
}

fn stop_rollout(
    database: &crate::db::Database,
    rollout_id: &str,
    batch_index: usize,
    reason: &str,
) -> Result<(), String> {
    let now = now_ms();
    let (_, healthy, failed) = batch_counts(database, rollout_id, batch_index)?;
    database.with_transaction(|transaction| {
        transaction
            .execute(
                "UPDATE deployment_rollout_batches SET status='failed', healthy_count=?3,
                 failed_count=?4, completed_at=?5
                 WHERE rollout_id=?1 AND batch_index=?2",
                params![
                    rollout_id,
                    sqlite_usize(batch_index),
                    sqlite_usize(healthy),
                    sqlite_usize(failed),
                    now
                ],
            )
            .map_err(|error| format!("failed to stop deployment rollout batch: {error}"))?;
        transaction
            .execute(
                "UPDATE deployment_rollouts SET phase='paused', circuit_open=1,
                 circuit_reason=?2, updated_at=?3 WHERE rollout_id=?1",
                params![rollout_id, reason, now],
            )
            .map_err(|error| format!("failed to trip deployment rollout circuit: {error}"))?;
        Ok(())
    })
}

fn advance_after_batch(
    database: &crate::db::Database,
    review: &DeploymentRolloutReviewV2,
    batch_index: usize,
) -> Result<(), String> {
    let batch = &review.batches[batch_index];
    let (total, healthy, failed) = batch_counts(database, &review.rollout_id, batch_index)?;
    let threshold_met = total == batch.target_indexes.len()
        && healthy >= batch.required_healthy
        && failed <= batch.maximum_failures;
    if !threshold_met {
        let reason = if batch.kind == DeploymentRolloutBatchKindV2::Canary {
            "canaryFailed"
        } else if failed > batch.maximum_failures {
            "failureThreshold"
        } else {
            "healthThreshold"
        };
        return stop_rollout(database, &review.rollout_id, batch_index, reason);
    }
    let now = now_ms();
    database.with_transaction(|transaction| {
        transaction
            .execute(
                "UPDATE deployment_rollout_batches SET status='succeeded', healthy_count=?3,
                 failed_count=?4, completed_at=?5 WHERE rollout_id=?1 AND batch_index=?2",
                params![
                    review.rollout_id,
                    sqlite_usize(batch_index),
                    sqlite_usize(healthy),
                    sqlite_usize(failed),
                    now
                ],
            )
            .map_err(|error| format!("failed to finish deployment rollout batch: {error}"))?;
        if let Some(next) = review.batches.get(batch_index + 1) {
            transaction
                .execute(
                    "UPDATE deployment_rollout_batches SET status='awaitingApproval'
                     WHERE rollout_id=?1 AND batch_index=?2",
                    params![review.rollout_id, sqlite_usize(next.batch_index)],
                )
                .map_err(|error| {
                    format!("failed to open deployment rollout batch gate: {error}")
                })?;
            transaction
                .execute(
                    "UPDATE deployment_rollouts SET phase='awaitingBatchApproval',
                     current_batch_index=?2, updated_at=?3 WHERE rollout_id=?1",
                    params![review.rollout_id, sqlite_usize(next.batch_index), now],
                )
                .map_err(|error| format!("failed to advance deployment rollout: {error}"))?;
        } else {
            let failed_total = transaction
                .query_row(
                    "SELECT COUNT(*) FROM deployment_rollout_targets
                     WHERE rollout_id=?1 AND status<>'succeeded'",
                    params![review.rollout_id],
                    |row| usize_from_row(row, 0),
                )
                .map_err(|error| format!("failed to finalize deployment rollout: {error}"))?;
            transaction
                .execute(
                    "UPDATE deployment_rollouts SET phase=?2, current_batch_index=NULL,
                     updated_at=?3 WHERE rollout_id=?1",
                    params![
                        review.rollout_id,
                        if failed_total == 0 {
                            "succeeded"
                        } else {
                            "partialSuccess"
                        },
                        now,
                    ],
                )
                .map_err(|error| format!("failed to finalize deployment rollout: {error}"))?;
        }
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
fn execute_batch(
    app: &AppHandle,
    database: &crate::db::Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    deployment_registry: &DeploymentExecutionRegistry,
    rollout_registry: &DeploymentRolloutRegistry,
    pool: &SftpPool,
    review: &DeploymentRolloutReviewV2,
    batch_index: usize,
    approval: DeploymentRolloutBatchApprovalV2,
    mut connections: HashMap<String, RemoteConnectionRequest>,
) -> Result<DeploymentRolloutBatchExecutionResultV2, String> {
    let cancelled = rollout_registry.start(&review.rollout_id)?;
    let _guard = RolloutGuard {
        registry: rollout_registry,
        rollout_id: &review.rollout_id,
        cancelled: Arc::clone(&cancelled),
    };
    let batch = review.batches[batch_index].clone();
    let mut target_results = Vec::new();
    let pending_target_indexes = batch
        .target_indexes
        .iter()
        .filter(|index| review.targets[**index].deployment_review.is_some())
        .copied()
        .collect::<Vec<_>>();
    for wave in pending_target_indexes.chunks(review.policy.max_parallel as usize) {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        let mut work = Vec::new();
        for target_index in wave {
            let target = &review.targets[*target_index];
            let child = target
                .deployment_review
                .as_ref()
                .ok_or_else(|| "completed rollout target cannot be redeployed".to_string())?;
            let target_approval = approval
                .target_approvals
                .iter()
                .find(|entry| entry.target_index == *target_index)
                .ok_or_else(|| "deployment rollout target approval is missing".to_string())?;
            let connection = connections
                .remove(&target.profile_id)
                .ok_or_else(|| "deployment rollout target connection is missing".to_string())?;
            database.with_connection(|db| {
                db.execute(
                    "UPDATE deployment_rollout_targets SET status='running', started_at=?3
                     WHERE rollout_id=?1 AND target_index=?2 AND status='notStarted'",
                    params![review.rollout_id, sqlite_usize(*target_index), now_ms()],
                )
                .map_err(|error| format!("failed to start deployment rollout target: {error}"))?;
                Ok(())
            })?;
            work.push((
                *target_index,
                DeploymentExecutionRequestV2 {
                    operation_id: child.operation_id.clone(),
                    runbook_text: review.normalized_runbook_text.clone(),
                    profile_id: target.profile_id.clone(),
                    connection,
                    approval: target_approval.approval.clone(),
                },
            ));
        }
        let operation_ids = work
            .iter()
            .map(|(_, request)| request.operation_id.clone())
            .collect::<Vec<_>>();
        rollout_registry.set_operations(&review.rollout_id, operation_ids)?;
        let results = std::thread::scope(|scope| {
            work.into_iter()
                .map(|(target_index, request)| {
                    scope.spawn(move || {
                        (
                            target_index,
                            execute_deployment_for_request(
                                app,
                                database,
                                credentials,
                                cancellations,
                                deployment_registry,
                                pool,
                                request,
                            ),
                        )
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .map_err(|_| "deployment rollout target worker panicked".to_string())
                })
                .collect::<Result<Vec<_>, _>>()
        })?;
        let mut identity_drift = false;
        let mut plan_drift = false;
        for (target_index, result) in results {
            if let Some(returned) =
                persist_target_result(database, &review.rollout_id, target_index, result)?
            {
                identity_drift |= returned.get("phase").and_then(serde_json::Value::as_str)
                    == Some("identityMismatch");
                plan_drift |= matches!(
                    returned
                        .get("errorCategory")
                        .and_then(serde_json::Value::as_str),
                    Some("reviewRevalidation" | "reviewMismatch" | "approvalMismatch")
                );
                target_results.push(returned);
            }
        }
        if identity_drift || plan_drift {
            stop_rollout(
                database,
                &review.rollout_id,
                batch_index,
                if identity_drift {
                    "targetDrift"
                } else {
                    "planDrift"
                },
            )?;
            break;
        }
        let (_, healthy, failed) = batch_counts(database, &review.rollout_id, batch_index)?;
        let completed = healthy + failed;
        let remaining = batch.target_indexes.len().saturating_sub(completed);
        let impossible = failed > batch.maximum_failures
            || healthy + remaining < batch.required_healthy
            || (batch.kind == DeploymentRolloutBatchKindV2::Canary && failed > 0);
        if impossible {
            stop_rollout(
                database,
                &review.rollout_id,
                batch_index,
                if batch.kind == DeploymentRolloutBatchKindV2::Canary {
                    "canaryFailed"
                } else if failed > batch.maximum_failures {
                    "failureThreshold"
                } else {
                    "healthThreshold"
                },
            )?;
            break;
        }
    }
    if cancelled.load(Ordering::SeqCst) {
        let now = now_ms();
        database.with_transaction(|transaction| {
            transaction
                .execute(
                    "UPDATE deployment_rollout_targets SET status='cancelled', completed_at=?2
                     WHERE rollout_id=?1 AND status IN ('notStarted','running')",
                    params![review.rollout_id, now],
                )
                .map_err(|error| format!("failed to cancel rollout targets: {error}"))?;
            transaction
                .execute(
                    "UPDATE deployment_rollouts SET phase='cancelled', circuit_open=1,
                     circuit_reason='cancelled', cancellation_requested=1,
                     current_batch_index=NULL, updated_at=?2 WHERE rollout_id=?1",
                    params![review.rollout_id, now],
                )
                .map_err(|error| format!("failed to cancel deployment rollout: {error}"))?;
            Ok(())
        })?;
    } else {
        let phase = database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT phase FROM deployment_rollouts WHERE rollout_id=?1",
                    params![review.rollout_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| format!("failed to load rollout phase: {error}"))
        })?;
        if phase == "running" {
            advance_after_batch(database, review, batch_index)?;
        }
    }
    let detail = get_rollout(database, &review.rollout_id)?
        .ok_or_else(|| "deployment rollout disappeared after execution".to_string())?;
    Ok(DeploymentRolloutBatchExecutionResultV2 {
        schema_version: 2,
        rollout_id: review.rollout_id.clone(),
        rollout_review_id: review.review_id.clone(),
        rollout_plan_digest: review.plan_digest.clone(),
        batch_index,
        batch_digest: batch.batch_digest,
        phase: detail.summary.phase.clone(),
        circuit_open: detail.summary.circuit_open,
        circuit_reason: detail.summary.circuit_reason.clone(),
        target_results,
        detail,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn start_deployment_rollout(
    app: AppHandle,
    database: State<'_, crate::db::Database>,
    credentials: State<'_, CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    deployment_registry: State<'_, DeploymentExecutionRegistry>,
    rollout_registry: State<'_, DeploymentRolloutRegistry>,
    pool: State<'_, SftpPool>,
    request: DeploymentRolloutStartRequestV2,
) -> Result<DeploymentRolloutBatchExecutionResultV2, String> {
    let review = load_rollout_review(&database, &request.rollout_id, &request.review_id)?;
    let expected_batch = review
        .batches
        .iter()
        .find(|batch| {
            batch
                .target_indexes
                .iter()
                .any(|index| review.targets[*index].deployment_review.is_some())
        })
        .map(|batch| batch.batch_index)
        .ok_or_else(|| "deployment rollout review has no executable target".to_string())?;
    if request.plan_digest != review.plan_digest
        || request.batch_approval.batch_index != expected_batch
        || !approval_matches(&review, &request.batch_approval)
    {
        return Err("deployment rollout start approval or plan identity mismatched".into());
    }
    let connections = connections_for_batch(&review, expected_batch, request.connections)?;
    revalidate_batch_connections(&database, &review, expected_batch, &connections)?;
    create_rollout_state(&database, &review, &request.batch_approval)?;
    execute_batch(
        &app,
        &database,
        &credentials,
        &cancellations,
        &deployment_registry,
        &rollout_registry,
        &pool,
        &review,
        expected_batch,
        request.batch_approval,
        connections,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn approve_next_deployment_rollout_batch(
    app: AppHandle,
    database: State<'_, crate::db::Database>,
    credentials: State<'_, CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    deployment_registry: State<'_, DeploymentExecutionRegistry>,
    rollout_registry: State<'_, DeploymentRolloutRegistry>,
    pool: State<'_, SftpPool>,
    request: DeploymentRolloutApproveBatchRequestV2,
) -> Result<DeploymentRolloutBatchExecutionResultV2, String> {
    let review = load_rollout_review(&database, &request.rollout_id, &request.review_id)?;
    let batch_index = request.batch_approval.batch_index;
    if review.expires_at <= now_ms() {
        stop_rollout(
            &database,
            &review.rollout_id,
            batch_index,
            "approvalExpired",
        )?;
        return Err("deployment rollout review expired before batch approval".into());
    }
    if request.plan_digest != review.plan_digest
        || !approval_matches(&review, &request.batch_approval)
    {
        stop_rollout(
            &database,
            &review.rollout_id,
            batch_index,
            "approvalMismatch",
        )?;
        return Err("deployment rollout batch approval or plan identity mismatched".into());
    }
    let connections = connections_for_batch(&review, batch_index, request.connections)?;
    if revalidate_batch_connections(&database, &review, batch_index, &connections).is_err() {
        stop_rollout(&database, &review.rollout_id, batch_index, "targetDrift")?;
        return Err("deployment rollout target identity drifted before batch dispatch".into());
    }
    consume_next_batch_approval(&database, &review, &request.batch_approval)?;
    execute_batch(
        &app,
        &database,
        &credentials,
        &cancellations,
        &deployment_registry,
        &rollout_registry,
        &pool,
        &review,
        batch_index,
        request.batch_approval,
        connections,
    )
}

#[tauri::command]
pub(crate) fn cancel_deployment_rollout(
    database: State<'_, crate::db::Database>,
    deployment_registry: State<'_, DeploymentExecutionRegistry>,
    rollout_registry: State<'_, DeploymentRolloutRegistry>,
    request: DeploymentRolloutCancelRequestV2,
) -> Result<(), String> {
    let identity = database.with_connection(|connection| {
        connection
            .query_row(
                "SELECT review_id, plan_digest FROM deployment_rollouts WHERE rollout_id=?1",
                params![request.rollout_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| {
                format!("failed to load deployment rollout cancellation identity: {error}")
            })
    })?;
    if identity.0 != request.review_id || identity.1 != request.plan_digest {
        return Err("deployment rollout cancellation identity mismatched".into());
    }
    let operation_ids = rollout_registry.cancel(&request.rollout_id)?;
    for operation_id in operation_ids {
        let _ = deployment_registry.cancel_operation(&operation_id);
    }
    database.with_connection(|connection| {
        connection
            .execute(
                "UPDATE deployment_rollouts SET cancellation_requested=1, updated_at=?2
                 WHERE rollout_id=?1",
                params![request.rollout_id, now_ms()],
            )
            .map_err(|error| {
                format!("failed to persist deployment rollout cancellation: {error}")
            })?;
        Ok(())
    })
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentRolloutSummaryV2> {
    Ok(DeploymentRolloutSummaryV2 {
        rollout_id: row.get(0)?,
        review_id: row.get(1)?,
        plan_digest: row.get(2)?,
        deployment_id: row.get(3)?,
        application_id: row.get(4)?,
        environment: row.get(5)?,
        version: row.get(6)?,
        phase: row.get(7)?,
        current_batch_index: optional_usize_from_row(row, 8)?,
        circuit_open: row.get(9)?,
        circuit_reason: row.get(10)?,
        recovery_required: row.get(11)?,
        total_targets: usize_from_row(row, 12)?,
        succeeded_targets: usize_from_row(row, 13)?,
        failed_targets: usize_from_row(row, 14)?,
        not_started_targets: usize_from_row(row, 15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

const SUMMARY_SQL: &str = "
SELECT r.rollout_id, r.review_id, r.plan_digest, r.deployment_id, r.application_id,
       r.environment, r.version, r.phase, r.current_batch_index, r.circuit_open,
       r.circuit_reason, r.recovery_required,
       COUNT(t.target_index),
       SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END),
       SUM(CASE WHEN t.status IN ('failed','cancelled','interrupted') THEN 1 ELSE 0 END),
       SUM(CASE WHEN t.status='notStarted' THEN 1 ELSE 0 END),
       r.created_at, r.updated_at
FROM deployment_rollouts r
JOIN deployment_rollout_targets t ON t.rollout_id=r.rollout_id";

fn get_rollout(
    database: &crate::db::Database,
    rollout_id: &str,
) -> Result<Option<DeploymentRolloutDetailV2>, String> {
    database.with_connection(|connection| {
        let summary_sql = format!("{SUMMARY_SQL} WHERE r.rollout_id=?1 GROUP BY r.rollout_id");
        let summary = connection
            .query_row(&summary_sql, params![rollout_id], summary_from_row)
            .optional()
            .map_err(|error| format!("failed to load deployment rollout: {error}"))?;
        let Some(summary) = summary else {
            return Ok(None);
        };
        let review_json: String = connection
            .query_row(
                "SELECT review_json FROM deployment_rollout_reviews WHERE review_id=?1",
                params![summary.review_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to load deployment rollout review detail: {error}"))?;
        let review: DeploymentRolloutReviewV2 = serde_json::from_str(&review_json)
            .map_err(|error| format!("persisted deployment rollout review is invalid: {error}"))?;
        let mut batch_statement = connection
            .prepare(
                "SELECT batch_index, status, healthy_count, failed_count, approval_review_id,
                        approval_consumed_at, started_at, completed_at
                 FROM deployment_rollout_batches WHERE rollout_id=?1 ORDER BY batch_index",
            )
            .map_err(|error| format!("failed to prepare rollout batch detail: {error}"))?;
        let batches = batch_statement
            .query_map(params![rollout_id], |row| {
                let index = usize_from_row(row, 0)?;
                let plan = review.batches[index].clone();
                let healthy = usize_from_row(row, 2)?;
                let failed = usize_from_row(row, 3)?;
                let total = plan.target_indexes.len();
                Ok(DeploymentRolloutBatchStateV2 {
                    health: DeploymentRolloutHealthSummaryV2 {
                        total,
                        healthy,
                        failed,
                        healthy_percent: if total == 0 { 0 } else { healthy * 100 / total },
                        threshold_met: healthy >= plan.required_healthy
                            && failed <= plan.maximum_failures,
                    },
                    plan,
                    status: row.get(1)?,
                    approval_review_id: row.get(4)?,
                    approval_consumed_at: row.get(5)?,
                    started_at: row.get(6)?,
                    completed_at: row.get(7)?,
                })
            })
            .map_err(|error| format!("failed to query rollout batch detail: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to collect rollout batch detail: {error}"))?;
        let mut target_statement = connection
            .prepare(
                "SELECT target_index, status, result_json, started_at, completed_at,
                        recovery_required, error_category, error
                 FROM deployment_rollout_targets WHERE rollout_id=?1 ORDER BY target_index",
            )
            .map_err(|error| format!("failed to prepare rollout target detail: {error}"))?;
        let targets = target_statement
            .query_map(params![rollout_id], |row| {
                let index = usize_from_row(row, 0)?;
                let result_json: Option<String> = row.get(2)?;
                Ok(DeploymentRolloutTargetStateV2 {
                    reviewed: review.targets[index].clone(),
                    status: row.get(1)?,
                    result: result_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                2,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                    started_at: row.get(3)?,
                    completed_at: row.get(4)?,
                    recovery_required: row.get(5)?,
                    error_category: row.get(6)?,
                    error: row.get(7)?,
                })
            })
            .map_err(|error| format!("failed to query rollout target detail: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to collect rollout target detail: {error}"))?;
        let rollback_suggestions =
            if review.policy.rollback_suggestion == "successfulTargets" && summary.circuit_open {
                targets
                    .iter()
                    .filter(|target| target.status == "succeeded")
                    .map(|target| DeploymentRolloutRollbackSuggestionV2 {
                        profile_id: target.reviewed.profile_id.clone(),
                        target_digest: target.reviewed.target.identity_digest.clone(),
                        source_operation_id: target.reviewed.operation_id.clone(),
                        reason: "rolloutCircuitOpen",
                        requires_separate_approval: true,
                    })
                    .collect()
            } else {
                Vec::new()
            };
        Ok(Some(DeploymentRolloutDetailV2 {
            summary,
            policy: review.policy.clone(),
            review,
            batches,
            targets,
            rollback_suggestions,
        }))
    })
}

#[tauri::command]
pub(crate) fn get_deployment_rollout(
    database: State<'_, crate::db::Database>,
    rollout_id: String,
) -> Result<Option<DeploymentRolloutDetailV2>, String> {
    if !valid_operation_id(&rollout_id) {
        return Err("deployment rollout identity is invalid".into());
    }
    get_rollout(&database, &rollout_id)
}

#[tauri::command]
pub(crate) fn list_deployment_rollouts(
    database: State<'_, crate::db::Database>,
    request: DeploymentRolloutListRequestV2,
) -> Result<Vec<DeploymentRolloutSummaryV2>, String> {
    if request.limit == 0 || request.limit > 500 {
        return Err("deployment rollout list limit must be from 1 to 500".into());
    }
    database.with_connection(|connection| {
        let sql = format!(
            "{SUMMARY_SQL} WHERE (?1 IS NULL OR r.phase=?1)
             AND (?2 IS NULL OR r.recovery_required=?2)
             GROUP BY r.rollout_id ORDER BY r.updated_at DESC LIMIT ?3"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("failed to prepare deployment rollout list: {error}"))?;
        let summaries = statement
            .query_map(
                params![request.phase, request.recovery_required, request.limit],
                summary_from_row,
            )
            .map_err(|error| format!("failed to query deployment rollout list: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to collect deployment rollout list: {error}"))?;
        Ok(summaries)
    })
}

pub(crate) fn recover_interrupted_rollouts(
    database: &crate::db::Database,
) -> Result<usize, String> {
    let now = now_ms();
    database.with_transaction(|transaction| {
        let rollout_ids = {
            let mut statement = transaction
                .prepare("SELECT rollout_id FROM deployment_rollouts WHERE phase='running'")
                .map_err(|error| format!("failed to prepare rollout recovery: {error}"))?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("failed to query rollout recovery: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect rollout recovery: {error}"))?;
            ids
        };
        for rollout_id in &rollout_ids {
            transaction
                .execute(
                    "UPDATE deployment_rollout_targets SET status='interrupted',
                     recovery_required=1, completed_at=?2, error_category='recoveryRequired',
                     error='application restart interrupted this deployment target; it was not replayed'
                     WHERE rollout_id=?1 AND status='running'",
                    params![rollout_id, now],
                )
                .map_err(|error| format!("failed to recover rollout targets: {error}"))?;
            transaction
                .execute(
                    "UPDATE deployment_rollout_batches SET status='interrupted', completed_at=?2
                     WHERE rollout_id=?1 AND status='running'",
                    params![rollout_id, now],
                )
                .map_err(|error| format!("failed to recover rollout batch: {error}"))?;
            transaction
                .execute(
                    "UPDATE deployment_rollouts SET phase='recoveryRequired', circuit_open=1,
                     circuit_reason='recoveryRequired', recovery_required=1, updated_at=?2
                     WHERE rollout_id=?1",
                    params![rollout_id, now],
                )
                .map_err(|error| format!("failed to recover deployment rollout: {error}"))?;
        }
        Ok(rollout_ids.len())
    })
}

#[tauri::command]
pub(crate) fn recover_deployment_rollout(
    database: State<'_, crate::db::Database>,
    request: DeploymentRolloutRecoverRequestV2,
) -> Result<DeploymentRolloutReviewV2, String> {
    let previous = get_rollout(&database, &request.rollout_id)?
        .ok_or_else(|| "deployment rollout recovery source was not found".to_string())?;
    if !previous.summary.recovery_required
        || previous.summary.review_id != request.source_review_id
        || previous.review.profile_ids != request.profile_ids
    {
        return Err("deployment rollout recovery identity or target order mismatched".into());
    }
    let completed = previous
        .targets
        .iter()
        .filter(|target| target.status == "succeeded")
        .map(|target| {
            (
                target.reviewed.profile_id.clone(),
                target.reviewed.operation_id.clone(),
            )
        })
        .collect::<HashMap<_, _>>();
    let review = build_rollout_review(
        &database,
        DeploymentRolloutReviewRequestV2 {
            rollout_id: request.rollout_id,
            runbook_text: request.runbook_text,
            profile_ids: request.profile_ids,
            targets: request.targets,
            policy: request.policy,
            deployment_policy: request.deployment_policy,
        },
        Some(request.source_review_id),
        &completed,
    )?;
    if review.document_digest != previous.review.document_digest
        || review.environment != previous.review.environment
        || review.policy != previous.review.policy
        || review.deployment_policy != previous.review.deployment_policy
        || review
            .batches
            .iter()
            .zip(previous.review.batches.iter())
            .any(|(current, old)| current.batch_digest != old.batch_digest)
        || review
            .targets
            .iter()
            .zip(previous.review.targets.iter())
            .any(|(current, old)| {
                current.profile_id != old.profile_id || current.target != old.target
            })
    {
        return Err("deployment rollout recovery target, document, or environment drifted".into());
    }
    store_rollout_review(&database, &review)?;
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> (tempfile::TempDir, crate::db::Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(&directory.path().join("termbridge.db")).unwrap();
        (directory, database)
    }

    fn policy() -> DeploymentRolloutPolicyV2 {
        DeploymentRolloutPolicyV2 {
            strategy: "canaryRolling".into(),
            canary: DeploymentRolloutCanaryV2 {
                mode: CanaryModeV2::Percentage,
                value: 20,
            },
            batch_size: 2,
            max_parallel: 2,
            require_batch_approval: true,
            min_healthy_percent: 50,
            max_failures_per_batch: 1,
            stop_policy: "pause".into(),
            rollback_suggestion: "successfulTargets".into(),
        }
    }

    #[test]
    fn normalizes_canary_and_rolling_order_without_reordering() {
        let ids = ["a", "b", "c", "d", "e"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let batches = normalize_batches(&ids, &policy()).unwrap();
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].profile_ids, vec!["a"]);
        assert_eq!(batches[1].profile_ids, vec!["b", "c"]);
        assert_eq!(batches[2].profile_ids, vec!["d", "e"]);
        assert_eq!(batches[0].maximum_failures, 0);
        assert_eq!(batches[1].required_healthy, 1);
        assert!(batches.iter().all(|batch| !batch.batch_digest.is_empty()));
    }

    #[test]
    fn consumes_the_shared_rollout_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/deployment-runbook/v2/multi-host-rollout.json"
        ))
        .unwrap();
        let profile_ids: Vec<String> =
            serde_json::from_value(fixture["profileIds"].clone()).unwrap();
        let policy: DeploymentRolloutPolicyV2 =
            serde_json::from_value(fixture["policy"].clone()).unwrap();
        let batches = normalize_batches(&profile_ids, &policy).unwrap();
        assert_eq!(batches[0].profile_ids, vec!["prod-a"]);
        assert_eq!(batches[1].profile_ids, vec!["prod-b", "prod-c"]);
        assert_eq!(batches[2].profile_ids, vec!["prod-d", "prod-e"]);
    }

    #[test]
    fn rejects_unsafe_policy_shapes() {
        let mut invalid = policy();
        invalid.require_batch_approval = false;
        assert!(invalid.validate(5).is_err());
        invalid = policy();
        invalid.max_parallel = 3;
        assert!(invalid.validate(5).is_err());
        invalid = policy();
        invalid.canary.value = 100;
        assert!(invalid.validate(5).is_err());
    }

    #[test]
    fn persisted_scrubber_removes_credentials_and_output_recursively() {
        let mut value = serde_json::json!({
            "connection": { "password": "secret" },
            "actions": [{ "output": "token", "status": "succeeded" }],
            "nested": { "privateKeyData": "key", "stderr": "secret" }
        });
        scrub_persisted_value(&mut value);
        let text = value.to_string();
        assert!(!text.contains("secret"));
        assert!(!text.contains("token"));
        assert!(!text.contains("privateKeyData"));
    }

    #[test]
    fn restart_seals_only_running_targets_and_never_replays_pending_targets() {
        let (_directory, database) = database();
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO deployment_rollout_reviews
                         (review_id, rollout_id, document_digest, plan_digest, environment,
                          review_json, state, reviewed_at, expires_at)
                         VALUES ('review-1', 'rollout-1', 'document', 'plan', 'production',
                                 '{}', 'consumed', 1, 9999999999999)",
                        [],
                    )
                    .unwrap();
                connection
                    .execute(
                        "INSERT INTO deployment_rollouts
                         (rollout_id, review_id, plan_digest, document_digest, deployment_id,
                          application_id, environment, version, phase, current_batch_index,
                          circuit_open, recovery_required, cancellation_requested, detail_json,
                          created_at, updated_at)
                         VALUES ('rollout-1', 'review-1', 'plan', 'document', 'release', 'app',
                                 'production', '1.0.0', 'running', 0, 0, 0, 0, '{}', 1, 1)",
                        [],
                    )
                    .unwrap();
                connection
                    .execute(
                        "INSERT INTO deployment_rollout_batches
                         (rollout_id, batch_index, batch_digest, batch_kind, status, target_count,
                          required_healthy, maximum_failures, healthy_count, failed_count)
                         VALUES ('rollout-1', 0, 'batch', 'canary', 'running', 2, 2, 0, 0, 0)",
                        [],
                    )
                    .unwrap();
                for (index, status) in [(0, "running"), (1, "notStarted")] {
                    connection
                        .execute(
                            "INSERT INTO deployment_rollout_targets
                             (rollout_id, target_index, batch_index, profile_id, target_digest,
                              operation_id, status, recovery_required)
                             VALUES ('rollout-1', ?1, 0, ?2, ?3, ?4, ?5, 0)",
                            params![
                                index,
                                format!("profile-{index}"),
                                format!("target-{index}"),
                                format!("operation-{index}"),
                                status,
                            ],
                        )
                        .unwrap();
                }
                Ok(())
            })
            .unwrap();

        assert_eq!(recover_interrupted_rollouts(&database).unwrap(), 1);
        let state = database
            .with_connection(|connection| {
                let rollout: (String, bool, bool) = connection
                    .query_row(
                        "SELECT phase, circuit_open, recovery_required
                         FROM deployment_rollouts WHERE rollout_id='rollout-1'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .unwrap();
                let mut statement = connection
                    .prepare(
                        "SELECT status FROM deployment_rollout_targets
                         WHERE rollout_id='rollout-1' ORDER BY target_index",
                    )
                    .unwrap();
                let targets = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                Ok((rollout, targets))
            })
            .unwrap();
        assert_eq!(state.0, ("recoveryRequired".to_string(), true, true));
        assert_eq!(state.1, vec!["interrupted", "notStarted"]);
    }
}
