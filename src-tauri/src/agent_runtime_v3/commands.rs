use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::agent_contract_v3::{
    agent_v3_rollout_policy, AgentRequestV3, AgentToolCallV3, AgentToolResultV3,
    AgentV3RolloutStage,
};
use crate::db::Database;
use crate::keychain::CredentialManager;
use crate::models::SessionManager;

use super::{
    fleet_feature_policy_v3, fleet_rollout_v3, operator_policy_v3, AgentAuditEventV3,
    AgentAuthorizeCallRequestV3, AgentCallPreviewV3, AgentCapabilityGrantV3,
    AgentContextSnapshotV3, AgentFileCheckpointV3, AgentFleetSnapshotV3,
    AgentMcpAuthorizeRequestV3, AgentMcpCallV3, AgentMcpCapabilityGrantV3, AgentMcpResultV3,
    AgentNotificationV3, AgentPlanV3, AgentRuntimeV3, AgentTaskSnapshotV3,
    BrokerAuthorizeRequestV3, BrokerGrantV3, ContextRetrievalRequestV3, ContextRetrievalV3,
    ExtensionSnapshotV3, FleetFeaturePolicyV3, FleetRolloutV3, InstantiateRunbookRequestV3,
    LoadSkillRequestV3, LoadedSkillV3, McpServerSnapshotV3, McpSetEnabledRequestV3,
    McpToolSchemaRequestV3, McpToolSchemaV3, OperatorConfigureRequestV3, OperatorGrantV3,
    OperatorPolicyV3, RecoveryStoreStatusV3, RegisterFleetRequestV3, RegisterSubAgentRequestV3,
    RegisteredToolV3, SubAgentSnapshotV3, SubmitFleetVerificationRequestV3,
};

fn require_runtime_rollout() -> Result<(), String> {
    let policy = agent_v3_rollout_policy();
    if policy.stage != AgentV3RolloutStage::Runtime || policy.execution_contract_version != 3 {
        return Err("Agent v3 runtime rollout is disabled; v2 remains authoritative".into());
    }
    Ok(())
}

fn require_fleet_rollout() -> Result<(), String> {
    require_runtime_rollout()?;
    match fleet_rollout_v3() {
        FleetRolloutV3::Enabled => Ok(()),
        FleetRolloutV3::Disabled => Err("Agent M5 Fleet rollout is disabled".into()),
        FleetRolloutV3::Invalid => Err("unknown Agent M5 Fleet rollout fails closed".into()),
    }
}

fn configure_checkpoint_root(app: &AppHandle, runtime: &AgentRuntimeV3) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve Agent checkpoint root: {error}"))?;
    runtime.configure_checkpoint_root(root)
}

fn deliver_pending_notifications(app: &AppHandle, runtime: &AgentRuntimeV3) {
    let Ok(notifications) = runtime.notifications() else {
        return;
    };
    for notification in notifications.into_iter().filter(|item| !item.delivered) {
        match app
            .notification()
            .builder()
            .title(&notification.title)
            .body(&notification.body)
            .show()
        {
            Ok(()) => {
                let _ = runtime.mark_notification_delivered(&notification.notification_id);
            }
            Err(error) => {
                log::warn!("Failed to deliver redacted Agent M4 notification: {error}");
            }
        }
    }
}

fn schedule_operator_expiry_notification(
    app: &AppHandle,
    runtime: &AgentRuntimeV3,
    grant: &OperatorGrantV3,
) {
    let delay_ms = grant
        .expires_at_unix_ms
        .saturating_sub(super::current_unix_ms())
        .saturating_sub(60_000);
    let app = app.clone();
    let runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        if runtime.operator_grants().is_ok() {
            deliver_pending_notifications(&app, &runtime);
        }
    });
}

#[tauri::command]
pub(crate) fn agent_v3_list_tools(
    runtime: State<'_, AgentRuntimeV3>,
) -> Result<Vec<RegisteredToolV3>, String> {
    require_runtime_rollout()?;
    Ok(runtime.tools())
}

#[tauri::command]
pub(crate) fn agent_v3_register_task(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    request: AgentRequestV3,
) -> Result<AgentTaskSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.register_task(request, &sessions, &database)
}

