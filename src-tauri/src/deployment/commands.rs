use super::artifact_cas::ArtifactBundleProjection;
use super::audit::{
    build_deployment_audit_document, save_deployment_audit_document, DeploymentAuditExportResult,
};
use super::compiler::compile_workflow_definition;
use super::docker_compose_executor::{
    docker_compose_executor_registry, NativeDockerComposeBackend,
};
use super::node_registry::DeploymentNodeRegistry;
use super::repository::{
    CreateDeploymentWorkflowInput, DeploymentArtifactReferenceRecord, DeploymentArtifactRetention,
    DeploymentNodeAttemptPage, DeploymentReleaseRecord, DeploymentRunEventPage,
    DeploymentRunNodeRecord, DeploymentRunOutputKind, DeploymentRunRecord, DeploymentRunStatus,
    DeploymentWorkflowLayoutRecord, DeploymentWorkflowPage, DeploymentWorkflowRecord,
    UpdateDeploymentWorkflowInput, UpdateDeploymentWorkflowLayoutInput,
};
use super::run_coordinator::{
    approve_run, begin_start_run, cancel_run, execute_approved_run, prepare_run_observed,
    reconcile_run, verify_pre_start_frozen_inputs, PreparationProgress, PrepareRunRequest,
};
use super::runtime::{
    DeploymentWorkflowAdmission, DeploymentWorkflowCapabilities, DeploymentWorkflowRuntime,
};
use super::validation_error::WorkflowValidationError;
use super::workflow_schema::{
    ArtifactBundleManifest, ArtifactHandle, CompiledRunPlanDraft, DeploymentWorkflowDefinition,
    EffectReceipt, FrozenReleaseIdentity, ImmutableRunPlan, ScalarValue, WorkflowRunOperationKind,
    WorkflowRunTriggerKind,
};
use crate::db::{current_timestamp_ms, Database};
use crate::execution::ExecutionCancellationRegistry;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ValidateDeploymentWorkflowInput {
    pub definition: DeploymentWorkflowDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateStaticSiteDeploymentWorkflowInput {
    pub name: String,
    pub connection_profile_id: String,
    pub remote_root: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowValidationResult {
    pub valid: bool,
    pub errors: Vec<WorkflowValidationError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled: Option<CompiledRunPlanDraft>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareDeploymentRunInput {
    pub workflow_id: String,
    pub workflow_revision: u64,
    pub operation_kind: WorkflowRunOperationKind,
    pub trigger_kind: WorkflowRunTriggerKind,
    #[serde(default)]
    pub parameters: BTreeMap<String, ScalarValue>,
    #[serde(default)]
    pub rollback_release_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRunPlanBindingInput {
    pub run_id: String,
    pub plan_digest: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentApprovalSource {
    ManualUi,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentApprovalBindingInput {
    pub run_id: String,
    pub plan_digest: String,
    pub approval_source: DeploymentApprovalSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRunIdInput {
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentPrepareResult {
    pub run_id: String,
    pub plan_digest: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunProjection {
    pub run_id: String,
    pub status: String,
    pub plan_digest: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentReconciliationResult {
    pub run_id: String,
    pub status: String,
    pub evidence_complete: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactInspection {
    pub handle: ArtifactHandle,
    pub manifest: ArtifactBundleManifest,
    pub component_count: u32,
    pub total_size: u64,
    pub retention: DeploymentArtifactRetention,
    pub references: Vec<DeploymentArtifactReferenceRecord>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunSummary {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: u64,
    pub operation_kind: WorkflowRunOperationKind,
    pub trigger_kind: WorkflowRunTriggerKind,
    pub status: String,
    pub plan_digest: String,
    pub target_release: FrozenReleaseIdentity,
    pub artifact_references: Vec<String>,
    pub expires_at: i64,
    pub expired: bool,
    pub plan_drifted: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunPage {
    pub items: Vec<DeploymentRunSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunOutputProjection {
    pub node_id: String,
    pub output_name: String,
    pub output_kind: String,
    pub value: serde_json::Value,
    pub artifact_reference: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunDetail {
    pub summary: DeploymentRunSummary,
    pub approval_summary: Option<serde_json::Value>,
    pub outputs: Vec<DeploymentRunOutputProjection>,
    pub receipts: Vec<EffectReceipt>,
    pub service_observation: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentNodeProgressEvent {
    pub workflow_id: String,
    pub operation_id: String,
    pub run_id: String,
    pub node_id: String,
    pub attempt: u32,
    pub sequence: u32,
    pub phase: String,
    pub completed: u32,
    pub total: u32,
    pub unit: String,
    pub summary_key: String,
}

fn native_executors(
    app: &AppHandle,
    database: Database,
    credentials: crate::keychain::CredentialManager,
    cancellations: ExecutionCancellationRegistry,
    runtime: &DeploymentWorkflowRuntime,
) -> Result<super::node_executor::DeploymentNodeExecutorRegistry, String> {
    let known_hosts_path = crate::known_hosts::known_hosts_path(app)?;
    let backend = NativeDockerComposeBackend::new(
        app.clone(),
        database,
        credentials,
        cancellations,
        known_hosts_path,
        runtime.artifacts().clone(),
    )?;
    docker_compose_executor_registry(Arc::new(backend))
}

fn run_summary(
    database: &Database,
    run: &DeploymentRunRecord,
) -> Result<DeploymentRunSummary, String> {
    let plan: ImmutableRunPlan = serde_json::from_value(run.plan.clone())
        .map_err(|_| "DEPLOYMENT_WORKFLOW_STORED_PLAN_INVALID".to_string())?;
    let head = database.get_deployment_workflow(&run.workflow_id)?;
    let plan_drifted = head.as_ref().is_none_or(|workflow| {
        workflow.archived
            || !workflow.enabled
            || workflow.revision != run.workflow_revision
            || workflow.definition_digest != run.definition_digest
    });
    Ok(DeploymentRunSummary {
        run_id: run.id.clone(),
        workflow_id: run.workflow_id.clone(),
        workflow_revision: run.workflow_revision,
        operation_kind: run.operation_kind,
        trigger_kind: run.trigger_kind,
        status: run.status.as_str().to_string(),
        plan_digest: run.plan_digest.clone(),
        target_release: plan.target_release,
        artifact_references: plan
            .artifacts
            .into_iter()
            .map(|artifact| artifact.artifact_reference)
            .collect(),
        expires_at: plan.expires_at,
        expired: current_timestamp_ms() > plan.expires_at,
        plan_drifted,
        created_at: run.created_at,
        updated_at: run.updated_at,
        started_at: run.started_at,
        finished_at: run.finished_at,
    })
}

pub(crate) fn start_deployment_workflow_recovery(app: &AppHandle) -> Result<(), String> {
    let database = app.state::<Database>().inner().clone();
    let runtime = app.state::<DeploymentWorkflowRuntime>().inner().clone();
    let credentials = app
        .state::<crate::keychain::CredentialManager>()
        .inner()
        .clone();
    let cancellations = app.state::<ExecutionCancellationRegistry>().inner().clone();
    let candidates = database.list_unfinished_deployment_runs()?;
    if candidates.is_empty() {
        return Ok(());
    }
    let executors = native_executors(app, database.clone(), credentials, cancellations, &runtime)?;
    tauri::async_runtime::spawn(async move {
        for candidate in candidates {
            if !matches!(
                candidate.status,
                DeploymentRunStatus::InProgress
                    | DeploymentRunStatus::Verifying
                    | DeploymentRunStatus::CancelRequested
                    | DeploymentRunStatus::Reconciling
                    | DeploymentRunStatus::StateUnknown
            ) {
                continue;
            }
            if let Err(error) = reconcile_run(&database, &runtime, &executors, &candidate.id).await
            {
                log::error!(
                    "deployment startup reconciliation failed for {}: {}",
                    candidate.id,
                    error
                );
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn preview_deployment_files(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    entry: super::applications::ApplicationEntry,
) -> Result<super::deployment_files::DeploymentFilePreview, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    tauri::async_runtime::spawn_blocking(move || super::deployment_files::preview(&entry))
        .await
        .map_err(|_| "DEPLOYMENT_APPLICATION_WORKER_STOPPED".to_string())?
}

#[tauri::command]
pub(crate) async fn apply_deployment_files(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    entry: super::applications::ApplicationEntry,
    expected_digest: String,
) -> Result<Vec<String>, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    tauri::async_runtime::spawn_blocking(move || {
        super::deployment_files::apply(&entry, &expected_digest)
    })
    .await
    .map_err(|_| "DEPLOYMENT_APPLICATION_WORKER_STOPPED".to_string())?
}

#[tauri::command]
pub(crate) fn list_deployment_applications(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
) -> Result<Vec<super::applications::ApplicationEntry>, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    database.list_deployment_applications()
}

#[tauri::command]
pub(crate) async fn save_deployment_application(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    input: super::applications::SaveApplicationInput,
) -> Result<super::applications::ApplicationEntry, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.save_deployment_application(&input))
        .await
        .map_err(|_| "DEPLOYMENT_APPLICATION_WORKER_STOPPED".to_string())?
}

#[tauri::command]
pub(crate) async fn inspect_deployment_project(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    local_path: String,
) -> Result<super::readiness::ProjectInspection, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    tauri::async_runtime::spawn_blocking(move || {
        super::readiness::inspect_project(std::path::Path::new(&local_path))
    })
    .await
    .map_err(|_| "DEPLOYMENT_APPLICATION_WORKER_STOPPED".to_string())?
}

#[tauri::command]
pub(crate) async fn check_deployment_readiness(
    app: AppHandle,
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    entry: super::applications::ApplicationEntry,
    check_remote: bool,
) -> Result<super::readiness::ReadinessReport, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let cancellations = cancellations.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        super::applications::validate(&entry)?;
        let mut report = super::readiness::check_local(&entry)?;
        if check_remote {
            super::readiness::check_remote(
                &entry,
                &mut report,
                &database,
                &credentials,
                &known_hosts,
                &cancellations,
            )?;
        }
        database.store_deployment_readiness(&entry, &report)?;
        Ok(report)
    })
    .await
    .map_err(|_| "DEPLOYMENT_APPLICATION_WORKER_STOPPED".to_string())?
}

#[tauri::command]
pub(crate) fn get_deployment_readiness(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    environment_id: String,
) -> Result<Option<super::readiness::ReadinessReport>, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    database.get_deployment_readiness(&environment_id)
}

#[tauri::command]
pub(crate) async fn inspect_deployment_source_binding(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    local_path: String,
) -> Result<super::source_binding::SourceBindingInspection, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    tauri::async_runtime::spawn_blocking(move || {
        super::source_binding::inspect(std::path::Path::new(&local_path))
    })
    .await
    .map_err(|_| "DEPLOYMENT_SOURCE_INSPECTION_STOPPED".to_string())?
}

#[tauri::command]
pub(crate) fn deployment_workflow_capabilities(
    runtime: State<'_, DeploymentWorkflowRuntime>,
) -> DeploymentWorkflowCapabilities {
    runtime.capabilities()
}

#[tauri::command]
pub(crate) fn list_deployment_node_types(
    runtime: State<'_, DeploymentWorkflowRuntime>,
) -> Result<super::node_registry::DeploymentNodeTypeCatalog, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    Ok(DeploymentNodeRegistry::mvp().catalog())
}

#[tauri::command]
pub(crate) fn validate_deployment_workflow(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    input: ValidateDeploymentWorkflowInput,
) -> Result<WorkflowValidationResult, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    Ok(
        match compile_workflow_definition(&input.definition, &DeploymentNodeRegistry::mvp()) {
            Ok(compiled) => WorkflowValidationResult {
                valid: true,
                errors: Vec::new(),
                compiled: Some(compiled),
            },
            Err(errors) => WorkflowValidationResult {
                valid: false,
                errors: errors.errors,
                compiled: None,
            },
        },
    )
}

#[tauri::command]
pub(crate) fn list_deployment_workflows(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    cursor: Option<String>,
    limit: u32,
    include_archived: bool,
) -> Result<DeploymentWorkflowPage, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    database.list_deployment_workflows(cursor.as_deref(), limit, include_archived)
}

#[tauri::command]
pub(crate) fn get_deployment_workflow(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    id: String,
) -> Result<Option<DeploymentWorkflowRecord>, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    database.get_deployment_workflow(&id)
}

#[tauri::command]
pub(crate) fn create_deployment_workflow(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    input: CreateDeploymentWorkflowInput,
) -> Result<DeploymentWorkflowRecord, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    database.create_deployment_workflow(&input)
}

#[tauri::command]
pub(crate) fn create_static_site_deployment_workflow(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    input: CreateStaticSiteDeploymentWorkflowInput,
) -> Result<DeploymentWorkflowRecord, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    let (definition, layout) = super::static_site_template::static_site_template(
        &input.connection_profile_id,
        &input.remote_root,
    )?;
    database.create_deployment_workflow(&CreateDeploymentWorkflowInput {
        name: input.name,
        definition,
        layout: Some(layout),
        enabled: input.enabled,
    })
}

#[tauri::command]
pub(crate) fn update_deployment_workflow(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    id: String,
    expected_revision: u64,
    input: UpdateDeploymentWorkflowInput,
) -> Result<DeploymentWorkflowRecord, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    database.update_deployment_workflow(&id, expected_revision, &input)
}

#[tauri::command]
pub(crate) fn update_deployment_workflow_layout(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    id: String,
    expected_layout_revision: u64,
    input: UpdateDeploymentWorkflowLayoutInput,
) -> Result<DeploymentWorkflowLayoutRecord, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    database.update_deployment_workflow_layout(&id, expected_layout_revision, &input)
}

#[tauri::command]
pub(crate) fn archive_deployment_workflow(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    id: String,
    expected_revision: u64,
) -> Result<(), String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    database.archive_deployment_workflow(&id, expected_revision)
}

#[tauri::command]
pub(crate) async fn prepare_deployment_run(
    app: AppHandle,
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: PrepareDeploymentRunInput,
) -> Result<DeploymentPrepareResult, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    if input.operation_kind == WorkflowRunOperationKind::Deploy {
        database
            .ensure_deployment_application_ready(&input.workflow_id, input.workflow_revision)?;
    }
    let executors = native_executors(
        &app,
        database.inner().clone(),
        credentials.inner().clone(),
        cancellations.inner().clone(),
        &runtime,
    )?;
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    app.emit(
        "deployment-prepare-started",
        serde_json::json!({ "runId": run_id, "workflowId": input.workflow_id }),
    )
    .map_err(|error| format!("failed to emit deployment preparation identity: {error}"))?;
    let request = PrepareRunRequest {
        run_id,
        workflow_id: input.workflow_id,
        workflow_revision: input.workflow_revision,
        operation_kind: input.operation_kind,
        trigger_kind: input.trigger_kind,
        parameters: input.parameters,
    };
    let rollback_release_id = match (request.operation_kind, input.rollback_release_id) {
        (WorkflowRunOperationKind::Deploy, None) => None,
        (WorkflowRunOperationKind::Rollback, Some(release_id)) => Some(release_id),
        _ => return Err("DEPLOYMENT_WORKFLOW_INVALID_ROLLBACK_SELECTION".into()),
    };
    let progress_app = app.clone();
    let progress_workflow_id = request.workflow_id.clone();
    let progress_sequence = Arc::new(AtomicU32::new(0));
    let observer = {
        let progress_sequence = progress_sequence.clone();
        Arc::new(move |progress: PreparationProgress| {
            let sequence = progress_sequence.fetch_add(1, Ordering::SeqCst) + 1;
            let event = DeploymentNodeProgressEvent {
                workflow_id: progress_workflow_id.clone(),
                operation_id: progress.run_id.clone(),
                run_id: progress.run_id,
                node_id: progress.node_id,
                attempt: 1,
                sequence,
                phase: progress.status.clone(),
                completed: progress.completed,
                total: progress.total,
                unit: "steps".into(),
                summary_key: format!("deployment.prepare.{}", progress.status),
            };
            if let Err(error) = progress_app.emit("deployment-node-progress", event) {
                log::warn!("failed to emit deployment preparation progress: {error}");
            }
        })
    };
    let prepared = prepare_run_observed(
        &database,
        &runtime,
        &executors,
        request,
        rollback_release_id,
        observer,
    )
    .await?;
    Ok(DeploymentPrepareResult {
        run_id: prepared.run_id,
        plan_digest: prepared.plan_digest,
        expires_at: prepared.expires_at,
    })
}

