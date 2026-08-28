//! Separately reviewed rollback executor for Deployment Runbook v2.
//!
//! A rollback plan can only be derived from one durable deployment activation
//! snapshot.  The IPC surface accepts no document text, release path, command,
//! service action, or health-check substitution.

use crate::deployment_execution::DeploymentExecutionReviewV2;
use crate::deployment_persistence::{
    checkpoint_operation, consume_review, load_rollback_source, load_rollback_source_for_execution,
    store_review, DeploymentOperationKind, ReviewIdentity, RollbackSourceRecord,
};
use crate::deployment_runbook::{
    parse_deployment_runbook_v2, serialize_deployment_runbook_v2, DeploymentHealthCheckKindV2,
    DeploymentRunbookDocumentV2, DeploymentServiceActionKindV2,
};
use crate::execution::{
    execute_reviewed_ssh_command, revalidate_frozen_target_identity, valid_operation_id,
    ExecutionCancellationRegistry, ExecutionErrorCategory, ExecutionOutputPolicy, ExecutionStatus,
    FrozenTargetIdentity, ReviewedSshCommand, ReviewedSshExecutionRequest,
    ReviewedSshExecutionResult,
};
use crate::keychain::CredentialManager;
use crate::models::RemoteConnectionRequest;
use crate::runbook::RunbookRisk;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const REVIEW_TTL_MS: i64 = 10 * 60 * 1_000;
const MIN_TOTAL_TIMEOUT_SECONDS: u64 = 30;
const MAX_TOTAL_TIMEOUT_SECONDS: u64 = 3_600;
const ACTION_STDOUT_BYTES: usize = 8 * 1024;
const ACTION_STDERR_BYTES: usize = 8 * 1024;
const ACTION_TOTAL_READ_BYTES: usize = 256 * 1024;