#[tauri::command]
pub(crate) fn agent_v3_register_fleet(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    request: RegisterFleetRequestV3,
) -> Result<AgentFleetSnapshotV3, String> {
    require_fleet_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.register_fleet(request, &sessions, &database)
}

#[tauri::command]
pub(crate) fn agent_v3_register_sub_agent(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    request: RegisterSubAgentRequestV3,
) -> Result<SubAgentSnapshotV3, String> {
    require_fleet_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.register_sub_agent(request)
}

#[tauri::command]
pub(crate) fn agent_v3_get_fleet(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    fleet_id: String,
) -> Result<AgentFleetSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.fleet_snapshot(&fleet_id)
}

#[tauri::command]
pub(crate) fn agent_v3_list_fleets(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
) -> Result<Vec<AgentFleetSnapshotV3>, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.list_fleets()
}

#[tauri::command]
pub(crate) fn agent_v3_fleet_policy() -> Result<FleetFeaturePolicyV3, String> {
    require_runtime_rollout()?;
    let policy = fleet_feature_policy_v3();
    if policy.stage == "invalid" {
        return Err("unknown Agent M5 Fleet rollout fails closed".into());
    }
    Ok(policy)
}

#[tauri::command]
pub(crate) fn agent_v3_preview_call(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    credentials: State<'_, CredentialManager>,
    request: AgentAuthorizeCallRequestV3,
) -> Result<AgentCallPreviewV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    Ok(runtime
        .prepare_authorization(
            request,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
        )?
        .preview)
}

#[tauri::command]
pub(crate) fn agent_v3_authorize_call(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    credentials: State<'_, CredentialManager>,
    request: AgentAuthorizeCallRequestV3,
) -> Result<AgentCapabilityGrantV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let prepared = runtime.prepare_authorization(
        request,
        &sessions,
        &database,
        &credentials,
        &known_hosts_path,
    )?;
    let native_approved = if prepared.requires_native_confirmation {
        let mut dialog = MessageDialog::new()
            .set_level(MessageLevel::Warning)
            .set_title("ShellSpan Agent capability")
            .set_description(&prepared.native_prompt)
            .set_buttons(MessageButtons::YesNo);
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        dialog.show() == MessageDialogResult::Yes
    } else {
        true
    };
    runtime.issue_prepared_authorization(prepared, native_approved)
}

#[tauri::command]
pub(crate) fn agent_v3_revoke_capability(
    runtime: State<'_, AgentRuntimeV3>,
    capability_id: String,
) -> Result<(), String> {
    require_runtime_rollout()?;
    runtime.revoke_capability(&capability_id)
}

#[tauri::command]
pub(crate) async fn agent_v3_execute_tool(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    credentials: State<'_, CredentialManager>,
    task_id: String,
    call: AgentToolCallV3,
) -> Result<AgentToolResultV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let runtime = runtime.inner().clone();
    let sessions = sessions.inner().clone();
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runtime.execute_tool(
            &task_id,
            call,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
        )
    })
    .await
    .map_err(|error| format!("Agent v3 execution worker stopped: {error}"))??;
    if let Some(runtime) = app.try_state::<AgentRuntimeV3>() {
        deliver_pending_notifications(&app, &runtime);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn agent_v3_execute_fleet_tool(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    credentials: State<'_, CredentialManager>,
    fleet_id: String,
    sub_agent_id: String,
    call: AgentToolCallV3,
) -> Result<AgentToolResultV3, String> {
    require_fleet_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let runtime = runtime.inner().clone();
    let sessions = sessions.inner().clone();
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runtime.execute_fleet_tool(
            &fleet_id,
            &sub_agent_id,
            call,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
        )
    })
    .await
    .map_err(|error| format!("Agent v3 Fleet execution worker stopped: {error}"))??;
    if let Some(runtime) = app.try_state::<AgentRuntimeV3>() {
        deliver_pending_notifications(&app, &runtime);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn agent_v3_submit_fleet_verification(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    request: SubmitFleetVerificationRequestV3,
) -> Result<AgentFleetSnapshotV3, String> {
    require_fleet_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.submit_fleet_verification(request)
}

#[tauri::command]
pub(crate) fn agent_v3_reconcile_fleet_target(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    fleet_id: String,
    target_id: String,
    continue_with_verification: bool,
) -> Result<AgentFleetSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.reconcile_fleet_target(&fleet_id, &target_id, continue_with_verification)
}

