use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent_runtime::{
    AgentAuthorizeCallRequestNative, AgentEffectKindNative, AgentPermissionModeNative,
    AgentRequestNative, AgentToolCallNative, AgentToolResultStatusNative, AgentToolTargetNative,
    NativeExecutionContext, NativeToolEngine, PreparedAuthorizationNative,
    PreparedMcpAuthorizationNative, ToolIdempotencyNative, NATIVE_TOOL_CONTRACT_VERSION,
};
use crate::db::Database;
use crate::keychain::CredentialManager;
use crate::models::{SessionManager, SessionStatus, SessionTerminalKind};
use crate::terminal_broker::TerminalVisibleCommandRoute;

use super::{
    normalize_terminal_target_lookup_error, terminal_target_unavailable, AgentSessionEffect,
    AgentSessionPermissionMode, AgentSessionTarget, AgentToolResultStatus, ModelToolCall,
    NativeToolArtifact, NativeToolIdempotency, NativeToolPreparation, NativeToolRequest,
    NativeToolResult, NativeToolRuntime, RecordedToolCall, DEFAULT_NATIVE_APPROVAL_TTL_MS,
};

enum PreparedAuthorization {
    Tool(Box<PreparedAuthorizationNative>),
    Mcp(Box<PreparedMcpAuthorizationNative>),
}

struct PreparedNativeCall {
    authorization: PreparedAuthorization,
    public_call_id: String,
    public_name: String,
    native_name: String,
    target_id: String,
    effect: AgentSessionEffect,
    started_at_unix_ms: u64,
    scratch: Option<super::scratch::ScratchLease>,
    model_arguments: Value,
}

pub(crate) struct NativeToolAdapter {
    services: NativeToolServices,
    engine: Arc<NativeToolEngine>,
    prepared: Mutex<HashMap<String, PreparedNativeCall>>,
    scratch: super::scratch::ScratchStore,
}

pub(crate) struct NativeToolServices {
    pub(crate) sessions: SessionManager,
    pub(crate) database: Database,
    pub(crate) credentials: CredentialManager,
    pub(crate) known_hosts_path: PathBuf,
    pub(crate) data_root: PathBuf,
}