fn now_ms() -> i64 {
    crate::db::current_timestamp_ms()
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

fn risk_rank(risk: RunbookRisk) -> u8 {
    match risk {
        RunbookRisk::ReadOnly => 0,
        RunbookRisk::StateChange => 1,
        RunbookRisk::Destructive => 2,
    }
}

fn max_risk(left: RunbookRisk, right: RunbookRisk) -> RunbookRisk {
    if risk_rank(left) >= risk_rank(right) {
        left
    } else {
        right
    }
}

fn action_output_policy() -> ExecutionOutputPolicy {
    ExecutionOutputPolicy::new(
        ACTION_STDOUT_BYTES,
        ACTION_STDERR_BYTES,
        ACTION_TOTAL_READ_BYTES,
    )
    .expect("rollback action output policy is bounded")
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

fn is_safe_release_path(release: &str, releases_directory: &str) -> bool {
    release
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RollbackExecutionReviewRequestV2 {
    operation_id: String,
    source_operation_id: String,
    profile_id: String,
    connection: RemoteConnectionRequest,
    total_timeout_seconds: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RollbackExecutionActionKindV2 {
    InspectReactivation,
    ReactivatePreviousRelease,
    ServiceAction,
    HttpHealthCheck,
    ServiceHealthCheck,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RollbackExecutionActionV2 {
    action_id: String,
    kind: RollbackExecutionActionKindV2,
    target: String,
    normalized_parameters: String,
    parameters_digest: String,
    risk: RunbookRisk,
    mutating: bool,
    timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RollbackExecutionReviewV2 {
    schema_version: u8,
    review_id: String,
    operation_id: String,
    source_operation_id: String,
    source_review_id: String,
    source_phase: String,
    document_digest: String,
    plan_digest: String,
    deployment_id: String,
    application_id: String,
    environment: String,
    version: String,
    current_release: String,
    previous_release: String,
    releases_directory: String,
    active_symlink: String,
    snapshot_captured_at: i64,
    declared_risk: RunbookRisk,
    target: FrozenTargetIdentity,
    total_timeout_seconds: u64,
    actions: Vec<RollbackExecutionActionV2>,
    reviewed_at: i64,
    expires_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RollbackExecutionApprovalV2 {
    review_id: String,
    operation_id: String,
    source_operation_id: String,
    document_digest: String,
    plan_digest: String,
    target_digest: String,
    current_release: String,
    previous_release: String,
    approved_risk: RunbookRisk,
    authorized: bool,
    destructive_confirmed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RollbackExecutionRequestV2 {
    operation_id: String,
    profile_id: String,
    connection: RemoteConnectionRequest,
    approval: RollbackExecutionApprovalV2,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RollbackExecutionPhaseV2 {
    Pending,
    InspectingTarget,
    ReactivatingPreviousRelease,
    ApplyingServices,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    IdentityMismatch,
    Unauthorized,
}

impl RollbackExecutionPhaseV2 {
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

    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InspectingTarget => "inspectingTarget",
            Self::ReactivatingPreviousRelease => "reactivatingPreviousRelease",
            Self::ApplyingServices => "applyingServices",
            Self::Verifying => "verifying",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timedOut",
            Self::IdentityMismatch => "identityMismatch",
            Self::Unauthorized => "unauthorized",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RollbackExecutionActionStatusV2 {
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
pub(crate) struct RollbackExecutionActionResultV2 {
    #[serde(flatten)]
    action: RollbackExecutionActionV2,
    child_operation_id: String,
    status: RollbackExecutionActionStatusV2,
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
pub(crate) struct RollbackHealthEvidenceV2 {
    check_id: String,
    kind: DeploymentHealthCheckKindV2,
    status: String,
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
pub(crate) struct RollbackReactivationResultV2 {
    current_release: String,
    previous_release: String,
    releases_directory: String,
    active_symlink: String,
    activation_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    changed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RollbackExecutionResultV2 {
    schema_version: u8,
    operation_id: String,
    review_id: String,
    source_operation_id: String,
    document_digest: String,
    plan_digest: String,
    deployment_id: String,
    version: String,
    target: FrozenTargetIdentity,
    phase: RollbackExecutionPhaseV2,
    started_at: i64,
    completed_at: i64,
    actions: Vec<RollbackExecutionActionResultV2>,
    health_evidence: Vec<RollbackHealthEvidenceV2>,
    reactivation: RollbackReactivationResultV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
struct RollbackRegistryState {
    active: HashMap<String, Arc<AtomicBool>>,
}

#[derive(Clone, Default)]
pub(crate) struct RollbackExecutionRegistry {
    state: Arc<Mutex<RollbackRegistryState>>,
}

impl RollbackExecutionRegistry {
    fn start(&self, operation_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "rollback execution registry is unavailable".to_string())?;
        if state.active.contains_key(operation_id) {
            return Err("rollback operation is already active".into());
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
            .map_err(|_| "rollback execution registry is unavailable".to_string())?;
        let flag = state
            .active
            .get(operation_id)
            .ok_or_else(|| "rollback execution was not found".to_string())?;
        flag.store(true, Ordering::SeqCst);
        Ok(())
    }
}

struct ActiveRollbackGuard<'a> {
    registry: &'a RollbackExecutionRegistry,
    operation_id: &'a str,
    cancelled: Arc<AtomicBool>,
}

impl Drop for ActiveRollbackGuard<'_> {
    fn drop(&mut self) {
        self.registry.finish(self.operation_id, &self.cancelled);
    }
}

fn action(
    index: usize,
    kind: RollbackExecutionActionKindV2,
    target: String,
    parameters: serde_json::Value,
    risk: RunbookRisk,
    mutating: bool,
    timeout_seconds: u64,
) -> RollbackExecutionActionV2 {
    let normalized_parameters = parameters.to_string();
    RollbackExecutionActionV2 {
        action_id: format!("rollback-action-{index}"),
        kind,
        target,
        parameters_digest: digest(
            "termbridge-rollback-action-parameters",
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
    source: &RollbackSourceRecord,
) -> Vec<RollbackExecutionActionV2> {
    let mut actions = vec![action(
        0,
        RollbackExecutionActionKindV2::InspectReactivation,
        source.active_symlink.clone(),
        serde_json::json!({
            "activeSymlink": source.active_symlink,
            "currentRelease": source.new_release,
            "previousRelease": source.previous_release,
            "releasesDirectory": source.releases_directory,
            "privilegeEscalation": document.security.allow_privilege_escalation,
        }),
        RunbookRisk::ReadOnly,
        false,
        30,
    )];
    actions.push(action(
        actions.len(),
        RollbackExecutionActionKindV2::ReactivatePreviousRelease,
        source.active_symlink.clone(),
        serde_json::json!({
            "activeSymlink": source.active_symlink,
            "expectedCurrentRelease": source.new_release,
            "previousRelease": source.previous_release,
            "strategy": "reactivatePreviousRelease",
            "privilegeEscalation": document.security.allow_privilege_escalation,
        }),
        RunbookRisk::StateChange,
        true,
        30,
    ));
    for service_action in &document.rollback.service_actions {
        let service = document
            .services
            .iter()
            .find(|service| service.id == service_action.service_id)
            .expect("validated rollback service reference");
        actions.push(action(
            actions.len(),
            RollbackExecutionActionKindV2::ServiceAction,
            service.unit.clone(),
            serde_json::json!({
                "actionId": service_action.id,
                "action": service_action.action,
                "manager": service.manager,
                "unit": service.unit,
                "privilegeEscalation": document.security.allow_privilege_escalation,
            }),
            service_action.risk,
            true,
            service_action.timeout_seconds,
        ));
    }
    for check_id in &document.rollback.verification_check_ids {
        let check = document
            .verification
            .checks
            .iter()
            .find(|check| &check.id == check_id)
            .expect("validated rollback check reference");
        let (kind, target, parameters) = match check.kind {
            DeploymentHealthCheckKindV2::Http => (
                RollbackExecutionActionKindV2::HttpHealthCheck,
                check.url.clone().expect("validated HTTP check URL"),
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
                    .expect("validated rollback service health reference");
                (
                    RollbackExecutionActionKindV2::ServiceHealthCheck,
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

fn validate_source(
    source: &RollbackSourceRecord,
    review: &DeploymentExecutionReviewV2,
    document: &DeploymentRunbookDocumentV2,
) -> Result<(), String> {
    let normalized = serialize_deployment_runbook_v2(document)?;
    let document_digest = digest("termbridge-deployment-document", normalized.as_bytes());
    if review.schema_version != 2
        || review.document_digest != document_digest
        || source.new_release != document.release.release_directory
        || source.releases_directory != document.release.releases_directory
        || source.active_symlink != document.release.active_symlink
        || !is_safe_release_path(&source.previous_release, &source.releases_directory)
        || source.previous_release == source.new_release
    {
        return Err(
            "persisted rollback source document or release identity is inconsistent".into(),
        );
    }
    Ok(())
}

fn review_material(
    database: &crate::db::Database,
    request: &RollbackExecutionReviewRequestV2,
    allowed_reservation: Option<&str>,
) -> Result<
    (
        RollbackSourceRecord,
        DeploymentExecutionReviewV2,
        DeploymentRunbookDocumentV2,
        Vec<RollbackExecutionActionV2>,
        RunbookRisk,
        String,
    ),
    String,
> {
    if !valid_operation_id(&request.operation_id)
        || !valid_operation_id(&request.source_operation_id)
        || request.operation_id == request.source_operation_id
    {
        return Err("rollback operation identity is invalid".into());
    }
    if !(MIN_TOTAL_TIMEOUT_SECONDS..=MAX_TOTAL_TIMEOUT_SECONDS)
        .contains(&request.total_timeout_seconds)
    {
        return Err("rollback total timeout must be between 30 and 3600 seconds".into());
    }
    let source = match allowed_reservation {
        Some(operation_id) => load_rollback_source_for_execution(
            database,
            &request.source_operation_id,
            operation_id,
        )?,
        None => load_rollback_source(database, &request.source_operation_id)?,
    };
    let deployment_review: DeploymentExecutionReviewV2 = serde_json::from_str(&source.review_json)
        .map_err(|error| format!("persisted deployment review is invalid: {error}"))?;
    if request.profile_id != deployment_review.target.profile_id {
        return Err("rollback profile does not match the persisted frozen target".into());
    }
    revalidate_frozen_target_identity(database, &deployment_review.target, &request.connection)
        .map_err(|error| error.message)?;
    let document = parse_deployment_runbook_v2(&deployment_review.normalized_runbook_text)?;
    validate_source(&source, &deployment_review, &document)?;
    let actions = build_actions(&document, &source);
    let declared_risk = document
        .rollback
        .service_actions
        .iter()
        .fold(RunbookRisk::StateChange, |risk, action| {
            max_risk(risk, action.risk)
        });
    let plan = serde_json::json!({
        "schemaVersion": 2,
        "operationId": request.operation_id,
        "sourceOperationId": source.source_operation_id,
        "sourceReviewId": deployment_review.review_id,
        "sourcePhase": source.source_phase,
        "documentDigest": deployment_review.document_digest,
        "deploymentId": deployment_review.deployment_id,
        "version": deployment_review.version,
        "currentRelease": source.new_release,
        "previousRelease": source.previous_release,
        "releasesDirectory": source.releases_directory,
        "activeSymlink": source.active_symlink,
        "snapshotCapturedAt": source.captured_at,
        "declaredRisk": declared_risk,
        "target": deployment_review.target,
        "totalTimeoutSeconds": request.total_timeout_seconds,
        "actions": actions,
    });
    let plan_digest = digest("termbridge-rollback-plan", plan.to_string().as_bytes());
    Ok((
        source,
        deployment_review,
        document,
        actions,
        declared_risk,
        plan_digest,
    ))
}

#[tauri::command]
pub(crate) fn review_rollback_execution(
    database: State<'_, crate::db::Database>,
    request: RollbackExecutionReviewRequestV2,
) -> Result<RollbackExecutionReviewV2, String> {
    let (source, deployment_review, _document, actions, declared_risk, plan_digest) =
        review_material(&database, &request, None)?;
    let reviewed_at = now_ms();
    let review = RollbackExecutionReviewV2 {
        schema_version: 2,
        review_id: format!("rollback-review:{}", uuid::Uuid::new_v4()),
        operation_id: request.operation_id,
        source_operation_id: source.source_operation_id,
        source_review_id: deployment_review.review_id,
        source_phase: source.source_phase,
        document_digest: deployment_review.document_digest,
        plan_digest,
        deployment_id: deployment_review.deployment_id,
        application_id: deployment_review.application_id,
        environment: deployment_review.environment,
        version: deployment_review.version,
        current_release: source.new_release,
        previous_release: source.previous_release,
        releases_directory: source.releases_directory,
        active_symlink: source.active_symlink,
        snapshot_captured_at: source.captured_at,
        declared_risk,
        target: deployment_review.target,
        total_timeout_seconds: request.total_timeout_seconds,
        actions,
        reviewed_at,
        expires_at: reviewed_at + REVIEW_TTL_MS,
    };
    store_review(
        &database,
        &ReviewIdentity {
            review_id: &review.review_id,
            operation_id: &review.operation_id,
            kind: DeploymentOperationKind::Rollback,
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
        &[
            (review.current_release.as_str(), "current"),
            (review.previous_release.as_str(), "rollbackTarget"),
        ],
    )?;
    Ok(review)
}

fn approval_matches_review(
    approval: &RollbackExecutionApprovalV2,
    review: &RollbackExecutionReviewV2,
) -> bool {
    approval.review_id == review.review_id
        && approval.operation_id == review.operation_id
        && approval.source_operation_id == review.source_operation_id
        && approval.document_digest == review.document_digest
        && approval.plan_digest == review.plan_digest
        && approval.target_digest == review.target.identity_digest
        && approval.current_release == review.current_release
        && approval.previous_release == review.previous_release
        && approval.approved_risk == review.declared_risk
        && approval.authorized
        && (review.declared_risk != RunbookRisk::Destructive || approval.destructive_confirmed)
        && review.expires_at > now_ms()
}

fn current_material_matches_review(
    review: &RollbackExecutionReviewV2,
    source: &RollbackSourceRecord,
    deployment_review: &DeploymentExecutionReviewV2,
    actions: &[RollbackExecutionActionV2],
    risk: RunbookRisk,
    plan_digest: &str,
) -> bool {
    review.source_operation_id == source.source_operation_id
        && review.source_review_id == deployment_review.review_id
        && review.source_phase == source.source_phase
        && review.document_digest == deployment_review.document_digest
        && review.deployment_id == deployment_review.deployment_id
        && review.application_id == deployment_review.application_id
        && review.environment == deployment_review.environment
        && review.version == deployment_review.version
        && review.current_release == source.new_release
        && review.previous_release == source.previous_release
        && review.releases_directory == source.releases_directory
        && review.active_symlink == source.active_symlink
        && review.snapshot_captured_at == source.captured_at
        && review.target == deployment_review.target
        && review.actions == actions
        && review.declared_risk == risk
        && review.plan_digest == plan_digest
}

fn inspection_command(review: &RollbackExecutionReviewV2, privileged: bool) -> String {
    const SCRIPT: &str = r#"set -eu
releases=$1
current_release=$2
previous_release=$3
active=$4
[ -d "$releases" ] && [ ! -L "$releases" ] || exit 71
[ -d "$current_release" ] && [ ! -L "$current_release" ] || exit 72
[ -d "$previous_release" ] && [ ! -L "$previous_release" ] || exit 73
[ -L "$active" ] || exit 74
resolved_releases=$(readlink -f -- "$releases") || exit 75
[ "$resolved_releases" = "$releases" ] || exit 76
resolved_current=$(readlink -f -- "$current_release") || exit 77
[ "$resolved_current" = "$current_release" ] || exit 78
resolved_previous=$(readlink -f -- "$previous_release") || exit 79
[ "$resolved_previous" = "$previous_release" ] || exit 80
current=$(readlink -f -- "$active") || exit 75
[ "$current" = "$current_release" ] || exit 81"#;
    semantic_shell(
        privileged,
        SCRIPT,
        &[
            &review.releases_directory,
            &review.current_release,
            &review.previous_release,
            &review.active_symlink,
        ],
    )
}

fn activation_temp_path(review: &RollbackExecutionReviewV2) -> String {
    let activation_digest = digest(
        "termbridge-rollback-activation",
        review.operation_id.as_bytes(),
    );
    let parent = review
        .active_symlink
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .filter(|parent| !parent.is_empty())
        .unwrap_or("/");
    format!(
        "{}/.termbridge-rollback-{}",
        parent.trim_end_matches('/'),
        &activation_digest[10..34]
    )
}

fn activation_command(review: &RollbackExecutionReviewV2, privileged: bool) -> String {
    const SCRIPT: &str = r#"set -eu
releases=$1
current_release=$2
previous_release=$3
active=$4
temporary=$5
[ -d "$releases" ] && [ ! -L "$releases" ] || exit 80
[ -d "$current_release" ] && [ ! -L "$current_release" ] || exit 81
[ -d "$previous_release" ] && [ ! -L "$previous_release" ] || exit 82
[ -L "$active" ] || exit 83
resolved_releases=$(readlink -f -- "$releases") || exit 84
[ "$resolved_releases" = "$releases" ] || exit 85
resolved_current=$(readlink -f -- "$current_release") || exit 86
[ "$resolved_current" = "$current_release" ] || exit 87
resolved_previous=$(readlink -f -- "$previous_release") || exit 88
[ "$resolved_previous" = "$previous_release" ] || exit 89
current=$(readlink -f -- "$active") || exit 90
[ "$current" = "$current_release" ] || exit 91
if [ -e "$temporary" ] || [ -L "$temporary" ]; then exit 92; fi
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT HUP INT TERM
ln -s -- "$previous_release" "$temporary"
mv -Tf -- "$temporary" "$active"
trap - EXIT HUP INT TERM"#;
    semantic_shell(
        privileged,
        SCRIPT,
        &[
            &review.releases_directory,
            &review.current_release,
            &review.previous_release,
            &review.active_symlink,
            &activation_temp_path(review),
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

fn child_operation_id(operation_id: &str, index: usize) -> String {
    let child_digest = digest("termbridge-rollback-child", operation_id.as_bytes());
    format!("rollback:{}:{index}", &child_digest[10..34])
}

struct RollbackStateMachine {
    result: RollbackExecutionResultV2,
}

impl RollbackStateMachine {
    fn new(review: &RollbackExecutionReviewV2) -> Self {
        let started_at = now_ms();
        Self {
            result: RollbackExecutionResultV2 {
                schema_version: 2,
                operation_id: review.operation_id.clone(),
                review_id: review.review_id.clone(),
                source_operation_id: review.source_operation_id.clone(),
                document_digest: review.document_digest.clone(),
                plan_digest: review.plan_digest.clone(),
                deployment_id: review.deployment_id.clone(),
                version: review.version.clone(),
                target: review.target.clone(),
                phase: RollbackExecutionPhaseV2::Pending,
                started_at,
                completed_at: started_at,
                actions: review
                    .actions
                    .iter()
                    .enumerate()
                    .map(|(index, action)| RollbackExecutionActionResultV2 {
                        action: action.clone(),
                        child_operation_id: child_operation_id(&review.operation_id, index),
                        status: RollbackExecutionActionStatusV2::Pending,
                        started_at: None,
                        completed_at: None,
                        exit_code: None,
                        output: None,
                        error: None,
                    })
                    .collect(),
                health_evidence: Vec::new(),
                reactivation: RollbackReactivationResultV2 {
                    current_release: review.current_release.clone(),
                    previous_release: review.previous_release.clone(),
                    releases_directory: review.releases_directory.clone(),
                    active_symlink: review.active_symlink.clone(),
                    activation_changed: false,
                    changed_at: None,
                },
                error_category: None,
                error: None,
            },
        }
    }

    fn transition(&mut self, next: RollbackExecutionPhaseV2) -> Result<(), String> {
        let allowed = match self.result.phase {
            RollbackExecutionPhaseV2::Pending => matches!(
                next,
                RollbackExecutionPhaseV2::InspectingTarget
                    | RollbackExecutionPhaseV2::Unauthorized
                    | RollbackExecutionPhaseV2::Cancelled
                    | RollbackExecutionPhaseV2::TimedOut
                    | RollbackExecutionPhaseV2::IdentityMismatch
                    | RollbackExecutionPhaseV2::Failed
            ),
            RollbackExecutionPhaseV2::InspectingTarget => matches!(
                next,
                RollbackExecutionPhaseV2::ReactivatingPreviousRelease
                    | RollbackExecutionPhaseV2::Cancelled
                    | RollbackExecutionPhaseV2::TimedOut
                    | RollbackExecutionPhaseV2::IdentityMismatch
                    | RollbackExecutionPhaseV2::Failed
            ),
            RollbackExecutionPhaseV2::ReactivatingPreviousRelease => matches!(
                next,
                RollbackExecutionPhaseV2::ApplyingServices
                    | RollbackExecutionPhaseV2::Verifying
                    | RollbackExecutionPhaseV2::Cancelled
                    | RollbackExecutionPhaseV2::TimedOut
                    | RollbackExecutionPhaseV2::IdentityMismatch
                    | RollbackExecutionPhaseV2::Failed
            ),
            RollbackExecutionPhaseV2::ApplyingServices => matches!(
                next,
                RollbackExecutionPhaseV2::Verifying
                    | RollbackExecutionPhaseV2::Cancelled
                    | RollbackExecutionPhaseV2::TimedOut
                    | RollbackExecutionPhaseV2::IdentityMismatch
                    | RollbackExecutionPhaseV2::Failed
            ),
            RollbackExecutionPhaseV2::Verifying => matches!(
                next,
                RollbackExecutionPhaseV2::Succeeded
                    | RollbackExecutionPhaseV2::Cancelled
                    | RollbackExecutionPhaseV2::TimedOut
                    | RollbackExecutionPhaseV2::IdentityMismatch
                    | RollbackExecutionPhaseV2::Failed
            ),
            _ => false,
        };
        if !allowed {
            return Err(format!(
                "invalid rollback execution transition: {:?} -> {:?}",
                self.result.phase, next
            ));
        }
        self.result.phase = next;
        Ok(())
    }

    fn fail(&mut self, phase: RollbackExecutionPhaseV2, category: &str, error: String) {
        if !self.result.phase.terminal() {
            let _ = self.transition(phase);
        }
        self.result.error_category = Some(category.to_string());
        self.result.error = Some(error);
        self.result.completed_at = now_ms();
    }

    fn persist(&self, database: &crate::db::Database, execution_token: &str) -> Result<(), String> {
        checkpoint_operation(
            database,
            &self.result.operation_id,
            execution_token,
            self.result.phase.as_str(),
            self.result.phase.terminal(),
            &self.result,
        )
    }
}

fn classify_error(
    cancelled: &AtomicBool,
    deadline: Instant,
    error: &str,
) -> (RollbackExecutionPhaseV2, &'static str) {
    if error.starts_with("identityMismatch:") {
        (
            RollbackExecutionPhaseV2::IdentityMismatch,
            "identityMismatch",
        )
    } else if cancelled.load(Ordering::SeqCst) || error.contains("cancelled") {
        (RollbackExecutionPhaseV2::Cancelled, "cancelled")
    } else if Instant::now() >= deadline || error.contains("timed out") || error.contains("timeout")
    {
        (RollbackExecutionPhaseV2::TimedOut, "timeout")
    } else {
        (RollbackExecutionPhaseV2::Failed, "rollback")
    }
}

fn ensure_running(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("rollback execution was cancelled".into())
    } else if Instant::now() >= deadline {
        Err("rollback execution exceeded its reviewed timeout".into())
    } else {
        Ok(())
    }
}

fn wait_cancelable(
    duration: Duration,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        ensure_running(cancelled, deadline)?;
        thread::sleep(Duration::from_millis(50).min(end.saturating_duration_since(Instant::now())));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn run_action(
    database: &crate::db::Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    machine: &mut RollbackStateMachine,
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
    ensure_running(cancelled, deadline)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining < Duration::from_secs(1) {
        return Err("rollback execution exceeded its reviewed timeout".into());
    }
    let (child_operation_id, timeout) = {
        let action = machine
            .result
            .actions
            .get_mut(index)
            .ok_or_else(|| "rollback action plan index is invalid".to_string())?;
        action.status = RollbackExecutionActionStatusV2::Running;
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
        if result.operation_id != child_operation_id || result.target != *target {
            action.status = RollbackExecutionActionStatusV2::IdentityMismatch;
            action.error = Some("rollback action returned a mismatched identity".into());
            Err("identityMismatch: rollback action returned a mismatched identity".into())
        } else {
            match result.status {
                ExecutionStatus::Completed if result.exit_code == Some(0) => {
                    action.status = RollbackExecutionActionStatusV2::Succeeded;
                    Ok(())
                }
                ExecutionStatus::Cancelled => {
                    action.status = RollbackExecutionActionStatusV2::Cancelled;
                    action.error = Some("rollback action was cancelled".into());
                    Err("rollback action was cancelled".into())
                }
                ExecutionStatus::TimedOut => {
                    action.status = RollbackExecutionActionStatusV2::TimedOut;
                    action.error = Some("rollback action timed out".into());
                    Err("rollback action timed out".into())
                }
                _ => {
                    action.status = RollbackExecutionActionStatusV2::Failed;
                    let category = match result.error_category {
                        Some(ExecutionErrorCategory::TargetMismatch)
                        | Some(ExecutionErrorCategory::TargetNotFound) => "identityMismatch",
                        Some(ExecutionErrorCategory::CredentialUnavailable) => {
                            "credentialUnavailable"
                        }
                        Some(ExecutionErrorCategory::HostKeyRejected) => "hostKey",
                        Some(ExecutionErrorCategory::ConnectionFailed) => "connection",
                        Some(ExecutionErrorCategory::ChannelOpenFailed) => "channelOpenFailed",
                        Some(ExecutionErrorCategory::CommandStartFailed) => "commandStartFailed",
                        Some(ExecutionErrorCategory::OutputLimitExceeded) => "outputLimit",
                        Some(ExecutionErrorCategory::TransportFailed) => "transportFailed",
                        Some(ExecutionErrorCategory::Cancelled) => "cancelled",
                        Some(ExecutionErrorCategory::TimedOut) => "timedOut",
                        Some(ExecutionErrorCategory::WorkerStopped) => "workerStopped",
                        Some(ExecutionErrorCategory::InvalidRequest) => "invalidRequest",
                        None => "remoteAction",
                    };
                    let error = result.error.clone().unwrap_or_else(|| {
                        format!(
                            "rollback action failed with exit code {:?}",
                            result.exit_code
                        )
                    });
                    action.error = Some(error.clone());
                    Err(format!("{category}: {error}"))
                }
            }
        }
    };
    machine.persist(database, execution_token)?;
    outcome.map(|()| result)
}

fn fail_machine(
    machine: &mut RollbackStateMachine,
    cancelled: &AtomicBool,
    deadline: Instant,
    error: String,
) {
    let (phase, category) = classify_error(cancelled, deadline, &error);
    machine.fail(phase, category, error);
}

#[allow(clippy::too_many_arguments)]
fn execute_consumed_review(
    app: &AppHandle,
    database: &crate::db::Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    review: &RollbackExecutionReviewV2,
    request: &RollbackExecutionRequestV2,
    cancelled: &Arc<AtomicBool>,
    execution_token: &str,
) -> RollbackExecutionResultV2 {
    let mut machine = RollbackStateMachine::new(review);
    let deadline = Instant::now() + Duration::from_secs(review.total_timeout_seconds);
    if !approval_matches_review(&request.approval, review)
        || request.operation_id != review.operation_id
        || request.profile_id != review.target.profile_id
    {
        machine.fail(
            RollbackExecutionPhaseV2::Unauthorized,
            "approvalMismatch",
            "rollback approval does not match the exact reviewed snapshot, target, plan, risk, or confirmation".into(),
        );
        return machine.result;
    }
    if let Err(error) =
        revalidate_frozen_target_identity(database, &review.target, &request.connection)
    {
        machine.fail(
            RollbackExecutionPhaseV2::IdentityMismatch,
            "targetMismatch",
            error.message,
        );
        return machine.result;
    }
    let current_request = RollbackExecutionReviewRequestV2 {
        operation_id: review.operation_id.clone(),
        source_operation_id: review.source_operation_id.clone(),
        profile_id: request.profile_id.clone(),
        connection: request.connection.clone(),
        total_timeout_seconds: review.total_timeout_seconds,
    };
    let current = match review_material(database, &current_request, Some(&review.operation_id)) {
        Ok(current) => current,
        Err(error) => {
            machine.fail(
                RollbackExecutionPhaseV2::Unauthorized,
                "reviewRevalidation",
                error,
            );
            return machine.result;
        }
    };
    let (source, deployment_review, document, actions, risk, plan_digest) = current;
    if !current_material_matches_review(
        review,
        &source,
        &deployment_review,
        &actions,
        risk,
        &plan_digest,
    ) {
        machine.fail(
            RollbackExecutionPhaseV2::Unauthorized,
            "reviewMismatch",
            "rollback source, document, target, release identities, actions, or plan changed after review".into(),
        );
        return machine.result;
    }
    let known_hosts_path = match crate::known_hosts::known_hosts_path(app) {
        Ok(path) => path,
        Err(error) => {
            machine.fail(RollbackExecutionPhaseV2::Failed, "hostKey", error);
            return machine.result;
        }
    };

    if let Err(error) = machine.transition(RollbackExecutionPhaseV2::InspectingTarget) {
        machine.fail(RollbackExecutionPhaseV2::Failed, "stateMachine", error);
        return machine.result;
    }
    if let Err(error) = run_action(
        database,
        credentials,
        cancellations,
        &known_hosts_path,
        &mut machine,
        0,
        inspection_command(review, document.security.allow_privilege_escalation),
        format!(
            "verify current {} and rollback target {}",
            review.current_release, review.previous_release
        ),
        &review.target,
        &request.connection,
        cancelled,
        deadline,
        None,
        execution_token,
    ) {
        let error = format!("identityMismatch: current or previous release drifted: {error}");
        machine.fail(
            RollbackExecutionPhaseV2::IdentityMismatch,
            "releaseDrift",
            error,
        );
        return machine.result;
    }

    if let Err(error) = machine.transition(RollbackExecutionPhaseV2::ReactivatingPreviousRelease) {
        machine.fail(RollbackExecutionPhaseV2::Failed, "stateMachine", error);
        return machine.result;
    }
    if let Err(error) = run_action(
        database,
        credentials,
        cancellations,
        &known_hosts_path,
        &mut machine,
        1,
        activation_command(review, document.security.allow_privilege_escalation),
        format!(
            "atomically reactivate {} as {}",
            review.previous_release, review.active_symlink
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
    machine.result.reactivation.activation_changed = true;
    machine.result.reactivation.changed_at = Some(now_ms());
    if let Err(error) = machine.persist(database, execution_token) {
        fail_machine(&mut machine, cancelled, deadline, error);
        return machine.result;
    }

    let service_start = 2;
    if document.rollback.service_actions.is_empty() {
        if let Err(error) = machine.transition(RollbackExecutionPhaseV2::Verifying) {
            machine.fail(RollbackExecutionPhaseV2::Failed, "stateMachine", error);
            return machine.result;
        }
    } else {
        if let Err(error) = machine.transition(RollbackExecutionPhaseV2::ApplyingServices) {
            machine.fail(RollbackExecutionPhaseV2::Failed, "stateMachine", error);
            return machine.result;
        }
        for (offset, service_action) in document.rollback.service_actions.iter().enumerate() {
            let service = document
                .services
                .iter()
                .find(|service| service.id == service_action.service_id)
                .expect("validated rollback service reference");
            if let Err(error) = run_action(
                database,
                credentials,
                cancellations,
                &known_hosts_path,
                &mut machine,
                service_start + offset,
                service_command(&document, service_action.action, &service.unit),
                format!(
                    "rollback systemd {:?} {}",
                    service_action.action, service.unit
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
        }
        if let Err(error) = machine.transition(RollbackExecutionPhaseV2::Verifying) {
            machine.fail(RollbackExecutionPhaseV2::Failed, "stateMachine", error);
            return machine.result;
        }
    }

    let health_start = service_start + document.rollback.service_actions.len();
    for (offset, check_id) in document.rollback.verification_check_ids.iter().enumerate() {
        let check = document
            .verification
            .checks
            .iter()
            .find(|check| &check.id == check_id)
            .expect("validated rollback check reference");
        let action_index = health_start + offset;
        let mut evidence = RollbackHealthEvidenceV2 {
            check_id: check.id.clone(),
            kind: check.kind,
            status: "failed".into(),
            attempts_used: 0,
            observed_status: None,
            observed_state: None,
            error: None,
        };
        let mut passed = false;
        for attempt in 1..=check.attempts {
            evidence.attempts_used = attempt;
            let (command, preview) = match check.kind {
                DeploymentHealthCheckKindV2::Http => {
                    let url = check.url.as_deref().expect("validated HTTP URL");
                    (
                        http_health_command(url, check.timeout_seconds),
                        format!(
                            "rollback HTTP health {} expects {}",
                            check.id,
                            check.expected_status.expect("validated HTTP status")
                        ),
                    )
                }
                DeploymentHealthCheckKindV2::Service => {
                    let service = document
                        .services
                        .iter()
                        .find(|service| Some(service.id.as_str()) == check.service_id.as_deref())
                        .expect("validated rollback service health reference");
                    (
                        service_health_command(&service.unit),
                        format!("rollback systemd health {} expects active", service.unit),
                    )
                }
            };
            match run_action(
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
                        evidence.observed_status = observed;
                        passed = observed == check.expected_status;
                    }
                    DeploymentHealthCheckKindV2::Service => {
                        let observed = result.stdout.trim().to_string();
                        evidence.observed_state = Some(observed.clone());
                        passed = observed == "active";
                    }
                },
                Err(error) => {
                    evidence.error = Some(error.clone());
                    if cancelled.load(Ordering::SeqCst) || Instant::now() >= deadline {
                        evidence.status = if cancelled.load(Ordering::SeqCst) {
                            "cancelled".into()
                        } else {
                            "timedOut".into()
                        };
                        machine.result.health_evidence.push(evidence);
                        fail_machine(&mut machine, cancelled, deadline, error);
                        return machine.result;
                    }
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
                    evidence.error = Some(error.clone());
                    machine.result.health_evidence.push(evidence);
                    fail_machine(&mut machine, cancelled, deadline, error);
                    return machine.result;
                }
            }
        }
        if !passed {
            machine.result.actions[action_index].status = RollbackExecutionActionStatusV2::Failed;
            machine.result.actions[action_index].error =
                Some("rollback health check exhausted all reviewed attempts".into());
            evidence.error.get_or_insert_with(|| {
                "rollback health check did not reach its expected state".into()
            });
            machine.result.health_evidence.push(evidence);
            machine.fail(
                RollbackExecutionPhaseV2::Failed,
                "healthCheck",
                format!("rollback health check {} failed", check.id),
            );
            return machine.result;
        }
        evidence.status = "passed".into();
        evidence.error = None;
        machine.result.health_evidence.push(evidence);
    }
    if let Err(error) = machine.transition(RollbackExecutionPhaseV2::Succeeded) {
        machine.fail(RollbackExecutionPhaseV2::Failed, "stateMachine", error);
    } else {
        machine.result.completed_at = now_ms();
    }
    machine.result
}

#[tauri::command]
pub(crate) fn execute_rollback(
    app: AppHandle,
    database: State<'_, crate::db::Database>,
    credentials: State<'_, CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    registry: State<'_, RollbackExecutionRegistry>,
    request: RollbackExecutionRequestV2,
) -> Result<RollbackExecutionResultV2, String> {
    if !valid_operation_id(&request.operation_id) {
        return Err("rollback operation identity is invalid".into());
    }
    let consumed = consume_review::<RollbackExecutionReviewV2, _>(
        &database,
        DeploymentOperationKind::Rollback,
        &request.approval.review_id,
        &request.operation_id,
        &request.approval,
    )?;
    let cancelled = registry.start(&request.operation_id)?;
    let _guard = ActiveRollbackGuard {
        registry: &registry,
        operation_id: &request.operation_id,
        cancelled: Arc::clone(&cancelled),
    };
    let result = execute_consumed_review(
        &app,
        &database,
        &credentials,
        &cancellations,
        &consumed.review,
        &request,
        &cancelled,
        &consumed.execution_token,
    );
    checkpoint_operation(
        &database,
        &request.operation_id,
        &consumed.execution_token,
        result.phase.as_str(),
        true,
        &result,
    )?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn cancel_rollback(
    registry: State<'_, RollbackExecutionRegistry>,
    operation_id: String,
) -> Result<(), String> {
    if !valid_operation_id(&operation_id) {
        return Err("rollback operation identity is invalid".into());
    }
    registry.cancel(&operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AuthMethod, ProfileAuthMethod, ProfileRow};

    fn connection() -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: "target.example.test".into(),
            port: 22,
            username: "operator".into(),
            auth_method: AuthMethod::Password,
            password: Some("profile-secret".into()),
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
                id: "profile-1".into(),
                name: "Deployment target".into(),
                host: "target.example.test".into(),
                port: 22,
                username: "operator".into(),
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

    fn rollback_review() -> RollbackExecutionReviewV2 {
        let document = parse_deployment_runbook_v2(include_str!(
            "../../docs/examples/deployment-runbook-v2.runbook.json"
        ))
        .unwrap();
        let source = RollbackSourceRecord {
            review_json: String::new(),
            source_operation_id: "deployment:source".into(),
            source_phase: "succeeded".into(),
            previous_release: "/srv/acme-api/releases/previous".into(),
            new_release: document.release.release_directory.clone(),
            releases_directory: document.release.releases_directory.clone(),
            active_symlink: document.release.active_symlink.clone(),
            captured_at: 1_000,
        };
        let target =
            FrozenTargetIdentity::from_connection("profile-1".into(), &connection()).unwrap();
        RollbackExecutionReviewV2 {
            schema_version: 2,
            review_id: "rollback-review:test".into(),
            operation_id: "rollback:test".into(),
            source_operation_id: source.source_operation_id.clone(),
            source_review_id: "deployment-review:source".into(),
            source_phase: source.source_phase.clone(),
            document_digest: "sha256-v1:document".into(),
            plan_digest: "sha256-v1:plan".into(),
            deployment_id: document.deployment.id.clone(),
            application_id: document.deployment.application_id.clone(),
            environment: document.deployment.environment.clone(),
            version: document.deployment.version.clone(),
            current_release: source.new_release.clone(),
            previous_release: source.previous_release.clone(),
            releases_directory: source.releases_directory.clone(),
            active_symlink: source.active_symlink.clone(),
            snapshot_captured_at: source.captured_at,
            declared_risk: RunbookRisk::StateChange,
            target,
            total_timeout_seconds: 600,
            actions: build_actions(&document, &source),
            reviewed_at: now_ms(),
            expires_at: now_ms() + REVIEW_TTL_MS,
        }
    }

    #[test]
    fn successful_rollback_state_is_linear_and_non_recursive() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/deployment-runbook/v2/rollback-recovery.json"
        ))
        .unwrap();
        assert_eq!(fixture["stage"], 3);
        assert!(fixture["rollbackBoundary"]["forbiddenCallerFields"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("command")));
        let review = rollback_review();
        let mut machine = RollbackStateMachine::new(&review);
        for phase in [
            RollbackExecutionPhaseV2::InspectingTarget,
            RollbackExecutionPhaseV2::ReactivatingPreviousRelease,
            RollbackExecutionPhaseV2::ApplyingServices,
            RollbackExecutionPhaseV2::Verifying,
            RollbackExecutionPhaseV2::Succeeded,
        ] {
            machine.transition(phase).unwrap();
        }
        machine.result.reactivation.activation_changed = true;
        assert!(machine.result.phase.terminal());
        assert!(machine
            .transition(RollbackExecutionPhaseV2::ReactivatingPreviousRelease)
            .is_err());
    }

    #[test]
    fn separate_approval_binds_source_releases_and_rejects_replay_shape() {
        let review = rollback_review();
        let approval = RollbackExecutionApprovalV2 {
            review_id: review.review_id.clone(),
            operation_id: review.operation_id.clone(),
            source_operation_id: review.source_operation_id.clone(),
            document_digest: review.document_digest.clone(),
            plan_digest: review.plan_digest.clone(),
            target_digest: review.target.identity_digest.clone(),
            current_release: review.current_release.clone(),
            previous_release: review.previous_release.clone(),
            approved_risk: review.declared_risk,
            authorized: true,
            destructive_confirmed: false,
        };
        assert!(approval_matches_review(&approval, &review));
        assert!(!approval_matches_review(
            &RollbackExecutionApprovalV2 {
                previous_release: "/srv/acme-api/releases/injected".into(),
                ..approval
            },
            &review
        ));
    }

    #[test]
    fn source_document_plan_and_target_drift_fail_review_revalidation() {
        let review = rollback_review();
        let source = RollbackSourceRecord {
            review_json: String::new(),
            source_operation_id: review.source_operation_id.clone(),
            source_phase: review.source_phase.clone(),
            previous_release: review.previous_release.clone(),
            new_release: review.current_release.clone(),
            releases_directory: review.releases_directory.clone(),
            active_symlink: review.active_symlink.clone(),
            captured_at: review.snapshot_captured_at,
        };
        let deployment_review = DeploymentExecutionReviewV2 {
            schema_version: 2,
            review_id: review.source_review_id.clone(),
            operation_id: review.source_operation_id.clone(),
            normalized_runbook_text: String::new(),
            document_digest: review.document_digest.clone(),
            plan_digest: "sha256-v1:source-plan".into(),
            deployment_id: review.deployment_id.clone(),
            application_id: review.application_id.clone(),
            environment: review.environment.clone(),
            version: review.version.clone(),
            artifact_digests: Vec::new(),
            declared_risk: review.declared_risk,
            target: review.target.clone(),
            policy: crate::deployment_execution::DeploymentExecutionPolicyV2 {
                artifact_timeout_seconds: 300,
                max_artifact_bytes: 1024,
                max_expanded_bytes: 2048,
                max_archive_entries: 16,
                total_timeout_seconds: 600,
            },
            actions: Vec::new(),
            reviewed_at: review.reviewed_at,
            expires_at: review.expires_at,
        };
        assert!(current_material_matches_review(
            &review,
            &source,
            &deployment_review,
            &review.actions,
            review.declared_risk,
            &review.plan_digest,
        ));

        let mut document_drift = deployment_review.clone();
        document_drift.document_digest = "sha256-v1:changed-document".into();
        assert!(!current_material_matches_review(
            &review,
            &source,
            &document_drift,
            &review.actions,
            review.declared_risk,
            &review.plan_digest,
        ));
        let mut target_drift = deployment_review;
        target_drift.target.host = "other.example.test".into();
        assert!(!current_material_matches_review(
            &review,
            &source,
            &target_drift,
            &review.actions,
            review.declared_risk,
            &review.plan_digest,
        ));
        assert!(!current_material_matches_review(
            &review,
            &source,
            &target_drift,
            &review.actions,
            review.declared_risk,
            "sha256-v1:changed-plan",
        ));
    }

    #[test]
    fn no_previous_release_and_consumed_snapshots_fail_closed() {
        let (_directory, database) = database();
        let error = load_rollback_source(&database, "deployment:missing").unwrap_err();
        assert!(error.contains("not found"));
        assert!(!is_safe_release_path(
            "/srv/acme-api/current",
            "/srv/acme-api/releases"
        ));
    }

    #[test]
    fn current_release_drift_is_checked_in_both_read_and_mutating_templates() {
        let review = rollback_review();
        let inspect = inspection_command(&review, false);
        let activate = activation_command(&review, false);
        assert!(inspect.contains("[ \"$current\" = \"$current_release\" ]"));
        assert!(activate.contains("[ \"$current\" = \"$current_release\" ]"));
        assert!(activate.contains("mv -Tf"));
    }

    #[test]
    fn partial_service_or_health_failure_preserves_reactivation_evidence() {
        let review = rollback_review();
        let mut machine = RollbackStateMachine::new(&review);
        machine
            .transition(RollbackExecutionPhaseV2::InspectingTarget)
            .unwrap();
        machine
            .transition(RollbackExecutionPhaseV2::ReactivatingPreviousRelease)
            .unwrap();
        machine.result.reactivation.activation_changed = true;
        machine.result.reactivation.changed_at = Some(now_ms());
        machine
            .transition(RollbackExecutionPhaseV2::ApplyingServices)
            .unwrap();
        machine.fail(
            RollbackExecutionPhaseV2::Failed,
            "healthCheck",
            "partial rollback verification failed".into(),
        );
        assert!(machine.result.reactivation.activation_changed);
        assert_eq!(machine.result.phase, RollbackExecutionPhaseV2::Failed);
    }
}
