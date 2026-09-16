//! Pure-data deployment plan construction.
//!
//! This module deliberately performs no filesystem discovery, credential
//! lookup, network access, SSH, transfer, Docker, or reverse-proxy work. A
//! future preflight layer may submit its bounded result through
//! `DeploymentPlanCreateInput`; this layer only validates, freezes, hashes,
//! and persists that data.

use super::approval::approval_summary_for;
use super::repository::{DeploymentEventWrite, DeploymentRunWrite};
use super::{
    ApprovedDeploymentAction, DeploymentFrozenPlanInputs, DeploymentJumpHostIdentitySnapshot,
    DeploymentOperationKind, DeploymentPlanCreateInput, DeploymentPreflightOutcome,
    DeploymentRunStatus, DeploymentStoredPlanRecord, DeploymentTargetIdentitySnapshot,
    DeploymentWorkflowRecord,
};
use crate::db::{current_timestamp_ms, Database};
use crate::models::{JumpHostConfig, ProfileRow};

pub(crate) fn target_identity(
    profile: &ProfileRow,
) -> Result<DeploymentTargetIdentitySnapshot, String> {
    let jump_host = profile
        .jump_host_config
        .as_deref()
        .map(serde_json::from_str::<JumpHostConfig>)
        .transpose()
        .map_err(|error| format!("stored jump-host identity is invalid: {error}"))?
        .map(|jump| DeploymentJumpHostIdentitySnapshot {
            host: jump.host,
            port: jump.port,
            username: jump.username,
            auth_method: jump.auth_method.as_str().to_string(),
        });
    Ok(DeploymentTargetIdentitySnapshot {
        profile_id: profile.id.clone(),
        profile_updated_at: profile.updated_at,
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth_method: profile.auth_method.as_str().to_string(),
        jump_host,
    })
}

fn actions_for(
    workflow: &DeploymentWorkflowRecord,
    operation_kind: DeploymentOperationKind,
    has_rollback_release: bool,
) -> Vec<ApprovedDeploymentAction> {
    if operation_kind == DeploymentOperationKind::Rollback {
        let mut actions = vec![
            ApprovedDeploymentAction::RestoreRelease,
            ApprovedDeploymentAction::VerifyHealth,
        ];
        if workflow.definition.reload_nginx_after_healthy {
            actions.push(ApprovedDeploymentAction::ValidateNginx);
            actions.push(ApprovedDeploymentAction::ReloadNginx);
            actions.push(ApprovedDeploymentAction::ReverifyHealth);
        }
        return actions;
    }

    let mut actions = vec![
        ApprovedDeploymentAction::StageRelease,
        ApprovedDeploymentAction::PrepareRelease,
        ApprovedDeploymentAction::LoadImage,
    ];
    actions.push(ApprovedDeploymentAction::ComposeConfig);
    if workflow.definition.compose.pull_before_up {
        actions.push(ApprovedDeploymentAction::ComposePull);
    }
    actions.push(ApprovedDeploymentAction::ComposeUp);
    actions.push(ApprovedDeploymentAction::VerifyHealth);
    if workflow.definition.reload_nginx_after_healthy {
        actions.push(ApprovedDeploymentAction::ValidateNginx);
        actions.push(ApprovedDeploymentAction::ReloadNginx);
        actions.push(ApprovedDeploymentAction::ReverifyHealth);
    }
    actions.push(ApprovedDeploymentAction::ActivateRelease);
    if has_rollback_release {
        actions.push(ApprovedDeploymentAction::AutomaticRestore);
    }
    actions
}

fn validate_preflight_for_plan(input: &DeploymentPlanCreateInput, now: i64) -> Result<(), String> {
    if input.preflight.checked_at > now {
        return Err("deployment preflight timestamp is in the future".into());
    }
    if input
        .preflight
        .checks
        .iter()
        .any(|check| check.outcome == DeploymentPreflightOutcome::Blocked)
    {
        return Err("DEPLOYMENT_PREFLIGHT_BLOCKED".into());
    }
    Ok(())
}

fn stored_plan_from_run(
    run: super::DeploymentRunRecord,
    now: i64,
) -> Result<DeploymentStoredPlanRecord, String> {
    let plan_digest = run
        .approval_summary
        .plan_digest()
        .map_err(|error| error.to_string())?;
    let plan_id = run
        .approval_summary
        .plan_id()
        .map_err(|error| error.to_string())?;
    run.approval_summary
        .verify_integrity(&plan_id, &run.approval_digest, now)?;
    Ok(DeploymentStoredPlanRecord {
        plan_id,
        plan_digest,
        run_id: run.id,
        run_revision: run.last_event_sequence,
        status: run.status,
        expires_at: run.approval_summary.expires_at,
        approval_summary: run.approval_summary,
        created_at: run.created_at,
    })
}

