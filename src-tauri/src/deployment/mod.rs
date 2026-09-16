#![allow(dead_code)]

//! Deployment protocol, persistence, approval-plan validation, and the
//! fixed-purpose local artifact builder.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt::{Display, Formatter};

mod approval;
mod approval_service;
mod artifact;
mod artifact_transfer;
mod audit;
pub(crate) mod commands;
mod planner;
mod preflight;
mod remote_runner;
mod repository;

pub(crate) use approval::{
    DeploymentApprovalPlanSummary, DeploymentFrozenPlanInputs, DeploymentFrozenSourceRevision,
    DeploymentJumpHostIdentitySnapshot, DeploymentPlanCreateInput, DeploymentPreflightCheckSummary,
    DeploymentPreflightOutcome, DeploymentPreflightSummary, DeploymentReleaseIdentity,
    DeploymentStoredPlanRecord, DeploymentTargetIdentitySnapshot,
};
pub(crate) use approval_service::{DeploymentApprovalDecisionRequest, DeploymentApprovalRequest};
pub(crate) use artifact::{
    DeploymentArtifactBuildRequest, DeploymentArtifactBuildResult,
    DeploymentArtifactSourceSnapshotRequest,
};
pub(crate) use artifact_transfer::{
    DeploymentArtifactTransferRequest, DeploymentArtifactTransferResult,
};
pub(crate) use audit::DeploymentAuditExportResult;
pub(crate) use preflight::{DeploymentPreflightRequest, DeploymentPreflightResult};
pub(crate) use remote_runner::{
    DeploymentReconciliationBinding, DeploymentReconciliationRequest,
    DeploymentReconciliationResult, DeploymentRemoteRunnerCancelRequest,
    DeploymentRemoteRunnerRequest, DeploymentRemoteRunnerResult, DeploymentStartupRecoveryResult,
};
pub(crate) use repository::{
    DeploymentNotificationReceipt, DeploymentRunDetail, DeploymentRunEventPage,
    DeploymentRunEventRecord, DeploymentRunPage, DeploymentRunRecord, DeploymentWorkflowCreate,
    DeploymentWorkflowRecord, DeploymentWorkflowUpdate,
};

pub(crate) const WORKFLOW_SCHEMA_VERSION: u32 = 2;
pub(crate) const APPROVAL_SCHEMA_VERSION: u32 = 2;
pub(crate) const MAX_WORKFLOW_JSON_BYTES: usize = 128 * 1024;
pub(crate) const MAX_APPROVAL_JSON_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeploymentValidationError(String);

impl DeploymentValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for DeploymentValidationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DeploymentValidationError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeploymentOperationKind {
    Deploy,
    Resume,
    Rollback,
}

impl DeploymentOperationKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Deploy => "deploy",
            Self::Resume => "resume",
            Self::Rollback => "rollback",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeploymentTriggerKind {
    Manual,
    Agent,
    QuickAction,
    Recovery,
}