#[tauri::command]
pub(crate) fn agent_v3_record_fleet_rollback(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    fleet_id: String,
    target_id: String,
    checkpoint_id: String,
) -> Result<AgentFleetSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.record_fleet_rollback(&fleet_id, &target_id, &checkpoint_id)
}

#[tauri::command]
pub(crate) fn agent_v3_get_task(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    task_id: String,
) -> Result<AgentTaskSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.task_snapshot(&task_id)
}

#[tauri::command]
pub(crate) fn agent_v3_list_tasks(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
) -> Result<Vec<AgentTaskSnapshotV3>, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let _ = runtime.operator_grants();
    deliver_pending_notifications(&app, &runtime);
    runtime.list_tasks()
}

#[tauri::command]
pub(crate) fn agent_v3_recovery_status(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
) -> Result<RecoveryStoreStatusV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.recovery_status()
}

#[tauri::command]
pub(crate) fn agent_v3_list_notifications(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
) -> Result<Vec<AgentNotificationV3>, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    deliver_pending_notifications(&app, &runtime);
    runtime.notifications()
}

#[tauri::command]
pub(crate) fn agent_v3_list_audit_events(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
) -> Result<Vec<AgentAuditEventV3>, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.audit_entries()
}

#[tauri::command]
pub(crate) fn agent_v3_operator_policy() -> Result<OperatorPolicyV3, String> {
    require_runtime_rollout()?;
    let policy = operator_policy_v3();
    if policy.stage == "invalid" {
        return Err("unknown Operator rollout value fails closed".into());
    }
    Ok(policy)
}

#[tauri::command]
pub(crate) fn agent_v3_configure_operator(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    request: OperatorConfigureRequestV3,
) -> Result<OperatorGrantV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let effects = request
        .effects
        .iter()
        .map(|effect| format!("{effect:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    let paths = if request.path_prefixes.is_empty() {
        "none".into()
    } else {
        request.path_prefixes.join(", ")
    };
    let network = if request.network_destinations.is_empty() {
        "none".into()
    } else {
        request
            .network_destinations
            .iter()
            .map(|destination| {
                format!(
                    "{}://{}:{}",
                    destination.protocol, destination.host, destination.port
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut dialog = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Enable bounded ShellSpan Operator")
        .set_description(format!(
            "Enable Operator for one task?\n\nTargets: {}\nTools: {}\nEffects: {}\nPath prefixes: {}\nNetwork destinations: {}\nTTL: {} ms\nElevation: {}\n\nUnknown writes, external effects, sensitive paths, target validation, rollout, checkpoints, MCP, Hooks, and Runbook policy remain enforced.",
            request.target_ids.join(", "),
            request.tool_names.join(", "),
            effects,
            paths,
            network,
            request.ttl_ms,
            request.allow_elevation,
        ))
        .set_buttons(MessageButtons::YesNo);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if dialog.show() != MessageDialogResult::Yes {
        return Err("native Operator configuration was denied".into());
    }
    let grant = runtime.configure_operator(request)?;
    schedule_operator_expiry_notification(&app, &runtime, &grant);
    Ok(grant)
}

#[tauri::command]
pub(crate) fn agent_v3_list_operator_grants(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
) -> Result<Vec<OperatorGrantV3>, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let grants = runtime.operator_grants()?;
    deliver_pending_notifications(&app, &runtime);
    Ok(grants)
}

#[tauri::command]
pub(crate) fn agent_v3_revoke_operator(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    grant_id: String,
) -> Result<OperatorGrantV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.revoke_operator(&grant_id)
}

#[tauri::command]
pub(crate) fn agent_v3_authorize_broker(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    request: BrokerAuthorizeRequestV3,
) -> Result<BrokerGrantV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let mut dialog = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Authorize native credential broker")
        .set_description(format!(
            "Issue a single-use native broker grant?\n\nTask: {}\nRequest: {}\nCall: {}\nTarget: {}\nTool: {}\nPurpose: {:?}\nCredential reference: {}\nTTL: {} ms\n\nNo credential value or elevation token will enter the WebView, model, logs, results, snapshot, or notification.",
            request.task_id,
            request.request_id,
            request.call_id,
            request.target_id,
            request.tool_name,
            request.purpose,
            request.credential_id.as_deref().unwrap_or("none"),
            request.ttl_ms
        ))
        .set_buttons(MessageButtons::YesNo);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if dialog.show() != MessageDialogResult::Yes {
        return Err("native broker authorization was denied".into());
    }
    runtime.authorize_broker(request)
}

#[tauri::command]
pub(crate) fn agent_v3_list_broker_grants(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
) -> Result<Vec<BrokerGrantV3>, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.broker_grants()
}

