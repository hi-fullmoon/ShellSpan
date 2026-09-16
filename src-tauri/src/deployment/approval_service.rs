//! Native deployment approval decisions.
//!
//! Approval is deliberately separate from plan creation and from every Agent
//! or quick-action entry point. Each request carries the exact immutable plan
//! identity, run event revision, and expiry observed by the UI. The database
//! compare-and-swap and event append happen in one transaction.

use super::artifact::verify_deployment_artifact;
use super::planner::get_deployment_plan;
use super::preflight::run_deployment_preflight;
use super::preflight::DeploymentPreflightStatus;
use super::repository::DeploymentEventWrite;
use super::{
    DeploymentEventKind, DeploymentFrozenPlanInputs, DeploymentPreflightRequest,
    DeploymentRunStatus, DeploymentStoredPlanRecord,
};
use crate::db::{current_timestamp_ms, Database};
use crate::execution::ExecutionCancellationRegistry;
use crate::keychain::CredentialManager;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentApprovalRequest {
    pub plan_id: String,
    pub plan_digest: String,
    pub run_id: String,
    pub run_revision: u32,
    pub expires_at: i64,
}

pub(crate) type DeploymentApprovalDecisionRequest = DeploymentApprovalRequest;

fn validate_binding(
    database: &Database,
    input: &DeploymentApprovalRequest,
    expected_status: DeploymentRunStatus,
) -> Result<DeploymentStoredPlanRecord, String> {
    super::validate_sha256(&input.plan_digest).map_err(|error| error.to_string())?;
    super::validate_identifier("deployment run id", &input.run_id, 128)
        .map_err(|error| error.to_string())?;
    if input.plan_id != format!("plan-{}", input.plan_digest) || input.run_revision == 0 {
        return Err("DEPLOYMENT_APPROVAL_BINDING_INVALID".into());
    }
    let plan = get_deployment_plan(database, &input.plan_id)?;
    if plan.plan_digest != input.plan_digest
        || plan.run_id != input.run_id
        || plan.expires_at != input.expires_at
        || plan.status != expected_status
    {
        return Err("DEPLOYMENT_APPROVAL_BINDING_CHANGED".into());
    }
    let run = database
        .get_deployment_run(&input.run_id)?
        .ok_or_else(|| "DEPLOYMENT_RUN_NOT_FOUND".to_string())?;
    if run.approval_digest != input.plan_digest
        || run.last_event_sequence != input.run_revision
        || run.status != expected_status
    {
        return Err("REVISION_CONFLICT".into());
    }
    Ok(plan)
}

fn approval_payload(input: &DeploymentApprovalRequest) -> serde_json::Value {
    serde_json::json!({
        "planId": input.plan_id,
        "planDigest": input.plan_digest,
        "runId": input.run_id,
        "runRevision": input.run_revision,
        "expiresAt": input.expires_at,
    })
}

pub(crate) fn request_deployment_approval(
    database: &Database,
    input: DeploymentApprovalRequest,
) -> Result<DeploymentStoredPlanRecord, String> {
    validate_binding(database, &input, DeploymentRunStatus::Planned)?;
    database.transition_deployment_run_atomic(
        &input.run_id,
        input.run_revision,
        DeploymentRunStatus::Planned,
        DeploymentRunStatus::AwaitingApproval,
        &DeploymentEventWrite {
            event_kind: DeploymentEventKind::ApprovalRequested,
            status: Some(DeploymentRunStatus::AwaitingApproval),
            summary: "Exact deployment plan submitted for native approval".into(),
            payload: Some(approval_payload(&input)),
        },
    )?;
    get_deployment_plan(database, &input.plan_id)
}

