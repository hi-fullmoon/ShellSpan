use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::keychain::CredentialManager;

use super::{
    AgentArtifactRequest, AgentArtifactResponse, AgentChildInputRequest, AgentChildInspection,
    AgentChildRequest, AgentCommittedEventsRequest, AgentFleetControlRequest, AgentFleetInspection,
    AgentFleetPlanRequest, AgentFleetReconcileRequest, AgentInboxMutationInput,
    AgentRecoveryCheckpoint, AgentRecoveryReconcileInput, AgentRecoverySessionInput, AgentRuntime,
    AgentSessionEventPage, AgentSessionEventsRequest, AgentSessionListPage,
    AgentSessionListRequest, AgentSessionRenameInput, AgentSessionSnapshot,
    AgentSubagentSpawnRequest, AgentToolDecisionInput, CreateAgentSessionRequest,
};

pub(crate) const AGENT_RUNTIME_SESSION_EVENT: &str = "agent-runtime-session-event";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTerminalLeaseControlInput {
    session_id: String,
    agent_session_id: String,
    operation_id: String,
    #[serde(default)]
    terminal_connected: bool,
    #[serde(default)]
    output_listener_ready: bool,
    #[serde(default)]
    has_pending_user_input: bool,
    #[serde(default)]
    has_unverified_user_submission: bool,
    #[serde(default)]
    has_credential_prompt: bool,
    #[serde(default)]
    reduced_motion: Option<bool>,
}

#[tauri::command]
pub(crate) fn agent_runtime_terminal_owner(
    runtime: State<'_, AgentRuntime>,
    session_id: String,
) -> Result<Option<String>, String> {
    super::session::validate_identifier(&session_id, "terminal session id")?;
    runtime.terminal_turn_owner(&session_id)
}

#[tauri::command]
pub(crate) async fn agent_runtime_terminal_manual_handoffs(
    runtime: State<'_, AgentRuntime>,
    terminals: State<'_, crate::models::SessionManager>,
) -> Result<Vec<super::user_questions::LiveTerminalManualHandoff>, String> {
    runtime.terminal_manual_handoffs(&terminals)
}

#[tauri::command]
pub(crate) fn agent_runtime_terminal_lease_ready(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentTerminalLeaseControlInput,
) -> Result<bool, String> {
    configure_runtime(&app, &runtime)?;
    runtime.acknowledge_terminal_lease_ready(
        &input.session_id,
        &input.agent_session_id,
        &input.operation_id,
        input.terminal_connected,
        input.output_listener_ready,
        input.has_pending_user_input,
        input.has_unverified_user_submission,
        input.has_credential_prompt,
        input.reduced_motion.unwrap_or(true),
    )
}

#[tauri::command]
pub(crate) async fn agent_runtime_takeover_terminal(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    sessions: State<'_, crate::models::SessionManager>,
    input: AgentTerminalLeaseControlInput,
) -> Result<bool, String> {
    // Keep takeover off Tauri's synchronous IPC path: releasing the lease
    // publishes an event back to the same webview, which must remain free to
    // receive it and update the terminal UI.
    configure_runtime(&app, &runtime)?;
    runtime.takeover_terminal(
        &sessions,
        &input.session_id,
        &input.agent_session_id,
        &input.operation_id,
    )
}

#[tauri::command]
pub(crate) async fn agent_runtime_prepare_images(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    images: Vec<super::images::ImageUpload>,
) -> Result<Vec<super::images::ImageUpload>, String> {
    configure_runtime(&app, &runtime)?;
    runtime.prepare_images(images).await
}

