use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::{api_key_for_provider, validate_provider_config, AiProviderConfig};
use crate::keychain::CredentialManager;

use super::{
    AgentArtifactRequest, AgentArtifactResponse, AgentChildInputRequest, AgentChildInspection,
    AgentChildRequest, AgentCommittedEventsRequest, AgentFleetControlRequest, AgentFleetInspection,
    AgentFleetPlanRequest, AgentFleetReconcileRequest, AgentRecoveryCheckpoint,
    AgentRecoveryReconcileInput, AgentRecoverySessionInput, AgentRuntime, AgentSessionEventPage,
    AgentSessionEventsRequest, AgentSessionListPage, AgentSessionListRequest, AgentSessionSnapshot,
    AgentSubagentSpawnRequest, AgentToolDecisionInput, CreateAgentSessionRequest,
};

pub(crate) const AGENT_RUNTIME_SESSION_EVENT: &str = "agent-runtime-session-event";

pub(crate) fn configure_runtime(app: &AppHandle, runtime: &AgentRuntime) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve Agent runtime root: {error}"))?;
    runtime.configure(root)?;
    runtime.configure_native(app.clone())?;
    let emitter = app.clone();
    runtime.set_event_publisher(Arc::new(move |event| {
        if let Err(error) = emitter.emit(AGENT_RUNTIME_SESSION_EVENT, event) {
            log::warn!("Failed to publish committed Agent Session event: {error}");
        }
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionInput {
    session_id: String,
    message_id: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeStartInput {
    session_id: String,
    provider: AiProviderConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeInjectionInput {
    session_id: String,
    message_id: String,
    label: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionIdInput {
    session_id: String,
}

#[tauri::command]
pub(crate) fn agent_runtime_create_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: CreateAgentSessionRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.create_session(request)
}

#[tauri::command]
pub(crate) async fn agent_runtime_spawn_subagent(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    request: AgentSubagentSpawnRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    runtime.spawn_subagent(request).await
}

#[tauri::command]
pub(crate) async fn agent_runtime_send_child_input(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    request: AgentChildInputRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    runtime.send_child_input(request).await
}

#[tauri::command]
pub(crate) fn agent_runtime_inspect_child_agent(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentChildRequest,
) -> Result<AgentChildInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.inspect_child_agent(request)
}

#[tauri::command]
pub(crate) async fn agent_runtime_cancel_child_agent(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentChildRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.cancel_child_agent(request).await
}

#[tauri::command]
pub(crate) fn agent_runtime_fleet_plan(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetPlanRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.plan_fleet(request)
}

#[tauri::command]
pub(crate) async fn agent_runtime_fleet_start(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetControlRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.start_fleet(request).await
}

#[tauri::command]
pub(crate) async fn agent_runtime_fleet_resume(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetControlRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.start_fleet(request).await
}

#[tauri::command]
pub(crate) fn agent_runtime_fleet_pause(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetControlRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.pause_fleet(request)
}

#[tauri::command]
pub(crate) async fn agent_runtime_fleet_abort(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetControlRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.abort_fleet(request).await
}

#[tauri::command]
pub(crate) fn agent_runtime_fleet_reconcile(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetReconcileRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.reconcile_fleet(request)
}

#[tauri::command]
pub(crate) fn agent_runtime_start(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    input: AgentRuntimeStartInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    validate_provider_config(&input.provider, true)?;
    let api_key = api_key_for_provider(credentials.inner(), &input.provider)?;
    runtime.start(&input.session_id, input.provider, api_key)
}

#[tauri::command]
pub(crate) fn agent_runtime_followup(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.followup(&input.session_id, input.message_id, input.content)
}

#[tauri::command]
pub(crate) fn agent_runtime_steer(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.steer(&input.session_id, input.message_id, input.content)
}

#[tauri::command]
pub(crate) fn agent_runtime_inject(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRuntimeInjectionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.inject(
        &input.session_id,
        input.message_id,
        input.label,
        input.content,
    )
}

#[tauri::command]
pub(crate) async fn agent_runtime_cancel(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.cancel(&input.session_id).await
}

#[tauri::command]
pub(crate) async fn agent_runtime_approve_tool(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentToolDecisionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.approve_tool(input).await
}

#[tauri::command]
pub(crate) async fn agent_runtime_reject_tool(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentToolDecisionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.reject_tool(input).await
}

#[tauri::command]
pub(crate) fn agent_runtime_get_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.session(&input.session_id)
}

#[tauri::command]
pub(crate) fn agent_runtime_list_sessions(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentSessionListRequest,
) -> Result<AgentSessionListPage, String> {
    configure_runtime(&app, &runtime)?;
    runtime.sessions(request)
}

#[tauri::command]
pub(crate) fn agent_runtime_archive_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.archive_session(&input.session_id)
}

#[tauri::command]
pub(crate) fn agent_runtime_get_events(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentSessionEventsRequest,
) -> Result<AgentSessionEventPage, String> {
    configure_runtime(&app, &runtime)?;
    runtime.events(request)
}

#[tauri::command]
pub(crate) fn agent_runtime_get_committed_events(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentCommittedEventsRequest,
) -> Result<AgentSessionEventPage, String> {
    configure_runtime(&app, &runtime)?;
    runtime.committed_events(request)
}

#[tauri::command]
pub(crate) fn agent_runtime_get_artifact(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentArtifactRequest,
) -> Result<AgentArtifactResponse, String> {
    configure_runtime(&app, &runtime)?;
    runtime.artifact(request)
}

#[tauri::command]
pub(crate) fn agent_runtime_inspect_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoverySessionInput,
) -> Result<AgentRecoveryCheckpoint, String> {
    configure_runtime(&app, &runtime)?;
    runtime.inspect_recovery(&input.session_id)
}

#[tauri::command]
pub(crate) async fn agent_runtime_resume_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoverySessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.resume_recovery(&input.session_id).await
}

#[tauri::command]
pub(crate) fn agent_runtime_reconcile_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoveryReconcileInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.reconcile_recovery(input)
}

#[tauri::command]
pub(crate) async fn agent_runtime_abort_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoverySessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.abort_recovery(&input.session_id).await
}