#[tauri::command]
pub(crate) fn approve_deployment_run(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    input: DeploymentApprovalBindingInput,
) -> Result<DeploymentRunProjection, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    if input.approval_source != DeploymentApprovalSource::ManualUi {
        return Err("DEPLOYMENT_WORKFLOW_MANUAL_APPROVAL_REQUIRED".into());
    }
    let projection = approve_run(&database, &runtime, &input.run_id, &input.plan_digest)?;
    Ok(DeploymentRunProjection {
        run_id: projection.run_id,
        status: projection.status,
        plan_digest: projection.plan_digest,
    })
}

#[tauri::command]
pub(crate) async fn start_deployment_run(
    app: AppHandle,
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentRunPlanBindingInput,
) -> Result<DeploymentRunProjection, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Mutating)?;
    let database = database.inner().clone();
    let runtime = runtime.inner().clone();
    let executors = native_executors(
        &app,
        database.clone(),
        credentials.inner().clone(),
        cancellations.inner().clone(),
        &runtime,
    )?;
    verify_pre_start_frozen_inputs(
        &database,
        &runtime,
        &executors,
        &input.run_id,
        &input.plan_digest,
    )
    .await?;
    let (projection, cancellation) =
        begin_start_run(&database, &runtime, &input.run_id, &input.plan_digest)?;
    let run_id = input.run_id;
    let plan_digest = input.plan_digest;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = execute_approved_run(
            database.clone(),
            runtime.clone(),
            executors,
            run_id.clone(),
            plan_digest,
            cancellation,
        )
        .await
        {
            log::error!("deployment coordinator stopped for {run_id}: {error}");
            if let Ok(Some(run)) = database.get_deployment_run(&run_id) {
                if matches!(
                    run.status,
                    DeploymentRunStatus::InProgress
                        | DeploymentRunStatus::Verifying
                        | DeploymentRunStatus::CancelRequested
                        | DeploymentRunStatus::Reconciling
                ) {
                    let now = current_timestamp_ms();
                    let _ = database.transition_deployment_run(
                        &run_id,
                        run.status,
                        DeploymentRunStatus::StateUnknown,
                        None,
                        "deployment.run.coordinatorStopped",
                        Some(&serde_json::json!({ "requiresReadOnlyReconciliation": true })),
                        None,
                        None,
                        now,
                    );
                }
            }
            runtime.finish_run(&run_id);
        }
    });
    Ok(DeploymentRunProjection {
        run_id: projection.run_id,
        status: projection.status,
        plan_digest: projection.plan_digest,
    })
}