fn verify_approval_inputs(
    database: &Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    artifact_staging_root: &Path,
    input: &DeploymentApprovalDecisionRequest,
) -> Result<DeploymentStoredPlanRecord, String> {
    let plan = validate_binding(database, input, DeploymentRunStatus::AwaitingApproval)?;
    let artifact_reference = plan
        .approval_summary
        .artifact_reference
        .as_deref()
        .ok_or_else(|| "DEPLOYMENT_APPROVAL_REQUIRES_V2_PLAN".to_string())?;
    let artifact = verify_deployment_artifact(artifact_staging_root, artifact_reference)
        .map_err(|_| "DEPLOYMENT_ARTIFACT_INVALID".to_string())?;
    let frozen = &plan.approval_summary.frozen;
    if artifact.manifest.workflow_id != plan.approval_summary.workflow_id
        || artifact.manifest.workflow_revision != plan.approval_summary.workflow_revision
        || artifact.manifest.source_revision != frozen.source_revision
        || artifact.target_release() != frozen.target_release
    {
        return Err("DEPLOYMENT_PLAN_INPUT_CHANGED".into());
    }

    let result = run_deployment_preflight(
        database,
        credentials,
        cancellations,
        known_hosts_path,
        artifact_staging_root,
        DeploymentPreflightRequest {
            operation_id: format!("deployment-preflight:approval-{}", uuid::Uuid::new_v4()),
            workflow_id: plan.approval_summary.workflow_id.clone(),
            expected_revision: plan.approval_summary.workflow_revision,
            artifact_reference: artifact_reference.to_string(),
            ttl_seconds: super::approval::MIN_PLAN_TTL_SECONDS,
            timeout_ms: 30_000,
        },
    );
    if result.status != DeploymentPreflightStatus::Passed {
        return Err("DEPLOYMENT_APPROVAL_REVALIDATION_FAILED".into());
    }
    let observed_plan = result
        .plan_input
        .ok_or_else(|| "DEPLOYMENT_APPROVAL_REVALIDATION_FAILED".to_string())?;
    if observed_plan.source_revision != frozen.source_revision
        || observed_plan.target != frozen.target
        || observed_plan.current_release != frozen.current_release
        || observed_plan.target_release != frozen.target_release
        || observed_plan.rollback_release != frozen.rollback_release
        || observed_plan.preflight.checks != frozen.preflight.checks
    {
        return Err("DEPLOYMENT_PLAN_INPUT_CHANGED".into());
    }

    // The fresh check timestamp is observational rather than an approved
    // action input. After proving the check set is byte-for-byte unchanged,
    // pass the original timestamp-bound summary through the plan's canonical
    // integrity verifier as required by the approval contract.
    let current = DeploymentFrozenPlanInputs {
        source_revision: observed_plan.source_revision,
        target: observed_plan.target,
        current_release: observed_plan.current_release,
        target_release: observed_plan.target_release,
        rollback_release: observed_plan.rollback_release,
        preflight: frozen.preflight.clone(),
    };
    plan.approval_summary.verify_for_approval(
        &input.plan_id,
        &input.plan_digest,
        &current,
        current_timestamp_ms(),
    )?;
    Ok(plan)
}

pub(crate) fn approve_deployment_plan(
    database: &Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    artifact_staging_root: &Path,
    input: DeploymentApprovalDecisionRequest,
) -> Result<DeploymentStoredPlanRecord, String> {
    verify_approval_inputs(
        database,
        credentials,
        cancellations,
        known_hosts_path,
        artifact_staging_root,
        &input,
    )?;
    database.transition_deployment_run_atomic(
        &input.run_id,
        input.run_revision,
        DeploymentRunStatus::AwaitingApproval,
        DeploymentRunStatus::Approved,
        &DeploymentEventWrite {
            event_kind: DeploymentEventKind::ApprovalGranted,
            status: Some(DeploymentRunStatus::Approved),
            summary: "Exact deployment plan approved after native revalidation".into(),
            payload: Some(approval_payload(&input)),
        },
    )?;
    get_deployment_plan(database, &input.plan_id)
}