impl DeploymentTriggerKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Agent => "agent",
            Self::QuickAction => "quick_action",
            Self::Recovery => "recovery",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Canceled | Self::Failed)
    }

    pub(crate) fn requires_reconciliation(self) -> bool {
        matches!(self, Self::StateUnknown)
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        use DeploymentRunStatus::{
            Approved, AwaitingApproval, CancelRequested, Canceled, Failed, InProgress, Planned,
            Reconciling, StateUnknown, Succeeded, Verifying,
        };
        matches!(
            (self, next),
            (Planned, AwaitingApproval | Canceled)
                | (AwaitingApproval, Approved | Canceled | Failed)
                | (
                    Approved,
                    AwaitingApproval | Reconciling | InProgress | CancelRequested | Failed
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeploymentEventKind {
    RunCreated,
    ApprovalRequested,
    ApprovalGranted,
    ApprovalRejected,
    ReconciliationStarted,
    ReconciliationCompleted,
    StatusChanged,
    CancellationRequested,
    ResumeLinked,
    RollbackLinked,
    RunSucceeded,
    RunCanceled,
    RunFailed,
}

impl DeploymentEventKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::RunCreated => "run_created",
            Self::ApprovalRequested => "approval_requested",
            Self::ApprovalGranted => "approval_granted",
            Self::ApprovalRejected => "approval_rejected",
            Self::ReconciliationStarted => "reconciliation_started",
            Self::ReconciliationCompleted => "reconciliation_completed",
            Self::StatusChanged => "status_changed",
            Self::CancellationRequested => "cancellation_requested",
            Self::ResumeLinked => "resume_linked",
            Self::RollbackLinked => "rollback_linked",
            Self::RunSucceeded => "run_succeeded",
            Self::RunCanceled => "run_canceled",
            Self::RunFailed => "run_failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovedDeploymentAction {
    StageRelease,
    PrepareRelease,
    LoadImage,
    ComposePull,
    ComposeConfig,
    ComposeUp,
    VerifyHealth,
    ValidateNginx,
    ReloadNginx,
    ReverifyHealth,
    ActivateRelease,
    AutomaticRestore,
    RestoreRelease,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentTarget {
    pub connection_profile_id: String,
    pub remote_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DockerComposePlan {
    pub project_name: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub pull_before_up: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArtifactBuilderKind {
    DockerBuildx,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DeploymentArtifactCompression {
    Zstd,
    Gzip,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DockerBuildxPlan {
    pub context: String,
    pub dockerfile: String,
    pub platform: String,
    pub image_repository: String,
    pub compression: DeploymentArtifactCompression,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HttpHealthCheck {
    pub path: String,
    pub expected_status: u16,
    pub timeout_seconds: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentWorkflowDefinition {
    pub schema_version: u32,
    pub source_directory: String,
    pub build: DockerBuildxPlan,
    pub target: DeploymentTarget,
    pub compose: DockerComposePlan,
    pub health_check: Option<HttpHealthCheck>,
    #[serde(default)]
    pub reload_nginx_after_healthy: bool,
    pub releases_to_keep: u16,
}

impl DeploymentWorkflowDefinition {
    pub(crate) fn from_json(json: &str) -> Result<Self, DeploymentValidationError> {
        validate_bounded_json(json, MAX_WORKFLOW_JSON_BYTES, "workflow")?;
        let definition: Self = serde_json::from_str(json).map_err(|error| {
            DeploymentValidationError::new(format!("invalid workflow: {error}"))
        })?;
        definition.validate()?;
        Ok(definition)
    }

    pub(crate) fn validate(&self) -> Result<(), DeploymentValidationError> {
        if !matches!(self.schema_version, 1 | WORKFLOW_SCHEMA_VERSION) {
            return Err(DeploymentValidationError::new(format!(
                "unsupported workflow schema version {}",
                self.schema_version
            )));
        }
        if self.schema_version == 1 && self.reload_nginx_after_healthy {
            return Err(DeploymentValidationError::new(
                "workflow schema version 1 cannot enable Nginx reload",
            ));
        }
        validate_local_source_directory(&self.source_directory)?;
        validate_docker_buildx_plan(&self.build)?;
        validate_identifier(
            "connection profile id",
            &self.target.connection_profile_id,
            128,
        )?;
        validate_remote_root(&self.target.remote_root)?;
        validate_compose_project(&self.compose.project_name)?;
        validate_unique_relative_paths("compose files", &self.compose.files, 8)?;
        validate_unique_identifiers("compose services", &self.compose.services, 64, 128)?;
        if !(1..=20).contains(&self.releases_to_keep) {
            return Err(DeploymentValidationError::new(
                "release retention must be between 1 and 20",
            ));
        }
        if let Some(health_check) = &self.health_check {
            validate_http_health_check(health_check)?;
        }
        if self.reload_nginx_after_healthy && self.health_check.is_none() {
            return Err(DeploymentValidationError::new(
                "Nginx reload requires a typed health check",
            ));
        }
        let serialized = serde_json::to_string(self)
            .map_err(|error| DeploymentValidationError::new(error.to_string()))?;
        if crate::runbook::contains_secret_literal(&serialized) {
            return Err(DeploymentValidationError::new(
                "workflow must contain credential references, not secret literals",
            ));
        }
        Ok(())
    }
}

fn validate_docker_buildx_plan(build: &DockerBuildxPlan) -> Result<(), DeploymentValidationError> {
    validate_build_relative_path("Docker build context", &build.context, true)?;
    validate_build_relative_path("Dockerfile", &build.dockerfile, false)?;
    if !matches!(build.platform.as_str(), "linux/amd64" | "linux/arm64") {
        return Err(DeploymentValidationError::new(
            "Docker build platform must be linux/amd64 or linux/arm64",
        ));
    }
    validate_image_repository(&build.image_repository)
}

fn validate_build_relative_path(
    label: &str,
    value: &str,
    allow_project_root: bool,
) -> Result<(), DeploymentValidationError> {
    validate_text(label, value, 1024)?;
    if allow_project_root && value == "." {
        return Ok(());
    }
    if value.starts_with('/') || value.starts_with('\\') || value.contains('\\') {
        return Err(DeploymentValidationError::new(format!(
            "{label} must be a relative POSIX path"
        )));
    }
    if value
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(DeploymentValidationError::new(format!(
            "{label} must be normalized"
        )));
    }
    Ok(())
}

fn validate_image_repository(value: &str) -> Result<(), DeploymentValidationError> {
    validate_text("image repository", value, 255)?;
    if value.contains('@') || value.ends_with(':') || value.starts_with('/') || value.ends_with('/')
    {
        return Err(DeploymentValidationError::new(
            "image repository must not contain a digest, tag, or empty path segment",
        ));
    }
    if !value.contains('/') && value.contains(':') {
        return Err(DeploymentValidationError::new(
            "image repository must not include an image tag",
        ));
    }
    let mut segments = value.split('/');
    let first = segments.next().unwrap_or_default();
    let all_segments = std::iter::once(first).chain(segments);
    for (index, segment) in all_segments.enumerate() {
        if segment.is_empty()
            || !segment.chars().next().is_some_and(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit()
            })
            || !segment.chars().last().is_some_and(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit()
            })
            || !segment.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '.' | '_' | '-')
                    || (index == 0 && character == ':')
            })
        {
            return Err(DeploymentValidationError::new(
                "image repository contains unsupported characters",
            ));
        }
        if index == 0 {
            if let Some((host, port)) = segment.rsplit_once(':') {
                if host.is_empty()
                    || port.is_empty()
                    || !port.chars().all(|character| character.is_ascii_digit())
                    || port
                        .parse::<u16>()
                        .ok()
                        .filter(|value| *value > 0)
                        .is_none()
                {
                    return Err(DeploymentValidationError::new(
                        "image repository registry port is invalid",
                    ));
                }
            }
        } else if segment.contains(':') {
            return Err(DeploymentValidationError::new(
                "image repository must not include an image tag",
            ));
        }
    }
    Ok(())
}

fn validate_bounded_json(
    json: &str,
    maximum_bytes: usize,
    label: &str,
) -> Result<(), DeploymentValidationError> {
    if json.is_empty() || json.len() > maximum_bytes {
        return Err(DeploymentValidationError::new(format!(
            "{label} must contain between 1 and {maximum_bytes} bytes"
        )));
    }
    Ok(())
}

fn validate_text(
    label: &str,
    value: &str,
    maximum: usize,
) -> Result<(), DeploymentValidationError> {
    if value.is_empty() || value.len() > maximum || value.trim() != value {
        return Err(DeploymentValidationError::new(format!(
            "{label} is empty, too long, or has surrounding whitespace"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(DeploymentValidationError::new(format!(
            "{label} contains control characters"
        )));
    }
    Ok(())
}

fn validate_identifier(
    label: &str,
    value: &str,
    maximum: usize,
) -> Result<(), DeploymentValidationError> {
    validate_text(label, value, maximum)?;
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
    }) {
        return Err(DeploymentValidationError::new(format!(
            "{label} contains unsupported characters"
        )));
    }
    Ok(())
}

fn validate_compose_project(value: &str) -> Result<(), DeploymentValidationError> {
    validate_identifier("compose project", value, 63)?;
    if !value
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        || value
            .chars()
            .any(|character| character.is_ascii_uppercase())
    {
        return Err(DeploymentValidationError::new(
            "compose project must start with a lowercase letter or digit and contain no uppercase letters",
        ));
    }
    Ok(())
}

fn validate_remote_root(value: &str) -> Result<(), DeploymentValidationError> {
    validate_text("remote root", value, 4096)?;
    if value == "/" || !value.starts_with('/') || value.ends_with('/') {
        return Err(DeploymentValidationError::new(
            "remote root must be a non-root absolute POSIX path without a trailing slash",
        ));
    }
    if value
        .split('/')
        .skip(1)
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(DeploymentValidationError::new(
            "remote root must be normalized",
        ));
    }
    Ok(())
}

fn validate_local_source_directory(value: &str) -> Result<(), DeploymentValidationError> {
    use std::path::{Component, Path};

    validate_text("source directory", value, 4096)?;
    let path = Path::new(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(DeploymentValidationError::new(
            "source directory must be a normalized absolute local path",
        ));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), DeploymentValidationError> {
    validate_text("compose file", value, 1024)?;
    if value.starts_with('/') || value.starts_with('\\') || value.contains('\\') {
        return Err(DeploymentValidationError::new(
            "compose file must be a relative POSIX path",
        ));
    }
    if value
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(DeploymentValidationError::new(
            "compose file path must be normalized",
        ));
    }
    if !value.ends_with(".yml") && !value.ends_with(".yaml") {
        return Err(DeploymentValidationError::new(
            "compose file must use a .yml or .yaml extension",
        ));
    }
    Ok(())
}

fn validate_unique_relative_paths(
    label: &str,
    values: &[String],
    maximum: usize,
) -> Result<(), DeploymentValidationError> {
    if values.is_empty() || values.len() > maximum {
        return Err(DeploymentValidationError::new(format!(
            "{label} must contain between 1 and {maximum} entries"
        )));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate_relative_path(value)?;
        if !unique.insert(value) {
            return Err(DeploymentValidationError::new(format!(
                "{label} must not contain duplicates"
            )));
        }
    }
    Ok(())
}

fn validate_unique_identifiers(
    label: &str,
    values: &[String],
    maximum_entries: usize,
    maximum_length: usize,
) -> Result<(), DeploymentValidationError> {
    if values.len() > maximum_entries {
        return Err(DeploymentValidationError::new(format!(
            "{label} contains too many entries"
        )));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate_identifier(label, value, maximum_length)?;
        if !unique.insert(value) {
            return Err(DeploymentValidationError::new(format!(
                "{label} must not contain duplicates"
            )));
        }
    }
    Ok(())
}

fn validate_http_health_check(
    health_check: &HttpHealthCheck,
) -> Result<(), DeploymentValidationError> {
    validate_text("health-check path", &health_check.path, 2048)?;
    if !health_check.path.starts_with('/') || health_check.path.starts_with("//") {
        return Err(DeploymentValidationError::new(
            "health-check path must be an absolute HTTP path",
        ));
    }
    if !(100..=599).contains(&health_check.expected_status) {
        return Err(DeploymentValidationError::new(
            "health-check status must be a valid HTTP status code",
        ));
    }
    if !(1..=300).contains(&health_check.timeout_seconds) {
        return Err(DeploymentValidationError::new(
            "health-check timeout must be between 1 and 300 seconds",
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), DeploymentValidationError> {
    if value.len() != 64
        || !value
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
    {
        return Err(DeploymentValidationError::new(
            "artifact digest must be a lowercase SHA-256 hex digest",
        ));
    }
    Ok(())
}

fn validate_artifact_reference(value: &str) -> Result<(), DeploymentValidationError> {
    let mut parts = value.split(':');
    if parts.next() != Some("deployment-artifact-v1")
        || parts
            .next()
            .is_none_or(|value| validate_sha256(value).is_err())
        || parts
            .next()
            .is_none_or(|value| validate_sha256(value).is_err())
        || parts.next().is_some()
    {
        return Err(DeploymentValidationError::new(
            "deployment artifact reference is invalid",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_workflow_json() -> String {
        let source_directory = std::env::current_dir()
            .unwrap()
            .join("deployment-fixture")
            .to_string_lossy()
            .into_owned();
        serde_json::json!({
            "schemaVersion": 2,
            "sourceDirectory": source_directory,
            "build": {
                "context": ".",
                "dockerfile": "Dockerfile",
                "platform": "linux/amd64",
                "imageRepository": "example.test/shellspan/api",
                "compression": "zstd"
            },
            "target": {
                "connectionProfileId": "profile-1",
                "remoteRoot": "/srv/shellspan/api"
            },
            "compose": {
                "projectName": "api",
                "files": ["compose.yaml"],
                "services": ["web"],
                "pullBeforeUp": true
            },
            "healthCheck": {
                "path": "/healthz",
                "expectedStatus": 200,
                "timeoutSeconds": 30
            },
            "reloadNginxAfterHealthy": false,
            "releasesToKeep": 3
        })
        .to_string()
    }

    #[test]
    fn workflow_validation_accepts_only_the_typed_compose_contract() {
        let workflow = DeploymentWorkflowDefinition::from_json(&valid_workflow_json()).unwrap();
        assert_eq!(workflow.compose.project_name, "api");

        let mut value: serde_json::Value = serde_json::from_str(&valid_workflow_json()).unwrap();
        value["remoteShell"] = serde_json::Value::String("docker compose up".into());
        let error = DeploymentWorkflowDefinition::from_json(&value.to_string()).unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn workflow_validation_rejects_unsafe_paths_and_secret_literals() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_workflow_json()).unwrap();
        value["target"]["remoteRoot"] = serde_json::Value::String("/srv/../root".into());
        assert!(DeploymentWorkflowDefinition::from_json(&value.to_string()).is_err());

        let mut value: serde_json::Value = serde_json::from_str(&valid_workflow_json()).unwrap();
        value["sourceDirectory"] = serde_json::Value::String(
            std::env::current_dir()
                .unwrap()
                .join("token=plaintext")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(DeploymentWorkflowDefinition::from_json(&value.to_string())
            .unwrap_err()
            .to_string()
            .contains("secret literals"));
    }

    #[test]
    fn workflow_validation_rejects_build_escape_and_image_tags() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_workflow_json()).unwrap();
        value["build"]["context"] = serde_json::Value::String("../outside".into());
        assert!(DeploymentWorkflowDefinition::from_json(&value.to_string()).is_err());

        let mut value: serde_json::Value = serde_json::from_str(&valid_workflow_json()).unwrap();
        value["build"]["imageRepository"] =
            serde_json::Value::String("example.test/api:latest".into());
        assert!(DeploymentWorkflowDefinition::from_json(&value.to_string()).is_err());
    }

    #[test]
    fn workflow_release_and_service_identifiers_reject_injection_and_controls() {
        for service in ["web;touch-pwned", "web$(id)", "web\nnext"] {
            let mut value: serde_json::Value =
                serde_json::from_str(&valid_workflow_json()).unwrap();
            value["compose"]["services"] = serde_json::json!([service]);
            assert!(DeploymentWorkflowDefinition::from_json(&value.to_string()).is_err());
        }
        for remote_root in ["/srv/app\nnext", "/srv/../root", "/srv/app/"] {
            let mut value: serde_json::Value =
                serde_json::from_str(&valid_workflow_json()).unwrap();
            value["target"]["remoteRoot"] = serde_json::json!(remote_root);
            assert!(DeploymentWorkflowDefinition::from_json(&value.to_string()).is_err());
        }
        assert!(DeploymentReleaseIdentity {
            release_id: "release-1;touch-pwned".into(),
            artifact_digest_sha256: "a".repeat(64),
        }
        .validate()
        .is_err());
    }

    #[test]
    fn nginx_reload_is_typed_versioned_and_requires_health() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_workflow_json()).unwrap();
        value["reloadNginxAfterHealthy"] = serde_json::Value::Bool(true);
        assert!(DeploymentWorkflowDefinition::from_json(&value.to_string()).is_ok());

        value["healthCheck"] = serde_json::Value::Null;
        assert!(DeploymentWorkflowDefinition::from_json(&value.to_string())
            .unwrap_err()
            .to_string()
            .contains("requires a typed health check"));

        value["nginxCommand"] = serde_json::Value::String("systemctl restart nginx".into());
        assert!(DeploymentWorkflowDefinition::from_json(&value.to_string())
            .unwrap_err()
            .to_string()
            .contains("unknown field"));
    }

    #[test]
    fn state_unknown_can_only_enter_reconciliation() {
        assert!(
            DeploymentRunStatus::StateUnknown.can_transition_to(DeploymentRunStatus::Reconciling)
        );
        assert!(
            !DeploymentRunStatus::StateUnknown.can_transition_to(DeploymentRunStatus::InProgress)
        );
        assert!(!DeploymentRunStatus::Succeeded.can_transition_to(DeploymentRunStatus::InProgress));
        assert!(DeploymentRunStatus::StateUnknown.requires_reconciliation());
        assert!(DeploymentRunStatus::Succeeded.is_terminal());
    }
}