impl NativeToolAdapter {
    pub(crate) fn new(app: AppHandle, engine: Arc<NativeToolEngine>) -> Result<Self, String> {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("failed to resolve ShellSpan home directory: {error}"))?;
        Self::from_services(
            NativeToolServices {
                sessions: app.state::<SessionManager>().inner().clone(),
                database: app.state::<Database>().inner().clone(),
                credentials: app.state::<CredentialManager>().inner().clone(),
                known_hosts_path: crate::known_hosts::known_hosts_path(&app)?,
                data_root: crate::shellspan_data_dir(&home),
            },
            engine,
        )
    }

    pub(crate) fn from_services(
        services: NativeToolServices,
        engine: Arc<NativeToolEngine>,
    ) -> Result<Self, String> {
        engine.configure_checkpoint_root(services.data_root.clone())?;
        let scratch = super::scratch::ScratchStore::open(&services.data_root)?;
        scratch.start_maintenance(
            services.database.clone(),
            services.credentials.clone(),
            services.known_hosts_path.clone(),
            &engine,
        )?;
        Ok(Self {
            services,
            engine,
            prepared: Mutex::new(HashMap::new()),
            scratch,
        })
    }

    fn configure(&self, runtime: &NativeToolEngine) -> Result<(), String> {
        runtime.reconcile_remote_visible_rollout()?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalCommandArguments {
    command: String,
    explanation: String,
    #[serde(default)]
    lifecycle_trust: TerminalLifecycleTrust,
    #[serde(default)]
    background: bool,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SudoOperationArguments {
    sudo_operation_id: String,
    explanation: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteProcessInputArguments {
    process_handle: String,
    input: String,
    #[serde(default)]
    close: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitProcessModelArguments {
    process_handle: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    max_output_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KillProcessModelArguments {
    process_handle: String,
    signal: super::ProcessSignalNative,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum TerminalLifecycleTrust {
    #[default]
    Cooperative,
    DirectRequired,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpCallArguments {
    server_id: String,
    tool_name: String,
    arguments: Value,
}

impl NativeToolRuntime for NativeToolAdapter {
    fn configured_sudo_operations(
        &self,
        target: &AgentSessionTarget,
    ) -> Vec<crate::sudo_policy::SudoOperation> {
        target_native(target)
            .and_then(|target| {
                crate::sudo_policy::policy_for_target(&self.services.database, &target)
            })
            .map(|policy| {
                if policy.runner.is_some() {
                    policy.operations
                } else {
                    Vec::new()
                }
            })
            .unwrap_or_default()
    }

    fn terminal_execution_capabilities(
        &self,
        transport_session_id: &str,
    ) -> Result<Option<crate::terminal_broker::TerminalExecutionCapabilities>, String> {
        self.engine
            .terminal_execution_capabilities(transport_session_id)
            .map(Some)
    }

    fn terminal_interactive_tools_enabled(&self, remote_target: bool) -> bool {
        self.engine
            .terminal_broker_snapshot(None)
            .is_ok_and(|snapshot| {
                snapshot.interactive_tools_rollout.enabled
                    && (!remote_target
                        || (snapshot.remote_bound_terminal_rollout.enabled
                            && snapshot.remote_interactive_tools_rollout.enabled))
            })
    }

    fn list_file_references(
        &self,
        request: super::file_references::FileReferenceRequest,
    ) -> super::file_references::FileReferenceList {
        if request.target.kind == "local" {
            return super::file_references::read_local(request);
        }
        list_remote_file_references(
            request,
            &self.services.database,
            &self.services.credentials,
            &self.services.known_hosts_path,
        )
    }

    fn read_skills(
        &self,
        request: super::skill_runtime::SkillReadRequest,
    ) -> super::skill_runtime::SkillReadResult {
        if request.target.kind == "local" {
            return super::skill_runtime::read_local(request);
        }
        read_remote_skills(
            request,
            &self.services.database,
            &self.services.credentials,
            &self.services.known_hosts_path,
        )
    }

    fn prepare(&self, mut request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
        let runtime = &self.engine;
        let sessions = &self.services.sessions;
        let database = &self.services.database;
        let credentials = &self.services.credentials;
        self.configure(runtime)?;
        let known_hosts_path = &self.services.known_hosts_path;
        let mut owner_target = target_native(&request.target)?;
        if request.model_call.name != "run_terminal_command"
            || request
                .model_call
                .arguments
                .get("sudoOperationId")
                .is_none()
        {
            crate::sudo_policy::require_ordinary_remote_account(database, &owner_target)?;
        }
        let original_arguments = request.model_call.arguments.clone();
        let scratch_scope = super::scratch::take_scope(
            &request.model_call.name,
            &mut request.model_call.arguments,
        )?;
        let tracks_execution = request.model_call.name == "run_terminal_command"
            || is_model_process_tool(&request.model_call.name);
        let mut scratch = if scratch_scope
            || (tracks_execution
                && (request.target.kind == "local" || request.target.profile_id.is_some()))
        {
            super::scratch::validate_transport_target(&request.scratch_target, &request.target)?;
            let services = super::scratch::ScratchServices {
                database,
                credentials,
                known_hosts: known_hosts_path,
                engine: Some(runtime),
            };
            let reservation = if scratch_scope
                && matches!(
                    request.model_call.name.as_str(),
                    "write_file" | "edit_file" | "apply_patch"
                ) {
                Some(
                    request
                        .model_call
                        .arguments
                        .get("content")
                        .or_else(|| request.model_call.arguments.get("newString"))
                        .or_else(|| request.model_call.arguments.get("patch"))
                        .and_then(Value::as_str)
                        .map_or(0, |s| s.len() as u64),
                )
            } else {
                None
            };
            Some(self.scratch.acquire(
                &request.session_id,
                &request.task_id,
                &request.scratch_target,
                current_unix_ms().saturating_add(DEFAULT_NATIVE_APPROVAL_TTL_MS),
                scratch_scope,
                reservation,
                &services,
            )?)
        } else {
            None
        };
        if let Some(lease) = &mut scratch {
            lease.bind_execution_target(&request.target)?;
        }
        if scratch_scope {
            let root = &scratch
                .as_ref()
                .ok_or("scratch workspace unavailable")?
                .root;
            let scratch_id = format!(
                "scratch-{}",
                super::scratch::key(&request.session_id, &request.scratch_target)?
            );
            match &mut owner_target {
                AgentToolTargetNative::Local { target_id, cwd, .. } => {
                    *target_id = scratch_id;
                    *cwd = Some(root.clone());
                }
                AgentToolTargetNative::Remote {
                    target_id,
                    root_path,
                    ..
                } => {
                    *target_id = scratch_id;
                    *root_path = Some(root.clone());
                }
                _ => return Err("scratch requires a host target".into()),
            }
        }
        let target = process_target_for_model_call(&request.model_call, &owner_target)?
            .unwrap_or_else(|| owner_target.clone());
        if matches!(
            request.model_call.name.as_str(),
            "read_terminal" | "write_terminal_input" | "wait_terminal"
        ) && matches!(&target, AgentToolTargetNative::Remote { .. })
            && !runtime
                .terminal_broker_snapshot(None)?
                .remote_interactive_tools_rollout
                .enabled
        {
            return Err("TERMINAL_REMOTE_INTERACTIVE_TOOLS_DISABLED".into());
        }
        let native_request_id = stable_native_id("request", &request.session_id);
        let frozen_targets = if matches!(target, AgentToolTargetNative::Process { .. }) {
            vec![owner_target, target.clone()]
        } else {
            vec![target.clone()]
        };
        let frozen_request = AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: native_request_id.clone(),
            user_session_id: request.session_id.clone(),
            task_id: request.task_id.clone(),
            goal: request.goal.clone(),
            success_criteria: native_success_criteria(&request.goal, &request.success_criteria),
            targets: frozen_targets,
            permission_mode: permission_mode_native(request.permission_mode),
        };

        if request.model_call.name == "call_mcp_tool" {
            let arguments: McpCallArguments =
                serde_json::from_value(request.model_call.arguments.clone())
                    .map_err(|error| format!("call_mcp_tool schema rejected arguments: {error}"))?;
            if arguments.server_id.trim().is_empty()
                || arguments.server_id.len() > 128
                || arguments.tool_name.trim().is_empty()
                || arguments.tool_name.len() > 128
                || !arguments.arguments.is_object()
            {
                return Err("call_mcp_tool schema rejected bounded fields".into());
            }
            let internal_call_id = stable_native_id(
                "call",
                &format!(
                    "{}\0{}\0{}",
                    request.session_id, request.step_id, request.model_call.call_id
                ),
            );
            let prepared = runtime.prepare_mcp_authorization(
                NativeExecutionContext {
                    request: frozen_request,
                    turn_id: request.turn_id.clone(),
                    step_id: request.step_id.clone(),
                },
                internal_call_id,
                &arguments.server_id,
                &arguments.tool_name,
                arguments.arguments,
                sessions,
                database,
            )?;
            let native_name = prepared.call.tool_name.clone();
            let effect = effect_from_native(prepared.effect.kind);
            let token = format!("prepared-{}", Uuid::new_v4().simple());
            let preparation = NativeToolPreparation {
                token: token.clone(),
                call: RecordedToolCall {
                    call_id: request.model_call.call_id.clone(),
                    provider_call_id: request.model_call.provider_call_id.clone(),
                    name: request.model_call.name.clone(),
                    native_name: Some(native_name.clone()),
                    arguments: request.model_call.arguments.clone(),
                    title: Some(native_name.clone()),
                    effect: Some(effect),
                    target: Some(request.target.clone()),
                },
                requires_approval: request.permission_mode != AgentSessionPermissionMode::Operator,
                prompt: prepared.native_prompt.clone(),
                expires_at_unix_ms: current_unix_ms()
                    .saturating_add(DEFAULT_NATIVE_APPROVAL_TTL_MS),
                idempotency: NativeToolIdempotency::No,
                parallel: false,
                exclusive: true,
            };
            self.prepared
                .lock()
                .map_err(|_| "native prepared-call registry is unavailable".to_string())?
                .insert(
                    token,
                    PreparedNativeCall {
                        authorization: PreparedAuthorization::Mcp(Box::new(prepared)),
                        public_call_id: request.model_call.call_id,
                        public_name: request.model_call.name,
                        native_name,
                        target_id: request.target.target_id,
                        effect,
                        started_at_unix_ms: current_unix_ms(),
                        scratch: None,
                        model_arguments: original_arguments,
                    },
                );
            return Ok(preparation);
        }

        let elevated_command = request.model_call.name == "run_terminal_command"
            && request
                .model_call
                .arguments
                .get("sudoOperationId")
                .is_some();
        let direct_lifecycle_required =
            !elevated_command && terminal_command_requires_direct_lifecycle(&request)?;
        let visible_route = if request.model_call.name == "run_terminal_command"
            && request.execution_surface == super::AgentExecutionSurface::BoundTerminal
            && !direct_lifecycle_required
            && !elevated_command
        {
            let route = match &target {
                AgentToolTargetNative::Local { session_id, .. } => {
                    let state = sessions.target_state(session_id).map_err(|error| {
                        normalize_terminal_target_lookup_error(session_id, error)
                    })?;
                    if state.terminal_kind != SessionTerminalKind::Local
                        || state.status != SessionStatus::Connected
                        || state.identity.host != "local"
                    {
                        return Err(terminal_target_unavailable(
                            "the frozen local terminal is disconnected or its identity changed",
                        ));
                    }
                    runtime.terminal_visible_command_route(session_id)?
                }
                AgentToolTargetNative::Remote {
                    session_id,
                    host,
                    port,
                    username,
                    ..
                } => {
                    let state = sessions.target_state(session_id).map_err(|error| {
                        normalize_terminal_target_lookup_error(session_id, error)
                    })?;
                    if state.terminal_kind != SessionTerminalKind::Remote
                        || state.status != SessionStatus::Connected
                        || state.identity.host != *host
                        || state.identity.port != *port
                        || state.identity.username != *username
                    {
                        return Err(terminal_target_unavailable(
                            "the frozen remote terminal is disconnected or its identity changed",
                        ));
                    }
                    runtime.terminal_remote_visible_command_route(session_id)?
                }
                _ => return Err("terminal command requires a frozen host target".into()),
            };
            Some(route)
        } else {
            None
        };
        let (native_name, arguments) = if elevated_command {
            (
                "exec_command".into(),
                normalize_sudo_operation(database, &request.model_call.arguments, &target)?,
            )
        } else {
            normalize_arguments(&request, &target, visible_route, direct_lifecycle_required)?
        };
        let elevated = native_name == "exec_command" && arguments["elevated"] == json!(true);
        let internal_call_id = stable_native_id(
            "call",
            &format!(
                "{}\0{}\0{}",
                request.session_id, request.step_id, request.model_call.call_id
            ),
        );
        let prepared = runtime.prepare_authorization(
            NativeExecutionContext {
                request: frozen_request,
                turn_id: request.turn_id.clone(),
                step_id: request.step_id.clone(),
            },
            AgentAuthorizeCallRequestNative {
                request_id: native_request_id,
                call_id: internal_call_id,
                tool_name: native_name.clone(),
                arguments,
                target,
                ttl_ms: Some(DEFAULT_NATIVE_APPROVAL_TTL_MS),
            },
            sessions,
            database,
            credentials,
            known_hosts_path,
        )?;
        let descriptor = runtime.tool(&native_name)?.descriptor.clone();
        let effect = effect_from_native(prepared.effect.kind);
        let token = format!("prepared-{}", Uuid::new_v4().simple());
        let mut call = RecordedToolCall {
            call_id: request.model_call.call_id.clone(),
            provider_call_id: request.model_call.provider_call_id.clone(),
            name: request.model_call.name.clone(),
            native_name: Some(native_name.clone()),
            arguments: if is_model_process_tool(&request.model_call.name) {
                super::model::recorded_tool_arguments(
                    &request.model_call.name,
                    &request.model_call.arguments,
                )
            } else {
                recorded_native_arguments(&native_name, &prepared.call.arguments)
            },
            title: Some(native_name.clone()),
            effect: Some(effect),
            target: Some(request.target.clone()),
        };
        if scratch_scope {
            call.arguments["fileScope"] = json!("scratch");
        }
        let expires_at_unix_ms = current_unix_ms().saturating_add(DEFAULT_NATIVE_APPROVAL_TTL_MS);
        let preparation = NativeToolPreparation {
            token: token.clone(),
            call,
            requires_approval: prepared.requires_native_confirmation,
            prompt: prepared.native_prompt.clone(),
            expires_at_unix_ms,
            idempotency: match descriptor.idempotency {
                _ if elevated => NativeToolIdempotency::No,
                ToolIdempotencyNative::Yes => NativeToolIdempotency::Yes,
                ToolIdempotencyNative::No => NativeToolIdempotency::No,
                ToolIdempotencyNative::Conditional => NativeToolIdempotency::Conditional,
            },
            parallel: descriptor.parallel,
            exclusive: elevated
                || descriptor.max_concurrency == 1
                || matches!(
                    effect,
                    AgentSessionEffect::StateChange
                        | AgentSessionEffect::Destructive
                        | AgentSessionEffect::ExternalSideEffect
                ),
        };
        let replaced = self
            .prepared
            .lock()
            .map_err(|_| "native prepared-call registry is unavailable".to_string())?
            .insert(
                token,
                PreparedNativeCall {
                    authorization: PreparedAuthorization::Tool(Box::new(prepared)),
                    public_call_id: request.model_call.call_id,
                    public_name: request.model_call.name,
                    native_name,
                    target_id: request.target.target_id,
                    effect,
                    started_at_unix_ms: current_unix_ms(),
                    scratch: scratch.take(),
                    model_arguments: original_arguments,
                },
            );
        if replaced.is_some() {
            return Err("native prepared-call token collision".into());
        }
        Ok(preparation)
    }

    fn execute(
        &self,
        token: &str,
        approved: bool,
        cancellation: CancellationToken,
    ) -> Result<NativeToolResult, String> {
        self.execute_with_runner_journal(token, approved, cancellation, None)
    }

    fn execute_with_runner_journal(
        &self,
        token: &str,
        approved: bool,
        cancellation: CancellationToken,
        journal: Option<super::RunnerDispatchJournal>,
    ) -> Result<NativeToolResult, String> {
        let mut stored = self
            .prepared
            .lock()
            .map_err(|_| "native prepared-call registry is unavailable".to_string())?
            .remove(token)
            .ok_or_else(|| "native prepared call is unknown or already consumed".to_string())?;
        if cancellation.is_cancelled() {
            return Ok(cancelled_result(&stored));
        }
        let runtime = &self.engine;
        let sessions = &self.services.sessions;
        let database = &self.services.database;
        let credentials = &self.services.credentials;
        self.configure(runtime)?;
        let known_hosts_path = &self.services.known_hosts_path;
        match stored.authorization {
            PreparedAuthorization::Tool(prepared) => {
                let native_request_id = prepared.call.request_id.clone();
                let native_call_id = prepared.call.call_id.clone();
                let native_tool_name = prepared.call.tool_name.clone();
                let native_target = prepared.call.target.clone();
                let grant = runtime.issue_prepared_authorization(&prepared, approved)?;
                #[cfg(all(
                    feature = "native-input-acceptance",
                    debug_assertions,
                    target_os = "macos",
                    target_arch = "aarch64"
                ))]
                if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
                    == Ok("permission-mismatch")
                {
                    crate::commands::terminal_acceptance_directory()?;
                    let owner = &prepared.context.request.user_session_id;
                    if !crate::terminal_command::acceptance_trace::enabled()
                        || stored.public_name != "run_terminal_command"
                        || !owner.starts_with("phase3-submission-")
                        || !matches!(prepared.call.target, AgentToolTargetNative::Local { .. })
                    {
                        return Err("TERMINAL_ACCEPTANCE_EXACT_PERMISSION_CASE_REQUIRED".into());
                    }
                    runtime.revoke_capability(&grant.capability_id)?;
                    crate::terminal_command::acceptance_trace::record(
                        "native-capability-revoked-for-case",
                        serde_json::json!({
                            "sessionId":owner,
                            "nativeRequestId":native_request_id,"nativeCallId":native_call_id,
                            "publicCallId":stored.public_call_id,
                            "capabilitySha256":crate::terminal_command::protocol::sha(&grant.capability_id)
                        }),
                    )?;
                }
                if cancellation.is_cancelled() {
                    let _ = runtime.revoke_capability(&grant.capability_id);
                    return Ok(NativeToolResult {
                        call_id: stored.public_call_id,
                        native_name: stored.native_name,
                        target_id: stored.target_id,
                        effect: stored.effect,
                        status: AgentToolResultStatus::Cancelled,
                        summary: "native tool execution was cancelled before dispatch".into(),
                        data: None,
                        duration_ms: Some(
                            current_unix_ms().saturating_sub(stored.started_at_unix_ms),
                        ),
                        evidence_refs: Vec::new(),
                        artifacts: Vec::new(),
                    });
                }
                if cancellation.is_cancelled() {
                    let _ = runtime.revoke_capability(&grant.capability_id);
                    return Ok(NativeToolResult {
                        call_id: stored.public_call_id,
                        native_name: stored.native_name,
                        target_id: stored.target_id,
                        effect: stored.effect,
                        status: AgentToolResultStatus::Cancelled,
                        summary: "native tool execution was cancelled before dispatch".into(),
                        data: None,
                        duration_ms: Some(
                            current_unix_ms().saturating_sub(stored.started_at_unix_ms),
                        ),
                        evidence_refs: Vec::new(),
                        artifacts: Vec::new(),
                    });
                }
                let call = AgentToolCallNative {
                    request_id: native_request_id,
                    call_id: native_call_id,
                    tool_name: native_tool_name,
                    arguments: grant.effective_arguments,
                    target: native_target,
                    capability_id: grant.capability_id,
                };
                if let Some(scratch) = stored.scratch.as_mut() {
                    scratch.dispatch()?;
                }
                let mut result = runtime.execute_tool(
                    &prepared.context,
                    call,
                    sessions,
                    database,
                    credentials,
                    known_hosts_path,
                    &cancellation,
                    journal,
                )?;
                let public_target_id = project_native_result_target(
                    &prepared.call.target,
                    &result.target_id,
                    if stored
                        .model_arguments
                        .get("fileScope")
                        .and_then(Value::as_str)
                        == Some("scratch")
                    {
                        prepared.call.target.target_id()
                    } else {
                        &stored.target_id
                    },
                )?;
                let public_target_id = if stored
                    .model_arguments
                    .get("fileScope")
                    .and_then(Value::as_str)
                    == Some("scratch")
                {
                    stored.target_id.clone()
                } else {
                    public_target_id
                };
                if matches!(
                    result.tool_name.as_str(),
                    "inspect_host" | "inspect_service" | "query_logs" | "diagnose_endpoint"
                ) {
                    if let Some(data) = result.data.as_mut() {
                        data["nativeCallId"] = json!(result.call_id);
                        data["evidenceRef"] = json!(stored.public_call_id);
                    }
                }
                let result_effect = result
                    .effects
                    .first()
                    .map(|effect| effect_from_native(effect.kind))
                    .unwrap_or(stored.effect);
                let mut public_result = NativeToolResult {
                    call_id: stored.public_call_id,
                    native_name: result.tool_name,
                    target_id: public_target_id,
                    effect: result_effect,
                    status: status_from_native(result.status),
                    summary: result.summary,
                    data: result.data,
                    duration_ms: Some(current_unix_ms().saturating_sub(stored.started_at_unix_ms)),
                    evidence_refs: result
                        .artifacts
                        .iter()
                        .map(|artifact| artifact.artifact_id.clone())
                        .collect(),
                    artifacts: result
                        .artifacts
                        .into_iter()
                        .map(|artifact| NativeToolArtifact {
                            media_type: Some(artifact.media_type.clone()),
                            sha256: Some(artifact.sha256.clone()),
                            artifact_id: artifact.artifact_id,
                            kind: format!("{:?}", artifact.kind).to_ascii_lowercase(),
                            title: stored.public_name.clone(),
                            size_bytes: Some(artifact.byte_length),
                        })
                        .collect(),
                };
                if let Some(scratch) = stored.scratch.as_mut() {
                    scratch.finish(&stored.public_name, &stored.model_arguments, &public_result)?;
                    if stored
                        .model_arguments
                        .get("fileScope")
                        .and_then(Value::as_str)
                        == Some("scratch")
                    {
                        if let Some(Value::Object(data)) = public_result.data.as_mut() {
                            data.insert("scratchRoot".into(), json!(scratch.root));
                            data.insert("fileScope".into(), json!("scratch"));
                            data.insert("temporary".into(), json!(true));
                        }
                    }
                }
                Ok(public_result)
            }
            PreparedAuthorization::Mcp(prepared) => {
                crate::sudo_policy::require_ordinary_remote_account(
                    database,
                    &prepared.call.target,
                )?;
                let grant = runtime.issue_prepared_mcp_authorization(&prepared, approved)?;
                if cancellation.is_cancelled() {
                    let _ = runtime.revoke_capability(&grant.capability_id);
                    return Ok(NativeToolResult {
                        call_id: stored.public_call_id,
                        native_name: stored.native_name,
                        target_id: stored.target_id,
                        effect: stored.effect,
                        status: AgentToolResultStatus::Cancelled,
                        summary: "native MCP execution was cancelled before dispatch".into(),
                        data: None,
                        duration_ms: Some(
                            current_unix_ms().saturating_sub(stored.started_at_unix_ms),
                        ),
                        evidence_refs: Vec::new(),
                        artifacts: Vec::new(),
                    });
                }
                let result = runtime.execute_mcp_call(
                    &prepared,
                    grant.capability_id,
                    credentials,
                    &cancellation,
                )?;
                Ok(NativeToolResult {
                    call_id: stored.public_call_id,
                    native_name: result.tool_name,
                    target_id: result.target_id,
                    effect: stored.effect,
                    status: status_from_native(result.status),
                    summary: result.summary,
                    data: result.data,
                    duration_ms: Some(current_unix_ms().saturating_sub(stored.started_at_unix_ms)),
                    evidence_refs: Vec::new(),
                    artifacts: Vec::new(),
                })
            }
        }
    }

    fn abandon(&self, token: &str) {
        if let Ok(mut prepared) = self.prepared.lock() {
            prepared.remove(token);
        }
    }

    fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let runtime = &self.engine;
        let processes = runtime.scratch_task_processes(task_id)?;
        let outcome = runtime.cancel_task(task_id, &self.services.sessions);
        let confirmed: Vec<_> = processes
            .into_iter()
            .filter_map(|process| {
                let snapshot = process.snapshot().ok()?;
                snapshot
                    .termination_confirmed
                    .then_some(snapshot.process_handle)
            })
            .collect();
        self.scratch.release_process_handles(&confirmed)?;
        outcome
    }
}

fn normalize_sudo_operation(
    database: &Database,
    arguments: &Value,
    target: &AgentToolTargetNative,
) -> Result<Value, String> {
    let args: SudoOperationArguments = serde_json::from_value(arguments.clone())
        .map_err(|_| "AGENT_SUDO_INVALID_ARGUMENTS: supply sudoOperationId, explanation and an optional timeoutMs")?;
    let policy = crate::sudo_policy::policy_for_target(database, target)?;
    let runner = policy
        .runner
        .ok_or("AGENT_SUDO_UNAVAILABLE: a trusted restricted SSH runner is required")?;
    let revision = policy
        .revision
        .ok_or("AGENT_SUDO_UNAVAILABLE: no elevated operations are configured")?;
    let operation = policy
        .operations
        .iter()
        .find(|op| op.id == args.sudo_operation_id)
        .ok_or("AGENT_SUDO_UNAVAILABLE: that operation is not configured for this SSH profile")?;
    Ok(omit_null_fields(json!({
        "command": operation.command,
        "explanation": args.explanation,
        "channel": "direct",
        "elevated": true,
        "sudoOperation": { "id": operation.id, "revision": revision, "runnerUsername": runner.username, "runnerPort": runner.port },
        "timeoutMs": args.timeout_ms,
    })))
}

fn normalize_arguments(
    request: &NativeToolRequest,
    target: &AgentToolTargetNative,
    visible_route: Option<TerminalVisibleCommandRoute>,
    direct_lifecycle_required: bool,
) -> Result<(String, Value), String> {
    super::model::reject_omitted_input_replay(
        &request.model_call.name,
        &request.model_call.arguments,
    )?;
    if request.model_call.name == "run_terminal_command" {
        let arguments: TerminalCommandArguments =
            serde_json::from_value(request.model_call.arguments.clone()).map_err(|error| {
                format!("run_terminal_command schema rejected arguments: {error}")
            })?;
        if arguments.command.trim().is_empty() {
            return Err(
                "run_terminal_command schema rejected command: it must not be empty".into(),
            );
        }
        if arguments
            .command
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            let recovery = terminal_command_recovery(target);
            return Err(format!(
                "run_terminal_command schema rejected command: unsupported control character; newlines and tabs are allowed; no command was executed; doNotRetry=true; {recovery}; use probe_http for target-loopback HTTP"
            ));
        }
        if arguments.command.len() > 8_192 {
            let recovery = terminal_command_recovery(target);
            return Err(format!(
                "run_terminal_command schema rejected command: {} UTF-8 bytes exceeds the 8192-byte maximum; doNotRetry=true; {recovery}; child Agents have the same limit",
                arguments.command.len(),
            ));
        }
        if arguments.explanation.trim().is_empty() {
            return Err(
                "run_terminal_command schema rejected explanation: it must not be empty".into(),
            );
        }
        if arguments.explanation.len() > 2_048 {
            return Err(format!(
                "run_terminal_command schema rejected explanation: {} UTF-8 bytes exceeds the 2048-byte maximum",
                arguments.explanation.len()
            ));
        }
        let cwd = match target {
            AgentToolTargetNative::Local { cwd, .. } => cwd.clone(),
            AgentToolTargetNative::Remote { .. } => None,
            _ => return Err("terminal command requires a frozen host target".into()),
        };
        let timeout_ms = arguments.timeout_ms;
        let background = arguments.background;
        return match request.execution_surface {
            super::AgentExecutionSurface::Direct => Ok((
                "exec_command".into(),
                omit_null_fields(json!({
                    "command": arguments.command,
                    "explanation": arguments.explanation,
                    "channel": "direct",
                    "cwd": cwd,
                    "background": background,
                    "elevated": false,
                    "timeoutMs": timeout_ms
                })),
            )),
            super::AgentExecutionSurface::BoundTerminal
                if direct_lifecycle_required || terminal_command_requires_direct_lifecycle(request)? => Err(
                    "TERMINAL_DIRECT_REQUIRED: this request requires an independent process lifecycle; no command was executed; explicitly switch the session to direct before retrying".into(),
                ),
            super::AgentExecutionSurface::BoundTerminal => match visible_route
                .unwrap_or(TerminalVisibleCommandRoute::Unavailable)
            {
                TerminalVisibleCommandRoute::TerminalExecute => Ok((
                    "terminal_execute".into(),
                    omit_null_fields(json!({
                        "command": arguments.command,
                        "explanation": arguments.explanation,
                        "background": background.then_some(true),
                        "timeoutMs": timeout_ms
                    })),
                )),
                TerminalVisibleCommandRoute::Unavailable => Err(
                    "TERMINAL_VISIBLE_COMMAND_UNAVAILABLE: cooperative terminal execution is not available"
                        .into(),
                ),
            },
        };
    }
    match request.model_call.name.as_str() {
        "exec_command" if request.model_call.arguments["elevated"] == json!(true)
            || request.model_call.arguments.get("sudoOperation").is_some() =>
        {
            Err("AGENT_SUDO_UNAVAILABLE: request a configured sudoOperationId in run_terminal_command".into())
        }
        "exec_command" if request.execution_surface == super::AgentExecutionSurface::BoundTerminal => {
            Err("TERMINAL_DIRECT_REQUIRED: exec_command requires an explicitly selected direct session; no command was executed; use run_terminal_command for the bound terminal".into())
        }
        "write_process_input" => {
            let value = serde_json::from_value::<WriteProcessInputArguments>(
                request.model_call.arguments.clone(),
            )
            .map_err(|error| format!("write_process_input schema rejected arguments: {error}"))?;
            let _process_handle = value.process_handle;
            Ok((
                "write_stdin".into(),
                omit_null_fields(json!({ "input": value.input, "close": value.close })),
            ))
        }
        "wait_process" => {
            let value = serde_json::from_value::<WaitProcessModelArguments>(
                request.model_call.arguments.clone(),
            )
            .map_err(|error| format!("wait_process schema rejected arguments: {error}"))?;
            let _process_handle = value.process_handle;
            Ok((
                "wait_process".into(),
                omit_null_fields(json!({
                    "timeoutMs": value.timeout_ms,
                    "maxOutputBytes": value.max_output_bytes
                })),
            ))
        }
        "kill_process" => {
            let value = serde_json::from_value::<KillProcessModelArguments>(
                request.model_call.arguments.clone(),
            )
            .map_err(|error| format!("kill_process schema rejected arguments: {error}"))?;
            let _process_handle = value.process_handle;
            Ok((
                "kill_process".into(),
                omit_null_fields(json!({ "signal": value.signal, "timeoutMs": value.timeout_ms })),
            ))
        }
        "read_terminal" | "write_terminal_input" | "wait_terminal"
            if request.execution_surface != super::AgentExecutionSurface::BoundTerminal =>
        {
            Err("interactive terminal tools require a bound-terminal Session".into())
        }
        "exec_command"
        | "inspect_host"
        | "inspect_service"
        | "query_logs"
        | "diagnose_endpoint"
        | "terminal_execute"
        | "probe_http"
        | "read_terminal"
        | "write_terminal_input"
        | "wait_terminal"
        | "read_file"
        | "list_directory"
        | "search_text"
        | "write_file"
        | "edit_file"
        | "apply_patch"
        | "trash_file"
        | "transfer_file" => Ok((
            request.model_call.name.clone(),
            request.model_call.arguments.clone(),
        )),
        _ => Err("model requested a tool outside the Agent Runtime native registry".into()),
    }
}

fn terminal_command_recovery(target: &AgentToolTargetNative) -> &'static str {
    match target {
        AgentToolTargetNative::Local { cwd: Some(_), .. }
        | AgentToolTargetNative::Remote {
            profile_id: Some(_),
            root_path: Some(_),
            ..
        } => "suggestedTool=write_file; do not use cat, echo, heredocs, or terminal commands for file content; use write_file for files up to 128 KiB and bounded read_file plus apply_patch increments for larger files",
        _ => "suggestedAction=split_bounded_commands; use smaller complete scripts below the limit; native file tools require a filesystem root and remote Direct execution requires a credential-backed profile",
    }
}