#[tauri::command]
pub(crate) async fn agent_runtime_submit_images(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::images::ImageSubmission,
    paused: Option<bool>,
    target_turn_id: Option<String>,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    let session_id = input.session_id.clone();
    let submission_id = input.client_operation_id.clone();
    let snapshot = runtime
        .submit_images_with_admission(input, paused.unwrap_or(false), target_turn_id.as_deref())
        .await?;
    runtime.generate_session_title(&session_id, submission_id);
    Ok(snapshot)
}
#[tauri::command]
pub(crate) fn agent_runtime_cancel_image_submission(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::images::ImageOperation,
) -> Result<bool, String> {
    configure_runtime(&app, &runtime)?;
    runtime.cancel_image_submission(input)
}
#[tauri::command]
pub(crate) async fn agent_runtime_image_preview(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::images::ImagePreviewRequest,
) -> Result<String, String> {
    configure_runtime(&app, &runtime)?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.image_preview(input))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn configure_runtime(app: &AppHandle, runtime: &AgentRuntime) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve ShellSpan home directory: {error}"))?;
    runtime.configure(crate::shellspan_data_dir(&home))?;
    runtime.attach_petdex(app.state::<crate::petdex::PetdexAdapter>().inner().clone())?;
    runtime.configure_llm(
        app.state::<crate::llm::runtime::LlmRuntime>()
            .inner()
            .clone(),
    )?;
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
    #[serde(default)]
    client_submission_id: Option<String>,
    content: String,
    #[serde(default)]
    terminal_context: Option<super::AgentTerminalContextSnapshot>,
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    target_turn_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeStartInput {
    session_id: String,
    selection: crate::llm::routes::ModelSelection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentModelRetryInput {
    session_id: String,
    turn_id: String,
}

#[tauri::command]
pub(crate) async fn agent_runtime_retry_model(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    input: AgentModelRetryInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    let snapshot = runtime.session(&input.session_id)?;
    if snapshot.header.subagent.is_some() {
        return runtime
            .retry_child_failure(super::AgentChildRetryRequest {
                parent_session_id: snapshot
                    .header
                    .parent_session_id
                    .ok_or("CHILD_RETRY_UNAVAILABLE: child has no parent")?,
                child_session_id: input.session_id,
                turn_id: input.turn_id,
                content: None,
            })
            .await;
    }
    let selection = runtime
        .session(&input.session_id)?
        .header
        .model_selection
        .ok_or("MODEL_RETRY_UNAVAILABLE: select a model first")?;
    let (provider, api_key) = {
        let llm = app.state::<crate::llm::runtime::LlmRuntime>();
        let routes = llm.routes.snapshot()?;
        let route = routes.route(&selection.route_id)?;
        let selection = crate::llm::routes::ModelSelection {
            route_id: selection.route_id.clone(),
            model_id: selection.model_id,
            reasoning_effort: selection.reasoning_effort,
        };
        (route.provider(&selection)?, llm.routes.credential(route)?)
    };
    runtime
        .retry_model_failure(&input.session_id, &input.turn_id, provider, api_key)
        .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeModelSelectionInput {
    session_id: String,
    selection: crate::llm::routes::ModelSelection,
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
    mut request: CreateAgentSessionRequest,
) -> Result<AgentSessionSnapshot, String> {
    if request.parent_session_id.is_some() || request.subagent.is_some() {
        return Err("Create child Agent Sessions through the delegation command".into());
    }
    configure_runtime(&app, &runtime)?;
    apply_connection_sandbox(&app, &mut request)?;
    runtime.create_session(request)
}

#[tauri::command]
pub(crate) fn agent_runtime_continue_on_target(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    mut request: CreateAgentSessionRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    apply_connection_sandbox(&app, &mut request)?;
    runtime.continue_on_target(request)
}

fn apply_connection_sandbox(
    app: &AppHandle,
    request: &mut CreateAgentSessionRequest,
) -> Result<(), String> {
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    if super::native::mac_sandbox_trial_active() {
        if let Some(target) = request
            .target
            .as_mut()
            .filter(|target| target.kind == "local" && target.target_id != "workbench-ai")
        {
            require_mac_sandbox_direct(target, request.execution_surface)?;
            let workspace = crate::commands::terminal_acceptance_directory()?.join("home");
            let workspace = workspace
                .to_str()
                .ok_or("Expected a UTF-8 managed workspace")?;
            if target.cwd.as_deref().is_some_and(|cwd| cwd != workspace)
                || target
                    .local_root
                    .as_deref()
                    .is_some_and(|root| root != workspace)
            {
                return Err("MAC_SANDBOX_PREVIEW_MANAGED_ROOT_REQUIRED: select the managed preview workspace".into());
            }
            target.cwd = Some(workspace.into());
        }
    }
    let Some(target) = request.target.as_mut() else {
        return Ok(());
    };
    target.remote_sandbox_required = None;
    #[cfg(windows)]
    if target.kind == "local" && target.target_id != "workbench-ai" {
        let db = app.state::<crate::db::Database>();
        if db.agent_sandbox_enabled()? {
            target.local_sandbox_required = Some(super::LocalSandboxKind::WindowsAppContainer);
        }
    }
    match target.local_sandbox_required {
        Some(super::LocalSandboxKind::WindowsAppContainer) => {
            if target.kind != "local"
                || target.target_id == "workbench-ai"
                || request.execution_surface != super::AgentExecutionSurface::Direct
            {
                return Err(
                    "WINDOWS_SANDBOX_DIRECT_REQUIRED: select a local Direct Agent session".into(),
                );
            }
            #[cfg(windows)]
            {
                let database = app.state::<crate::db::Database>();
                database.require_agent_sandbox_enabled()?;
                let home = app.path().home_dir().map_err(|error| error.to_string())?;
                let workspace = super::native::windows_sandbox::create_workspace(
                    &crate::shellspan_data_dir(&home),
                    &request.session_id,
                )?;
                target.cwd = Some(workspace.clone());
                target.local_root = Some(workspace);
                use super::AgentSessionEffect::*;
                let allowed = |name: &str| {
                    matches!(
                        name,
                        "run_terminal_command" | "ask_user_question" | "read_tool_result"
                    )
                };
                if let Some(scope) = request.capability_scope.as_mut() {
                    if scope.tool_names.iter().any(|name| !allowed(name)) {
                        return Err("WINDOWS_SANDBOX_DIRECT_REQUIRED".into());
                    }
                } else {
                    request.capability_scope = Some(super::AgentCapabilityScope {
                        tool_names: [
                            "run_terminal_command",
                            "ask_user_question",
                            "read_tool_result",
                        ]
                        .map(str::to_owned)
                        .to_vec(),
                        effects: vec![
                            None,
                            ReadOnly,
                            SensitiveRead,
                            StateChange,
                            Destructive,
                            ExternalSideEffect,
                            Unknown,
                        ],
                        target_ids: vec![target.target_id.clone()],
                    });
                }
            }
            #[cfg(not(windows))]
            return Err(
                "WINDOWS_SANDBOX_UNAVAILABLE: the session requires Windows AppContainer".into(),
            );
        }
        Some(super::LocalSandboxKind::MacNono) => {
            return Err(
                "LOCAL_SANDBOX_UNAVAILABLE: macOS managed local sandbox is not enabled in this build"
                    .into(),
            );
        }
        None => {}
    }
    if target.kind != "remote" {
        return Ok(());
    }
    let native = super::native_adapter::target_native(target)?;
    let db = app.state::<crate::db::Database>();
    let known_hosts = crate::known_hosts::known_hosts_path(app)?;
    let binding = crate::remote_sandbox::binding_for_target(&native, &db, &known_hosts)?;
    let policy = binding.and_then(|binding| binding.state.policy);
    target.remote_sandbox_required = Some(policy.is_some());
    if let Some(policy) = policy {
        if request.execution_surface != super::AgentExecutionSurface::Direct {
            return Err(crate::remote_sandbox::DIRECT_REQUIRED.into());
        }
        if target
            .root_path
            .as_deref()
            .is_none_or(|root| !policy.contains(root))
        {
            target.root_path = Some(policy.workspace);
        }
    }
    Ok(())
}

#[cfg(all(
    feature = "native-input-acceptance",
    debug_assertions,
    target_os = "macos",
    target_arch = "aarch64"
))]
fn require_mac_sandbox_direct(
    target: &super::AgentSessionTarget,
    surface: super::AgentExecutionSurface,
) -> Result<(), String> {
    if target.kind == "local"
        && target.target_id != "workbench-ai"
        && surface != super::AgentExecutionSurface::Direct
    {
        return Err(
            "MAC_SANDBOX_PREVIEW_DIRECT_ONLY: use Direct execution in the managed workspace".into(),
        );
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTerminalReconnectInput {
    session_id: String,
    previous_session_id: String,
    terminal_session_id: String,
}

#[tauri::command]
pub(crate) async fn agent_runtime_reconnect_terminal(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    sessions: State<'_, crate::models::SessionManager>,
    input: AgentTerminalReconnectInput,
) -> Result<AgentSessionSnapshot, String> {
    for value in [
        &input.session_id,
        &input.previous_session_id,
        &input.terminal_session_id,
    ] {
        super::session::validate_identifier(value, "sessionId")?;
    }
    let runtime = runtime.inner().clone();
    let sessions = sessions.inner().clone();
    tokio::task::spawn_blocking(move || {
        configure_runtime(&app, &runtime)?;
        runtime.reconnect_terminal(
            &sessions,
            &input.session_id,
            &input.previous_session_id,
            &input.terminal_session_id,
        )
    })
    .await
    .map_err(|error| format!("terminal reconnect worker failed: {error}"))?
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
    let selected = runtime.session(&input.session_id)?.header.model_selection;
    let selection = selected
        .map(|s| crate::llm::routes::ModelSelection {
            route_id: s.route_id,
            model_id: s.model_id,
            reasoning_effort: s.reasoning_effort,
        })
        .unwrap_or(input.selection);
    let llm = app.state::<crate::llm::runtime::LlmRuntime>();
    let routes = llm.routes.snapshot()?;
    let route = routes.route(&selection.route_id)?;
    let provider = route.provider(&selection)?;
    let api_key = llm.routes.credential(route)?;
    runtime.start(&input.session_id, provider, api_key)
}

#[tauri::command]
pub(crate) fn agent_runtime_select_model(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    _credentials: State<'_, CredentialManager>,
    input: AgentRuntimeModelSelectionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    let llm = app.state::<crate::llm::runtime::LlmRuntime>();
    let snapshot = llm.routes.snapshot()?;
    let route = snapshot.route(&input.selection.route_id)?;
    let provider = route.provider(&input.selection)?;
    let api_key = llm.routes.credential(route)?;
    runtime.select_model(&input.session_id, provider, api_key)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPermissionInput {
    session_id: String,
    mode: super::AgentSessionPermissionMode,
}

#[tauri::command]
pub(crate) fn agent_runtime_set_permission(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentPermissionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.set_permission_mode(&input.session_id, input.mode)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentProjectRootInput {
    session_id: String,
    root: String,
}

#[tauri::command]
pub(crate) fn agent_runtime_bind_project_root(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentProjectRootInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.bind_project_root(&input.session_id, input.root)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentExecutionSurfaceInput {
    session_id: String,
    surface: super::AgentExecutionSurface,
}

#[tauri::command]
pub(crate) fn agent_runtime_set_execution_surface(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentExecutionSurfaceInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    if input.surface == super::AgentExecutionSurface::BoundTerminal {
        let snapshot = runtime.session(&input.session_id)?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if super::native::mac_sandbox_trial_active() {
            if let Some(target) = &snapshot.header.target {
                require_mac_sandbox_direct(target, input.surface)?;
            }
        }
        if let Some(target) = snapshot
            .header
            .target
            .filter(|target| target.kind == "remote")
        {
            let database = app.state::<crate::db::Database>();
            let known_hosts = crate::known_hosts::known_hosts_path(&app)?;
            let native = super::native_adapter::target_native(&target)?;
            let binding =
                crate::remote_sandbox::binding_for_target(&native, &database, &known_hosts)?;
            if target.remote_sandbox_required == Some(true)
                || binding.is_some_and(|binding| binding.state.policy.is_some())
            {
                return Err(crate::remote_sandbox::DIRECT_REQUIRED.into());
            }
        }
    }
    runtime.set_execution_surface(&input.session_id, input.surface)
}

#[tauri::command]
pub(crate) fn agent_runtime_answer_question(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    input: super::user_questions::AnswerQuestionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    runtime.answer_question(input, Some(credentials.inner()))
}

#[tauri::command]
pub(crate) async fn agent_runtime_followup(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    let client_submission_id = input
        .client_submission_id
        .unwrap_or_else(|| input.message_id.clone());
    let snapshot = runtime.receive_submission(
        &input.session_id,
        input.message_id,
        client_submission_id.clone(),
        input.content,
        input.terminal_context,
        super::AgentInboxLane::NextTurn,
        input.paused,
        input.target_turn_id.as_deref(),
    )?;
    runtime.generate_session_title(&input.session_id, client_submission_id);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn agent_runtime_steer(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    let client_submission_id = input
        .client_submission_id
        .unwrap_or_else(|| input.message_id.clone());
    let snapshot = runtime.receive_submission(
        &input.session_id,
        input.message_id,
        client_submission_id.clone(),
        input.content,
        input.terminal_context,
        super::AgentInboxLane::NextStep,
        input.paused,
        input.target_turn_id.as_deref(),
    )?;
    runtime.generate_session_title(&input.session_id, client_submission_id);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn agent_runtime_mutate_inbox(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentInboxMutationInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.mutate_inbox(input))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn agent_runtime_rename_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionRenameInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.rename_session(input)
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
pub(crate) async fn agent_runtime_interrupt(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.interrupt(&input.session_id).await
}

#[tauri::command]
pub(crate) async fn agent_runtime_resume(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.resume(&input.session_id).await
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
pub(crate) fn agent_runtime_respond_sudo(
    runtime: State<'_, AgentRuntime>,
    prompt_id: uuid::Uuid,
    password: Option<String>,
) -> Result<(), String> {
    runtime.respond_to_sudo_prompt(prompt_id, password.map(zeroize::Zeroizing::new))
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
pub(crate) fn agent_runtime_get_pending_approval_arguments(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentToolDecisionInput,
) -> Result<Option<serde_json::Value>, String> {
    configure_runtime(&app, &runtime)?;
    runtime.pending_approval_arguments(&input)
}

#[tauri::command]
pub(crate) fn agent_runtime_get_session(
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    runtime.session(&input.session_id)
}

#[tauri::command]
pub(crate) fn agent_runtime_list_sessions(
    runtime: State<'_, AgentRuntime>,
    request: AgentSessionListRequest,
) -> Result<AgentSessionListPage, String> {
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
pub(crate) async fn agent_runtime_delete_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<(), String> {
    configure_runtime(&app, &runtime)?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.delete_session(&input.session_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn agent_runtime_get_events(
    runtime: State<'_, AgentRuntime>,
    request: AgentSessionEventsRequest,
) -> Result<AgentSessionEventPage, String> {
    runtime.events(request)
}

#[tauri::command]
pub(crate) fn agent_runtime_get_committed_events(
    runtime: State<'_, AgentRuntime>,
    request: AgentCommittedEventsRequest,
) -> Result<AgentSessionEventPage, String> {
    runtime.committed_events(request)
}

#[tauri::command]
pub(crate) async fn agent_runtime_get_artifact(
    runtime: State<'_, AgentRuntime>,
    request: AgentArtifactRequest,
) -> Result<AgentArtifactResponse, String> {
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.artifact(request))
        .await
        .map_err(|error| error.to_string())?
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
pub(crate) async fn agent_runtime_reconcile_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoveryReconcileInput,
) -> Result<AgentSessionSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        configure_runtime(&app, &runtime)?;
        runtime.reconcile_recovery(input)
    })
    .await
    .map_err(|error| format!("reconciliation task failed: {error}"))?
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

#[tauri::command]
pub(crate) async fn agent_runtime_list_skills(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<super::skill_runtime::SkillUserList, String> {
    configure_runtime(&app, &runtime)?;
    runtime.list_skills(&input.session_id).await
}

#[tauri::command]
pub(crate) async fn agent_runtime_resolve_skill_proposal(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    input: super::skill_proposals::ResolveSkillProposalInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime
        .resolve_skill_proposal(input, Some(credentials.inner()))
        .await
}

#[tauri::command]
pub(crate) fn agent_runtime_inspect_skill_target(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::skill_proposals::InspectSkillTargetInput,
) -> Result<super::skill_proposals::SkillTargetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.inspect_skill_target(input)
}

#[tauri::command]
pub(crate) async fn agent_runtime_list_managed_skills(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
) -> Result<super::skill_proposals::ManagedSkillCatalog, String> {
    configure_runtime(&app, &runtime)?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.list_managed_skills())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn agent_runtime_save_user_skill(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::skill_proposals::SaveUserSkillInput,
) -> Result<super::skill_proposals::ManagedSkillItem, String> {
    configure_runtime(&app, &runtime)?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.save_user_skill(input))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn agent_runtime_delete_user_skill(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::skill_proposals::DeleteUserSkillInput,
) -> Result<(), String> {
    configure_runtime(&app, &runtime)?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.delete_user_skill(input))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn agent_runtime_open_user_skills_dir(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
) -> Result<(), String> {
    configure_runtime(&app, &runtime)?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.open_user_skills_dir())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn agent_runtime_list_file_references(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::file_references::FileReferenceInput,
) -> Result<super::file_references::FileReferenceList, String> {
    configure_runtime(&app, &runtime)?;
    runtime.file_references.list(input).await
}
#[tauri::command]
pub(crate) fn agent_runtime_cancel_file_references(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::file_references::FileReferenceCancel,
) -> Result<(), String> {
    configure_runtime(&app, &runtime)?;
    runtime.file_references.cancel(input)
}
