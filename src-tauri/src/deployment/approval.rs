use super::{
    ApprovedDeploymentAction, DeploymentOperationKind, DeploymentTriggerKind,
    DeploymentValidationError, DeploymentWorkflowDefinition, APPROVAL_SCHEMA_VERSION,
    MAX_APPROVAL_JSON_BYTES,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(crate) const MIN_PLAN_TTL_SECONDS: u32 = 60;
pub(crate) const MAX_PLAN_TTL_SECONDS: u32 = 30 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentFrozenSourceRevision {
    pub revision: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentJumpHostIdentitySnapshot {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentTargetIdentitySnapshot {
    pub profile_id: String,
    pub profile_updated_at: i64,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub jump_host: Option<DeploymentJumpHostIdentitySnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentReleaseIdentity {
    pub release_id: String,
    pub artifact_digest_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeploymentPreflightOutcome {
    Passed,
    Warning,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentPreflightCheckSummary {
    pub code: String,
    pub outcome: DeploymentPreflightOutcome,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentPreflightSummary {
    pub checked_at: i64,
    pub checks: Vec<DeploymentPreflightCheckSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentFrozenPlanInputs {
    pub source_revision: DeploymentFrozenSourceRevision,
    pub target: DeploymentTargetIdentitySnapshot,
    pub current_release: Option<DeploymentReleaseIdentity>,
    pub target_release: DeploymentReleaseIdentity,
    pub rollback_release: Option<DeploymentReleaseIdentity>,
    pub preflight: DeploymentPreflightSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentApprovalPlanSummary {
    pub schema_version: u32,
    pub workflow_id: String,
    pub workflow_revision: u32,
    pub operation_kind: DeploymentOperationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_reference: Option<String>,
    pub frozen: DeploymentFrozenPlanInputs,
    pub remote_root: String,
    pub compose_project: String,
    pub compose_files: Vec<String>,
    pub services: Vec<String>,
    pub actions: Vec<ApprovedDeploymentAction>,
    pub generated_at: i64,
    pub expires_at: i64,
}

impl DeploymentApprovalPlanSummary {
    pub(crate) fn from_json(json: &str) -> Result<Self, DeploymentValidationError> {
        if json.is_empty() || json.len() > MAX_APPROVAL_JSON_BYTES {
            return Err(DeploymentValidationError::new(format!(
                "approval summary must contain between 1 and {MAX_APPROVAL_JSON_BYTES} bytes"
            )));
        }
        let summary: Self = serde_json::from_str(json).map_err(|error| {
            DeploymentValidationError::new(format!("invalid approval summary: {error}"))
        })?;
        summary.validate()?;
        Ok(summary)
    }

    pub(crate) fn validate(&self) -> Result<(), DeploymentValidationError> {
        if !matches!(self.schema_version, 1 | APPROVAL_SCHEMA_VERSION) {
            return Err(DeploymentValidationError::new(format!(
                "unsupported approval schema version {}",
                self.schema_version
            )));
        }
        match (self.schema_version, self.artifact_reference.as_deref()) {
            (1, None) => {}
            (APPROVAL_SCHEMA_VERSION, Some(reference)) => {
                super::validate_artifact_reference(reference)?;
            }
            _ => {
                return Err(DeploymentValidationError::new(
                    "approval schema and artifact reference are inconsistent",
                ));
            }
        }
        super::validate_identifier("workflow id", &self.workflow_id, 128)?;
        if self.workflow_revision == 0 {
            return Err(DeploymentValidationError::new(
                "workflow revision must be positive",
            ));
        }
        self.frozen.validate()?;
        super::validate_remote_root(&self.remote_root)?;
        super::validate_compose_project(&self.compose_project)?;
        super::validate_unique_relative_paths("compose files", &self.compose_files, 8)?;
        super::validate_unique_identifiers("compose services", &self.services, 64, 128)?;
        validate_actions(&self.actions)?;
        if self.generated_at < 0 || self.expires_at <= self.generated_at {
            return Err(DeploymentValidationError::new(
                "deployment plan expiry must be after generation",
            ));
        }
        let lifetime = self.expires_at.saturating_sub(self.generated_at);
        if lifetime < i64::from(MIN_PLAN_TTL_SECONDS) * 1_000
            || lifetime > i64::from(MAX_PLAN_TTL_SECONDS) * 1_000
        {
            return Err(DeploymentValidationError::new(
                "deployment plan lifetime is outside the supported range",
            ));
        }
        let serialized = serde_json::to_string(self)
            .map_err(|error| DeploymentValidationError::new(error.to_string()))?;
        if serialized.len() > MAX_APPROVAL_JSON_BYTES {
            return Err(DeploymentValidationError::new(
                "approval summary exceeds the storage limit",
            ));
        }
        if crate::runbook::contains_secret_literal(&serialized) {
            return Err(DeploymentValidationError::new(
                "approval summary must not contain secret literals",
            ));
        }
        Ok(())
    }

    pub(crate) fn canonical_json(&self) -> Result<String, DeploymentValidationError> {
        let mut canonical = self.clone();
        canonical.services.sort();
        canonical.frozen.preflight.checks.sort_by(|left, right| {
            left.code
                .cmp(&right.code)
                .then_with(|| outcome_name(left.outcome).cmp(outcome_name(right.outcome)))
                .then_with(|| left.summary.cmp(&right.summary))
        });
        canonical.validate()?;
        serde_json::to_string(&canonical)
            .map_err(|error| DeploymentValidationError::new(error.to_string()))
    }

    pub(crate) fn plan_digest(&self) -> Result<String, DeploymentValidationError> {
        let canonical = self.canonical_json()?;
        Ok(Sha256::digest(canonical.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }

    pub(crate) fn plan_id(&self) -> Result<String, DeploymentValidationError> {
        Ok(format!("plan-{}", self.plan_digest()?))
    }

    pub(crate) fn verify_integrity(
        &self,
        plan_id: &str,
        plan_digest: &str,
        now: i64,
    ) -> Result<(), String> {
        let expected_digest = self.plan_digest().map_err(|error| error.to_string())?;
        let expected_id = format!("plan-{expected_digest}");
        if plan_digest != expected_digest || plan_id != expected_id {
            return Err("DEPLOYMENT_PLAN_INTEGRITY_FAILURE".into());
        }
        if now >= self.expires_at {
            return Err("DEPLOYMENT_PLAN_EXPIRED".into());
        }
        Ok(())
    }

    pub(crate) fn verify_frozen_inputs(
        &self,
        current: &DeploymentFrozenPlanInputs,
        now: i64,
    ) -> Result<(), String> {
        self.validate().map_err(|error| error.to_string())?;
        current.validate().map_err(|error| error.to_string())?;
        if now >= self.expires_at {
            return Err("DEPLOYMENT_PLAN_EXPIRED".into());
        }
        let mut expected = self.frozen.clone();
        let mut actual = current.clone();
        expected
            .preflight
            .checks
            .sort_by(|left, right| left.code.cmp(&right.code));
        actual
            .preflight
            .checks
            .sort_by(|left, right| left.code.cmp(&right.code));
        if expected != actual {
            return Err("DEPLOYMENT_PLAN_INPUT_CHANGED".into());
        }
        Ok(())
    }

    pub(crate) fn verify_for_approval(
        &self,
        plan_id: &str,
        plan_digest: &str,
        current: &DeploymentFrozenPlanInputs,
        now: i64,
    ) -> Result<(), String> {
        self.verify_integrity(plan_id, plan_digest, now)?;
        self.verify_frozen_inputs(current, now)
    }
}

impl DeploymentFrozenPlanInputs {
    pub(crate) fn validate(&self) -> Result<(), DeploymentValidationError> {
        self.source_revision.validate()?;
        self.target.validate()?;
        self.current_release
            .as_ref()
            .map(DeploymentReleaseIdentity::validate)
            .transpose()?;
        self.target_release.validate()?;
        self.rollback_release
            .as_ref()
            .map(DeploymentReleaseIdentity::validate)
            .transpose()?;
        if self
            .current_release
            .as_ref()
            .is_some_and(|release| release == &self.target_release)
        {
            return Err(DeploymentValidationError::new(
                "target release must differ from the current release",
            ));
        }
        self.preflight.validate()
    }
}

impl DeploymentFrozenSourceRevision {
    fn validate(&self) -> Result<(), DeploymentValidationError> {
        if !matches!(self.revision.len(), 40 | 64)
            || !self
                .revision
                .chars()
                .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
        {
            return Err(DeploymentValidationError::new(
                "source revision must be a lowercase Git object digest",
            ));
        }
        Ok(())
    }
}

impl DeploymentTargetIdentitySnapshot {
    fn validate(&self) -> Result<(), DeploymentValidationError> {
        super::validate_identifier("target profile id", &self.profile_id, 128)?;
        if self.profile_updated_at < 0 || self.port == 0 {
            return Err(DeploymentValidationError::new(
                "target identity timestamp or port is invalid",
            ));
        }
        validate_host_identity("target host", &self.host, &self.username, &self.auth_method)?;
        if let Some(jump_host) = &self.jump_host {
            jump_host.validate()?;
        }
        Ok(())
    }
}

impl DeploymentJumpHostIdentitySnapshot {
    fn validate(&self) -> Result<(), DeploymentValidationError> {
        if self.port == 0 {
            return Err(DeploymentValidationError::new(
                "jump-host port must be positive",
            ));
        }
        validate_host_identity("jump host", &self.host, &self.username, &self.auth_method)
    }
}

impl DeploymentReleaseIdentity {
    pub(super) fn validate(&self) -> Result<(), DeploymentValidationError> {
        super::validate_identifier("release id", &self.release_id, 128)?;
        super::validate_sha256(&self.artifact_digest_sha256)
    }
}

impl DeploymentPreflightSummary {
    fn validate(&self) -> Result<(), DeploymentValidationError> {
        if self.checked_at < 0 || self.checks.is_empty() || self.checks.len() > 32 {
            return Err(DeploymentValidationError::new(
                "preflight summary timestamp or check count is invalid",
            ));
        }
        let mut codes = BTreeSet::new();
        for check in &self.checks {
            super::validate_identifier("preflight check code", &check.code, 64)?;
            super::validate_text("preflight check summary", &check.summary, 512)?;
            if !codes.insert(&check.code) {
                return Err(DeploymentValidationError::new(
                    "preflight check codes must be unique",
                ));
            }
            if crate::runbook::contains_secret_literal(&check.summary) {
                return Err(DeploymentValidationError::new(
                    "preflight summaries must not contain secret literals",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentPlanCreateInput {
    pub workflow_id: String,
    pub expected_revision: u32,
    pub source_run_id: Option<String>,
    pub operation_kind: DeploymentOperationKind,
    pub trigger_kind: DeploymentTriggerKind,
    pub artifact_reference: String,
    pub source_revision: DeploymentFrozenSourceRevision,
    pub target: DeploymentTargetIdentitySnapshot,
    pub current_release: Option<DeploymentReleaseIdentity>,
    pub target_release: DeploymentReleaseIdentity,
    pub rollback_release: Option<DeploymentReleaseIdentity>,
    pub preflight: DeploymentPreflightSummary,
    pub ttl_seconds: u32,
}

impl DeploymentPlanCreateInput {
    pub(crate) fn validate(&self) -> Result<(), DeploymentValidationError> {
        super::validate_identifier("workflow id", &self.workflow_id, 128)?;
        super::validate_artifact_reference(&self.artifact_reference)?;
        if self.expected_revision == 0
            || !(MIN_PLAN_TTL_SECONDS..=MAX_PLAN_TTL_SECONDS).contains(&self.ttl_seconds)
        {
            return Err(DeploymentValidationError::new(
                "plan revision or lifetime is invalid",
            ));
        }
        match (self.operation_kind, self.source_run_id.as_deref()) {
            (DeploymentOperationKind::Deploy, None) => {}
            (DeploymentOperationKind::Resume | DeploymentOperationKind::Rollback, Some(id)) => {
                super::validate_identifier("source run id", id, 128)?;
            }
            _ => {
                return Err(DeploymentValidationError::new(
                    "resume and rollback require a source run; deploy forbids one",
                ));
            }
        }
        DeploymentFrozenPlanInputs {
            source_revision: self.source_revision.clone(),
            target: self.target.clone(),
            current_release: self.current_release.clone(),
            target_release: self.target_release.clone(),
            rollback_release: self.rollback_release.clone(),
            preflight: self.preflight.clone(),
        }
        .validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentStoredPlanRecord {
    pub plan_id: String,
    pub plan_digest: String,
    pub run_id: String,
    pub run_revision: u32,
    pub status: super::DeploymentRunStatus,
    pub approval_summary: DeploymentApprovalPlanSummary,
    pub created_at: i64,
    pub expires_at: i64,
}

pub(crate) fn approval_summary_for(
    workflow_id: String,
    workflow_revision: u32,
    operation_kind: DeploymentOperationKind,
    artifact_reference: String,
    frozen: DeploymentFrozenPlanInputs,
    workflow: &DeploymentWorkflowDefinition,
    actions: Vec<ApprovedDeploymentAction>,
    generated_at: i64,
    expires_at: i64,
) -> Result<DeploymentApprovalPlanSummary, DeploymentValidationError> {
    let summary = DeploymentApprovalPlanSummary {
        schema_version: APPROVAL_SCHEMA_VERSION,
        workflow_id,
        workflow_revision,
        operation_kind,
        artifact_reference: Some(artifact_reference),
        frozen,
        remote_root: workflow.target.remote_root.clone(),
        compose_project: workflow.compose.project_name.clone(),
        compose_files: workflow.compose.files.clone(),
        services: workflow.compose.services.clone(),
        actions,
        generated_at,
        expires_at,
    };
    summary.validate()?;
    Ok(summary)
}

fn validate_actions(actions: &[ApprovedDeploymentAction]) -> Result<(), DeploymentValidationError> {
    if actions.is_empty() || actions.len() > 16 {
        return Err(DeploymentValidationError::new(
            "approval actions must contain between 1 and 16 entries",
        ));
    }
    let unique = actions.iter().copied().collect::<BTreeSet<_>>();
    if unique.len() != actions.len() {
        return Err(DeploymentValidationError::new(
            "approval actions must not contain duplicates",
        ));
    }
    Ok(())
}

fn validate_host_identity(
    label: &str,
    host: &str,
    username: &str,
    auth_method: &str,
) -> Result<(), DeploymentValidationError> {
    super::validate_text(label, host, 255)?;
    super::validate_text("target username", username, 255)?;
    if !matches!(auth_method, "password" | "key") {
        return Err(DeploymentValidationError::new(
            "target authentication method is invalid",
        ));
    }
    Ok(())
}

fn outcome_name(outcome: DeploymentPreflightOutcome) -> &'static str {
    match outcome {
        DeploymentPreflightOutcome::Passed => "passed",
        DeploymentPreflightOutcome::Warning => "warning",
        DeploymentPreflightOutcome::Blocked => "blocked",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> DeploymentApprovalPlanSummary {
        DeploymentApprovalPlanSummary {
            schema_version: APPROVAL_SCHEMA_VERSION,
            workflow_id: "workflow-1".into(),
            workflow_revision: 3,
            operation_kind: DeploymentOperationKind::Deploy,
            artifact_reference: Some(format!(
                "deployment-artifact-v1:{}:{}",
                "9".repeat(64),
                "8".repeat(64)
            )),
            frozen: DeploymentFrozenPlanInputs {
                source_revision: DeploymentFrozenSourceRevision {
                    revision: "a".repeat(40),
                    dirty: false,
                },
                target: DeploymentTargetIdentitySnapshot {
                    profile_id: "profile-1".into(),
                    profile_updated_at: 12,
                    host: "example.test".into(),
                    port: 22,
                    username: "deploy".into(),
                    auth_method: "password".into(),
                    jump_host: None,
                },
                current_release: Some(DeploymentReleaseIdentity {
                    release_id: "release-old".into(),
                    artifact_digest_sha256: "b".repeat(64),
                }),
                target_release: DeploymentReleaseIdentity {
                    release_id: "release-new".into(),
                    artifact_digest_sha256: "c".repeat(64),
                },
                rollback_release: Some(DeploymentReleaseIdentity {
                    release_id: "release-rollback".into(),
                    artifact_digest_sha256: "d".repeat(64),
                }),
                preflight: DeploymentPreflightSummary {
                    checked_at: 1_000,
                    checks: vec![
                        DeploymentPreflightCheckSummary {
                            code: "disk".into(),
                            outcome: DeploymentPreflightOutcome::Passed,
                            summary: "Capacity is sufficient".into(),
                        },
                        DeploymentPreflightCheckSummary {
                            code: "compose".into(),
                            outcome: DeploymentPreflightOutcome::Passed,
                            summary: "Compose is available".into(),
                        },
                    ],
                },
            },
            remote_root: "/srv/shellspan/app".into(),
            compose_project: "app".into(),
            compose_files: vec!["compose.yaml".into()],
            services: vec!["worker".into(), "web".into()],
            actions: vec![
                ApprovedDeploymentAction::StageRelease,
                ApprovedDeploymentAction::ComposeUp,
            ],
            generated_at: 1_000,
            expires_at: 61_000,
        }
    }

    #[test]
    fn canonical_digest_is_stable_across_non_semantic_input_order() {
        let left = summary();
        let mut right = left.clone();
        right.services.reverse();
        right.frozen.preflight.checks.reverse();
        assert_eq!(
            left.canonical_json().unwrap(),
            right.canonical_json().unwrap()
        );
        assert_eq!(left.plan_digest().unwrap(), right.plan_digest().unwrap());
        assert_eq!(left.plan_id().unwrap(), right.plan_id().unwrap());
    }

    #[test]
    fn unknown_fields_critical_changes_and_expiry_fail_closed() {
        let plan = summary();
        let mut value = serde_json::to_value(&plan).unwrap();
        value["credential"] = serde_json::Value::String("not-allowed".into());
        assert!(DeploymentApprovalPlanSummary::from_json(&value.to_string()).is_err());
        assert!(
            DeploymentApprovalPlanSummary::from_json(&"x".repeat(MAX_APPROVAL_JSON_BYTES + 1))
                .unwrap_err()
                .to_string()
                .contains("65536")
        );

        let mut changed = plan.frozen.clone();
        changed.target_release.release_id = "release-other".into();
        assert_eq!(
            plan.verify_frozen_inputs(&changed, 2_000).unwrap_err(),
            "DEPLOYMENT_PLAN_INPUT_CHANGED"
        );
        let mut changed_source = plan.frozen.clone();
        changed_source.source_revision.revision = "e".repeat(40);
        assert_eq!(
            plan.verify_frozen_inputs(&changed_source, 2_000)
                .unwrap_err(),
            "DEPLOYMENT_PLAN_INPUT_CHANGED"
        );
        assert_eq!(
            plan.verify_frozen_inputs(&plan.frozen, plan.expires_at)
                .unwrap_err(),
            "DEPLOYMENT_PLAN_EXPIRED"
        );
    }

    #[test]
    fn integrity_binds_plan_id_digest_and_summary() {
        let plan = summary();
        let digest = plan.plan_digest().unwrap();
        let id = plan.plan_id().unwrap();
        plan.verify_for_approval(&id, &digest, &plan.frozen, 2_000)
            .unwrap();

        let mut changed = plan;
        changed.workflow_revision += 1;
        assert_eq!(
            changed.verify_integrity(&id, &digest, 2_000).unwrap_err(),
            "DEPLOYMENT_PLAN_INTEGRITY_FAILURE"
        );
    }

    #[test]
    fn legacy_v1_summary_remains_digest_readable_but_has_no_phase5_artifact_authority() {
        let mut legacy = summary();
        legacy.schema_version = 1;
        legacy.artifact_reference = None;
        legacy.actions = vec![
            ApprovedDeploymentAction::StageRelease,
            ApprovedDeploymentAction::ComposeUp,
            ApprovedDeploymentAction::ActivateRelease,
        ];
        let json = legacy.canonical_json().unwrap();
        assert!(!json.contains("artifactReference"));
        let decoded = DeploymentApprovalPlanSummary::from_json(&json).unwrap();
        assert_eq!(decoded.schema_version, 1);
        assert!(decoded.artifact_reference.is_none());
        assert_eq!(
            decoded.plan_digest().unwrap(),
            legacy.plan_digest().unwrap()
        );
    }
}