fn recorded_native_arguments(tool_name: &str, arguments: &Value) -> Value {
    super::model::recorded_tool_arguments(tool_name, arguments)
}

fn native_success_criteria(goal: &str, criteria: &[String]) -> Vec<String> {
    if !criteria.is_empty() {
        return criteria.to_vec();
    }
    if goal.len() <= 2_048 {
        vec![goal.to_owned()]
    } else {
        // The full goal remains in AgentRequestNative.goal. Refer to it rather
        // than duplicating it into a field with a smaller wire-contract limit.
        vec!["Complete the goal preserved in this frozen request.".into()]
    }
}

fn omit_null_fields(mut value: Value) -> Value {
    if let Value::Object(fields) = &mut value {
        fields.retain(|_, value| !value.is_null());
    }
    value
}

fn terminal_command_requires_direct_lifecycle(request: &NativeToolRequest) -> Result<bool, String> {
    if request.model_call.name != "run_terminal_command" {
        return Ok(false);
    }
    let arguments: TerminalCommandArguments =
        serde_json::from_value(request.model_call.arguments.clone())
            .map_err(|error| format!("run_terminal_command schema rejected arguments: {error}"))?;
    if request.execution_surface == super::AgentExecutionSurface::BoundTerminal {
        super::validate_visible_command_input(&arguments.command)?;
        return Ok(arguments.lifecycle_trust == TerminalLifecycleTrust::DirectRequired);
    }
    Ok(arguments.background || arguments.lifecycle_trust == TerminalLifecycleTrust::DirectRequired)
}

