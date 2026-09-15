use std::collections::HashMap;
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
use crate::models::{AgentRemoteTerminalOwner, SessionManager, SessionStatus, SessionTerminalKind};
use crate::terminal_broker::TerminalIntegrationState;
use crate::terminal_broker::TerminalVisibleCommandRoute;

use super::{
    AgentSessionEffect, AgentSessionPermissionMode, AgentSessionTarget, AgentToolResultStatus,
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
}

/// Construction is private to this module and occurs only after the prepared
/// native authorization has been issued. The remote session creator requires
/// this witness before it may write bootstrap bytes to an Agent SSH PTY.
pub(crate) struct ApprovedAgentRemoteTerminalBootstrap {
    _private: (),
}

pub(crate) struct NativeToolAdapter {
    app: AppHandle,
    engine: Arc<NativeToolEngine>,
    prepared: Mutex<HashMap<String, PreparedNativeCall>>,
}

impl NativeToolAdapter {
    pub(crate) fn new(app: AppHandle, engine: Arc<NativeToolEngine>) -> Self {
        Self {
            app,
            engine,
            prepared: Mutex::new(HashMap::new()),
        }
    }

    fn configure(
        &self,
        runtime: &NativeToolEngine,
        sessions: &SessionManager,
    ) -> Result<(), String> {
        let root = self
            .app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve Agent native runtime root: {error}"))?;
        runtime.configure_checkpoint_root(root)?;
        if !runtime
            .terminal_broker_snapshot(None)?
            .remote_agent_pty_rollout
            .enabled
        {
            for session_id in sessions.agent_remote_session_ids()? {
                let _ = runtime.terminal_closed(&session_id);
                if !runtime
                    .abort_agent_ssh_terminal_broker_candidate(&session_id)
                    .unwrap_or(false)
                {
                    let _ = runtime.close_terminal_broker_transport(
                        &session_id,
                        crate::terminal_broker::TerminalGenerationCloseReason::BrokerShutdown,
                    );
                }
                let _ = sessions.close(&session_id);
            }
        }
        Ok(())
    }