#[tauri::command]
pub(crate) fn agent_v3_revoke_broker(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    grant_id: String,
) -> Result<BrokerGrantV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.revoke_broker(&grant_id)
}

#[tauri::command]
pub(crate) fn agent_v3_reconcile_task(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    credentials: State<'_, CredentialManager>,
    task_id: String,
    continue_task: bool,
) -> Result<AgentTaskSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let action = if continue_task {
        "continue without replay"
    } else {
        "cancel"
    };
    let mut dialog = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Reconcile restarted ShellSpan task")
        .set_description(format!(
            "Confirm {action}?\n\nNo uncertain call or consumed capability will be replayed. Continuing first revalidates the frozen target and all later calls must obtain fresh native authorization."
        ))
        .set_buttons(MessageButtons::YesNo);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if dialog.show() != MessageDialogResult::Yes {
        return Err("native task reconciliation was denied".into());
    }
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    runtime.reconcile_task(
        &task_id,
        continue_task,
        &sessions,
        &database,
        &credentials,
        &known_hosts_path,
    )
}

#[tauri::command]
pub(crate) fn agent_v3_rebind_recovery_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    credentials: State<'_, CredentialManager>,
    task_id: String,
    replacement_session_id: String,
) -> Result<AgentTaskSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let mut dialog = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Rebind restarted ShellSpan task")
        .set_description(
            "Bind this restarted task to the selected live terminal session?\n\nRust will require the same local/remote kind, host, port, username, saved profile, host key, and filesystem root. No process handle, capability, or call will be revived.",
        )
        .set_buttons(MessageButtons::YesNo);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if dialog.show() != MessageDialogResult::Yes {
        return Err("native recovery session rebind was denied".into());
    }
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    runtime.rebind_recovery_session(
        &task_id,
        &replacement_session_id,
        &sessions,
        &database,
        &credentials,
        &known_hosts_path,
    )
}

#[tauri::command]
pub(crate) async fn agent_v3_restore_checkpoint(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    credentials: State<'_, CredentialManager>,
    task_id: String,
    checkpoint_id: String,
) -> Result<AgentFileCheckpointV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let prepared = runtime.prepare_checkpoint_restore(
        &task_id,
        &checkpoint_id,
        &sessions,
        &database,
        &credentials,
        &known_hosts_path,
    )?;
    let mut dialog = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Restore ShellSpan Agent checkpoint")
        .set_description(&prepared.native_prompt)
        .set_buttons(MessageButtons::YesNo);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if dialog.show() != MessageDialogResult::Yes {
        return Err("native checkpoint restore approval was denied".into());
    }
    let runtime = runtime.inner().clone();
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.restore_prepared_checkpoint(prepared, &database, &credentials, &known_hosts_path)
    })
    .await
    .map_err(|error| format!("checkpoint restore worker stopped: {error}"))?
}

#[tauri::command]
pub(crate) fn agent_v3_cancel_task(
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    task_id: String,
) -> Result<(), String> {
    require_runtime_rollout()?;
    runtime.cancel_task(&task_id, &sessions)
}

#[tauri::command]
pub(crate) fn agent_v3_refresh_context(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    task_id: String,
) -> Result<AgentContextSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.refresh_context(&task_id)
}

#[tauri::command]
pub(crate) fn agent_v3_compact_context(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    task_id: String,
    reason: String,
) -> Result<AgentContextSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.compact_context(&task_id, &reason)
}

#[tauri::command]
pub(crate) fn agent_v3_retrieve_context(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    request: ContextRetrievalRequestV3,
) -> Result<ContextRetrievalV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.retrieve_context(request)
}

#[tauri::command]
pub(crate) fn agent_v3_refresh_extensions(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    task_id: String,
) -> Result<ExtensionSnapshotV3, String> {
    require_runtime_rollout()?;
    configure_checkpoint_root(&app, &runtime)?;
    runtime.refresh_extensions(&task_id)
}