pub(crate) fn reject_deployment_plan(
    database: &Database,
    input: DeploymentApprovalDecisionRequest,
) -> Result<DeploymentStoredPlanRecord, String> {
    validate_binding(database, &input, DeploymentRunStatus::AwaitingApproval)?;
    database.transition_deployment_run_atomic(
        &input.run_id,
        input.run_revision,
        DeploymentRunStatus::AwaitingApproval,
        DeploymentRunStatus::Canceled,
        &DeploymentEventWrite {
            event_kind: DeploymentEventKind::ApprovalRejected,
            status: Some(DeploymentRunStatus::Canceled),
            summary: "Exact deployment plan rejected by the user".into(),
            payload: Some(approval_payload(&input)),
        },
    )?;
    get_deployment_plan(database, &input.plan_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::{
        DeploymentArtifactCompression, DeploymentFrozenSourceRevision, DeploymentOperationKind,
        DeploymentPlanCreateInput, DeploymentPreflightCheckSummary, DeploymentPreflightOutcome,
        DeploymentPreflightSummary, DeploymentReleaseIdentity, DeploymentTarget,
        DeploymentTriggerKind, DeploymentWorkflowCreate, DeploymentWorkflowDefinition,
        DockerBuildxPlan, DockerComposePlan,
    };
    use crate::models::{ProfileAuthMethod, ProfileRow};

    fn fixture() -> (tempfile::TempDir, Database, DeploymentStoredPlanRecord) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("approval.db")).unwrap();
        let profile = ProfileRow {
            id: "profile-1".into(),
            name: "Production".into(),
            host: "example.test".into(),
            port: 22,
            username: "deploy".into(),
            auth_method: ProfileAuthMethod::Key,
            keychain_key_id: Some("credential-reference".into()),
            jump_host_config: None,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        };
        database.insert_profile(&profile).unwrap();
        database
            .create_deployment_workflow(
                "workflow-1",
                &DeploymentWorkflowCreate {
                    name: "API".into(),
                    definition: DeploymentWorkflowDefinition {
                        schema_version: 2,
                        source_directory: std::env::current_dir()
                            .unwrap()
                            .canonicalize()
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                        build: DockerBuildxPlan {
                            context: ".".into(),
                            dockerfile: "Dockerfile".into(),
                            platform: "linux/amd64".into(),
                            image_repository: "example.test/shellspan/app".into(),
                            compression: DeploymentArtifactCompression::None,
                        },
                        target: DeploymentTarget {
                            connection_profile_id: profile.id.clone(),
                            remote_root: "/srv/app".into(),
                        },
                        compose: DockerComposePlan {
                            project_name: "app".into(),
                            files: vec!["compose.yaml".into()],
                            services: vec!["web".into()],
                            pull_before_up: false,
                        },
                        health_check: None,
                        reload_nginx_after_healthy: false,
                        releases_to_keep: 3,
                    },
                    enabled: true,
                },
            )
            .unwrap();
        let target = super::super::planner::target_identity(&profile).unwrap();
        let plan = super::super::planner::create_deployment_plan(
            &database,
            DeploymentPlanCreateInput {
                workflow_id: "workflow-1".into(),
                expected_revision: 1,
                source_run_id: None,
                operation_kind: DeploymentOperationKind::Deploy,
                trigger_kind: DeploymentTriggerKind::Manual,
                artifact_reference: format!(
                    "deployment-artifact-v1:{}:{}",
                    "a".repeat(64),
                    "b".repeat(64)
                ),
                source_revision: DeploymentFrozenSourceRevision {
                    revision: "c".repeat(40),
                    dirty: false,
                },
                target,
                current_release: None,
                target_release: DeploymentReleaseIdentity {
                    release_id: "release-next".into(),
                    artifact_digest_sha256: "d".repeat(64),
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
                ttl_seconds: 600,
            },
        )
        .unwrap();
        (directory, database, plan)
    }

    #[test]
    fn decision_wire_rejects_unbound_or_unknown_fields() {
        let value = serde_json::json!({
            "planId": format!("plan-{}", "a".repeat(64)),
            "planDigest": "a".repeat(64),
            "runId": "run-1",
            "runRevision": 2,
            "expiresAt": 1234,
            "approvedByAgent": true
        });
        assert!(serde_json::from_value::<DeploymentApprovalDecisionRequest>(value).is_err());
    }

    #[test]
    fn request_and_rejection_bind_revision_expiry_and_event_atomically() {
        let (_directory, database, plan) = fixture();
        let input = DeploymentApprovalRequest {
            plan_id: plan.plan_id.clone(),
            plan_digest: plan.plan_digest.clone(),
            run_id: plan.run_id.clone(),
            run_revision: plan.run_revision,
            expires_at: plan.expires_at,
        };
        let mut wrong_expiry = input.clone();
        wrong_expiry.expires_at += 1;
        assert_eq!(
            request_deployment_approval(&database, wrong_expiry).unwrap_err(),
            "DEPLOYMENT_APPROVAL_BINDING_CHANGED"
        );

        let awaiting = request_deployment_approval(&database, input).unwrap();
        assert_eq!(awaiting.status, DeploymentRunStatus::AwaitingApproval);
        assert_eq!(awaiting.run_revision, 2);
        assert_eq!(
            request_deployment_approval(
                &database,
                DeploymentApprovalRequest {
                    plan_id: awaiting.plan_id.clone(),
                    plan_digest: awaiting.plan_digest.clone(),
                    run_id: awaiting.run_id.clone(),
                    run_revision: 1,
                    expires_at: awaiting.expires_at,
                },
            )
            .unwrap_err(),
            "DEPLOYMENT_APPROVAL_BINDING_CHANGED"
        );
        let rejected = reject_deployment_plan(
            &database,
            DeploymentApprovalDecisionRequest {
                plan_id: awaiting.plan_id.clone(),
                plan_digest: awaiting.plan_digest.clone(),
                run_id: awaiting.run_id.clone(),
                run_revision: awaiting.run_revision,
                expires_at: awaiting.expires_at,
            },
        )
        .unwrap();
        assert_eq!(rejected.status, DeploymentRunStatus::Canceled);
        assert_eq!(rejected.run_revision, 3);
        let events = database
            .list_deployment_run_events(&rejected.run_id, 0, 10)
            .unwrap();
        assert_eq!(events[1].event_kind, DeploymentEventKind::ApprovalRequested);
        assert_eq!(events[2].event_kind, DeploymentEventKind::ApprovalRejected);
        assert_eq!(
            events[2].payload.as_ref().unwrap()["planDigest"],
            plan.plan_digest
        );
    }
}
