//! Narrow single-host executor for Deployment Runbook v2.
//!
//! This module deliberately exposes three semantic commands only: issue an
//! exact review, consume that review once, and cancel the bound execution.
//! It does not accept commands, remote paths outside the validated document,
//! or arbitrary SFTP operations from the frontend.

use crate::deployment_persistence::{
    checkpoint_operation, consume_review, store_review, DeploymentOperationKind, ReviewIdentity,
};
use crate::deployment_runbook::{
    parse_deployment_runbook_v2, serialize_deployment_runbook_v2, DeploymentArchiveFormatV2,
    DeploymentArtifactKindV2, DeploymentHealthCheckKindV2, DeploymentRunbookDocumentV2,
    DeploymentServiceActionKindV2,
};
use crate::execution::{
    execute_reviewed_ssh_command, revalidate_frozen_target_identity, valid_operation_id,
    ExecutionCancellationRegistry, ExecutionErrorCategory, ExecutionOutputPolicy, ExecutionStatus,
    FrozenTargetIdentity, ReviewedSshCommand, ReviewedSshExecutionRequest,
    ReviewedSshExecutionResult,
};
use crate::keychain::{CredentialManager, DEPLOYMENT_SECRET_SERVICE};
use crate::models::RemoteConnectionRequest;
use crate::runbook::RunbookRisk;
use crate::sftp_pool::SftpPool;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::{OpenFlags, OpenType};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use url::Url;
use zeroize::Zeroize;

const REVIEW_TTL_MS: i64 = 10 * 60 * 1_000;
const MIN_TOTAL_TIMEOUT_SECONDS: u64 = 30;
const MAX_TOTAL_TIMEOUT_SECONDS: u64 = 3_600;
const MAX_ARTIFACT_TIMEOUT_SECONDS: u64 = 300;
const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: u32 = 100_000;
const ACTION_STDOUT_BYTES: usize = 8 * 1024;
const ACTION_STDERR_BYTES: usize = 8 * 1024;
const ACTION_TOTAL_READ_BYTES: usize = 256 * 1024;
const SFTP_FILE_MODE: i32 = 0o644;
const SFTP_DIRECTORY_MODE: i32 = 0o755;
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

fn now_ms() -> i64 {
    crate::db::current_timestamp_ms()
}

fn sha256_digest(domain: &str, value: &[u8]) -> String {
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

fn risk_name(risk: RunbookRisk) -> &'static str {
    match risk {
        RunbookRisk::ReadOnly => "readOnly",
        RunbookRisk::StateChange => "stateChange",
        RunbookRisk::Destructive => "destructive",
    }
}