    fn ensure_remote_agent_terminal(
        &self,
        prepared: &PreparedAuthorizationNative,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        cancellation: &CancellationToken,
        approval: &ApprovedAgentRemoteTerminalBootstrap,
    ) -> Result<(), String> {
        if !matches!(
            prepared.call.tool_name.as_str(),
            "terminal_execute" | "write_terminal_input"
        ) {
            return Ok(());
        }
        let AgentToolTargetNative::Remote {
            target_id,
            session_id: source_session_id,
            profile_id: Some(profile_id),
            host,
            port,
            username,
            ..
        } = &prepared.call.target
        else {
            return Ok(());
        };
        let existing =
            sessions.agent_remote_terminal(&prepared.context.request.user_session_id, target_id)?;
        let existing_ready = existing.as_ref().is_some_and(|binding| {
            binding.owner.source_session_id == *source_session_id
                && binding.state.terminal_kind == SessionTerminalKind::Remote
                && binding.state.status == SessionStatus::Connected
                && binding.state.identity.host == *host
                && binding.state.identity.port == *port
                && binding.state.identity.username == *username
        });
        let mut owned_candidate = None;
        let dedicated_session_id = if existing_ready {
            existing
                .as_ref()
                .expect("existing Agent terminal checked above")
                .session_id
                .clone()
        } else {
            if cancellation.is_cancelled() {
                return Err("Agent remote terminal creation was cancelled before dispatch".into());
            }
            let predecessor = existing.as_ref().map(|binding| binding.session_id.clone());
            let geometry = predecessor
                .as_deref()
                .and_then(|id| self.engine.terminal_broker_snapshot(Some(id)).ok())
                .and_then(|snapshot| snapshot.session)
                .or_else(|| {
                    self.engine
                        .terminal_broker_snapshot(Some(source_session_id))
                        .ok()
                        .and_then(|snapshot| snapshot.session)
                })
                .map(|snapshot| snapshot.geometry)
                .unwrap_or_else(|| crate::terminal_broker::TerminalGeometry::new(120, 30));
            let profile = database
                .get_profile(profile_id)?
                .ok_or_else(|| "remote execution profile was not found".to_string())?;
            let connection = super::native::connection_for_remote_target(
                &prepared.call.target,
                database,
                credentials,
            )?;
            let candidate = crate::commands::create_agent_remote_terminal_blocking(
                &self.app,
                sessions,
                self.app.state::<crate::sftp_pool::SftpPool>().inner(),
                connection,
                profile.name,
                profile_id.clone(),
                AgentRemoteTerminalOwner {
                    agent_session_id: prepared.context.request.user_session_id.clone(),
                    target_id: target_id.clone(),
                    source_session_id: source_session_id.clone(),
                },
                predecessor,
                geometry.columns,
                geometry.rows,
                cancellation,
                approval,
            )?;
            let session_id = candidate.session_id().to_string();
            owned_candidate = Some(candidate);
            session_id
        };

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let readiness = loop {
            if cancellation.is_cancelled() {
                break Err(
                    "Agent remote terminal creation was cancelled before command input".into(),
                );
            }
            let snapshot = match self
                .engine
                .terminal_broker_snapshot(Some(&dedicated_session_id))
            {
                Ok(snapshot) => match snapshot.session {
                    Some(session) => session,
                    None => break Err("Agent remote terminal broker session disappeared".into()),
                },
                Err(error) => break Err(error),
            };
            match snapshot.integration_state {
                TerminalIntegrationState::Ready if snapshot.prompt_ready => break Ok(()),
                TerminalIntegrationState::Degraded
                | TerminalIntegrationState::Unavailable
                | TerminalIntegrationState::Invalidated => {
                    break Err(format!(
                        "TERMINAL_REMOTE_INTEGRATION_UNAVAILABLE: {}",
                        snapshot.integration_reason.as_deref().unwrap_or("unknown")
                    ));
                }
                TerminalIntegrationState::Initializing | TerminalIntegrationState::Ready => {}
            }
            if std::time::Instant::now() >= deadline {
                break Err("TERMINAL_REMOTE_INTEGRATION_TIMEOUT".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        };
        if let Err(error) = readiness {
            if let Some(candidate) = owned_candidate.as_ref() {
                let cleanup_errors = crate::commands::abort_agent_remote_terminal_candidate(
                    &self.app, sessions, candidate,
                );
                return Err(crate::commands::attachment_failure_message(
                    &error,
                    cleanup_errors,
                ));
            }
            return Err(error);
        }
        if let Some(candidate) = owned_candidate.as_ref() {
            if cancellation.is_cancelled() {
                let cleanup_errors = crate::commands::abort_agent_remote_terminal_candidate(
                    &self.app, sessions, candidate,
                );
                return Err(crate::commands::attachment_failure_message(
                    "Agent remote terminal creation was cancelled before publication",
                    cleanup_errors,
                ));
            }
            if let Err(error) = crate::commands::publish_agent_remote_terminal_candidate(
                &self.app, sessions, candidate,
            ) {
                let cleanup_errors = crate::commands::abort_agent_remote_terminal_candidate(
                    &self.app, sessions, candidate,
                );
                return Err(crate::commands::attachment_failure_message(
                    &error,
                    cleanup_errors,
                ));
            }
        }
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
    fn terminal_interactive_tools_enabled(&self, remote_target: bool) -> bool {
        self.engine
            .terminal_broker_snapshot(None)
            .is_ok_and(|snapshot| {
                snapshot.interactive_tools_rollout.enabled
                    && (!remote_target || snapshot.remote_agent_pty_rollout.enabled)
            })
    }

    fn list_file_references(
        &self,
        request: super::file_references::FileReferenceRequest,
    ) -> super::file_references::FileReferenceList {
        if request.target.kind == "local" {
            return super::file_references::read_local(request);
        }
        let known_hosts = match crate::known_hosts::known_hosts_path(&self.app) {
            Ok(p) => p,
            Err(_) => return super::file_references::FileReferenceList::failed("Unavailable"),
        };
        list_remote_file_references(
            request,
            &self.app.state::<Database>(),
            &self.app.state::<CredentialManager>(),
            &known_hosts,
        )
    }

    fn read_skills(
        &self,
        request: super::skill_runtime::SkillReadRequest,
    ) -> super::skill_runtime::SkillReadResult {
        if request.target.kind == "local" {
            return super::skill_runtime::read_local(request);
        }
        let known_hosts = match crate::known_hosts::known_hosts_path(&self.app) {
            Ok(p) => p,
            Err(_) => {
                return super::skill_runtime::SkillReadResult::unavailable(
                    "known hosts unavailable",
                )
            }
        };
        read_remote_skills(
            request,
            &self.app.state::<Database>(),
            &self.app.state::<CredentialManager>(),
            &known_hosts,
        )
    }

    fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
        let runtime = &self.engine;
        let sessions = self.app.state::<SessionManager>();
        let database = self.app.state::<Database>();
        let credentials = self.app.state::<CredentialManager>();
        self.configure(runtime, &sessions)?;
        let known_hosts_path = crate::known_hosts::known_hosts_path(&self.app)?;
        let target = target_native(&request.target)?;
        let native_request_id = stable_native_id("request", &request.session_id);
        let frozen_request = AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: native_request_id.clone(),
            user_session_id: request.session_id.clone(),
            task_id: request.task_id.clone(),
            goal: request.goal.clone(),
            success_criteria: if request.success_criteria.is_empty() {
                vec![request.goal.clone()]
            } else {
                request.success_criteria.clone()
            },
            targets: vec![target.clone()],
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
                &sessions,
                &database,
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
                requires_approval: true,
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
                    },
                );
            return Ok(preparation);
        }