fn is_model_process_tool(name: &str) -> bool {
    matches!(
        name,
        "write_process_input" | "wait_process" | "kill_process"
    )
}

fn project_native_result_target(
    native_target: &AgentToolTargetNative,
    result_target_id: &str,
    frozen_host_target_id: &str,
) -> Result<String, String> {
    if native_target.target_id() != result_target_id {
        return Err("Native result target did not match its authorized target".into());
    }
    let owner = match native_target {
        AgentToolTargetNative::Process {
            owner_target_id, ..
        } => owner_target_id.as_str(),
        _ => native_target.target_id(),
    };
    if owner != frozen_host_target_id {
        return Err("Native result owner did not match the frozen host".into());
    }
    // Process handles are native authorization targets. The model facade keeps
    // its frozen host identity, after validating both native target and owner.
    Ok(frozen_host_target_id.to_string())
}

fn process_target_for_model_call(
    call: &ModelToolCall,
    owner: &AgentToolTargetNative,
) -> Result<Option<AgentToolTargetNative>, String> {
    if !is_model_process_tool(&call.name) {
        return Ok(None);
    }
    if !matches!(
        owner,
        AgentToolTargetNative::Local { .. } | AgentToolTargetNative::Remote { .. }
    ) {
        return Err("process tools require a frozen host owner".into());
    }
    let process_handle = call
        .arguments
        .get("processHandle")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{} schema requires processHandle", call.name))?;
    let suffix = process_handle
        .strip_prefix("proc-")
        .or_else(|| process_handle.strip_prefix("job-"))
        .filter(|value| value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| format!("{} schema rejected processHandle", call.name))?;
    debug_assert_eq!(suffix.len(), 32);
    Ok(Some(AgentToolTargetNative::Process {
        target_id: format!("process-{process_handle}"),
        owner_target_id: owner.target_id().to_string(),
        process_handle: process_handle.to_string(),
    }))
}