pub(crate) fn create_deployment_plan(
    database: &Database,
    input: DeploymentPlanCreateInput,
) -> Result<DeploymentStoredPlanRecord, String> {
    input.validate().map_err(|error| error.to_string())?;
    let workflow = database
        .get_deployment_workflow(&input.workflow_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_NOT_FOUND".to_string())?;
    if workflow.revision != input.expected_revision {
        return Err("REVISION_CONFLICT".into());
    }
    if !workflow.enabled {
        return Err("DEPLOYMENT_WORKFLOW_DISABLED".into());
    }
    let profile = database
        .get_profile(&workflow.connection_profile_id)?
        .ok_or_else(|| "DEPLOYMENT_PROFILE_NOT_FOUND".to_string())?;
    let current_target = target_identity(&profile)?;
    if current_target != input.target {
        return Err("DEPLOYMENT_PLAN_INPUT_CHANGED".into());
    }
    let generated_at = current_timestamp_ms();
    validate_preflight_for_plan(&input, generated_at)?;
    let expires_at = generated_at
        .checked_add(i64::from(input.ttl_seconds) * 1_000)
        .ok_or_else(|| "deployment plan expiry overflow".to_string())?;
    let frozen = DeploymentFrozenPlanInputs {
        source_revision: input.source_revision,
        target: input.target,
        current_release: input.current_release,
        target_release: input.target_release,
        rollback_release: input.rollback_release,
        preflight: input.preflight,
    };
    let actions = actions_for(
        &workflow,
        input.operation_kind,
        frozen.rollback_release.is_some(),
    );
    let approval_summary = approval_summary_for(
        workflow.id.clone(),
        workflow.revision,
        input.operation_kind,
        input.artifact_reference,
        frozen,
        &workflow.definition,
        actions,
        generated_at,
        expires_at,
    )
    .map_err(|error| error.to_string())?;
    let approval_digest = approval_summary
        .plan_digest()
        .map_err(|error| error.to_string())?;
    let plan_id = approval_summary
        .plan_id()
        .map_err(|error| error.to_string())?;
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    database.create_deployment_run_atomic(
        &DeploymentRunWrite {
            id: run_id.clone(),
            workflow_id: workflow.id,
            workflow_revision: workflow.revision,
            source_run_id: input.source_run_id,
            operation_kind: input.operation_kind,
            trigger_kind: input.trigger_kind,
            status: DeploymentRunStatus::Planned,
            approval_summary,
            approval_digest: approval_digest.clone(),
        },
        &DeploymentEventWrite {
            event_kind: super::DeploymentEventKind::RunCreated,
            status: Some(DeploymentRunStatus::Planned),
            summary: "Deployment plan created".into(),
            payload: Some(serde_json::json!({
                "planId": plan_id,
                "planDigest": approval_digest,
            })),
        },
    )?;
    let run = database
        .get_deployment_run(&run_id)?
        .ok_or_else(|| "created deployment run was not found".to_string())?;
    stored_plan_from_run(run, generated_at)
}

pub(crate) fn get_deployment_plan(
    database: &Database,
    plan_id: &str,
) -> Result<DeploymentStoredPlanRecord, String> {
    let digest = plan_id
        .strip_prefix("plan-")
        .ok_or_else(|| "deployment plan id is invalid".to_string())?;
    super::validate_sha256(digest).map_err(|_| "deployment plan id is invalid".to_string())?;
    let run = database
        .get_deployment_run_by_approval_digest(digest)?
        .ok_or_else(|| "DEPLOYMENT_PLAN_NOT_FOUND".to_string())?;
    let now = current_timestamp_ms();
    let plan = stored_plan_from_run(run, now)?;
    let workflow = database
        .get_deployment_workflow(&plan.approval_summary.workflow_id)?
        .ok_or_else(|| "DEPLOYMENT_PLAN_INPUT_CHANGED".to_string())?;
    if workflow.revision != plan.approval_summary.workflow_revision
        || workflow.connection_profile_id != plan.approval_summary.frozen.target.profile_id
        || !workflow.enabled
    {
        return Err("DEPLOYMENT_PLAN_INPUT_CHANGED".into());
    }
    let profile = database
        .get_profile(&workflow.connection_profile_id)?
        .ok_or_else(|| "DEPLOYMENT_PLAN_INPUT_CHANGED".to_string())?;
    if target_identity(&profile)? != plan.approval_summary.frozen.target {
        return Err("DEPLOYMENT_PLAN_INPUT_CHANGED".into());
    }
    if plan.approval_summary.schema_version == 1 {
        return Ok(plan);
    }
    let expected_summary = approval_summary_for(
        workflow.id.clone(),
        workflow.revision,
        plan.approval_summary.operation_kind,
        plan.approval_summary
            .artifact_reference
            .clone()
            .ok_or_else(|| "DEPLOYMENT_PLAN_INPUT_CHANGED".to_string())?,
        plan.approval_summary.frozen.clone(),
        &workflow.definition,
        actions_for(
            &workflow,
            plan.approval_summary.operation_kind,
            plan.approval_summary.frozen.rollback_release.is_some(),
        ),
        plan.approval_summary.generated_at,
        plan.approval_summary.expires_at,
    )
    .map_err(|_| "DEPLOYMENT_PLAN_INPUT_CHANGED".to_string())?;
    if expected_summary
        .canonical_json()
        .map_err(|_| "DEPLOYMENT_PLAN_INPUT_CHANGED".to_string())?
        != plan
            .approval_summary
            .canonical_json()
            .map_err(|_| "DEPLOYMENT_PLAN_INPUT_CHANGED".to_string())?
    {
        return Err("DEPLOYMENT_PLAN_INPUT_CHANGED".into());
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::super::approval::{
        DeploymentFrozenSourceRevision, DeploymentPreflightCheckSummary,
        DeploymentPreflightSummary, DeploymentReleaseIdentity,
    };
    use super::super::{DeploymentTriggerKind, DeploymentWorkflowCreate};
    use super::*;
    use crate::models::{ProfileAuthMethod, ProfileRow};

    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("deployment-plan.db")).unwrap();
        database
            .insert_profile(&ProfileRow {
                id: "profile-1".into(),
                name: "Production".into(),
                host: "example.test".into(),
                port: 22,
                username: "deploy".into(),
                auth_method: ProfileAuthMethod::Password,
                keychain_key_id: Some("credential-reference-not-frozen".into()),
                jump_host_config: None,
                organization_json: None,
                created_at: 1,
                updated_at: 7,
            })
            .unwrap();
        let definition = super::super::DeploymentWorkflowDefinition {
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
        };
        database
            .create_deployment_workflow(
                "workflow-1",
                &DeploymentWorkflowCreate {
                    name: "API".into(),
                    definition,
                    enabled: true,
                },
            )
            .unwrap();
        (directory, database)
    }

    fn input() -> DeploymentPlanCreateInput {
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
                profile_updated_at: 7,
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
                    code: "data-ready".into(),
                    outcome: DeploymentPreflightOutcome::Passed,
                    summary: "Preflight input is ready".into(),
                }],
            },
            ttl_seconds: 60,
        }
    }

    #[test]
    fn pure_data_plan_is_persisted_and_queryable() {
        let (_directory, database) = database();
        let created = create_deployment_plan(&database, input()).unwrap();
        assert_eq!(created.status, DeploymentRunStatus::Planned);
        assert_eq!(created.plan_digest.len(), 64);
        assert_eq!(created.plan_id, format!("plan-{}", created.plan_digest));
        assert_eq!(created.approval_summary.frozen.target.profile_updated_at, 7);
        let encoded = serde_json::to_string(&created.approval_summary).unwrap();
        assert!(!encoded.contains("credential-reference-not-frozen"));
        let wire = serde_json::to_value(&created).unwrap();
        assert_eq!(wire["planId"], created.plan_id);
        assert_eq!(wire["runId"], created.run_id);
        assert_eq!(
            wire["approvalSummary"]["frozen"]["sourceRevision"]["revision"],
            "a".repeat(40)
        );
        assert!(wire.get("plan_id").is_none());

        let queried = get_deployment_plan(&database, &created.plan_id).unwrap();
        assert_eq!(queried, created);
        assert_eq!(database.list_deployment_runs(None, 10).unwrap().len(), 1);
        assert_eq!(
            database
                .list_deployment_runs(Some("workflow-1"), 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            database
                .list_deployment_run_events(&created.run_id, 0, 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn revision_profile_changes_and_blocked_preflight_fail_closed() {
        let (_directory, database) = database();
        let created = create_deployment_plan(&database, input()).unwrap();
        let mut profile = database.get_profile("profile-1").unwrap().unwrap();
        profile.updated_at = 8;
        profile.host = "changed.example.test".into();
        database.update_profile("profile-1", &profile).unwrap();
        assert_eq!(
            get_deployment_plan(&database, &created.plan_id).unwrap_err(),
            "DEPLOYMENT_PLAN_INPUT_CHANGED"
        );

        let mut blocked = input();
        assert_eq!(
            create_deployment_plan(&database, blocked.clone()).unwrap_err(),
            "DEPLOYMENT_PLAN_INPUT_CHANGED"
        );
        blocked.target.profile_updated_at = 8;
        blocked.target.host = "changed.example.test".into();
        blocked.preflight.checks[0].outcome = DeploymentPreflightOutcome::Blocked;
        assert_eq!(
            create_deployment_plan(&database, blocked).unwrap_err(),
            "DEPLOYMENT_PREFLIGHT_BLOCKED"
        );
    }
}
