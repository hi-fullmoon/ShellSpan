use super::approval_service::{
    approve_deployment_plan as approve_plan, reject_deployment_plan as reject_plan,
    request_deployment_approval as request_approval,
};
use super::artifact::{
    build_deployment_artifact, snapshot_deployment_artifact_source, ARTIFACT_PROGRESS_EVENT,
};
use super::artifact_transfer::{
    transfer_deployment_artifact, valid_artifact_transfer_operation_id,
    ARTIFACT_TRANSFER_PROGRESS_EVENT,
};
use super::audit::{build_deployment_audit_document, save_deployment_audit_document};
use super::planner::{create_deployment_plan as create_plan, get_deployment_plan as get_plan};
use super::preflight::{run_deployment_preflight, valid_preflight_operation_id};
use super::remote_runner::{
    cancel_deployment_reconciliation_observation, get_deployment_reconciliation_binding,
    list_deployment_startup_recovery, reconcile_deployment_run, run_deployment_remote_runner,
    valid_remote_runner_operation_id, REMOTE_RUNNER_PROGRESS_EVENT,
};
use super::repository::DeploymentEventWrite;
use super::{
    DeploymentApprovalDecisionRequest, DeploymentApprovalRequest, DeploymentArtifactBuildRequest,
    DeploymentArtifactBuildResult, DeploymentArtifactSourceSnapshotRequest,
    DeploymentArtifactTransferRequest, DeploymentArtifactTransferResult,
    DeploymentAuditExportResult, DeploymentEventKind, DeploymentFrozenSourceRevision,
    DeploymentNotificationReceipt, DeploymentPlanCreateInput, DeploymentPreflightRequest,
    DeploymentPreflightResult, DeploymentReconciliationBinding, DeploymentReconciliationRequest,
    DeploymentReconciliationResult, DeploymentRemoteRunnerCancelRequest,
    DeploymentRemoteRunnerRequest, DeploymentRemoteRunnerResult, DeploymentRunDetail,
    DeploymentRunEventPage, DeploymentRunEventRecord, DeploymentRunPage, DeploymentRunRecord,
    DeploymentRunStatus, DeploymentStartupRecoveryResult, DeploymentStoredPlanRecord,
    DeploymentWorkflowCreate, DeploymentWorkflowRecord, DeploymentWorkflowUpdate,
};
use crate::db::Database;
use crate::execution::{ExecutionCancellationErrorKind, ExecutionCancellationRegistry};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const DEPLOYMENT_NOTIFICATION_OPEN_EVENT: &str = "deployment-notification-open";
const DEPLOYMENT_ROLLOUT_ENV: &str = "SHELLSPAN_DEPLOYMENT_CENTER_V1";
const DEPLOYMENT_DEFAULT_ENABLED: bool = true;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRuntimeCapabilities {
    schema_version: u32,
    admissions_enabled: bool,
    default_enabled: bool,
    flag_name: &'static str,
    source: &'static str,
    read_only_recovery_available: bool,
    automatic_release_cleanup: bool,
}

fn deployment_rollout(value: Option<&str>) -> (bool, &'static str) {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        None => (DEPLOYMENT_DEFAULT_ENABLED, "default"),
        Some("1" | "true" | "on" | "enabled") => (true, "environment"),
        Some("0" | "false" | "off" | "disabled") => (false, "environment"),
        Some(_) => (false, "invalidEnvironment"),
    }
}

fn deployment_capabilities() -> DeploymentRuntimeCapabilities {
    let configured = std::env::var(DEPLOYMENT_ROLLOUT_ENV).ok();
    let (admissions_enabled, source) = deployment_rollout(configured.as_deref());
    DeploymentRuntimeCapabilities {
        schema_version: 1,
        admissions_enabled,
        default_enabled: DEPLOYMENT_DEFAULT_ENABLED,
        flag_name: DEPLOYMENT_ROLLOUT_ENV,
        source,
        read_only_recovery_available: true,
        automatic_release_cleanup: false,
    }
}