#[tauri::command]
pub(crate) fn cancel_deployment_run(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    input: DeploymentRunIdInput,
) -> Result<(), String> {
    runtime.ensure(DeploymentWorkflowAdmission::Continuity)?;
    if database.get_deployment_run(&input.run_id)?.is_none() {
        return if runtime.cancel_run(&input.run_id)? {
            Ok(())
        } else {
            Err("DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".into())
        };
    }
    cancel_run(&database, &runtime, &input.run_id)
}

#[tauri::command]
pub(crate) async fn reconcile_deployment_run(
    app: AppHandle,
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentRunIdInput,
) -> Result<DeploymentReconciliationResult, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Continuity)?;
    let executors = native_executors(
        &app,
        database.inner().clone(),
        credentials.inner().clone(),
        cancellations.inner().clone(),
        &runtime,
    )?;
    let projection = reconcile_run(&database, &runtime, &executors, &input.run_id).await?;
    Ok(DeploymentReconciliationResult {
        run_id: projection.run_id,
        status: projection.status,
        evidence_complete: projection.evidence_complete,
    })
}

#[tauri::command]
pub(crate) fn list_deployment_runs(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    workflow_id: String,
    cursor: Option<String>,
    limit: u32,
) -> Result<DeploymentRunPage, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    let page = database.list_deployment_runs(&workflow_id, cursor.as_deref(), limit)?;
    let items = page
        .items
        .iter()
        .map(|run| run_summary(&database, run))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DeploymentRunPage {
        items,
        next_cursor: page.next_cursor,
    })
}