pub(super) fn target_native(target: &AgentSessionTarget) -> Result<AgentToolTargetNative, String> {
    match target.kind.as_str() {
        "local" => Ok(AgentToolTargetNative::Local {
            target_id: target.target_id.clone(),
            session_id: target.session_id.clone(),
            cwd: target.cwd.clone(),
        }),
        "remote" => Ok(AgentToolTargetNative::Remote {
            target_id: target.target_id.clone(),
            session_id: target.session_id.clone(),
            profile_id: target.profile_id.clone(),
            host: target
                .host
                .clone()
                .ok_or_else(|| "frozen remote target has no host".to_string())?,
            port: target
                .port
                .ok_or_else(|| "frozen remote target has no port".to_string())?,
            username: target
                .username
                .clone()
                .ok_or_else(|| "frozen remote target has no username".to_string())?,
            root_path: target.root_path.clone(),
            local_root: target.local_root.clone(),
        }),
        _ => Err("Agent Session target is not a native host target".into()),
    }
}

fn permission_mode_native(mode: AgentSessionPermissionMode) -> AgentPermissionModeNative {
    match mode {
        AgentSessionPermissionMode::RequestApproval => AgentPermissionModeNative::RequestApproval,
        AgentSessionPermissionMode::ScopedAutopilot => AgentPermissionModeNative::ScopedAutopilot,
        AgentSessionPermissionMode::Operator => AgentPermissionModeNative::Operator,
    }
}