        let direct_lifecycle_required = terminal_command_requires_direct_lifecycle(&request)?;
        let visible_route = if request.model_call.name == "run_terminal_command"
            && request.execution_surface == super::AgentExecutionSurface::BoundTerminal
            && !direct_lifecycle_required
        {
            let route = match &target {
                AgentToolTargetNative::Local { session_id, .. } => {
                    runtime.terminal_visible_command_route(session_id)?
                }
                AgentToolTargetNative::Remote {
                    target_id,
                    session_id,
                    host,
                    port,
                    username,
                    ..
                } => match sessions
                    .agent_remote_terminal(&request.session_id, target_id)?
                    .filter(|binding| {
                        binding.owner.source_session_id == *session_id
                            && binding.state.terminal_kind == SessionTerminalKind::Remote
                            && binding.state.status == SessionStatus::Connected
                            && binding.state.identity.host == *host
                            && binding.state.identity.port == *port
                            && binding.state.identity.username == *username
                    }) {
                    Some(binding) => {
                        runtime.terminal_remote_visible_command_route(&binding.session_id)?
                    }
                    None => runtime.remote_agent_pty_new_operation_route()?,
                },
                _ => return Err("terminal command requires a frozen host target".into()),
            };
            Some(route)
        } else {
            None
        };
        let (native_name, arguments) =
            normalize_arguments(&request, &target, visible_route, direct_lifecycle_required)?;
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
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
        )?;
        let descriptor = runtime.tool(&native_name)?.descriptor.clone();
        let effect = effect_from_native(prepared.effect.kind);
        let token = format!("prepared-{}", Uuid::new_v4().simple());
        let call = RecordedToolCall {
            call_id: request.model_call.call_id.clone(),
            provider_call_id: request.model_call.provider_call_id.clone(),
            name: request.model_call.name.clone(),
            native_name: Some(native_name.clone()),
            arguments: recorded_native_arguments(&native_name, &prepared.call.arguments),
            title: Some(native_name.clone()),
            effect: Some(effect),
            target: Some(request.target.clone()),
        };
        let expires_at_unix_ms = current_unix_ms().saturating_add(DEFAULT_NATIVE_APPROVAL_TTL_MS);
        let preparation = NativeToolPreparation {
            token: token.clone(),
            call,
            requires_approval: prepared.requires_native_confirmation,
            prompt: prepared.native_prompt.clone(),
            expires_at_unix_ms,
            idempotency: match descriptor.idempotency {
                ToolIdempotencyNative::Yes => NativeToolIdempotency::Yes,
                ToolIdempotencyNative::No => NativeToolIdempotency::No,
                ToolIdempotencyNative::Conditional => NativeToolIdempotency::Conditional,
            },
            parallel: descriptor.parallel,
            exclusive: descriptor.max_concurrency == 1
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
        let stored = self
            .prepared
            .lock()
            .map_err(|_| "native prepared-call registry is unavailable".to_string())?
            .remove(token)
            .ok_or_else(|| "native prepared call is unknown or already consumed".to_string())?;
        if cancellation.is_cancelled() {
            return Ok(cancelled_result(&stored));
        }
        let runtime = &self.engine;
        let sessions = self.app.state::<SessionManager>();
        let database = self.app.state::<Database>();
        let credentials = self.app.state::<CredentialManager>();
        self.configure(runtime, &sessions)?;
        let known_hosts_path = crate::known_hosts::known_hosts_path(&self.app)?;
        match stored.authorization {
            PreparedAuthorization::Tool(prepared) => {
                let native_request_id = prepared.call.request_id.clone();
                let native_call_id = prepared.call.call_id.clone();
                let native_tool_name = prepared.call.tool_name.clone();
                let native_target = prepared.call.target.clone();
                let grant = runtime.issue_prepared_authorization(&prepared, approved)?;
                let remote_bootstrap_approval =
                    ApprovedAgentRemoteTerminalBootstrap { _private: () };
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
                if let Err(error) = self.ensure_remote_agent_terminal(
                    &prepared,
                    &sessions,
                    &database,
                    &credentials,
                    &cancellation,
                    &remote_bootstrap_approval,
                ) {
                    let _ = runtime.revoke_capability(&grant.capability_id);
                    return Err(error);
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
                let result = runtime.execute_tool(
                    &prepared.context,
                    call,
                    &sessions,
                    &database,
                    &credentials,
                    &known_hosts_path,
                    &cancellation,
                )?;
                let result_effect = result
                    .effects
                    .first()
                    .map(|effect| effect_from_native(effect.kind))
                    .unwrap_or(stored.effect);
                Ok(NativeToolResult {
                    call_id: stored.public_call_id,
                    native_name: result.tool_name,
                    target_id: result.target_id,
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
                })
            }
            PreparedAuthorization::Mcp(prepared) => {
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
                    &credentials,
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
        let sessions = self.app.state::<SessionManager>();
        runtime.cancel_task(task_id, &sessions)
    }
}

fn normalize_arguments(
    request: &NativeToolRequest,
    target: &AgentToolTargetNative,
    visible_route: Option<TerminalVisibleCommandRoute>,
    direct_lifecycle_required: bool,
) -> Result<(String, Value), String> {
    if request.model_call.name == "run_terminal_command" {
        let arguments: TerminalCommandArguments =
            serde_json::from_value(request.model_call.arguments.clone()).map_err(|error| {
                format!("run_terminal_command schema rejected arguments: {error}")
            })?;
        if arguments.command.trim().is_empty()
            || arguments.command.len() > 8_192
            || arguments.explanation.trim().is_empty()
            || arguments.explanation.len() > 2_048
        {
            return Err("run_terminal_command schema rejected bounded string fields".into());
        }
        let cwd = match target {
            AgentToolTargetNative::Local { cwd, .. } => cwd.clone(),
            AgentToolTargetNative::Remote { .. } => None,
            _ => return Err("terminal command requires a frozen host target".into()),
        };
        return match request.execution_surface {
            super::AgentExecutionSurface::Direct => Ok((
                "exec_command".into(),
                json!({
                    "command": arguments.command,
                    "explanation": arguments.explanation,
                    "channel": "direct",
                    "cwd": cwd,
                    "background": false,
                    "elevated": false
                }),
            )),
            super::AgentExecutionSurface::BoundTerminal if direct_lifecycle_required => Ok((
                "exec_command".into(),
                json!({
                    "command": arguments.command,
                    "explanation": arguments.explanation,
                    "channel": "direct",
                    "cwd": cwd,
                    "background": false,
                    "elevated": false
                }),
            )),
            super::AgentExecutionSurface::BoundTerminal => match visible_route
                .unwrap_or(TerminalVisibleCommandRoute::LegacyFallback)
            {
                TerminalVisibleCommandRoute::TerminalExecute => Ok((
                    "terminal_execute".into(),
                    json!({
                        "command": arguments.command,
                        "explanation": arguments.explanation
                    }),
                )),
                TerminalVisibleCommandRoute::LegacyFallback => Ok((
                    "exec_command".into(),
                    json!({
                        "command": arguments.command,
                        "explanation": arguments.explanation,
                        "channel": "pty",
                        "cwd": cwd,
                        "background": false,
                        "elevated": false
                    }),
                )),
                TerminalVisibleCommandRoute::Unavailable => Err(
                    "TERMINAL_VISIBLE_COMMAND_UNAVAILABLE: integration is not ready and legacy fallback is disabled"
                        .into(),
                ),
            },
        };
    }
    match request.model_call.name.as_str() {
        "read_terminal" | "write_terminal_input" | "wait_terminal"
            if request.execution_surface != super::AgentExecutionSurface::BoundTerminal =>
        {
            Err("interactive terminal tools require a bound-terminal Session".into())
        }
        "exec_command"
        | "terminal_execute"
        | "read_terminal"
        | "write_terminal_input"
        | "wait_terminal"
        | "read_file"
        | "list_directory"
        | "search_text"
        | "apply_patch"
        | "transfer_file" => Ok((
            request.model_call.name.clone(),
            request.model_call.arguments.clone(),
        )),
        _ => Err("model requested a tool outside the Agent Runtime native registry".into()),
    }
}

fn recorded_native_arguments(tool_name: &str, arguments: &Value) -> Value {
    super::model::recorded_tool_arguments(tool_name, arguments)
}

fn terminal_command_requires_direct_lifecycle(request: &NativeToolRequest) -> Result<bool, String> {
    if request.model_call.name != "run_terminal_command" {
        return Ok(false);
    }
    let arguments: TerminalCommandArguments =
        serde_json::from_value(request.model_call.arguments.clone())
            .map_err(|error| format!("run_terminal_command schema rejected arguments: {error}"))?;
    Ok(
        arguments.lifecycle_trust == TerminalLifecycleTrust::DirectRequired
            || super::native::command_requires_direct_lifecycle_native(&arguments.command),
    )
}

fn target_native(target: &AgentSessionTarget) -> Result<AgentToolTargetNative, String> {
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

fn stable_native_id(prefix: &str, value: &str) -> String {
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