#[tauri::command]
pub(crate) fn get_deployment_run_detail(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    run_id: String,
) -> Result<Option<DeploymentRunDetail>, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    run_detail(&database, &run_id)
}

pub(super) fn run_detail(
    database: &Database,
    run_id: &str,
) -> Result<Option<DeploymentRunDetail>, String> {
    let Some(run) = database.get_deployment_run(&run_id)? else {
        return Ok(None);
    };
    let summary = run_summary(&database, &run)?;
    let outputs = database
        .list_deployment_run_outputs(&run_id)?
        .into_iter()
        .map(|output| DeploymentRunOutputProjection {
            node_id: output.node_id,
            output_name: output.output_name,
            output_kind: match output.output_kind {
                DeploymentRunOutputKind::Scalar => "scalar",
                DeploymentRunOutputKind::Artifact => "artifact",
                DeploymentRunOutputKind::Receipt => "receipt",
                DeploymentRunOutputKind::Evidence => "evidence",
            }
            .into(),
            value: output.value,
            artifact_reference: output.artifact_reference,
            created_at: output.created_at,
        })
        .collect();
    Ok(Some(DeploymentRunDetail {
        summary,
        approval_summary: run.approval_summary,
        outputs,
        receipts: database.list_deployment_effect_receipts(&run_id)?,
        service_observation: database
            .list_deployment_run_events(&run_id, None, 100)?
            .items
            .into_iter()
            .find(|event| event.event_kind == "serviceObservation")
            .and_then(|event| event.payload),
    }))
}