fn effect_from_native(effect: AgentEffectKindNative) -> AgentSessionEffect {
    match effect {
        AgentEffectKindNative::None => AgentSessionEffect::None,
        AgentEffectKindNative::ReadOnly => AgentSessionEffect::ReadOnly,
        AgentEffectKindNative::SensitiveRead => AgentSessionEffect::SensitiveRead,
        AgentEffectKindNative::StateChange => AgentSessionEffect::StateChange,
        AgentEffectKindNative::Destructive => AgentSessionEffect::Destructive,
        AgentEffectKindNative::ExternalSideEffect => AgentSessionEffect::ExternalSideEffect,
    }
}

fn status_from_native(status: AgentToolResultStatusNative) -> AgentToolResultStatus {
    match status {
        AgentToolResultStatusNative::Completed => AgentToolResultStatus::Completed,
        AgentToolResultStatusNative::Rejected => AgentToolResultStatus::Rejected,
        AgentToolResultStatusNative::Failed => AgentToolResultStatus::Failed,
        AgentToolResultStatusNative::TimedOut => AgentToolResultStatus::TimedOut,
        AgentToolResultStatusNative::Cancelled => AgentToolResultStatus::Cancelled,
        AgentToolResultStatusNative::Uncertain => AgentToolResultStatus::Uncertain,
    }
}