fn action_kind_name(kind: DeploymentExecutionActionKindV2) -> &'static str {
    match kind {
        DeploymentExecutionActionKindV2::InspectRelease => "inspectRelease",
        DeploymentExecutionActionKindV2::CreateRelease => "createRelease",
        DeploymentExecutionActionKindV2::StageArtifact => "stageArtifact",
        DeploymentExecutionActionKindV2::VerifyArtifact => "verifyArtifact",
        DeploymentExecutionActionKindV2::ActivateRelease => "activateRelease",
        DeploymentExecutionActionKindV2::ServiceAction => "serviceAction",
        DeploymentExecutionActionKindV2::HttpHealthCheck => "httpHealthCheck",
        DeploymentExecutionActionKindV2::ServiceHealthCheck => "serviceHealthCheck",
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentExecutionActionKindV2 {
    InspectRelease,
    CreateRelease,
    StageArtifact,
    VerifyArtifact,
    ActivateRelease,
    ServiceAction,
    HttpHealthCheck,
    ServiceHealthCheck,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentExecutionPolicyV2 {
    pub(crate) artifact_timeout_seconds: u64,
    pub(crate) max_artifact_bytes: u64,
    pub(crate) max_expanded_bytes: u64,
    pub(crate) max_archive_entries: u32,
    pub(crate) total_timeout_seconds: u64,
}

impl DeploymentExecutionPolicyV2 {
    fn validate(&self) -> Result<(), String> {
        if self.artifact_timeout_seconds == 0
            || self.artifact_timeout_seconds > MAX_ARTIFACT_TIMEOUT_SECONDS
        {
            return Err("deployment artifact timeout must be between 1 and 300 seconds".into());
        }
        if self.max_artifact_bytes == 0 || self.max_artifact_bytes > MAX_ARTIFACT_BYTES {
            return Err("deployment maxArtifactBytes is outside the supported bound".into());
        }
        if self.max_expanded_bytes == 0 || self.max_expanded_bytes > MAX_EXPANDED_BYTES {
            return Err("deployment maxExpandedBytes is outside the supported bound".into());
        }
        if self.max_archive_entries == 0 || self.max_archive_entries > MAX_ARCHIVE_ENTRIES {
            return Err("deployment maxArchiveEntries is outside the supported bound".into());
        }
        if !(MIN_TOTAL_TIMEOUT_SECONDS..=MAX_TOTAL_TIMEOUT_SECONDS)
            .contains(&self.total_timeout_seconds)
        {
            return Err("deployment total timeout must be between 30 and 3600 seconds".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentExecutionReviewRequestV2 {
    pub(crate) operation_id: String,
    pub(crate) runbook_text: String,
    pub(crate) profile_id: String,
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) policy: DeploymentExecutionPolicyV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactDigestBindingV2 {
    artifact_id: String,
    sha256: String,
    target_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentExecutionActionV2 {
    action_id: String,
    kind: DeploymentExecutionActionKindV2,
    target: String,
    normalized_parameters: String,
    parameters_digest: String,
    risk: RunbookRisk,
    mutating: bool,
    timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentExecutionReviewV2 {
    pub(crate) schema_version: u8,
    pub(crate) review_id: String,
    pub(crate) operation_id: String,
    pub(crate) normalized_runbook_text: String,
    pub(crate) document_digest: String,
    pub(crate) plan_digest: String,
    pub(crate) deployment_id: String,
    pub(crate) application_id: String,
    pub(crate) environment: String,
    pub(crate) version: String,
    pub(crate) artifact_digests: Vec<DeploymentArtifactDigestBindingV2>,
    pub(crate) declared_risk: RunbookRisk,
    pub(crate) target: FrozenTargetIdentity,
    pub(crate) policy: DeploymentExecutionPolicyV2,
    pub(crate) actions: Vec<DeploymentExecutionActionV2>,
    pub(crate) reviewed_at: i64,
    pub(crate) expires_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentExecutionApprovalV2 {
    pub(crate) review_id: String,
    pub(crate) operation_id: String,
    pub(crate) document_digest: String,
    pub(crate) plan_digest: String,
    pub(crate) target_digest: String,
    pub(crate) approved_risk: RunbookRisk,
    pub(crate) authorized: bool,
    pub(crate) destructive_confirmed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentExecutionRequestV2 {
    pub(crate) operation_id: String,
    pub(crate) runbook_text: String,
    pub(crate) profile_id: String,
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) approval: DeploymentExecutionApprovalV2,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentExecutionPhaseV2 {
    Pending,
    PreparingArtifacts,
    InspectingTarget,
    CreatingRelease,
    StagingArtifacts,
    ActivatingRelease,
    ApplyingServices,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    IdentityMismatch,
    Unauthorized,
}

impl DeploymentExecutionPhaseV2 {
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded
                | Self::Failed
                | Self::Cancelled
                | Self::TimedOut
                | Self::IdentityMismatch
                | Self::Unauthorized
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentExecutionActionStatusV2 {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    IdentityMismatch,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentExecutionActionResultV2 {
    #[serde(flatten)]
    action: DeploymentExecutionActionV2,
    child_operation_id: String,
    status: DeploymentExecutionActionStatusV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentHealthCheckResultV2 {
    check_id: String,
    kind: DeploymentHealthCheckKindV2,
    status: &'static str,
    attempts_used: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRollbackSnapshotV2 {
    strategy: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_release: Option<String>,
    new_release: String,
    releases_directory: String,
    active_symlink: String,
    activation_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    captured_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentExecutionResultV2 {
    schema_version: u8,
    operation_id: String,
    review_id: String,
    document_digest: String,
    plan_digest: String,
    deployment_id: String,
    version: String,
    target: FrozenTargetIdentity,
    phase: DeploymentExecutionPhaseV2,
    started_at: i64,
    completed_at: i64,
    actions: Vec<DeploymentExecutionActionResultV2>,
    health_checks: Vec<DeploymentHealthCheckResultV2>,
    rollback_snapshot: DeploymentRollbackSnapshotV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
struct DeploymentRegistryState {
    active: HashMap<String, Arc<AtomicBool>>,
}

#[derive(Clone, Default)]
pub(crate) struct DeploymentExecutionRegistry {
    state: Arc<Mutex<DeploymentRegistryState>>,
}

impl DeploymentExecutionRegistry {
    fn start(&self, operation_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "deployment execution registry is unavailable".to_string())?;
        if state.active.contains_key(operation_id) {
            return Err("deployment operation is already active".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        state
            .active
            .insert(operation_id.to_string(), Arc::clone(&cancelled));
        Ok(cancelled)
    }

    fn finish(&self, operation_id: &str, expected: &Arc<AtomicBool>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state
            .active
            .get(operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, expected))
        {
            state.active.remove(operation_id);
        }
    }

    fn cancel(&self, operation_id: &str) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "deployment execution registry is unavailable".to_string())?;
        let flag = state
            .active
            .get(operation_id)
            .ok_or_else(|| "deployment execution was not found".to_string())?;
        flag.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn cancel_operation(&self, operation_id: &str) -> Result<(), String> {
        self.cancel(operation_id)
    }
}

struct ActiveExecutionGuard<'a> {
    registry: &'a DeploymentExecutionRegistry,
    operation_id: &'a str,
    cancelled: Arc<AtomicBool>,
}

impl Drop for ActiveExecutionGuard<'_> {
    fn drop(&mut self) {
        self.registry.finish(self.operation_id, &self.cancelled);
    }
}

fn action(
    index: usize,
    kind: DeploymentExecutionActionKindV2,
    target: String,
    parameters: serde_json::Value,
    risk: RunbookRisk,
    mutating: bool,
    timeout_seconds: u64,
) -> DeploymentExecutionActionV2 {
    let normalized_parameters = parameters.to_string();
    DeploymentExecutionActionV2 {
        action_id: format!("deployment-action-{index}"),
        kind,
        target,
        parameters_digest: sha256_digest(
            "termbridge-deployment-action-parameters",
            normalized_parameters.as_bytes(),
        ),
        normalized_parameters,
        risk,
        mutating,
        timeout_seconds,
    }
}

fn build_actions(
    document: &DeploymentRunbookDocumentV2,
    policy: &DeploymentExecutionPolicyV2,
) -> Vec<DeploymentExecutionActionV2> {
    let mut actions = Vec::new();
    actions.push(action(
        actions.len(),
        DeploymentExecutionActionKindV2::InspectRelease,
        document.release.active_symlink.clone(),
        serde_json::json!({
            "activeSymlink": document.release.active_symlink,
            "privilegeEscalation": document.security.allow_privilege_escalation,
            "releaseDirectory": document.release.release_directory,
            "releasesDirectory": document.release.releases_directory,
        }),
        RunbookRisk::ReadOnly,
        false,
        30,
    ));
    actions.push(action(
        actions.len(),
        DeploymentExecutionActionKindV2::CreateRelease,
        document.release.release_directory.clone(),
        serde_json::json!({
            "releaseDirectory": document.release.release_directory,
            "releasesDirectory": document.release.releases_directory,
            "owner": "frozenTarget.username",
            "privilegeEscalation": document.security.allow_privilege_escalation,
            "rejectSymlinks": true,
        }),
        RunbookRisk::StateChange,
        true,
        30,
    ));
    for artifact in &document.artifacts {
        actions.push(action(
            actions.len(),
            DeploymentExecutionActionKindV2::StageArtifact,
            artifact.target_path.clone(),
            serde_json::json!({
                "artifactId": artifact.id,
                "kind": artifact.kind,
                "sha256": artifact.sha256,
                "targetPath": artifact.target_path,
                "unpack": artifact.unpack,
            }),
            RunbookRisk::StateChange,
            true,
            policy.artifact_timeout_seconds,
        ));
        actions.push(action(
            actions.len(),
            DeploymentExecutionActionKindV2::VerifyArtifact,
            artifact.target_path.clone(),
            serde_json::json!({
                "artifactId": artifact.id,
                "sha256": artifact.sha256,
                "targetPath": artifact.target_path,
            }),
            RunbookRisk::ReadOnly,
            false,
            30,
        ));
    }
    actions.push(action(
        actions.len(),
        DeploymentExecutionActionKindV2::ActivateRelease,
        document.release.active_symlink.clone(),
        serde_json::json!({
            "activeSymlink": document.release.active_symlink,
            "privilegeEscalation": document.security.allow_privilege_escalation,
            "releaseDirectory": document.release.release_directory,
            "strategy": document.release.activation_strategy,
        }),
        RunbookRisk::StateChange,
        true,
        30,
    ));
    for service_action in &document.service_actions {
        let service = document
            .services
            .iter()
            .find(|service| service.id == service_action.service_id)
            .expect("validated service action reference");
        actions.push(action(
            actions.len(),
            DeploymentExecutionActionKindV2::ServiceAction,
            service.unit.clone(),
            serde_json::json!({
                "actionId": service_action.id,
                "action": service_action.action,
                "manager": service.manager,
                "privilegeEscalation": document.security.allow_privilege_escalation,
                "unit": service.unit,
            }),
            service_action.risk,
            true,
            service_action.timeout_seconds,
        ));
    }
    for check in &document.verification.checks {
        let (kind, target, parameters) = match check.kind {
            DeploymentHealthCheckKindV2::Http => (
                DeploymentExecutionActionKindV2::HttpHealthCheck,
                check.url.clone().expect("validated HTTP URL"),
                serde_json::json!({
                    "attempts": check.attempts,
                    "expectedStatus": check.expected_status,
                    "intervalSeconds": check.interval_seconds,
                    "timeoutSeconds": check.timeout_seconds,
                    "url": check.url,
                }),
            ),
            DeploymentHealthCheckKindV2::Service => {
                let service = document
                    .services
                    .iter()
                    .find(|service| Some(service.id.as_str()) == check.service_id.as_deref())
                    .expect("validated health service reference");
                (
                    DeploymentExecutionActionKindV2::ServiceHealthCheck,
                    service.unit.clone(),
                    serde_json::json!({
                        "attempts": check.attempts,
                        "expectedState": check.expected_state,
                        "intervalSeconds": check.interval_seconds,
                        "timeoutSeconds": check.timeout_seconds,
                        "unit": service.unit,
                    }),
                )
            }
        };
        actions.push(action(
            actions.len(),
            kind,
            target,
            parameters,
            RunbookRisk::ReadOnly,
            false,
            check.timeout_seconds,
        ));
    }
    actions
}

fn review_material(
    database: &crate::db::Database,
    request: &DeploymentExecutionReviewRequestV2,
) -> Result<
    (
        DeploymentRunbookDocumentV2,
        String,
        String,
        FrozenTargetIdentity,
        Vec<DeploymentArtifactDigestBindingV2>,
        Vec<DeploymentExecutionActionV2>,
        String,
    ),
    String,
> {
    if !valid_operation_id(&request.operation_id) {
        return Err("deployment operation identity is invalid".into());
    }
    request.policy.validate()?;
    let document = parse_deployment_runbook_v2(&request.runbook_text)?;
    let normalized = serialize_deployment_runbook_v2(&document)?;
    let document_digest = sha256_digest("termbridge-deployment-document", normalized.as_bytes());
    let target =
        FrozenTargetIdentity::from_connection(request.profile_id.clone(), &request.connection)
            .map_err(|error| error.message.to_string())?;
    revalidate_frozen_target_identity(database, &target, &request.connection)
        .map_err(|error| error.message)?;
    for artifact in &document.artifacts {
        if artifact
            .size_bytes
            .is_some_and(|size| size > request.policy.max_artifact_bytes)
        {
            return Err(format!(
                "deployment artifact {} exceeds the reviewed byte policy",
                artifact.id
            ));
        }
    }
    let artifact_digests = document
        .artifacts
        .iter()
        .map(|artifact| DeploymentArtifactDigestBindingV2 {
            artifact_id: artifact.id.clone(),
            sha256: artifact.sha256.clone(),
            target_path: artifact.target_path.clone(),
        })
        .collect::<Vec<_>>();
    let actions = build_actions(&document, &request.policy);
    let plan = serde_json::json!({
        "schemaVersion": 2,
        "operationId": request.operation_id,
        "documentDigest": document_digest,
        "deploymentId": document.deployment.id,
        "version": document.deployment.version,
        "artifactDigests": artifact_digests,
        "declaredRisk": document.security.declared_risk,
        "target": target,
        "policy": request.policy,
        "actions": actions,
    });
    let plan_digest = sha256_digest("termbridge-deployment-plan", plan.to_string().as_bytes());
    Ok((
        document,
        normalized,
        document_digest,
        target,
        artifact_digests,
        actions,
        plan_digest,
    ))
}

pub(crate) fn review_deployment_execution_for_request(
    database: &crate::db::Database,
    request: DeploymentExecutionReviewRequestV2,
) -> Result<DeploymentExecutionReviewV2, String> {
    let (
        document,
        normalized_runbook_text,
        document_digest,
        target,
        artifact_digests,
        actions,
        plan_digest,
    ) = review_material(&database, &request)?;
    let reviewed_at = now_ms();
    let review = DeploymentExecutionReviewV2 {
        schema_version: 2,
        review_id: format!("deployment-review:{}", uuid::Uuid::new_v4()),
        operation_id: request.operation_id,
        normalized_runbook_text,
        document_digest,
        plan_digest,
        deployment_id: document.deployment.id.clone(),
        application_id: document.deployment.application_id.clone(),
        environment: document.deployment.environment.clone(),
        version: document.deployment.version.clone(),
        artifact_digests,
        declared_risk: document.security.declared_risk,
        target,
        policy: request.policy,
        actions,
        reviewed_at,
        expires_at: reviewed_at + REVIEW_TTL_MS,
    };
    store_review(
        &database,
        &ReviewIdentity {
            review_id: &review.review_id,
            operation_id: &review.operation_id,
            kind: DeploymentOperationKind::Deployment,
            source_operation_id: None,
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
        &[(document.release.release_directory.as_str(), "newRelease")],
    )?;
    Ok(review)
}

#[tauri::command]
pub(crate) fn review_deployment_execution(
    database: State<'_, crate::db::Database>,
    request: DeploymentExecutionReviewRequestV2,
) -> Result<DeploymentExecutionReviewV2, String> {
    review_deployment_execution_for_request(&database, request)
}

struct DeploymentStateMachine {
    result: DeploymentExecutionResultV2,
}

impl DeploymentStateMachine {
    fn new(review: &DeploymentExecutionReviewV2, document: &DeploymentRunbookDocumentV2) -> Self {
        let actions = review
            .actions
            .iter()
            .enumerate()
            .map(|(index, action)| DeploymentExecutionActionResultV2 {
                action: action.clone(),
                child_operation_id: child_operation_id(&review.operation_id, index),
                status: DeploymentExecutionActionStatusV2::Pending,
                started_at: None,
                completed_at: None,
                exit_code: None,
                output: None,
                error: None,
            })
            .collect();
        let started_at = now_ms();
        Self {
            result: DeploymentExecutionResultV2 {
                schema_version: 2,
                operation_id: review.operation_id.clone(),
                review_id: review.review_id.clone(),
                document_digest: review.document_digest.clone(),
                plan_digest: review.plan_digest.clone(),
                deployment_id: review.deployment_id.clone(),
                version: review.version.clone(),
                target: review.target.clone(),
                phase: DeploymentExecutionPhaseV2::Pending,
                started_at,
                completed_at: started_at,
                actions,
                health_checks: Vec::new(),
                rollback_snapshot: DeploymentRollbackSnapshotV2 {
                    strategy: "reactivatePreviousRelease",
                    previous_release: None,
                    new_release: document.release.release_directory.clone(),
                    releases_directory: document.release.releases_directory.clone(),
                    active_symlink: document.release.active_symlink.clone(),
                    activation_changed: false,
                    captured_at: None,
                },
                error_category: None,
                error: None,
            },
        }
    }

    fn transition(&mut self, next: DeploymentExecutionPhaseV2) -> Result<(), String> {
        let allowed = match self.result.phase {
            DeploymentExecutionPhaseV2::Pending => matches!(
                next,
                DeploymentExecutionPhaseV2::PreparingArtifacts
                    | DeploymentExecutionPhaseV2::Unauthorized
                    | DeploymentExecutionPhaseV2::Cancelled
                    | DeploymentExecutionPhaseV2::TimedOut
                    | DeploymentExecutionPhaseV2::IdentityMismatch
                    | DeploymentExecutionPhaseV2::Failed
            ),
            DeploymentExecutionPhaseV2::PreparingArtifacts => matches!(
                next,
                DeploymentExecutionPhaseV2::InspectingTarget
                    | DeploymentExecutionPhaseV2::Cancelled
                    | DeploymentExecutionPhaseV2::TimedOut
                    | DeploymentExecutionPhaseV2::Failed
            ),
            DeploymentExecutionPhaseV2::InspectingTarget => matches!(
                next,
                DeploymentExecutionPhaseV2::CreatingRelease
                    | DeploymentExecutionPhaseV2::Cancelled
                    | DeploymentExecutionPhaseV2::TimedOut
                    | DeploymentExecutionPhaseV2::IdentityMismatch
                    | DeploymentExecutionPhaseV2::Failed
            ),
            DeploymentExecutionPhaseV2::CreatingRelease => matches!(
                next,
                DeploymentExecutionPhaseV2::StagingArtifacts
                    | DeploymentExecutionPhaseV2::Cancelled
                    | DeploymentExecutionPhaseV2::TimedOut
                    | DeploymentExecutionPhaseV2::IdentityMismatch
                    | DeploymentExecutionPhaseV2::Failed
            ),
            DeploymentExecutionPhaseV2::StagingArtifacts => matches!(
                next,
                DeploymentExecutionPhaseV2::ActivatingRelease
                    | DeploymentExecutionPhaseV2::Cancelled
                    | DeploymentExecutionPhaseV2::TimedOut
                    | DeploymentExecutionPhaseV2::IdentityMismatch
                    | DeploymentExecutionPhaseV2::Failed
            ),
            DeploymentExecutionPhaseV2::ActivatingRelease => matches!(
                next,
                DeploymentExecutionPhaseV2::ApplyingServices
                    | DeploymentExecutionPhaseV2::Verifying
                    | DeploymentExecutionPhaseV2::Cancelled
                    | DeploymentExecutionPhaseV2::TimedOut
                    | DeploymentExecutionPhaseV2::IdentityMismatch
                    | DeploymentExecutionPhaseV2::Failed
            ),
            DeploymentExecutionPhaseV2::ApplyingServices => matches!(
                next,
                DeploymentExecutionPhaseV2::Verifying
                    | DeploymentExecutionPhaseV2::Cancelled
                    | DeploymentExecutionPhaseV2::TimedOut
                    | DeploymentExecutionPhaseV2::IdentityMismatch
                    | DeploymentExecutionPhaseV2::Failed
            ),
            DeploymentExecutionPhaseV2::Verifying => matches!(
                next,
                DeploymentExecutionPhaseV2::Succeeded
                    | DeploymentExecutionPhaseV2::Cancelled
                    | DeploymentExecutionPhaseV2::TimedOut
                    | DeploymentExecutionPhaseV2::IdentityMismatch
                    | DeploymentExecutionPhaseV2::Failed
            ),
            _ => false,
        };
        if !allowed {
            return Err(format!(
                "invalid deployment execution transition: {:?} -> {:?}",
                self.result.phase, next
            ));
        }
        self.result.phase = next;
        Ok(())
    }

    fn finish_failure(&mut self, phase: DeploymentExecutionPhaseV2, category: &str, error: String) {
        if !self.result.phase.terminal() {
            let _ = self.transition(phase);
        }
        self.result.error_category = Some(category.to_string());
        self.result.error = Some(error);
        self.result.completed_at = now_ms();
    }

    fn finish_success(&mut self) -> Result<(), String> {
        self.transition(DeploymentExecutionPhaseV2::Succeeded)?;
        self.result.completed_at = now_ms();
        Ok(())
    }

    fn persist(&self, database: &crate::db::Database, execution_token: &str) -> Result<(), String> {
        checkpoint_operation(
            database,
            &self.result.operation_id,
            execution_token,
            phase_name(self.result.phase),
            self.result.phase.terminal(),
            &self.result,
        )
    }
}

fn phase_name(phase: DeploymentExecutionPhaseV2) -> &'static str {
    match phase {
        DeploymentExecutionPhaseV2::Pending => "pending",
        DeploymentExecutionPhaseV2::PreparingArtifacts => "preparingArtifacts",
        DeploymentExecutionPhaseV2::InspectingTarget => "inspectingTarget",
        DeploymentExecutionPhaseV2::CreatingRelease => "creatingRelease",
        DeploymentExecutionPhaseV2::StagingArtifacts => "stagingArtifacts",
        DeploymentExecutionPhaseV2::ActivatingRelease => "activatingRelease",
        DeploymentExecutionPhaseV2::ApplyingServices => "applyingServices",
        DeploymentExecutionPhaseV2::Verifying => "verifying",
        DeploymentExecutionPhaseV2::Succeeded => "succeeded",
        DeploymentExecutionPhaseV2::Failed => "failed",
        DeploymentExecutionPhaseV2::Cancelled => "cancelled",
        DeploymentExecutionPhaseV2::TimedOut => "timedOut",
        DeploymentExecutionPhaseV2::IdentityMismatch => "identityMismatch",
        DeploymentExecutionPhaseV2::Unauthorized => "unauthorized",
    }
}

fn child_operation_id(operation_id: &str, index: usize) -> String {
    let digest = sha256_digest("termbridge-deployment-child", operation_id.as_bytes());
    format!("deployment:{}:{index}", &digest[10..34])
}

fn terminal_from_cancel(
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Option<(DeploymentExecutionPhaseV2, &'static str, String)> {
    if cancelled.load(Ordering::SeqCst) {
        Some((
            DeploymentExecutionPhaseV2::Cancelled,
            "cancelled",
            "deployment execution was cancelled".to_string(),
        ))
    } else if Instant::now() >= deadline {
        Some((
            DeploymentExecutionPhaseV2::TimedOut,
            "timeout",
            "deployment execution exceeded its reviewed timeout".to_string(),
        ))
    } else {
        None
    }
}

fn wait_cancelable(
    duration: Duration,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        if let Some((_, _, error)) = terminal_from_cancel(cancelled, deadline) {
            return Err(error);
        }
        thread::sleep(Duration::from_millis(50).min(end.saturating_duration_since(Instant::now())));
    }
    Ok(())
}

#[derive(Debug)]
struct PreparedUpload {
    local_path: PathBuf,
    remote_relative_path: String,
    size: u64,
}

#[derive(Debug)]
struct PreparedArtifact {
    artifact_id: String,
    expected_sha256: String,
    target_path: String,
    uploads: Vec<PreparedUpload>,
}

#[derive(Debug)]
struct PreparedDeployment {
    _temporary_directory: tempfile::TempDir,
    artifacts: Vec<PreparedArtifact>,
}

fn ensure_not_cancelled(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    terminal_from_cancel(cancelled, deadline)
        .map(|(_, _, error)| Err(error))
        .unwrap_or(Ok(()))
}

fn copy_and_hash<R: Read>(
    mut source: R,
    destination: &mut File,
    maximum: u64,
    declared_maximum: Option<u64>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        ensure_not_cancelled(cancelled, deadline)?;
        let read = source
            .read(&mut buffer)
            .map_err(|error| format!("failed to read deployment artifact: {error}"))?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > maximum || declared_maximum.is_some_and(|declared| total > declared) {
            return Err("deployment artifact exceeded its reviewed byte bound".into());
        }
        hasher.update(&buffer[..read]);
        destination
            .write_all(&buffer[..read])
            .map_err(|error| format!("failed to stage deployment artifact: {error}"))?;
    }
    destination
        .flush()
        .map_err(|error| format!("failed to flush deployment artifact: {error}"))?;
    let encoded = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((total, encoded))
}

fn open_artifact_source(
    artifact: &crate::deployment_runbook::DeploymentArtifactV2,
    credential_account: Option<&str>,
    credentials: &CredentialManager,
    policy: &DeploymentExecutionPolicyV2,
) -> Result<Box<dyn Read>, String> {
    let uri = Url::parse(&artifact.source_uri)
        .map_err(|_| "deployment artifact URI became invalid after review".to_string())?;
    match uri.scheme() {
        "file" => {
            let path = uri
                .to_file_path()
                .map_err(|_| "deployment file URI does not resolve to a local path".to_string())?;
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("failed to inspect local deployment artifact: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("deployment file artifact must be a regular non-symlink file".into());
            }
            File::open(path)
                .map(|file| Box::new(file) as Box<dyn Read>)
                .map_err(|error| format!("failed to open local deployment artifact: {error}"))
        }
        "https" => {
            let client = reqwest::blocking::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(policy.artifact_timeout_seconds))
                .build()
                .map_err(|_| "failed to initialize the bounded artifact downloader".to_string())?;
            let mut request = client.get(uri);
            if let Some(account) = credential_account {
                let mut secret = credentials
                    .get_credential(DEPLOYMENT_SECRET_SERVICE, account)?
                    .ok_or_else(|| {
                        format!("deployment artifact credential {account} is unavailable")
                    })?;
                if secret.is_empty()
                    || secret.contains(|character| matches!(character, '\r' | '\n'))
                {
                    return Err("deployment artifact credential is invalid".into());
                }
                request = request.bearer_auth(&secret);
                secret.zeroize();
            }
            let response = request
                .send()
                .map_err(|_| "bounded HTTPS artifact download failed".to_string())?;
            if !response.status().is_success() {
                return Err(format!(
                    "artifact server returned HTTP status {}",
                    response.status().as_u16()
                ));
            }
            if response
                .content_length()
                .is_some_and(|size| size > policy.max_artifact_bytes)
            {
                return Err("deployment artifact Content-Length exceeds the reviewed bound".into());
            }
            Ok(Box::new(response))
        }
        _ => Err("unsupported deployment artifact source scheme".into()),
    }
}

fn deployment_credential_account<'a>(
    document: &'a DeploymentRunbookDocumentV2,
    artifact: &crate::deployment_runbook::DeploymentArtifactV2,
) -> Result<Option<&'a str>, String> {
    let Some(reference_id) = artifact.credential_ref.as_deref() else {
        return Ok(None);
    };
    let reference = document
        .security
        .secret_refs
        .iter()
        .find(|reference| reference.id == reference_id)
        .ok_or_else(|| {
            "deployment artifact credential reference changed after review".to_string()
        })?;
    reference
        .keychain_ref
        .strip_prefix("keychain://deployment/")
        .map(Some)
        .ok_or_else(|| "deployment artifact keychain reference changed after review".to_string())
}

fn stripped_archive_path(path: &Path, strip_components: u8) -> Result<Option<PathBuf>, String> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_string_lossy();
                if value.is_empty()
                    || value == "."
                    || value == ".."
                    || value.contains(|character| matches!(character, '/' | '\\'))
                    || value.chars().any(char::is_control)
                {
                    return Err("deployment archive contains an unsafe path".into());
                }
                components.push(value.into_owned());
            }
            _ => return Err("deployment archive contains an absolute or traversing path".into()),
        }
    }
    let stripped = components
        .into_iter()
        .skip(strip_components as usize)
        .collect::<Vec<_>>();
    if stripped.is_empty() {
        Ok(None)
    } else {
        Ok(Some(stripped.iter().collect()))
    }
}

fn extracted_remote_path(destination: &str, relative: &Path) -> String {
    let suffix = relative
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if destination == "." {
        suffix
    } else {
        format!("{destination}/{suffix}")
    }
}

fn register_expanded_entry(
    entries: &mut u32,
    bytes: &mut u64,
    size: u64,
    policy: &DeploymentExecutionPolicyV2,
) -> Result<(), String> {
    *entries = entries.saturating_add(1);
    *bytes = bytes.saturating_add(size);
    if *entries > policy.max_archive_entries || *bytes > policy.max_expanded_bytes {
        return Err("deployment archive expansion exceeds its reviewed safety bound".into());
    }
    Ok(())
}

fn copy_expanded_file<R: Read>(
    source: &mut R,
    destination: &mut File,
    expected_size: u64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        ensure_not_cancelled(cancelled, deadline)?;
        let read = source
            .read(&mut buffer)
            .map_err(|error| format!("failed to read deployment archive file: {error}"))?;
        if read == 0 {
            break;
        }
        copied = copied.saturating_add(read as u64);
        if copied > expected_size {
            return Err("deployment archive entry exceeded its declared size".into());
        }
        destination
            .write_all(&buffer[..read])
            .map_err(|error| format!("failed to extract deployment archive file: {error}"))?;
    }
    if copied != expected_size {
        return Err("deployment archive entry did not match its declared size".into());
    }
    Ok(())
}

fn extract_tar<R: Read>(
    source: R,
    destination: &Path,
    unpack: &crate::deployment_runbook::DeploymentArtifactUnpackV2,
    policy: &DeploymentExecutionPolicyV2,
    entries: &mut u32,
    bytes: &mut u64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<PreparedUpload>, String> {
    let mut archive = tar::Archive::new(source);
    let mut uploads = Vec::new();
    for entry in archive
        .entries()
        .map_err(|error| format!("failed to inspect deployment tar archive: {error}"))?
    {
        ensure_not_cancelled(cancelled, deadline)?;
        let mut entry =
            entry.map_err(|error| format!("failed to read deployment tar entry: {error}"))?;
        let entry_type = entry.header().entry_type();
        if !(entry_type.is_file() || entry_type.is_dir()) {
            return Err("deployment archive contains a link or special entry".into());
        }
        let path = entry
            .path()
            .map_err(|_| "deployment archive contains a malformed path".to_string())?;
        let Some(relative) = stripped_archive_path(&path, unpack.strip_components)? else {
            continue;
        };
        let local_path = destination.join(&relative);
        if entry_type.is_dir() {
            fs::create_dir_all(&local_path)
                .map_err(|error| format!("failed to prepare archive directory: {error}"))?;
            register_expanded_entry(entries, bytes, 0, policy)?;
            continue;
        }
        let size = entry.size();
        register_expanded_entry(entries, bytes, size, policy)?;
        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to prepare archive parent: {error}"))?;
        }
        let mut output = File::create(&local_path)
            .map_err(|error| format!("failed to create staged archive file: {error}"))?;
        copy_expanded_file(&mut entry, &mut output, size, cancelled, deadline)?;
        uploads.push(PreparedUpload {
            local_path,
            remote_relative_path: extracted_remote_path(&unpack.destination_path, &relative),
            size,
        });
    }
    Ok(uploads)
}

fn extract_zip(
    source: &mut File,
    destination: &Path,
    unpack: &crate::deployment_runbook::DeploymentArtifactUnpackV2,
    policy: &DeploymentExecutionPolicyV2,
    entries: &mut u32,
    bytes: &mut u64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<PreparedUpload>, String> {
    source
        .rewind()
        .map_err(|error| format!("failed to rewind deployment zip: {error}"))?;
    let mut archive = zip::ZipArchive::new(source)
        .map_err(|error| format!("failed to inspect deployment zip archive: {error}"))?;
    let mut uploads = Vec::new();
    for index in 0..archive.len() {
        ensure_not_cancelled(cancelled, deadline)?;
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to read deployment zip entry: {error}"))?;
        if let Some(kind) = entry.unix_mode().map(|mode| mode & S_IFMT) {
            if !matches!(kind, 0 | S_IFREG | S_IFDIR) {
                return Err("deployment archive contains a link or special entry".into());
            }
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "deployment zip contains an unsafe path".to_string())?;
        let Some(relative) = stripped_archive_path(&enclosed, unpack.strip_components)? else {
            continue;
        };
        let local_path = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&local_path)
                .map_err(|error| format!("failed to prepare zip directory: {error}"))?;
            register_expanded_entry(entries, bytes, 0, policy)?;
            continue;
        }
        let size = entry.size();
        register_expanded_entry(entries, bytes, size, policy)?;
        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to prepare zip parent: {error}"))?;
        }
        let mut output = File::create(&local_path)
            .map_err(|error| format!("failed to create staged zip file: {error}"))?;
        copy_expanded_file(&mut entry, &mut output, size, cancelled, deadline)?;
        uploads.push(PreparedUpload {
            local_path,
            remote_relative_path: extracted_remote_path(&unpack.destination_path, &relative),
            size,
        });
    }
    Ok(uploads)
}

fn prepare_artifacts(
    document: &DeploymentRunbookDocumentV2,
    credentials: &CredentialManager,
    policy: &DeploymentExecutionPolicyV2,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<PreparedDeployment, String> {
    let temporary_directory = tempfile::tempdir()
        .map_err(|error| format!("failed to create private artifact staging directory: {error}"))?;
    let mut prepared = Vec::new();
    let mut remote_paths = HashSet::new();
    let mut expanded_entries = 0_u32;
    let mut expanded_bytes = 0_u64;
    for (index, artifact) in document.artifacts.iter().enumerate() {
        ensure_not_cancelled(cancelled, deadline)?;
        let staged_path = temporary_directory.path().join(format!("artifact-{index}"));
        let mut staged = File::create(&staged_path)
            .map_err(|error| format!("failed to create artifact staging file: {error}"))?;
        let credential_account = deployment_credential_account(document, artifact)?;
        let source = open_artifact_source(artifact, credential_account, credentials, policy)?;
        let (size, digest) = copy_and_hash(
            source,
            &mut staged,
            policy.max_artifact_bytes,
            artifact.size_bytes,
            cancelled,
            deadline,
        )?;
        if digest != artifact.sha256 {
            return Err(format!(
                "deployment artifact {} SHA-256 digest mismatch",
                artifact.id
            ));
        }
        if !remote_paths.insert(artifact.target_path.clone()) {
            return Err("deployment artifacts resolve to a duplicate remote path".into());
        }
        let mut uploads = vec![PreparedUpload {
            local_path: staged_path.clone(),
            remote_relative_path: artifact.target_path.clone(),
            size,
        }];
        if artifact.kind == DeploymentArtifactKindV2::Archive {
            let unpack = artifact
                .unpack
                .as_ref()
                .expect("validated archive unpack metadata");
            let extraction_root = temporary_directory.path().join(format!("expanded-{index}"));
            fs::create_dir(&extraction_root)
                .map_err(|error| format!("failed to create archive staging root: {error}"))?;
            let mut archive_file = File::open(&staged_path)
                .map_err(|error| format!("failed to reopen verified archive: {error}"))?;
            let expanded = match unpack.format {
                DeploymentArchiveFormatV2::Tar => extract_tar(
                    archive_file,
                    &extraction_root,
                    unpack,
                    policy,
                    &mut expanded_entries,
                    &mut expanded_bytes,
                    cancelled,
                    deadline,
                )?,
                DeploymentArchiveFormatV2::TarGz => extract_tar(
                    GzDecoder::new(archive_file),
                    &extraction_root,
                    unpack,
                    policy,
                    &mut expanded_entries,
                    &mut expanded_bytes,
                    cancelled,
                    deadline,
                )?,
                DeploymentArchiveFormatV2::Zip => extract_zip(
                    &mut archive_file,
                    &extraction_root,
                    unpack,
                    policy,
                    &mut expanded_entries,
                    &mut expanded_bytes,
                    cancelled,
                    deadline,
                )?,
            };
            for upload in &expanded {
                if !remote_paths.insert(upload.remote_relative_path.clone()) {
                    return Err(format!(
                        "deployment archive {} collides with another staged path",
                        artifact.id
                    ));
                }
            }
            uploads.extend(expanded);
        }
        prepared.push(PreparedArtifact {
            artifact_id: artifact.id.clone(),
            expected_sha256: artifact.sha256.clone(),
            target_path: artifact.target_path.clone(),
            uploads,
        });
    }
    Ok(PreparedDeployment {
        _temporary_directory: temporary_directory,
        artifacts: prepared,
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn semantic_shell(privileged: bool, script: &str, arguments: &[&str]) -> String {
    let prefix = if privileged { "sudo -n sh -c" } else { "sh -c" };
    let arguments = arguments
        .iter()
        .map(|argument| shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{prefix} {} termbridge {arguments}", shell_quote(script))
}

fn inspect_release_command(document: &DeploymentRunbookDocumentV2) -> String {
    const SCRIPT: &str = r#"set -eu
check_chain() {
  target=$1
  current=
  old_ifs=$IFS
  IFS=/
  set -- $target
  IFS=$old_ifs
  for segment do
    [ -n "$segment" ] || continue
    current=$current/$segment
    if [ -L "$current" ]; then
      exit 41
    fi
  done
}
root=$1
releases=$2
release=$3
active=$4
check_chain "$root"
check_chain "$releases"
check_chain "$release"
if [ -e "$release" ] || [ -L "$release" ]; then
  exit 42
fi
if [ -L "$active" ]; then
  previous=$(readlink -f -- "$active") || exit 43
  case "$previous" in
    "$releases"/*) printf '%s\n' "$previous" ;;
    *) exit 44 ;;
  esac
elif [ -e "$active" ]; then
  exit 45
else
  printf 'NONE\n'
fi"#;
    semantic_shell(
        document.security.allow_privilege_escalation,
        SCRIPT,
        &[
            &document.release.root_directory,
            &document.release.releases_directory,
            &document.release.release_directory,
            &document.release.active_symlink,
        ],
    )
}

fn create_release_command(
    document: &DeploymentRunbookDocumentV2,
    target: &FrozenTargetIdentity,
) -> String {
    const SCRIPT: &str = r#"set -eu
ensure_dir() {
  target=$1
  current=
  old_ifs=$IFS
  IFS=/
  set -- $target
  IFS=$old_ifs
  for segment do
    [ -n "$segment" ] || continue
    current=$current/$segment
    if [ -L "$current" ]; then
      exit 51
    elif [ -e "$current" ]; then
      [ -d "$current" ] || exit 52
    else
      mkdir -- "$current"
    fi
  done
}
releases=$1
release=$2
owner=$3
ensure_dir "$releases"
if [ -e "$release" ] || [ -L "$release" ]; then
  exit 53
fi
mkdir -- "$release"
if [ "$owner" != NONE ]; then
  chown -- "$owner" "$release"
fi"#;
    let owner = if document.security.allow_privilege_escalation {
        target.username.as_str()
    } else {
        "NONE"
    };
    semantic_shell(
        document.security.allow_privilege_escalation,
        SCRIPT,
        &[
            &document.release.releases_directory,
            &document.release.release_directory,
            owner,
        ],
    )
}

fn activation_temp_path(document: &DeploymentRunbookDocumentV2, operation_id: &str) -> String {
    let digest = sha256_digest("termbridge-deployment-activation", operation_id.as_bytes());
    let parent = document
        .release
        .active_symlink
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .filter(|parent| !parent.is_empty())
        .unwrap_or("/");
    format!(
        "{}/.termbridge-activate-{}",
        parent.trim_end_matches('/'),
        &digest[10..34]
    )
}

fn activate_release_command(
    document: &DeploymentRunbookDocumentV2,
    operation_id: &str,
    previous_release: Option<&str>,
) -> String {
    const SCRIPT: &str = r#"set -eu
release=$1
active=$2
expected=$3
temporary=$4
if [ -L "$release" ] || [ ! -d "$release" ]; then
  exit 61
fi
if [ "$expected" = NONE ]; then
  if [ -e "$active" ] || [ -L "$active" ]; then
    exit 62
  fi
else
  [ -L "$active" ] || exit 63
  current=$(readlink -f -- "$active") || exit 64
  [ "$current" = "$expected" ] || exit 65
fi
if [ -e "$temporary" ] || [ -L "$temporary" ]; then
  exit 66
fi
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT HUP INT TERM
ln -s -- "$release" "$temporary"
mv -Tf -- "$temporary" "$active"
trap - EXIT HUP INT TERM"#;
    let expected = previous_release.unwrap_or("NONE");
    semantic_shell(
        document.security.allow_privilege_escalation,
        SCRIPT,
        &[
            &document.release.release_directory,
            &document.release.active_symlink,
            expected,
            &activation_temp_path(document, operation_id),
        ],
    )
}

fn service_command(
    document: &DeploymentRunbookDocumentV2,
    action: DeploymentServiceActionKindV2,
    unit: &str,
) -> String {
    let action = match action {
        DeploymentServiceActionKindV2::Start => "start",
        DeploymentServiceActionKindV2::Restart => "restart",
        DeploymentServiceActionKindV2::Reload => "reload",
    };
    let prefix = if document.security.allow_privilege_escalation {
        "sudo -n "
    } else {
        ""
    };
    format!("{prefix}systemctl {action} -- {}", shell_quote(unit))
}

fn service_health_command(unit: &str) -> String {
    format!("systemctl is-active -- {}", shell_quote(unit))
}

fn http_health_command(url: &str, timeout_seconds: u64) -> String {
    format!(
        "curl --silent --show-error --output /dev/null --write-out '%{{http_code}}' --max-redirs 0 --proto '=http,https' --max-time {timeout_seconds} -- {}",
        shell_quote(url)
    )
}

fn action_output_policy() -> ExecutionOutputPolicy {
    ExecutionOutputPolicy::new(
        ACTION_STDOUT_BYTES,
        ACTION_STDERR_BYTES,
        ACTION_TOTAL_READ_BYTES,
    )
    .expect("deployment action output policy is bounded")
}

fn execution_category_name(category: Option<ExecutionErrorCategory>) -> &'static str {
    match category {
        Some(ExecutionErrorCategory::InvalidRequest) => "invalidRequest",
        Some(ExecutionErrorCategory::TargetMismatch)
        | Some(ExecutionErrorCategory::TargetNotFound) => "identityMismatch",
        Some(ExecutionErrorCategory::CredentialUnavailable) => "credentialUnavailable",
        Some(ExecutionErrorCategory::HostKeyRejected) => "hostKey",
        Some(ExecutionErrorCategory::ConnectionFailed) => "connection",
        Some(ExecutionErrorCategory::ChannelOpenFailed) => "channelOpenFailed",
        Some(ExecutionErrorCategory::CommandStartFailed) => "commandStartFailed",
        Some(ExecutionErrorCategory::OutputLimitExceeded) => "outputLimit",
        Some(ExecutionErrorCategory::TransportFailed) => "transportFailed",
        Some(ExecutionErrorCategory::Cancelled) => "cancelled",
        Some(ExecutionErrorCategory::TimedOut) => "timedOut",
        Some(ExecutionErrorCategory::WorkerStopped) => "workerStopped",
        None => "remoteAction",
    }
}

fn reviewed_result_identity_matches(
    expected_operation_id: &str,
    expected_target: &FrozenTargetIdentity,
    result: &ReviewedSshExecutionResult,
) -> bool {
    result.operation_id == expected_operation_id && result.target == *expected_target
}

fn run_reviewed_action(
    database: &crate::db::Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    machine: &mut DeploymentStateMachine,
    index: usize,
    command: String,
    preview: String,
    target: &FrozenTargetIdentity,
    connection: &RemoteConnectionRequest,
    cancelled: &Arc<AtomicBool>,
    deadline: Instant,
    attempt: Option<u8>,
    execution_token: &str,
) -> Result<ReviewedSshExecutionResult, String> {
    ensure_not_cancelled(cancelled, deadline)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining < Duration::from_secs(1) {
        return Err("deployment execution exceeded its reviewed timeout".into());
    }
    let (child_operation_id, timeout) = {
        let action = machine
            .result
            .actions
            .get_mut(index)
            .ok_or_else(|| "deployment action plan index is invalid".to_string())?;
        action.status = DeploymentExecutionActionStatusV2::Running;
        action.started_at = Some(now_ms());
        let child_operation_id = attempt.map_or_else(
            || action.child_operation_id.clone(),
            |attempt| format!("{}:attempt-{attempt}", action.child_operation_id),
        );
        let timeout = Duration::from_secs(action.action.timeout_seconds).min(remaining);
        (child_operation_id, timeout)
    };
    machine.persist(database, execution_token)?;
    let reviewed = ReviewedSshExecutionRequest {
        operation_id: child_operation_id.clone(),
        target: target.clone(),
        connection: connection.clone(),
        command: ReviewedSshCommand::new(command, preview, Vec::new())
            .map_err(|error| error.message.to_string())?,
        timeout,
        output_policy: action_output_policy(),
    };

    let watcher_done = Arc::new(AtomicBool::new(false));
    let watcher_done_clone = Arc::clone(&watcher_done);
    let cancelled_clone = Arc::clone(cancelled);
    let cancellations_clone = cancellations.clone();
    let watched_operation = child_operation_id.clone();
    let watcher = thread::spawn(move || {
        while !watcher_done_clone.load(Ordering::SeqCst) {
            if cancelled_clone.load(Ordering::SeqCst) {
                let _ = cancellations_clone.cancel(&watched_operation);
            }
            thread::sleep(Duration::from_millis(25));
        }
    });
    let result = execute_reviewed_ssh_command(
        database,
        credentials,
        cancellations,
        known_hosts_path,
        reviewed,
    );
    watcher_done.store(true, Ordering::SeqCst);
    let _ = watcher.join();

    let outcome = {
        let action = &mut machine.result.actions[index];
        action.completed_at = Some(now_ms());
        action.exit_code = result.exit_code;
        if !result.stdout.trim().is_empty() {
            action.output = Some(result.stdout.trim().to_string());
        }
        if !reviewed_result_identity_matches(&child_operation_id, target, &result) {
            action.status = DeploymentExecutionActionStatusV2::IdentityMismatch;
            action.error =
                Some("deployment action returned a mismatched operation or target identity".into());
            Err(action.error.clone().expect("identity error"))
        } else {
            match result.status {
                ExecutionStatus::Completed if result.exit_code == Some(0) => {
                    action.status = DeploymentExecutionActionStatusV2::Succeeded;
                    Ok(())
                }
                ExecutionStatus::Cancelled => {
                    action.status = DeploymentExecutionActionStatusV2::Cancelled;
                    action.error = Some("deployment action was cancelled".into());
                    Err(action.error.clone().expect("cancel error"))
                }
                ExecutionStatus::TimedOut => {
                    action.status = DeploymentExecutionActionStatusV2::TimedOut;
                    action.error = Some("deployment action timed out".into());
                    Err(action.error.clone().expect("timeout error"))
                }
                _ => {
                    action.status = DeploymentExecutionActionStatusV2::Failed;
                    let error = result.error.clone().unwrap_or_else(|| {
                        format!(
                            "deployment action failed with exit code {:?}",
                            result.exit_code
                        )
                    });
                    action.error = Some(error.clone());
                    Err(format!(
                        "{}: {error}",
                        execution_category_name(result.error_category)
                    ))
                }
            }
        }
    };
    machine.persist(database, execution_token)?;
    outcome.map(|()| result)
}

fn remote_kind(stat: &ssh2::FileStat) -> Option<u32> {
    stat.perm.map(|permissions| permissions & S_IFMT)
}

fn safe_relative_segments(path: &str) -> Result<Vec<&str>, String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains("//")
        || path.contains('\\')
    {
        return Err("deployment remote path is not a normalized relative path".into());
    }
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.iter().any(|segment| {
        segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || !segment.is_ascii()
            || segment.chars().any(|character| {
                !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
            })
    }) {
        return Err("deployment remote path contains an unsafe segment".into());
    }
    Ok(segments)
}

fn ensure_remote_directory_secure(
    sftp: &ssh2::Sftp,
    release_directory: &Path,
    relative_parent: &Path,
) -> Result<(), String> {
    ensure_remote_absolute_directory_chain(sftp, release_directory)?;
    let mut current = release_directory.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(segment) = component else {
            return Err("deployment upload parent escaped the release directory".into());
        };
        current.push(segment);
        match sftp.lstat(&current) {
            Ok(stat) if remote_kind(&stat) == Some(S_IFDIR) => {}
            Ok(stat) if remote_kind(&stat) == Some(S_IFLNK) => {
                return Err("deployment upload parent contains a symlink".into())
            }
            Ok(_) => return Err("deployment upload parent is not a directory".into()),
            Err(_) => {
                sftp.mkdir(&current, SFTP_DIRECTORY_MODE).map_err(|error| {
                    format!("failed to create deployment upload directory: {error}")
                })?;
                let stat = sftp.lstat(&current).map_err(|error| {
                    format!("failed to verify deployment upload directory: {error}")
                })?;
                if remote_kind(&stat) != Some(S_IFDIR) {
                    return Err(
                        "created deployment upload directory failed lstat verification".into(),
                    );
                }
            }
        }
    }
    Ok(())
}

fn ensure_remote_absolute_directory_chain(
    sftp: &ssh2::Sftp,
    directory: &Path,
) -> Result<(), String> {
    if !directory.is_absolute() {
        return Err("deployment release directory is not absolute".into());
    }
    let mut current = PathBuf::from("/");
    for component in directory.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(segment) => current.push(segment),
            _ => return Err("deployment release directory contains an unsafe component".into()),
        }
        let stat = sftp
            .lstat(&current)
            .map_err(|error| format!("failed to inspect release directory chain: {error}"))?;
        match remote_kind(&stat) {
            Some(S_IFDIR) => {}
            Some(S_IFLNK) => {
                return Err("deployment release directory chain contains a symlink".into())
            }
            _ => return Err("deployment release directory chain is not a directory".into()),
        }
    }
    Ok(())
}

fn upload_prepared_file(
    sftp: &ssh2::Sftp,
    release_directory: &Path,
    upload: &PreparedUpload,
    temporary_suffix: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    ensure_not_cancelled(cancelled, deadline)?;
    let segments = safe_relative_segments(&upload.remote_relative_path)?;
    let relative = segments.iter().collect::<PathBuf>();
    let target = release_directory.join(&relative);
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    ensure_remote_directory_secure(sftp, release_directory, parent)?;
    if sftp.lstat(&target).is_ok() {
        return Err(format!(
            "deployment upload target already exists: {}",
            upload.remote_relative_path
        ));
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| "deployment upload target has no file name".to_string())?
        .to_string_lossy();
    let temporary =
        target.with_file_name(format!(".{file_name}.termbridge-{temporary_suffix}.part"));
    if sftp.lstat(&temporary).is_ok() {
        return Err("deployment upload temporary path already exists".into());
    }
    let result = (|| {
        let mut source = File::open(&upload.local_path)
            .map_err(|error| format!("failed to reopen staged deployment file: {error}"))?;
        let mut destination = sftp
            .open_mode(
                &temporary,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
                SFTP_FILE_MODE,
                OpenType::File,
            )
            .map_err(|error| format!("failed to create remote deployment file: {error}"))?;
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            ensure_not_cancelled(cancelled, deadline)?;
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("failed to read staged deployment file: {error}"))?;
            if read == 0 {
                break;
            }
            destination
                .write_all(&buffer[..read])
                .map_err(|error| format!("failed to upload deployment file: {error}"))?;
            copied = copied.saturating_add(read as u64);
        }
        destination
            .flush()
            .map_err(|error| format!("failed to flush remote deployment file: {error}"))?;
        drop(destination);
        if copied != upload.size {
            return Err("deployment upload byte count changed during transfer".into());
        }
        let stat = sftp
            .lstat(&temporary)
            .map_err(|error| format!("failed to verify remote deployment file: {error}"))?;
        if remote_kind(&stat) != Some(S_IFREG) || stat.size != Some(upload.size) {
            return Err("remote deployment file failed type or size verification".into());
        }
        if sftp.lstat(&target).is_ok() {
            return Err("deployment upload target appeared before atomic rename".into());
        }
        sftp.rename(&temporary, &target, None)
            .map_err(|error| format!("failed to activate staged deployment file: {error}"))?;
        let stat = sftp
            .lstat(&target)
            .map_err(|error| format!("failed to verify activated deployment file: {error}"))?;
        if remote_kind(&stat) != Some(S_IFREG) || stat.size != Some(upload.size) {
            return Err("activated deployment file failed type or size verification".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = sftp.unlink(&temporary);
    }
    result
}

fn stage_artifact_sftp(
    database: &crate::db::Database,
    credentials: &CredentialManager,
    pool: &SftpPool,
    known_hosts_path: &Path,
    review: &DeploymentExecutionReviewV2,
    document: &DeploymentRunbookDocumentV2,
    connection: &RemoteConnectionRequest,
    artifact: &PreparedArtifact,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    revalidate_frozen_target_identity(database, &review.target, connection)
        .map_err(|error| format!("identityMismatch: {}", error.message))?;
    let mut hydrated = connection.clone();
    crate::commands::resolve_keychain_key_for_remote(credentials, &mut hydrated)
        .map_err(|_| "deployment SSH credential is unavailable".to_string())?;
    let connected = crate::connection::connect_sftp_with_abort(
        &hydrated,
        Some(pool),
        Some(known_hosts_path),
        Some(cancelled),
    )
    .map_err(|error| format!("failed to establish reviewed deployment SFTP: {error:?}"))?;
    ensure_not_cancelled(cancelled, deadline)?;
    let guard = connected
        .lock()
        .map_err(|_| "deployment SFTP connection lock is unavailable".to_string())?;
    let _timeout = crate::connection::TransferTimeoutGuard::new(&guard.session);
    let release_directory = Path::new(&document.release.release_directory);
    let suffix_digest = sha256_digest(
        "termbridge-deployment-upload",
        format!("{}:{}", review.operation_id, artifact.artifact_id).as_bytes(),
    );
    let suffix = &suffix_digest[10..26];
    for upload in &artifact.uploads {
        upload_prepared_file(
            &guard.sftp,
            release_directory,
            upload,
            suffix,
            cancelled,
            deadline,
        )?;
    }
    Ok(())
}

fn is_safe_previous_release(previous: &str, releases_directory: &str) -> bool {
    previous
        .strip_prefix(releases_directory)
        .is_some_and(|suffix| {
            suffix.starts_with('/')
                && suffix.len() > 1
                && !suffix.contains("//")
                && !suffix.contains('\\')
                && suffix[1..].split('/').all(|segment| {
                    !segment.is_empty()
                        && segment != "."
                        && segment != ".."
                        && segment.is_ascii()
                        && segment.chars().all(|character| {
                            character.is_ascii_alphanumeric()
                                || matches!(character, '.' | '_' | '-')
                        })
                })
        })
}

fn approval_matches_review(
    approval: &DeploymentExecutionApprovalV2,
    review: &DeploymentExecutionReviewV2,
) -> bool {
    approval.review_id == review.review_id
        && approval.operation_id == review.operation_id
        && approval.document_digest == review.document_digest
        && approval.plan_digest == review.plan_digest
        && approval.target_digest == review.target.identity_digest
        && approval.approved_risk == review.declared_risk
        && approval.authorized
        && (review.declared_risk != RunbookRisk::Destructive || approval.destructive_confirmed)
        && review.expires_at > now_ms()
}

fn current_material_matches_review(
    review: &DeploymentExecutionReviewV2,
    normalized: &str,
    document_digest: &str,
    target: &FrozenTargetIdentity,
    artifact_digests: &[DeploymentArtifactDigestBindingV2],
    actions: &[DeploymentExecutionActionV2],
    plan_digest: &str,
) -> bool {
    normalized == review.normalized_runbook_text
        && document_digest == review.document_digest
        && target == &review.target
        && artifact_digests == review.artifact_digests
        && actions == review.actions
        && plan_digest == review.plan_digest
}

fn classify_orchestration_failure(
    machine: &DeploymentStateMachine,
    cancelled: &AtomicBool,
    deadline: Instant,
    error: &str,
) -> (DeploymentExecutionPhaseV2, &'static str) {
    if machine
        .result
        .actions
        .iter()
        .any(|action| action.status == DeploymentExecutionActionStatusV2::IdentityMismatch)
        || error.starts_with("identityMismatch:")
    {
        (
            DeploymentExecutionPhaseV2::IdentityMismatch,
            "identityMismatch",
        )
    } else if cancelled.load(Ordering::SeqCst) || error.contains("was cancelled") {
        (DeploymentExecutionPhaseV2::Cancelled, "cancelled")
    } else if Instant::now() >= deadline || error.contains("timed out") || error.contains("timeout")
    {
        (DeploymentExecutionPhaseV2::TimedOut, "timeout")
    } else if error.starts_with("outputLimit:") {
        (DeploymentExecutionPhaseV2::Failed, "outputLimit")
    } else {
        (DeploymentExecutionPhaseV2::Failed, "deployment")
    }
}

fn fail_machine(
    machine: &mut DeploymentStateMachine,
    cancelled: &AtomicBool,
    deadline: Instant,
    error: String,
) {
    let (phase, category) = classify_orchestration_failure(machine, cancelled, deadline, &error);
    machine.finish_failure(phase, category, error);
}

fn mark_direct_action_started(
    machine: &mut DeploymentStateMachine,
    index: usize,
    database: &crate::db::Database,
    execution_token: &str,
) -> Result<(), String> {
    let action = machine
        .result
        .actions
        .get_mut(index)
        .ok_or_else(|| "deployment direct action index is invalid".to_string())?;
    action.status = DeploymentExecutionActionStatusV2::Running;
    action.started_at = Some(now_ms());
    machine.persist(database, execution_token)
}

fn mark_direct_action_finished(
    machine: &mut DeploymentStateMachine,
    index: usize,
    outcome: &Result<(), String>,
    database: &crate::db::Database,
    execution_token: &str,
) -> Result<(), String> {
    let action = &mut machine.result.actions[index];
    action.completed_at = Some(now_ms());
    match outcome {
        Ok(()) => action.status = DeploymentExecutionActionStatusV2::Succeeded,
        Err(error) if error.starts_with("identityMismatch:") => {
            action.status = DeploymentExecutionActionStatusV2::IdentityMismatch;
            action.error = Some(error.clone());
        }
        Err(error) if error.contains("cancelled") => {
            action.status = DeploymentExecutionActionStatusV2::Cancelled;
            action.error = Some(error.clone());
        }
        Err(error) if error.contains("timeout") => {
            action.status = DeploymentExecutionActionStatusV2::TimedOut;
            action.error = Some(error.clone());
        }
        Err(error) => {
            action.status = DeploymentExecutionActionStatusV2::Failed;
            action.error = Some(error.clone());
        }
    }
    machine.persist(database, execution_token)
}

#[allow(clippy::too_many_arguments)]
fn execute_consumed_review(
    app: &AppHandle,
    database: &crate::db::Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    pool: &SftpPool,
    review: &DeploymentExecutionReviewV2,
    request: &DeploymentExecutionRequestV2,
    cancelled: &Arc<AtomicBool>,
    execution_token: &str,
) -> DeploymentExecutionResultV2 {
    let expected_document = parse_deployment_runbook_v2(&review.normalized_runbook_text)
        .expect("issued deployment review stores a validated canonical document");
    let mut machine = DeploymentStateMachine::new(review, &expected_document);
    let deadline = Instant::now() + Duration::from_secs(review.policy.total_timeout_seconds);

    if !approval_matches_review(&request.approval, review)
        || request.operation_id != review.operation_id
        || request.profile_id != review.target.profile_id
    {
        machine.finish_failure(
            DeploymentExecutionPhaseV2::Unauthorized,
            "approvalMismatch",
            "deployment approval does not match the exact reviewed operation, target, plan, risk, or confirmation".into(),
        );
        return machine.result;
    }

    let current_request = DeploymentExecutionReviewRequestV2 {
        operation_id: request.operation_id.clone(),
        runbook_text: request.runbook_text.clone(),
        profile_id: request.profile_id.clone(),
        connection: request.connection.clone(),
        policy: review.policy.clone(),
    };
    let current = match review_material(database, &current_request) {
        Ok(current) => current,
        Err(error) => {
            let phase = if error.contains("target")
                || error.contains("profile")
                || error.contains("identity")
            {
                DeploymentExecutionPhaseV2::IdentityMismatch
            } else {
                DeploymentExecutionPhaseV2::Unauthorized
            };
            machine.finish_failure(phase, "reviewRevalidation", error);
            return machine.result;
        }
    };
    let (document, normalized, document_digest, target, artifact_digests, actions, plan_digest) =
        current;
    if !current_material_matches_review(
        review,
        &normalized,
        &document_digest,
        &target,
        &artifact_digests,
        &actions,
        &plan_digest,
    ) {
        machine.finish_failure(
            DeploymentExecutionPhaseV2::Unauthorized,
            "reviewMismatch",
            "deployment document, artifact digest, target, timeout policy, or semantic plan changed after review".into(),
        );
        return machine.result;
    }

    if let Err(error) = machine.transition(DeploymentExecutionPhaseV2::PreparingArtifacts) {
        machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
        return machine.result;
    }
    let prepared =
        match prepare_artifacts(&document, credentials, &review.policy, cancelled, deadline) {
            Ok(prepared) => prepared,
            Err(error) => {
                fail_machine(&mut machine, cancelled, deadline, error);
                return machine.result;
            }
        };
    if let Some((phase, category, error)) = terminal_from_cancel(cancelled, deadline) {
        machine.finish_failure(phase, category, error);
        return machine.result;
    }
    let known_hosts_path = match crate::known_hosts::known_hosts_path(app) {
        Ok(path) => path,
        Err(error) => {
            machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "hostKey", error);
            return machine.result;
        }
    };

    if let Err(error) = machine.transition(DeploymentExecutionPhaseV2::InspectingTarget) {
        machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
        return machine.result;
    }
    let inspect = run_reviewed_action(
        database,
        credentials,
        cancellations,
        &known_hosts_path,
        &mut machine,
        0,
        inspect_release_command(&document),
        format!(
            "inspect release roots and previous activation for {}",
            document.release.active_symlink
        ),
        &review.target,
        &request.connection,
        cancelled,
        deadline,
        None,
        execution_token,
    );
    let inspect = match inspect {
        Ok(result) => result,
        Err(error) => {
            fail_machine(&mut machine, cancelled, deadline, error);
            return machine.result;
        }
    };
    let previous = inspect.stdout.trim();
    let previous = if previous == "NONE" {
        None
    } else if is_safe_previous_release(previous, &document.release.releases_directory)
        && previous != document.release.release_directory
    {
        Some(previous.to_string())
    } else {
        machine.finish_failure(
            DeploymentExecutionPhaseV2::Failed,
            "symlinkRisk",
            "active symlink resolved outside the approved releases directory".into(),
        );
        return machine.result;
    };
    machine.result.rollback_snapshot.previous_release = previous.clone();
    machine.result.rollback_snapshot.captured_at = Some(now_ms());

    if let Err(error) = machine.transition(DeploymentExecutionPhaseV2::CreatingRelease) {
        machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
        return machine.result;
    }
    if let Err(error) = run_reviewed_action(
        database,
        credentials,
        cancellations,
        &known_hosts_path,
        &mut machine,
        1,
        create_release_command(&document, &review.target),
        format!(
            "create immutable release {}",
            document.release.release_directory
        ),
        &review.target,
        &request.connection,
        cancelled,
        deadline,
        None,
        execution_token,
    ) {
        fail_machine(&mut machine, cancelled, deadline, error);
        return machine.result;
    }

    if let Err(error) = machine.transition(DeploymentExecutionPhaseV2::StagingArtifacts) {
        machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
        return machine.result;
    }
    for (artifact_index, artifact) in prepared.artifacts.iter().enumerate() {
        let stage_index = 2 + artifact_index * 2;
        if let Err(error) =
            mark_direct_action_started(&mut machine, stage_index, database, execution_token)
        {
            fail_machine(&mut machine, cancelled, deadline, error);
            return machine.result;
        }
        let stage = stage_artifact_sftp(
            database,
            credentials,
            pool,
            &known_hosts_path,
            review,
            &document,
            &request.connection,
            artifact,
            cancelled,
            deadline.min(
                Instant::now()
                    + Duration::from_secs(
                        machine.result.actions[stage_index].action.timeout_seconds,
                    ),
            ),
        );
        if let Err(error) = mark_direct_action_finished(
            &mut machine,
            stage_index,
            &stage,
            database,
            execution_token,
        ) {
            fail_machine(&mut machine, cancelled, deadline, error);
            return machine.result;
        }
        if let Err(error) = stage {
            fail_machine(&mut machine, cancelled, deadline, error);
            return machine.result;
        }
        let remote_artifact_path = format!(
            "{}/{}",
            document.release.release_directory, artifact.target_path
        );
        let verify_index = stage_index + 1;
        let verify = run_reviewed_action(
            database,
            credentials,
            cancellations,
            &known_hosts_path,
            &mut machine,
            verify_index,
            format!("sha256sum -- {}", shell_quote(&remote_artifact_path)),
            format!("verify SHA-256 for artifact {}", artifact.artifact_id),
            &review.target,
            &request.connection,
            cancelled,
            deadline,
            None,
            execution_token,
        );
        let verify = match verify {
            Ok(result) => result,
            Err(error) => {
                fail_machine(&mut machine, cancelled, deadline, error);
                return machine.result;
            }
        };
        if verify.stdout.split_whitespace().next() != Some(artifact.expected_sha256.as_str()) {
            machine.result.actions[verify_index].status = DeploymentExecutionActionStatusV2::Failed;
            machine.result.actions[verify_index].error =
                Some("remote artifact SHA-256 digest mismatch".into());
            machine.finish_failure(
                DeploymentExecutionPhaseV2::Failed,
                "digestMismatch",
                format!(
                    "remote deployment artifact {} did not preserve its reviewed digest",
                    artifact.artifact_id
                ),
            );
            return machine.result;
        }
    }

    if let Err(error) = machine.transition(DeploymentExecutionPhaseV2::ActivatingRelease) {
        machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
        return machine.result;
    }
    let activation_index = 2 + prepared.artifacts.len() * 2;
    if let Err(error) = run_reviewed_action(
        database,
        credentials,
        cancellations,
        &known_hosts_path,
        &mut machine,
        activation_index,
        activate_release_command(&document, &review.operation_id, previous.as_deref()),
        format!(
            "atomically activate {} as {}",
            document.release.release_directory, document.release.active_symlink
        ),
        &review.target,
        &request.connection,
        cancelled,
        deadline,
        None,
        execution_token,
    ) {
        fail_machine(&mut machine, cancelled, deadline, error);
        return machine.result;
    }
    machine.result.rollback_snapshot.activation_changed = true;
    if let Err(error) = machine.persist(database, execution_token) {
        fail_machine(&mut machine, cancelled, deadline, error);
        return machine.result;
    }

    let service_start = activation_index + 1;
    if document.service_actions.is_empty() {
        if let Err(error) = machine.transition(DeploymentExecutionPhaseV2::Verifying) {
            machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
            return machine.result;
        }
    } else {
        if let Err(error) = machine.transition(DeploymentExecutionPhaseV2::ApplyingServices) {
            machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
            return machine.result;
        }
        for (offset, service_action) in document.service_actions.iter().enumerate() {
            let service = document
                .services
                .iter()
                .find(|service| service.id == service_action.service_id)
                .expect("validated service reference");
            if let Err(error) = run_reviewed_action(
                database,
                credentials,
                cancellations,
                &known_hosts_path,
                &mut machine,
                service_start + offset,
                service_command(&document, service_action.action, &service.unit),
                format!("systemd {:?} {}", service_action.action, service.unit),
                &review.target,
                &request.connection,
                cancelled,
                deadline,
                None,
                execution_token,
            ) {
                fail_machine(&mut machine, cancelled, deadline, error);
                return machine.result;
            }
        }
        if let Err(error) = machine.transition(DeploymentExecutionPhaseV2::Verifying) {
            machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
            return machine.result;
        }
    }

    let health_start = service_start + document.service_actions.len();
    for (offset, check) in document.verification.checks.iter().enumerate() {
        let action_index = health_start + offset;
        let mut health_result = DeploymentHealthCheckResultV2 {
            check_id: check.id.clone(),
            kind: check.kind,
            status: "failed",
            attempts_used: 0,
            observed_status: None,
            observed_state: None,
            error: None,
        };
        let mut passed = false;
        for attempt in 1..=check.attempts {
            health_result.attempts_used = attempt;
            let (command, preview) = match check.kind {
                DeploymentHealthCheckKindV2::Http => {
                    let url = check.url.as_deref().expect("validated HTTP URL");
                    (
                        http_health_command(url, check.timeout_seconds),
                        format!(
                            "HTTP health {} expects {}",
                            check.id,
                            check.expected_status.unwrap()
                        ),
                    )
                }
                DeploymentHealthCheckKindV2::Service => {
                    let service = document
                        .services
                        .iter()
                        .find(|service| Some(service.id.as_str()) == check.service_id.as_deref())
                        .expect("validated service health reference");
                    (
                        service_health_command(&service.unit),
                        format!("systemd health {} expects active", service.unit),
                    )
                }
            };
            match run_reviewed_action(
                database,
                credentials,
                cancellations,
                &known_hosts_path,
                &mut machine,
                action_index,
                command,
                preview,
                &review.target,
                &request.connection,
                cancelled,
                deadline,
                Some(attempt),
                execution_token,
            ) {
                Ok(result) => match check.kind {
                    DeploymentHealthCheckKindV2::Http => {
                        let observed = result.stdout.trim().parse::<u16>().ok();
                        health_result.observed_status = observed;
                        passed = observed == check.expected_status;
                    }
                    DeploymentHealthCheckKindV2::Service => {
                        let observed = result.stdout.trim().to_string();
                        health_result.observed_state = Some(observed.clone());
                        passed = observed == "active";
                    }
                },
                Err(error) => {
                    if cancelled.load(Ordering::SeqCst) || Instant::now() >= deadline {
                        health_result.status = if cancelled.load(Ordering::SeqCst) {
                            "cancelled"
                        } else {
                            "timedOut"
                        };
                        health_result.error = Some(error.clone());
                        machine.result.health_checks.push(health_result);
                        fail_machine(&mut machine, cancelled, deadline, error);
                        return machine.result;
                    }
                    health_result.error = Some(error);
                }
            }
            if passed {
                break;
            }
            if attempt < check.attempts {
                if let Err(error) = wait_cancelable(
                    Duration::from_secs(check.interval_seconds),
                    cancelled,
                    deadline,
                ) {
                    health_result.status = if cancelled.load(Ordering::SeqCst) {
                        "cancelled"
                    } else {
                        "timedOut"
                    };
                    health_result.error = Some(error.clone());
                    machine.result.health_checks.push(health_result);
                    fail_machine(&mut machine, cancelled, deadline, error);
                    return machine.result;
                }
            }
        }
        if !passed {
            machine.result.actions[action_index].status = DeploymentExecutionActionStatusV2::Failed;
            machine.result.actions[action_index].error =
                Some("deployment health check exhausted all reviewed attempts".into());
            health_result.error.get_or_insert_with(|| {
                "deployment health check did not reach its declared expected state".into()
            });
            machine.result.health_checks.push(health_result);
            machine.finish_failure(
                DeploymentExecutionPhaseV2::Failed,
                "healthCheck",
                format!("deployment health check {} failed", check.id),
            );
            return machine.result;
        }
        health_result.status = "passed";
        health_result.error = None;
        machine.result.health_checks.push(health_result);
    }

    if let Err(error) = machine.finish_success() {
        machine.finish_failure(DeploymentExecutionPhaseV2::Failed, "stateMachine", error);
    }
    machine.result
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn execute_deployment_for_request(
    app: &AppHandle,
    database: &crate::db::Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    registry: &DeploymentExecutionRegistry,
    pool: &SftpPool,
    request: DeploymentExecutionRequestV2,
) -> Result<DeploymentExecutionResultV2, String> {
    if !valid_operation_id(&request.operation_id) {
        return Err("deployment operation identity is invalid".into());
    }
    let consumed = consume_review::<DeploymentExecutionReviewV2, _>(
        &database,
        DeploymentOperationKind::Deployment,
        &request.approval.review_id,
        &request.operation_id,
        &request.approval,
    )?;
    let cancelled = registry.start(&request.operation_id)?;
    let _guard = ActiveExecutionGuard {
        registry: &registry,
        operation_id: &request.operation_id,
        cancelled: Arc::clone(&cancelled),
    };
    let result = execute_consumed_review(
        app,
        database,
        credentials,
        cancellations,
        pool,
        &consumed.review,
        &request,
        &cancelled,
        &consumed.execution_token,
    );
    checkpoint_operation(
        &database,
        &request.operation_id,
        &consumed.execution_token,
        phase_name(result.phase),
        true,
        &result,
    )?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn execute_deployment(
    app: AppHandle,
    database: State<'_, crate::db::Database>,
    credentials: State<'_, CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    registry: State<'_, DeploymentExecutionRegistry>,
    pool: State<'_, SftpPool>,
    request: DeploymentExecutionRequestV2,
) -> Result<DeploymentExecutionResultV2, String> {
    execute_deployment_for_request(
        &app,
        &database,
        &credentials,
        &cancellations,
        &registry,
        &pool,
        request,
    )
}

#[tauri::command]
pub(crate) fn cancel_deployment(
    registry: State<'_, DeploymentExecutionRegistry>,
    operation_id: String,
) -> Result<(), String> {
    if !valid_operation_id(&operation_id) {
        return Err("deployment operation identity is invalid".into());
    }
    registry.cancel(&operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AuthMethod, ProfileAuthMethod, ProfileRow};

    fn policy() -> DeploymentExecutionPolicyV2 {
        DeploymentExecutionPolicyV2 {
            artifact_timeout_seconds: 30,
            max_artifact_bytes: 10 * 1024 * 1024,
            max_expanded_bytes: 50 * 1024 * 1024,
            max_archive_entries: 1_000,
            total_timeout_seconds: 600,
        }
    }

    fn connection(host: &str) -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: host.to_string(),
            port: 22,
            username: "operator".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("profile-secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        }
    }

    fn database() -> (tempfile::TempDir, crate::db::Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(&directory.path().join("termbridge.db")).unwrap();
        database
            .insert_profile(&ProfileRow {
                id: "profile-1".to_string(),
                name: "Deployment target".to_string(),
                host: "target.example.test".to_string(),
                port: 22,
                username: "operator".to_string(),
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

    fn review() -> DeploymentExecutionReviewV2 {
        let document = parse_deployment_runbook_v2(include_str!(
            "../../docs/examples/deployment-runbook-v2.runbook.json"
        ))
        .unwrap();
        let target = FrozenTargetIdentity::from_connection(
            "profile-1".to_string(),
            &connection("target.example.test"),
        )
        .unwrap();
        let actions = build_actions(&document, &policy());
        DeploymentExecutionReviewV2 {
            schema_version: 2,
            review_id: "deployment-review:test".to_string(),
            operation_id: "deployment:test".to_string(),
            normalized_runbook_text: serialize_deployment_runbook_v2(&document).unwrap(),
            document_digest: "sha256-v1:document".to_string(),
            plan_digest: "sha256-v1:plan".to_string(),
            deployment_id: document.deployment.id.clone(),
            application_id: document.deployment.application_id.clone(),
            environment: document.deployment.environment.clone(),
            version: document.deployment.version.clone(),
            artifact_digests: document
                .artifacts
                .iter()
                .map(|artifact| DeploymentArtifactDigestBindingV2 {
                    artifact_id: artifact.id.clone(),
                    sha256: artifact.sha256.clone(),
                    target_path: artifact.target_path.clone(),
                })
                .collect(),
            declared_risk: document.security.declared_risk,
            target,
            policy: policy(),
            actions,
            reviewed_at: now_ms(),
            expires_at: now_ms() + REVIEW_TTL_MS,
        }
    }

    #[test]
    fn execution_fixture_documents_the_bounded_policy_and_terminal_states() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/deployment-runbook/v2/single-host-execution.json"
        ))
        .unwrap();
        assert_eq!(fixture["schemaVersion"], 2);
        assert_eq!(fixture["policy"]["totalTimeoutSeconds"], 600);
        assert!(fixture["terminalPhases"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("identityMismatch")));
    }

    #[test]
    fn state_machine_accepts_only_the_single_host_forward_sequence() {
        let review = review();
        let document = parse_deployment_runbook_v2(&review.normalized_runbook_text).unwrap();
        let mut machine = DeploymentStateMachine::new(&review, &document);
        for phase in [
            DeploymentExecutionPhaseV2::PreparingArtifacts,
            DeploymentExecutionPhaseV2::InspectingTarget,
            DeploymentExecutionPhaseV2::CreatingRelease,
            DeploymentExecutionPhaseV2::StagingArtifacts,
            DeploymentExecutionPhaseV2::ActivatingRelease,
            DeploymentExecutionPhaseV2::ApplyingServices,
            DeploymentExecutionPhaseV2::Verifying,
            DeploymentExecutionPhaseV2::Succeeded,
        ] {
            machine.transition(phase).unwrap();
        }
        assert!(machine.result.phase.terminal());

        let mut invalid = DeploymentStateMachine::new(&review, &document);
        assert!(invalid
            .transition(DeploymentExecutionPhaseV2::ActivatingRelease)
            .is_err());
    }

    #[test]
    fn approval_is_exact_and_active_registry_is_operation_scoped() {
        let review = review();
        let matching = DeploymentExecutionApprovalV2 {
            review_id: review.review_id.clone(),
            operation_id: review.operation_id.clone(),
            document_digest: review.document_digest.clone(),
            plan_digest: review.plan_digest.clone(),
            target_digest: review.target.identity_digest.clone(),
            approved_risk: review.declared_risk,
            authorized: true,
            destructive_confirmed: false,
        };
        assert!(approval_matches_review(&matching, &review));
        assert!(!approval_matches_review(
            &DeploymentExecutionApprovalV2 {
                plan_digest: "sha256-v1:changed".to_string(),
                ..matching
            },
            &review
        ));

        let registry = DeploymentExecutionRegistry::default();
        let flag = registry.start(&review.operation_id).unwrap();
        assert!(registry.start(&review.operation_id).is_err());
        registry.cancel(&review.operation_id).unwrap();
        assert!(flag.load(Ordering::SeqCst));
        registry.finish(&review.operation_id, &flag);
    }

    #[test]
    fn operation_and_deployment_secret_identities_are_resolved_exactly() {
        assert!(valid_operation_id("deployment:release-1"));
        assert!(!valid_operation_id("deployment release 1"));
        assert!(!valid_operation_id(&"x".repeat(129)));

        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/deployment-runbook/v2/deployment-runbooks.json"
        ))
        .unwrap();
        let mut value = fixture["cases"][0]["value"].clone();
        value["security"]["secretRefs"][0]["id"] = serde_json::json!("download-credential");
        value["artifacts"][0]["credentialRef"] = serde_json::json!("download-credential");
        let document = parse_deployment_runbook_v2(&value.to_string()).unwrap();
        assert_eq!(
            deployment_credential_account(&document, &document.artifacts[0]).unwrap(),
            Some("artifact-download")
        );
    }

    #[test]
    fn target_change_fails_review_revalidation_before_network_access() {
        let (_directory, database) = database();
        let baseline = DeploymentExecutionReviewRequestV2 {
            operation_id: "deployment:target".to_string(),
            runbook_text: include_str!("../../docs/examples/deployment-runbook-v2.runbook.json")
                .to_string(),
            profile_id: "profile-1".to_string(),
            connection: connection("target.example.test"),
            policy: policy(),
        };
        assert!(review_material(&database, &baseline).is_ok());
        let changed = DeploymentExecutionReviewRequestV2 {
            connection: connection("changed.example.test"),
            ..baseline
        };
        assert!(review_material(&database, &changed)
            .unwrap_err()
            .contains("frozen target"));
    }

    #[test]
    fn path_and_symlink_guards_reject_escape_shapes() {
        assert!(stripped_archive_path(Path::new("../../etc/passwd"), 0).is_err());
        assert!(stripped_archive_path(Path::new("/absolute/path"), 0).is_err());
        assert!(!is_safe_previous_release(
            "/srv/app/current",
            "/srv/app/releases"
        ));
        assert!(!is_safe_previous_release(
            "/srv/app/releases/../current",
            "/srv/app/releases"
        ));
        assert!(is_safe_previous_release(
            "/srv/app/releases/release-1",
            "/srv/app/releases"
        ));
        assert!(inspect_release_command(
            &parse_deployment_runbook_v2(include_str!(
                "../../docs/examples/deployment-runbook-v2.runbook.json"
            ))
            .unwrap()
        )
        .contains("[ -L"));
        let document = parse_deployment_runbook_v2(include_str!(
            "../../docs/examples/deployment-runbook-v2.runbook.json"
        ))
        .unwrap();
        assert_eq!(
            Path::new(&activation_temp_path(&document, "deployment:test")).parent(),
            Path::new(&document.release.active_symlink).parent()
        );

        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_path("linked-config").unwrap();
        header.set_link_name("/etc/passwd").unwrap();
        header.set_cksum();
        builder.append(&header, std::io::empty()).unwrap();
        let bytes = builder.into_inner().unwrap();
        let extraction = tempfile::tempdir().unwrap();
        let unpack = crate::deployment_runbook::DeploymentArtifactUnpackV2 {
            format: DeploymentArchiveFormatV2::Tar,
            destination_path: ".".to_string(),
            strip_components: 0,
        };
        let mut entries = 0;
        let mut expanded = 0;
        let error = extract_tar(
            bytes.as_slice(),
            extraction.path(),
            &unpack,
            &policy(),
            &mut entries,
            &mut expanded,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("link or special entry"));
    }

    #[test]
    fn digest_mismatch_and_pre_cancel_stop_during_artifact_preparation() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("artifact.tar.gz");
        fs::write(&source, b"not the reviewed artifact").unwrap();
        let mut document = parse_deployment_runbook_v2(include_str!(
            "../../docs/examples/deployment-runbook-v2.runbook.json"
        ))
        .unwrap();
        document.artifacts[0].source_uri = Url::from_file_path(&source).unwrap().to_string();
        document.artifacts[0].size_bytes = Some(1024);
        document.artifacts[0].credential_ref = None;
        let credentials = CredentialManager::new();
        let cancelled = AtomicBool::new(false);
        let error = prepare_artifacts(
            &document,
            &credentials,
            &policy(),
            &cancelled,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("digest mismatch"));

        cancelled.store(true, Ordering::SeqCst);
        let error = prepare_artifacts(
            &document,
            &credentials,
            &policy(),
            &cancelled,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("cancelled"));
    }

    #[test]
    fn timeout_output_policy_and_late_identity_results_fail_closed() {
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            terminal_from_cancel(&cancelled, Instant::now() - Duration::from_millis(1))
                .unwrap()
                .0,
            DeploymentExecutionPhaseV2::TimedOut
        );
        let policy = action_output_policy();
        assert_eq!(policy.stdout_capture_bytes, ACTION_STDOUT_BYTES);
        assert_eq!(policy.total_read_hard_limit_bytes, ACTION_TOTAL_READ_BYTES);

        let review = review();
        let result = ReviewedSshExecutionResult {
            operation_id: "deployment:late".to_string(),
            target: review.target.clone(),
            status: ExecutionStatus::Completed,
            started_at: 1,
            completed_at: 2,
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            stdout_bytes_captured: 0,
            stderr_bytes_captured: 0,
            stdout_bytes_read: 0,
            stderr_bytes_read: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            error_category: None,
            error: None,
        };
        assert!(!reviewed_result_identity_matches(
            "deployment:expected",
            &review.target,
            &result
        ));
    }

    #[test]
    fn health_failure_preserves_the_previous_release_snapshot_without_rollback() {
        let review = review();
        let document = parse_deployment_runbook_v2(&review.normalized_runbook_text).unwrap();
        let mut machine = DeploymentStateMachine::new(&review, &document);
        machine.result.rollback_snapshot.previous_release =
            Some("/srv/acme-api/releases/previous".to_string());
        machine.result.rollback_snapshot.activation_changed = true;
        machine
            .transition(DeploymentExecutionPhaseV2::PreparingArtifacts)
            .unwrap();
        machine
            .transition(DeploymentExecutionPhaseV2::InspectingTarget)
            .unwrap();
        machine
            .transition(DeploymentExecutionPhaseV2::CreatingRelease)
            .unwrap();
        machine
            .transition(DeploymentExecutionPhaseV2::StagingArtifacts)
            .unwrap();
        machine
            .transition(DeploymentExecutionPhaseV2::ActivatingRelease)
            .unwrap();
        machine
            .transition(DeploymentExecutionPhaseV2::ApplyingServices)
            .unwrap();
        machine
            .transition(DeploymentExecutionPhaseV2::Verifying)
            .unwrap();
        machine.finish_failure(
            DeploymentExecutionPhaseV2::Failed,
            "healthCheck",
            "health failed".to_string(),
        );
        assert_eq!(
            machine.result.rollback_snapshot.previous_release.as_deref(),
            Some("/srv/acme-api/releases/previous")
        );
        assert!(machine.result.rollback_snapshot.activation_changed);
        assert_eq!(machine.result.phase, DeploymentExecutionPhaseV2::Failed);
    }
}