#[tauri::command]
pub(crate) async fn observe_deployment_service(
    app: AppHandle,
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    run_id: String,
) -> Result<serde_json::Value, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    let executors = native_executors(
        &app,
        database.inner().clone(),
        credentials.inner().clone(),
        cancellations.inner().clone(),
        &runtime,
    )?;
    super::run_coordinator::observe_service(&database, &runtime, &executors, &run_id).await
}

#[tauri::command]
pub(crate) fn list_deployment_run_events(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    run_id: String,
    before_sequence: Option<u32>,
    limit: u32,
) -> Result<DeploymentRunEventPage, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    database.list_deployment_run_events(&run_id, before_sequence, limit)
}

#[tauri::command]
pub(crate) fn list_deployment_releases(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    workflow_id: String,
) -> Result<Vec<DeploymentReleaseRecord>, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    database.list_deployment_releases(&workflow_id)
}

#[tauri::command]
pub(crate) fn list_deployment_run_nodes(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    run_id: String,
) -> Result<Vec<DeploymentRunNodeRecord>, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    database.list_deployment_run_nodes(&run_id)
}

#[tauri::command]
pub(crate) fn list_deployment_node_attempts(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    run_id: String,
    node_id: String,
    before_attempt: Option<u32>,
    limit: u32,
) -> Result<DeploymentNodeAttemptPage, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    database.list_deployment_node_attempts(&run_id, &node_id, before_attempt, limit)
}