fn ensure_deployment_admissions_enabled() -> Result<(), String> {
    if deployment_capabilities().admissions_enabled {
        Ok(())
    } else {
        Err("DEPLOYMENT_ADMISSIONS_DISABLED".into())
    }
}

#[tauri::command]
pub(crate) fn deployment_runtime_capabilities() -> DeploymentRuntimeCapabilities {
    deployment_capabilities()
}

#[tauri::command]
pub(crate) async fn export_deployment_run_audit(
    database: State<'_, Database>,
    run_id: String,
) -> Result<DeploymentAuditExportResult, String> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let document = build_deployment_audit_document(&database, &run_id)?;
        let safe_run_name = document
            .run_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let file_name = format!("shellspan-deployment-{safe_run_name}.audit.json");
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
            schema_version: 1,
            run_id: document.run_id,
            saved,
            bytes: document.bytes.len() as u64,
            document_sha256: document.document_sha256,
        })
    })
    .await
    .map_err(|_| "deployment audit export worker stopped unexpectedly".to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentNotificationDisplayRequest {
    run_id: String,
    title: String,
    body: String,
    open_label: String,
}

fn artifact_staging_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    Ok(crate::shellspan_data_dir(&home)
        .join("deployment-runtime")
        .join("artifacts-v1"))
}

#[tauri::command]
pub(crate) fn list_deployment_workflows(
    database: State<'_, Database>,
) -> Result<Vec<DeploymentWorkflowRecord>, String> {
    database.list_deployment_workflows()
}

#[tauri::command]
pub(crate) fn get_deployment_workflow(
    database: State<'_, Database>,
    id: String,
) -> Result<Option<DeploymentWorkflowRecord>, String> {
    database.get_deployment_workflow(&id)
}

#[tauri::command]
pub(crate) fn create_deployment_workflow(
    database: State<'_, Database>,
    input: DeploymentWorkflowCreate,
) -> Result<DeploymentWorkflowRecord, String> {
    ensure_deployment_admissions_enabled()?;
    let id = format!("workflow-{}", uuid::Uuid::new_v4());
    database.create_deployment_workflow(&id, &input)
}

#[tauri::command]
pub(crate) fn update_deployment_workflow(
    database: State<'_, Database>,
    id: String,
    input: DeploymentWorkflowUpdate,
) -> Result<DeploymentWorkflowRecord, String> {
    ensure_deployment_admissions_enabled()?;
    database.update_deployment_workflow(&id, &input)
}

#[tauri::command]
pub(crate) fn delete_deployment_workflow(
    database: State<'_, Database>,
    id: String,
    expected_revision: u32,
) -> Result<(), String> {
    ensure_deployment_admissions_enabled()?;
    database.delete_deployment_workflow(&id, expected_revision)
}

#[tauri::command]
pub(crate) fn create_deployment_plan(
    database: State<'_, Database>,
    input: DeploymentPlanCreateInput,
) -> Result<DeploymentStoredPlanRecord, String> {
    ensure_deployment_admissions_enabled()?;
    create_plan(&database, input)
}

#[tauri::command]
pub(crate) fn get_deployment_plan(
    database: State<'_, Database>,
    plan_id: String,
) -> Result<DeploymentStoredPlanRecord, String> {
    get_plan(&database, &plan_id)
}

#[tauri::command]
pub(crate) fn request_deployment_approval(
    database: State<'_, Database>,
    input: DeploymentApprovalRequest,
) -> Result<DeploymentStoredPlanRecord, String> {
    ensure_deployment_admissions_enabled()?;
    request_approval(&database, input)
}