fn cancelled_result(stored: &PreparedNativeCall) -> NativeToolResult {
    NativeToolResult {
        call_id: stored.public_call_id.clone(),
        native_name: stored.native_name.clone(),
        target_id: stored.target_id.clone(),
        effect: stored.effect,
        status: AgentToolResultStatus::Cancelled,
        summary: "native tool execution was cancelled before dispatch".into(),
        data: None,
        duration_ms: Some(current_unix_ms().saturating_sub(stored.started_at_unix_ms)),
        evidence_refs: Vec::new(),
        artifacts: Vec::new(),
    }
}

pub(super) fn stable_native_id(prefix: &str, value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let suffix = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}-{suffix}")
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    include!("tests/native_adapter/core.rs");
}

pub(crate) fn list_remote_file_references(
    request: super::file_references::FileReferenceRequest,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts: &std::path::Path,
) -> super::file_references::FileReferenceList {
    use super::{
        file_references::{discover, FileReferenceList},
        native::scoped_read::*,
    };
    let Some(root) = request.target.root_path.as_deref() else {
        return FileReferenceList::failed("RootRequired");
    };
    let target = match target_native(&request.target) {
        Ok(t) => t,
        Err(_) => return FileReferenceList::failed("Denied"),
    };
    let connection = match super::connection_for_remote_target(&target, database, credentials) {
        Ok(c) => c,
        Err(_) => return FileReferenceList::failed("Drift"),
    };
    let control = ReadControl {
        cancellation: request.cancellation.clone(),
        deadline: request.deadline,
    };
    if let Err(e) = control.check() {
        return FileReferenceList::failed(e.to_string());
    }
    crate::connection::with_scoped_connection_io(
        request.cancellation.clone(),
        control.deadline,
        || {
            let connected =
                match crate::connection::connect_sftp(&connection, None, Some(known_hosts)) {
                    Ok(c) => c,
                    Err(_) => return FileReferenceList::failed("Io"),
                };
            let connected = match connected.lock() {
                Ok(c) => c,
                Err(_) => return FileReferenceList::failed("Io"),
            };
            if let Err(e) = control.check() {
                return FileReferenceList::failed(e.to_string());
            }
            connected.session.set_timeout(
                control
                    .deadline
                    .saturating_duration_since(std::time::Instant::now())
                    .as_millis()
                    .clamp(1, 1000) as u32,
            );
            let reader = match RemoteScopedReader::open(&connected.session, &connected.sftp, root) {
                Ok(r) => r,
                Err(e) => return FileReferenceList::failed(e.to_string()),
            };
            let result = discover(&reader, &request);
            if super::connection_for_remote_target(&target, database, credentials).is_err() {
                return FileReferenceList::failed("Drift");
            }
            result
        },
    )
}