#[tauri::command]
pub(crate) fn inspect_deployment_artifact(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    artifact_reference: String,
) -> Result<DeploymentArtifactInspection, String> {
    runtime.ensure(DeploymentWorkflowAdmission::ReadOnly)?;
    let handle = database
        .get_deployment_artifact_handle(&artifact_reference)?
        .ok_or_else(|| "DEPLOYMENT_ARTIFACT_NOT_FOUND".to_string())?;
    let ArtifactBundleProjection {
        handle,
        manifest,
        component_count,
        total_size,
    } = runtime.artifacts().inspect(&handle)?;
    let retention =
        database.deployment_artifact_retention(&artifact_reference, current_timestamp_ms())?;
    let references = database.list_deployment_artifact_references(&artifact_reference)?;
    Ok(DeploymentArtifactInspection {
        handle,
        manifest,
        component_count,
        total_size,
        retention,
        references,
    })
}

#[tauri::command]
pub(crate) async fn export_deployment_run_audit(
    runtime: State<'_, DeploymentWorkflowRuntime>,
    database: State<'_, Database>,
    run_id: String,
) -> Result<DeploymentAuditExportResult, String> {
    runtime.ensure(DeploymentWorkflowAdmission::Continuity)?;
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let document = build_deployment_audit_document(&database, &run_id)?;
        let file_name = format!("shellspan-deployment-{}.audit.json", document.run_id);
        let destination = rfd::FileDialog::new()
            .set_title("Export deployment audit")
            .set_file_name(&file_name)
            .add_filter("JSON", &["json"])
            .save_file();
        let saved = if let Some(destination) = destination {
            save_deployment_audit_document(&document, &destination)?;
            true
        } else {
            false
        };
        Ok(DeploymentAuditExportResult {
            schema_version: 3,
            run_id: document.run_id,
            saved,
            bytes: document.bytes.len() as u64,
            document_sha256: document.document_sha256,
        })
    })
    .await
    .map_err(|_| "DEPLOYMENT_WORKFLOW_AUDIT_WORKER_STOPPED".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_surface_contains_no_effectful_single_node_bypass() {
        let source = include_str!("commands.rs");
        for forbidden in [
            "execute_deployment_node",
            "run_deployment_node",
            "transfer_deployment_node",
            "switch_deployment_node",
        ] {
            assert!(!source.contains(&format!("fn {forbidden}")));
        }
        assert!(source.contains("fn prepare_deployment_run"));
        assert!(source.contains("fn start_deployment_run"));
        let removed_stub = ["coordinator", "unavailable"].join("_");
        assert!(!source.contains(&removed_stub));
        assert!(source.contains("prepare_run("));
        assert!(source.contains("approve_run("));
        assert!(source.contains("begin_start_run("));
        assert!(source.contains("cancel_run("));
        assert!(source.contains("reconcile_run("));
        assert!(source.contains("deployment-node-progress"));
        let registration = include_str!("../lib.rs");
        for command in [
            "list_deployment_node_types",
            "validate_deployment_workflow",
            "create_deployment_workflow",
            "update_deployment_workflow",
            "update_deployment_workflow_layout",
            "prepare_deployment_run",
            "approve_deployment_run",
            "start_deployment_run",
            "cancel_deployment_run",
            "reconcile_deployment_run",
            "list_deployment_runs",
            "get_deployment_run_detail",
            "list_deployment_run_events",
            "list_deployment_releases",
            "list_deployment_run_nodes",
            "list_deployment_node_attempts",
            "inspect_deployment_artifact",
            "export_deployment_run_audit",
        ] {
            assert!(registration.contains(&format!("commands::{command}")));
        }
    }

    #[test]
    fn approval_authority_is_manual_ui_only_and_not_exposed_to_quick_actions() {
        let digest = format!("sha256:{}", "a".repeat(64));
        assert!(
            serde_json::from_value::<DeploymentApprovalBindingInput>(serde_json::json!({
                "runId": "run",
                "planDigest": digest,
                "approvalSource": "manualUi",
            }))
            .is_ok()
        );
        for forbidden in ["agent", "quickAction", "recovery"] {
            assert!(
                serde_json::from_value::<DeploymentApprovalBindingInput>(serde_json::json!({
                    "runId": "run",
                    "planDigest": format!("sha256:{}", "a".repeat(64)),
                    "approvalSource": forbidden,
                }))
                .is_err()
            );
        }
        let quick_actions = include_str!("../../../src/lib/host/host-quick-actions.ts");
        assert!(!quick_actions.contains("approve_deployment_run"));
        assert!(!quick_actions.contains("invokeApproveDeploymentRun"));
    }
}