#[tauri::command]
pub(crate) async fn approve_deployment_plan(
    app: AppHandle,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentApprovalDecisionRequest,
) -> Result<DeploymentStoredPlanRecord, String> {
    ensure_deployment_admissions_enabled()?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let staging_root = artifact_staging_root(&app)?;
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let cancellations = cancellations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        approve_plan(
            &database,
            &credentials,
            &cancellations,
            &known_hosts_path,
            &staging_root,
            input,
        )
    })
    .await
    .map_err(|_| "deployment approval worker stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) fn reject_deployment_plan(
    database: State<'_, Database>,
    input: DeploymentApprovalDecisionRequest,
) -> Result<DeploymentStoredPlanRecord, String> {
    reject_plan(&database, input)
}

#[tauri::command]
pub(crate) async fn deployment_artifact_source_snapshot(
    database: State<'_, Database>,
    input: DeploymentArtifactSourceSnapshotRequest,
) -> Result<DeploymentFrozenSourceRevision, String> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        snapshot_deployment_artifact_source(&database, input)
    })
    .await
    .map_err(|_| "deployment artifact source worker stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn deployment_build_artifact(
    app: AppHandle,
    database: State<'_, Database>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentArtifactBuildRequest,
) -> Result<DeploymentArtifactBuildResult, String> {
    ensure_deployment_admissions_enabled()?;
    let staging_root = artifact_staging_root(&app)?;
    let database = database.inner().clone();
    let cancellations = cancellations.inner().clone();
    let event_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        build_deployment_artifact(
            &database,
            &cancellations,
            &staging_root,
            input,
            &mut |progress| {
                let _ = event_app.emit(ARTIFACT_PROGRESS_EVENT, progress);
            },
        )
    })
    .await
    .map_err(|_| "deployment artifact build worker stopped unexpectedly".to_string())
}

#[tauri::command]
pub(crate) fn deployment_cancel_artifact_build(
    cancellations: State<'_, ExecutionCancellationRegistry>,
    operation_id: String,
) -> Result<bool, String> {
    if !operation_id.starts_with("deployment-artifact-build:")
        || !crate::execution::valid_operation_id(&operation_id)
    {
        return Err("deployment artifact build operation ID is invalid".to_string());
    }
    match cancellations.cancel(&operation_id) {
        Ok(()) => Ok(true),
        Err(error) if error.kind == ExecutionCancellationErrorKind::OperationNotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) async fn deployment_transfer_artifact(
    app: AppHandle,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentArtifactTransferRequest,
) -> Result<DeploymentArtifactTransferResult, String> {
    ensure_deployment_admissions_enabled()?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let staging_root = artifact_staging_root(&app)?;
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let cancellations = cancellations.inner().clone();
    let event_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        transfer_deployment_artifact(
            &database,
            &credentials,
            &cancellations,
            &known_hosts_path,
            &staging_root,
            input,
            &mut |progress| {
                let _ = event_app.emit(ARTIFACT_TRANSFER_PROGRESS_EVENT, progress);
            },
        )
    })
    .await
    .map_err(|_| "deployment artifact transfer worker stopped unexpectedly".to_string())
}

#[tauri::command]
pub(crate) fn deployment_cancel_artifact_transfer(
    cancellations: State<'_, ExecutionCancellationRegistry>,
    operation_id: String,
) -> Result<bool, String> {
    if !valid_artifact_transfer_operation_id(&operation_id) {
        return Err("deployment artifact transfer operation ID is invalid".to_string());
    }
    match cancellations.cancel(&operation_id) {
        Ok(()) => Ok(true),
        Err(error) if error.kind == ExecutionCancellationErrorKind::OperationNotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) async fn deployment_run_remote(
    app: AppHandle,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentRemoteRunnerRequest,
) -> Result<DeploymentRemoteRunnerResult, String> {
    ensure_deployment_admissions_enabled()?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let staging_root = artifact_staging_root(&app)?;
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let cancellations = cancellations.inner().clone();
    let event_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_deployment_remote_runner(
            &database,
            &credentials,
            &cancellations,
            &known_hosts_path,
            &staging_root,
            input,
            &mut |progress| {
                let _ = event_app.emit(REMOTE_RUNNER_PROGRESS_EVENT, progress);
            },
        )
    })
    .await
    .map_err(|_| "deployment remote runner worker stopped unexpectedly".to_string())
}