pub(crate) fn read_remote_skills(
    request: super::skill_runtime::SkillReadRequest,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts: &std::path::Path,
) -> super::skill_runtime::SkillReadResult {
    use super::{
        native::scoped_read::*,
        skill_runtime::{discover, SkillReadResult},
    };
    let Some(root) = request.target.root_path.as_deref() else {
        return SkillReadResult::unavailable("frozen remote root is absent");
    };
    let target = match target_native(&request.target) {
        Ok(t) => t,
        Err(_) => return SkillReadResult::failed(ScopeReadError::Denied),
    };
    let connection = match super::connection_for_remote_target(&target, database, credentials) {
        Ok(c) => c,
        Err(_) => return SkillReadResult::failed(ScopeReadError::Drift),
    };
    let control = ReadControl {
        cancellation: request.cancellation.clone(),
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(15),
    };
    if let Err(e) = control.check() {
        return SkillReadResult::failed(e);
    }
    crate::connection::with_scoped_connection_io(
        request.cancellation.clone(),
        control.deadline,
        || {
            let connected =
                match crate::connection::connect_sftp(&connection, None, Some(known_hosts)) {
                    Ok(c) => c,
                    Err(_) => return SkillReadResult::failed(ScopeReadError::Io),
                };
            let connected = match connected.lock() {
                Ok(c) => c,
                Err(_) => return SkillReadResult::failed(ScopeReadError::Io),
            };
            if let Err(e) = control.check() {
                return SkillReadResult::failed(e);
            }
            connected.session.set_timeout(
                control
                    .deadline
                    .saturating_duration_since(std::time::Instant::now())
                    .as_millis()
                    .clamp(1, 1000) as u32,
            );
            let reader = match RemoteScopedReader::open(&connected.session, &connected.sftp, root) {
                Ok(r) => r,
                Err(e) => return SkillReadResult::failed(e),
            };
            let result = discover(&reader, &request, &control);
            if super::connection_for_remote_target(&target, database, credentials).is_err() {
                return SkillReadResult::failed(ScopeReadError::Drift);
            }
            result
        },
    )
}

#[cfg(test)]
mod skill_sftp_tests {
    include!("tests/native_adapter/skill_sftp.rs");
}

#[cfg(test)]
mod file_reference_sftp_tests {
    include!("tests/native_adapter/file_references_sftp.rs");
}