#[tauri::command]
pub(crate) fn agent_v3_load_skill(
    runtime: State<'_, AgentRuntimeV3>,
    request: LoadSkillRequestV3,
) -> Result<LoadedSkillV3, String> {
    require_runtime_rollout()?;
    runtime.load_skill(request)
}

#[tauri::command]
pub(crate) fn agent_v3_instantiate_runbook(
    runtime: State<'_, AgentRuntimeV3>,
    request: InstantiateRunbookRequestV3,
) -> Result<AgentPlanV3, String> {
    require_runtime_rollout()?;
    runtime.instantiate_runbook(request)
}

#[tauri::command]
pub(crate) fn agent_v3_list_mcp_servers(
    runtime: State<'_, AgentRuntimeV3>,
    task_id: String,
) -> Result<Vec<McpServerSnapshotV3>, String> {
    require_runtime_rollout()?;
    runtime.mcp_servers(&task_id)
}

#[tauri::command]
pub(crate) fn agent_v3_set_mcp_enabled(
    runtime: State<'_, AgentRuntimeV3>,
    request: McpSetEnabledRequestV3,
) -> Result<Vec<McpServerSnapshotV3>, String> {
    require_runtime_rollout()?;
    runtime.set_mcp_enabled(request)
}

#[tauri::command]
pub(crate) fn agent_v3_get_mcp_tool_schema(
    runtime: State<'_, AgentRuntimeV3>,
    request: McpToolSchemaRequestV3,
) -> Result<McpToolSchemaV3, String> {
    require_runtime_rollout()?;
    runtime.mcp_tool_schema(request)
}

#[tauri::command]
pub(crate) async fn agent_v3_refresh_mcp_server(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    credentials: State<'_, CredentialManager>,
    task_id: String,
    server_id: String,
) -> Result<McpServerSnapshotV3, String> {
    require_runtime_rollout()?;
    let mut dialog = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Start experimental MCP server")
        .set_description(format!(
            "Allow ShellSpan to start configured MCP server {server_id} for bounded stdio discovery?\n\nThe server process is untrusted. Credentials, when configured, are resolved only inside Rust."
        ))
        .set_buttons(MessageButtons::YesNo);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if dialog.show() != MessageDialogResult::Yes {
        return Err("native MCP discovery approval was denied".into());
    }
    let runtime = runtime.inner().clone();
    let credentials = credentials.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.refresh_mcp_server(&task_id, &server_id, &credentials)
    })
    .await
    .map_err(|error| format!("MCP discovery worker stopped: {error}"))?
}

#[tauri::command]
pub(crate) fn agent_v3_authorize_mcp_call(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    request: AgentMcpAuthorizeRequestV3,
) -> Result<AgentMcpCapabilityGrantV3, String> {
    require_runtime_rollout()?;
    let prepared = runtime.prepare_mcp_authorization(request, &sessions, &database)?;
    let native_approved = if prepared.requires_native_confirmation {
        let mut dialog = MessageDialog::new()
            .set_level(MessageLevel::Warning)
            .set_title("ShellSpan experimental MCP capability")
            .set_description(&prepared.native_prompt)
            .set_buttons(MessageButtons::YesNo);
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        dialog.show() == MessageDialogResult::Yes
    } else {
        true
    };
    runtime.issue_prepared_mcp_authorization(prepared, native_approved)
}

#[tauri::command]
pub(crate) async fn agent_v3_execute_mcp_call(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeV3>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    credentials: State<'_, CredentialManager>,
    task_id: String,
    call: AgentMcpCallV3,
) -> Result<AgentMcpResultV3, String> {
    require_runtime_rollout()?;
    let runtime = runtime.inner().clone();
    let sessions = sessions.inner().clone();
    let database = database.inner().clone();
    let credentials = credentials.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runtime.execute_mcp_call(&task_id, call, &sessions, &database, &credentials)
    })
    .await
    .map_err(|error| format!("MCP execution worker stopped: {error}"))??;
    if let Some(runtime) = app.try_state::<AgentRuntimeV3>() {
        deliver_pending_notifications(&app, &runtime);
    }
    Ok(result)
}