#[tauri::command]
pub(crate) fn deployment_cancel_remote_runner(
    database: State<'_, Database>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentRemoteRunnerCancelRequest,
) -> Result<bool, String> {
    if !valid_remote_runner_operation_id(&input.operation_id)
        || input.plan_id != format!("plan-{}", input.plan_digest)
    {
        return Err("deployment remote runner cancellation request is invalid".into());
    }
    let run = database
        .get_deployment_run(&input.run_id)?
        .ok_or_else(|| "DEPLOYMENT_RUN_NOT_FOUND".to_string())?;
    if run.approval_digest != input.plan_digest
        || !matches!(
            run.status,
            DeploymentRunStatus::InProgress | DeploymentRunStatus::Verifying
        )
    {
        return Err("deployment remote runner cancellation binding changed".into());
    }
    match cancellations.cancel(&input.operation_id) {
        Ok(()) => {}
        Err(error) if error.kind == ExecutionCancellationErrorKind::OperationNotFound => {
            return Ok(false)
        }
        Err(error) => return Err(error.to_string()),
    }
    database.transition_deployment_run_atomic(
        &run.id,
        run.last_event_sequence,
        run.status,
        DeploymentRunStatus::CancelRequested,
        &DeploymentEventWrite {
            event_kind: DeploymentEventKind::CancellationRequested,
            status: Some(DeploymentRunStatus::CancelRequested),
            summary: "User requested stop and automatic restore at the next safe boundary".into(),
            payload: Some(serde_json::json!({
                "operationId": input.operation_id,
                "planId": input.plan_id,
                "planDigest": input.plan_digest,
            })),
        },
    )?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn deployment_preflight(
    app: AppHandle,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentPreflightRequest,
) -> Result<DeploymentPreflightResult, String> {
    ensure_deployment_admissions_enabled()?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let staging_root = artifact_staging_root(&app)?;
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let cancellations = cancellations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_deployment_preflight(
            &database,
            &credentials,
            &cancellations,
            &known_hosts_path,
            &staging_root,
            input,
        )
    })
    .await
    .map_err(|_| "deployment preflight worker stopped unexpectedly".to_string())
}

#[tauri::command]
pub(crate) fn deployment_cancel_preflight(
    cancellations: State<'_, ExecutionCancellationRegistry>,
    operation_id: String,
) -> Result<bool, String> {
    if !valid_preflight_operation_id(&operation_id) {
        return Err("deployment preflight operation ID is invalid".to_string());
    }
    match cancellations.cancel(&operation_id) {
        Ok(()) => Ok(true),
        Err(error) if error.kind == ExecutionCancellationErrorKind::OperationNotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) fn list_deployment_runs(
    database: State<'_, Database>,
    workflow_id: Option<String>,
    limit: u32,
) -> Result<Vec<DeploymentRunRecord>, String> {
    database.list_deployment_runs(workflow_id.as_deref(), limit)
}

#[tauri::command]
pub(crate) fn list_deployment_run_page(
    database: State<'_, Database>,
    workflow_id: Option<String>,
    cursor: Option<String>,
    limit: u32,
) -> Result<DeploymentRunPage, String> {
    database.list_deployment_run_page(workflow_id.as_deref(), cursor.as_deref(), limit)
}

#[tauri::command]
pub(crate) fn get_deployment_run(
    database: State<'_, Database>,
    id: String,
) -> Result<Option<DeploymentRunRecord>, String> {
    database.get_deployment_run(&id)
}

#[tauri::command]
pub(crate) fn get_deployment_run_detail(
    database: State<'_, Database>,
    id: String,
    event_limit: u32,
) -> Result<Option<DeploymentRunDetail>, String> {
    database.get_deployment_run_detail(&id, event_limit)
}

#[tauri::command]
pub(crate) fn list_deployment_run_events(
    database: State<'_, Database>,
    run_id: String,
    after_sequence: u32,
    limit: u32,
) -> Result<Vec<DeploymentRunEventRecord>, String> {
    database.list_deployment_run_events(&run_id, after_sequence, limit)
}

#[tauri::command]
pub(crate) fn list_deployment_run_events_before(
    database: State<'_, Database>,
    run_id: String,
    before_sequence: u32,
    limit: u32,
) -> Result<DeploymentRunEventPage, String> {
    database.list_deployment_run_events_before(&run_id, before_sequence, limit)
}

#[tauri::command]
pub(crate) fn claim_deployment_notifications(
    database: State<'_, Database>,
    limit: u32,
) -> Result<Vec<DeploymentNotificationReceipt>, String> {
    database.claim_deployment_notifications(limit)
}

#[tauri::command]
pub(crate) fn show_deployment_notification(
    app: AppHandle,
    input: DeploymentNotificationDisplayRequest,
) -> Result<(), String> {
    super::validate_identifier("deployment notification run id", &input.run_id, 128)
        .map_err(|error| error.to_string())?;
    super::validate_text("deployment notification title", &input.title, 200)
        .map_err(|error| error.to_string())?;
    super::validate_text("deployment notification body", &input.body, 1024)
        .map_err(|error| error.to_string())?;
    super::validate_text("deployment notification action", &input.open_label, 80)
        .map_err(|error| error.to_string())?;
    if crate::runbook::contains_secret_literal(&input.title)
        || crate::runbook::contains_secret_literal(&input.body)
        || crate::runbook::contains_secret_literal(&input.open_label)
    {
        return Err("deployment notification content is unsafe".into());
    }

    #[cfg(target_os = "macos")]
    {
        let application = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            app.config().identifier.as_str()
        };
        let _ = notify_rust::set_application(application);
    }

    let mut notification = notify_rust::Notification::new();
    notification
        .appname(app.config().product_name.as_deref().unwrap_or("ShellSpan"))
        .summary(&input.title)
        .body(&input.body)
        .action("default", &input.open_label);
    let handle = notification
        .show()
        .map_err(|error| format!("failed to show deployment notification: {error}"))?;
    let run_id = input.run_id;
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            if action == "__closed" {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit(DEPLOYMENT_NOTIFICATION_OPEN_EVENT, &run_id);
        });
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn deployment_startup_recovery(
    database: State<'_, Database>,
) -> Result<DeploymentStartupRecoveryResult, String> {
    list_deployment_startup_recovery(&database)
}

#[tauri::command]
pub(crate) fn deployment_reconciliation_binding(
    database: State<'_, Database>,
    run_id: String,
) -> Result<DeploymentReconciliationBinding, String> {
    get_deployment_reconciliation_binding(&database, &run_id)
}

#[tauri::command]
pub(crate) async fn deployment_reconcile(
    app: AppHandle,
    database: State<'_, Database>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    input: DeploymentReconciliationRequest,
) -> Result<DeploymentReconciliationResult, String> {
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let staging_root = artifact_staging_root(&app)?;
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let cancellations = cancellations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        reconcile_deployment_run(
            &database,
            &credentials,
            &cancellations,
            &known_hosts_path,
            &staging_root,
            input,
        )
    })
    .await
    .map_err(|_| "deployment reconciliation worker stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) fn deployment_cancel_reconciliation_observation(
    cancellations: State<'_, ExecutionCancellationRegistry>,
    operation_id: String,
) -> Result<bool, String> {
    cancel_deployment_reconciliation_observation(&cancellations, &operation_id)
}

#[cfg(test)]
mod rollout_tests {
    use super::*;

    #[test]
    fn deployment_rollout_is_default_on_and_invalid_values_fail_closed() {
        assert_eq!(deployment_rollout(None), (true, "default"));
        assert_eq!(deployment_rollout(Some(" true ")), (true, "environment"));
        assert_eq!(deployment_rollout(Some("0")), (false, "environment"));
        assert_eq!(
            deployment_rollout(Some("surprise")),
            (false, "invalidEnvironment")
        );
    }
}
