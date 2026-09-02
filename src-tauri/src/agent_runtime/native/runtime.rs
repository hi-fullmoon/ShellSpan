//! Native safe-execution kernel.
//!
//! Agent lifecycle, plans, recovery, notifications, and Fleet orchestration are
//! owned by the Session runtime. This module receives one immutable call
//! context and owns only safety validation plus the operating-system effect.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agent_runtime::{
    validate_agent_request_native, validate_tool_arguments_native,
    AgentCapabilityVerificationContextNative, AgentEffectKindNative, AgentExecutionChannelNative,
    AgentObservedEffectNative, AgentPermissionModeNative, AgentPolicyEngineNative,
    AgentPolicyEvaluationNative, AgentPolicyOutcomeNative, AgentRequestNative, AgentToolCallNative,
    AgentToolResultNative, AgentToolResultStatusNative, AgentToolTargetNative,
    ExecCommandArgumentsNative, KillProcessArgumentsNative, NativeContractPolicyEngine,
    WaitProcessArgumentsNative, WriteStdinArgumentsNative,
};
use crate::db::Database;
use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::{
    AuthMethod, JumpHostConfig, ProfileAuthMethod, RemoteConnectionRequest, SessionManager,
    SessionStatus, SessionTerminalKind,
};

use super::{
    assess_effect_native, configured_tool_policy_native, current_unix_ms,
    enforce_native_call_policy_native, execute_file_tool_native, execute_mcp_tool_native,
    inspect_call_policy_scope_native, load_mcp_server_native, preview_file_call_native,
    spawn_local_process_native, spawn_remote_process_native, AgentCallPreviewNative,
    CapabilityIssueRequestNative, CheckpointStoreNative, FileExecutionContextNative,
    FileOperationRegistryNative, IssuedCapabilityNative, McpServerConfigNative,
    McpToolPolicyNative, NativeCapabilityStoreNative, ProcessLifecycleNative,
    ProcessRegistryNative, ProcessSnapshotNative, PtyLifecycleNative, PtyRegistryNative,
    RegisteredToolNative, RemoteProcessStartNative, ToolRegistryErrorNative, ToolRegistryNative,
};

pub(crate) const DEFAULT_CAPABILITY_TTL_MS: u64 = 120_000;
pub(crate) const MAX_CAPABILITY_TTL_MS: u64 = 300_000;

#[derive(Debug, Clone)]
pub(crate) struct NativeExecutionContext {
    pub(crate) request: AgentRequestNative,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
}

impl NativeExecutionContext {
    fn validate(&self) -> Result<(), String> {
        validate_agent_request_native(&self.request)
            .map_err(|_| "invalid frozen Agent Session request".to_string())?;
        validate_identifier(&self.turn_id, "turn id")?;
        validate_identifier(&self.step_id, "step id")?;
        let host_targets = self
            .request
            .targets
            .iter()
            .filter(|target| {
                matches!(
                    target,
                    AgentToolTargetNative::Local { .. } | AgentToolTargetNative::Remote { .. }
                )
            })
            .count();
        if host_targets != 1 {
            return Err("native execution requires one frozen Session host target".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentAuthorizeCallRequestNative {
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) tool_name: String,
    pub(crate) arguments: Value,
    pub(crate) target: AgentToolTargetNative,
    pub(crate) ttl_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedAuthorizationNative {
    pub(crate) context: NativeExecutionContext,
    pub(crate) call: AgentToolCallNative,
    pub(crate) effect: AgentObservedEffectNative,
    ttl_ms: u64,
    pub(crate) requires_native_confirmation: bool,
    pub(crate) native_prompt: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentCapabilityGrantNative {
    pub(crate) capability_id: String,
    pub(crate) effective_arguments: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedMcpAuthorizationNative {
    pub(crate) context: NativeExecutionContext,
    pub(crate) call: AgentToolCallNative,
    server: McpServerConfigNative,
    tool_name: String,
    workspace_root: PathBuf,
    pub(crate) effect: AgentObservedEffectNative,
    ttl_ms: u64,
    pub(crate) native_prompt: String,
}

#[derive(Clone)]
pub(crate) struct NativeToolEngine {
    registry: Arc<ToolRegistryNative>,
    capabilities: NativeCapabilityStoreNative,
    processes: ProcessRegistryNative,
    pty: PtyRegistryNative,
    checkpoints: CheckpointStoreNative,
    file_operations: FileOperationRegistryNative,
    checkpoint_root: Arc<Mutex<Option<PathBuf>>>,
}

impl Default for NativeToolEngine {
    fn default() -> Self {
        Self {
            registry: Arc::new(
                ToolRegistryNative::from_builtin_manifest().expect("valid native tool manifest"),
            ),
            capabilities: NativeCapabilityStoreNative::default(),
            processes: ProcessRegistryNative::default(),
            pty: PtyRegistryNative::default(),
            checkpoints: CheckpointStoreNative::default(),
            file_operations: FileOperationRegistryNative::default(),
            checkpoint_root: Arc::new(Mutex::new(None)),
        }
    }
}

impl NativeToolEngine {
    pub(crate) fn configure_checkpoint_root(&self, root: PathBuf) -> Result<(), String> {
        let mut stored = self
            .checkpoint_root
            .lock()
            .map_err(|_| "native checkpoint root is unavailable".to_string())?;
        if let Some(existing) = stored.as_ref() {
            if existing != &root {
                return Err("native checkpoint root changed during a Session".into());
            }
        } else {
            *stored = Some(root);
        }
        Ok(())
    }

    pub(crate) fn tool(&self, name: &str) -> Result<&RegisteredToolNative, String> {
        self.registry
            .executable(name)
            .map_err(registry_error_message)
    }

    pub(crate) fn prepare_authorization(
        &self,
        context: NativeExecutionContext,
        input: AgentAuthorizeCallRequestNative,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<PreparedAuthorizationNative, String> {
        context.validate()?;
        if context.request.request_id != input.request_id
            || !context
                .request
                .targets
                .iter()
                .any(|target| target == &input.target)
        {
            return Err("native call is outside the frozen Agent Session request".into());
        }
        let tool = self
            .registry
            .executable(&input.tool_name)
            .map_err(registry_error_message)?;
        validate_tool_arguments_native(&input.tool_name, &input.arguments)?;
        let call = AgentToolCallNative {
            request_id: input.request_id,
            call_id: input.call_id,
            tool_name: input.tool_name,
            arguments: input.arguments,
            target: input.target,
            capability_id: "pending-native-capability".into(),
        };
        self.revalidate_target(&context, &call.target, sessions, database)?;
        let effect = assess_effect_native(&tool.descriptor, &call)?;
        let scope = inspect_call_policy_scope_native(&call)?;
        enforce_native_call_policy_native(&call, &effect, &scope)?;
        let ttl_ms = input.ttl_ms.unwrap_or(DEFAULT_CAPABILITY_TTL_MS);
        if ttl_ms == 0 || ttl_ms > MAX_CAPABILITY_TTL_MS {
            return Err("capability TTL is outside the native limit".into());
        }
        let preview = preview_file_call_native(&call, database, credentials, known_hosts_path)?;
        let requires_native_confirmation = context.request.permission_mode
            == AgentPermissionModeNative::RequestApproval
            || scope.sensitive_path_count > 0
            || matches!(
                effect.kind,
                AgentEffectKindNative::StateChange
                    | AgentEffectKindNative::Destructive
                    | AgentEffectKindNative::ExternalSideEffect
            );
        Ok(PreparedAuthorizationNative {
            native_prompt: native_prompt(&context, &call, &effect, &scope, &preview, ttl_ms),
            context,
            call,
            effect,
            ttl_ms,
            requires_native_confirmation,
        })
    }

    pub(crate) fn issue_prepared_authorization(
        &self,
        prepared: &PreparedAuthorizationNative,
        approved: bool,
    ) -> Result<AgentCapabilityGrantNative, String> {
        if prepared.requires_native_confirmation && !approved {
            return Err("native capability approval was denied".into());
        }
        let IssuedCapabilityNative {
            capability_id,
            expires_at_unix_ms: _,
        } = self
            .capabilities
            .issue(
                CapabilityIssueRequestNative {
                    request_id: prepared.context.request.request_id.clone(),
                    user_session_id: prepared.context.request.user_session_id.clone(),
                    call_id: prepared.call.call_id.clone(),
                    call_digest: call_digest(&prepared.call)?,
                    allowed_tools: vec![prepared.call.tool_name.clone()],
                    allowed_effects: vec![prepared.effect.kind],
                    target_ids: vec![prepared.call.target.target_id().to_string()],
                    ttl_ms: prepared.ttl_ms,
                    max_uses: 1,
                },
                current_unix_ms(),
            )
            .map_err(|error| format!("native capability issuance failed: {error:?}"))?;
        Ok(AgentCapabilityGrantNative {
            capability_id,
            effective_arguments: prepared.call.arguments.clone(),
        })
    }

    pub(crate) fn revoke_capability(&self, capability_id: &str) -> Result<(), String> {
        self.capabilities
            .revoke(capability_id)
            .map_err(|error| format!("native capability revocation failed: {error:?}"))
    }

    pub(crate) fn prepare_mcp_authorization(
        &self,
        context: NativeExecutionContext,
        call_id: String,
        server_id: &str,
        tool_name: &str,
        arguments: Value,
        sessions: &SessionManager,
        database: &Database,
    ) -> Result<PreparedMcpAuthorizationNative, String> {
        context.validate()?;
        let target = context
            .request
            .targets
            .first()
            .cloned()
            .ok_or_else(|| "MCP call has no frozen target".to_string())?;
        self.revalidate_target(&context, &target, sessions, database)?;
        let workspace = match &target {
            AgentToolTargetNative::Local {
                cwd: Some(root), ..
            } => PathBuf::from(root),
            AgentToolTargetNative::Local { cwd: None, .. } => {
                return Err("MCP requires a frozen local workspace root".into())
            }
            _ => return Err("MCP stdio is local-workspace only".into()),
        };
        if !arguments.is_object() {
            return Err("MCP arguments must be an object".into());
        }
        // This reads and validates only a bounded configuration file. No child
        // process, tool discovery, or credential access occurs before approval.
        let (workspace_root, server) = load_mcp_server_native(&workspace, server_id)?;
        let policy = configured_tool_policy_native(&server, tool_name)?;
        let effect_kind = match policy {
            McpToolPolicyNative::ReadOnly => AgentEffectKindNative::SensitiveRead,
            McpToolPolicyNative::ExternalWrite => AgentEffectKindNative::ExternalSideEffect,
            McpToolPolicyNative::Disabled => {
                return Err("MCP tool is disabled by native policy".into())
            }
        };
        let canonical_name = format!("mcp::{server_id}::{tool_name}");
        let call = AgentToolCallNative {
            request_id: context.request.request_id.clone(),
            call_id,
            tool_name: canonical_name.clone(),
            arguments,
            target: target.clone(),
            capability_id: "pending-native-capability".into(),
        };
        let effect = AgentObservedEffectNative {
            kind: effect_kind,
            target_id: target.target_id().to_string(),
            summary: format!("Native policy classified {canonical_name} as {effect_kind:?}."),
            paths: Vec::new(),
            network_destinations: Vec::new(),
        };
        Ok(PreparedMcpAuthorizationNative {
            native_prompt: format!(
                "Allow {} for Session task {} / turn {} / step {}?\n\nThe MCP server starts only after approval. Its output is untrusted.",
                canonical_name,
                context.request.task_id,
                context.turn_id,
                context.step_id,
            ),
            context,
            call,
            server,
            tool_name: tool_name.to_string(),
            workspace_root,
            effect,
            ttl_ms: DEFAULT_CAPABILITY_TTL_MS,
        })
    }

    pub(crate) fn issue_prepared_mcp_authorization(
        &self,
        prepared: &PreparedMcpAuthorizationNative,
        approved: bool,
    ) -> Result<AgentCapabilityGrantNative, String> {
        if !approved {
            return Err("native MCP capability approval was denied".into());
        }
        let IssuedCapabilityNative {
            capability_id,
            expires_at_unix_ms: _,
        } = self
            .capabilities
            .issue(
                CapabilityIssueRequestNative {
                    request_id: prepared.context.request.request_id.clone(),
                    user_session_id: prepared.context.request.user_session_id.clone(),
                    call_id: prepared.call.call_id.clone(),
                    call_digest: call_digest(&prepared.call)?,
                    allowed_tools: vec![prepared.call.tool_name.clone()],
                    allowed_effects: vec![prepared.effect.kind],
                    target_ids: vec![prepared.call.target.target_id().to_string()],
                    ttl_ms: prepared.ttl_ms,
                    max_uses: 1,
                },
                current_unix_ms(),
            )
            .map_err(|error| format!("native MCP capability issuance failed: {error:?}"))?;
        Ok(AgentCapabilityGrantNative {
            capability_id,
            effective_arguments: prepared.call.arguments.clone(),
        })
    }

    pub(crate) fn execute_mcp_call(
        &self,
        prepared: &PreparedMcpAuthorizationNative,
        capability_id: String,
        credentials: &CredentialManager,
    ) -> Result<AgentToolResultNative, String> {
        let mut call = prepared.call.clone();
        call.capability_id = capability_id;
        self.capabilities
            .verify_bound_scope(
                &call.capability_id,
                AgentCapabilityVerificationContextNative {
                    request_id: &prepared.context.request.request_id,
                    user_session_id: &prepared.context.request.user_session_id,
                    call_id: &call.call_id,
                    target_id: call.target.target_id(),
                },
                &call_digest(&call)?,
                &call.tool_name,
                prepared.effect.kind,
                current_unix_ms(),
            )
            .map_err(|error| format!("native MCP capability verification failed: {error:?}"))?;
        self.capabilities
            .consume(&call.capability_id, current_unix_ms())
            .map_err(|error| format!("native MCP capability consumption failed: {error:?}"))?;
        let (data, truncated) = execute_mcp_tool_native(
            &prepared.server,
            &prepared.workspace_root,
            credentials,
            &prepared.tool_name,
            &call.arguments,
        )?;
        let failed = data.get("isError").and_then(Value::as_bool) == Some(true);
        Ok(AgentToolResultNative {
            request_id: prepared.context.request.request_id.clone(),
            call_id: call.call_id,
            tool_name: call.tool_name,
            target_id: call.target.target_id().to_string(),
            status: if failed {
                AgentToolResultStatusNative::Failed
            } else {
                AgentToolResultStatusNative::Completed
            },
            summary: if failed {
                "MCP tool returned an untrusted error.".into()
            } else {
                "MCP tool completed; returned data is untrusted.".into()
            },
            data: Some(data),
            artifacts: Vec::new(),
            effects: vec![prepared.effect.clone()],
            truncated: Some(truncated),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn execute_tool(
        &self,
        context: &NativeExecutionContext,
        call: AgentToolCallNative,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<AgentToolResultNative, String> {
        context.validate()?;
        if call.request_id != context.request.request_id
            || !context
                .request
                .targets
                .iter()
                .any(|target| target == &call.target)
        {
            return Err("dispatch target is outside the frozen Agent Session request".into());
        }
        let tool = self
            .registry
            .executable(&call.tool_name)
            .map_err(registry_error_message)?;
        self.revalidate_target(context, &call.target, sessions, database)?;
        let effect = assess_effect_native(&tool.descriptor, &call)?;
        let scope = inspect_call_policy_scope_native(&call)?;
        enforce_native_call_policy_native(&call, &effect, &scope)?;
        let capability = self
            .capabilities
            .verify_bound_call(
                &call.capability_id,
                AgentCapabilityVerificationContextNative {
                    request_id: &context.request.request_id,
                    user_session_id: &context.request.user_session_id,
                    call_id: &call.call_id,
                    target_id: call.target.target_id(),
                },
                &call_digest(&call)?,
                current_unix_ms(),
            )
            .map_err(|error| format!("native capability verification failed: {error:?}"))?;
        let decision = NativeContractPolicyEngine.evaluate(AgentPolicyEvaluationNative {
            request: &context.request,
            call: &call,
            assessed_effect: Some(&effect),
            capability: Some(&capability),
            now_unix_ms: current_unix_ms(),
        });
        if decision.outcome != AgentPolicyOutcomeNative::Allow {
            return Err(format!(
                "native contract policy denied dispatch: {:?}",
                decision.reason
            ));
        }
        self.capabilities
            .consume(&call.capability_id, current_unix_ms())
            .map_err(|error| format!("native capability consumption failed: {error:?}"))?;

        match call.tool_name.as_str() {
            "exec_command" => self.execute_command(
                context,
                &call,
                &effect,
                sessions,
                database,
                credentials,
                known_hosts_path,
                tool.descriptor.default_timeout_ms,
                tool.descriptor.max_concurrency,
            ),
            "write_stdin" => self.write_process(context, &call, &effect),
            "wait_process" => self.wait_process(context, &call, &effect),
            "kill_process" => self.kill_process(context, &call, &effect),
            "read_file" | "list_directory" | "search_text" | "apply_patch" | "transfer_file" => {
                self.execute_file_tool(
                    context,
                    &call,
                    &effect,
                    database,
                    credentials,
                    known_hosts_path,
                )
            }
            _ => Err("tool is outside the native execution kernel".into()),
        }
    }

    pub(crate) fn cancel_task(
        &self,
        task_id: &str,
        sessions: &SessionManager,
    ) -> Result<(), String> {
        self.file_operations.cancel_task(task_id)?;
        self.processes.cancel_task(task_id)?;
        self.pty.cancel_task(sessions, task_id);
        Ok(())
    }

    pub(crate) fn observe_pty_output(&self, session_id: &str, chunk: &str) {
        self.pty.observe(session_id, chunk);
    }

    pub(crate) fn prepare_for_shutdown(&self, sessions: &SessionManager) -> Result<usize, String> {
        let mut cancelled = 0;
        for task_id in self.processes.owner_task_ids()? {
            self.cancel_task(&task_id, sessions)?;
            cancelled += 1;
        }
        Ok(cancelled)
    }

    fn checkpoint_root(&self) -> Result<PathBuf, String> {
        self.checkpoint_root
            .lock()
            .map_err(|_| "native checkpoint root is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "native checkpoint root was not configured".into())
    }

    fn revalidate_target(
        &self,
        context: &NativeExecutionContext,
        target: &AgentToolTargetNative,
        sessions: &SessionManager,
        database: &Database,
    ) -> Result<(), String> {
        match target {
            AgentToolTargetNative::Local { session_id, .. } => {
                let state = sessions.target_state(session_id)?;
                if state.terminal_kind != SessionTerminalKind::Local
                    || state.status != SessionStatus::Connected
                    || state.identity.host != "local"
                {
                    return Err("local target no longer matches its frozen Session identity".into());
                }
                Ok(())
            }
            AgentToolTargetNative::Remote {
                session_id,
                profile_id,
                host,
                port,
                username,
                ..
            } => {
                let state = sessions.target_state(session_id)?;
                if state.terminal_kind != SessionTerminalKind::Remote
                    || state.status != SessionStatus::Connected
                    || state.identity.host != *host
                    || state.identity.port != *port
                    || state.identity.username != *username
                {
                    return Err(
                        "remote target no longer matches its frozen Session identity".into(),
                    );
                }
                if let Some(profile_id) = profile_id {
                    let profile = database
                        .get_profile(profile_id)?
                        .ok_or_else(|| "frozen remote profile was not found".to_string())?;
                    if profile.host != *host
                        || profile.port != *port
                        || profile.username != *username
                    {
                        return Err("stored remote profile drifted from the frozen target".into());
                    }
                }
                Ok(())
            }
            AgentToolTargetNative::Process {
                target_id,
                owner_target_id,
                process_handle,
            } => {
                let snapshot = self.processes.get(process_handle)?.snapshot()?;
                if snapshot.target_id != *target_id
                    || snapshot.owner_target_id != *owner_target_id
                    || snapshot.request_id != context.request.request_id
                    || snapshot.task_id != context.request.task_id
                {
                    return Err("process handle does not match its frozen Session owner".into());
                }
                Ok(())
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_command(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        default_timeout_ms: u64,
        max_concurrency: u16,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: ExecCommandArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid exec_command arguments: {error}"))?;
        if arguments.elevated.unwrap_or(false) {
            return Err("elevated execution is unavailable in the native kernel".into());
        }
        let timeout = Duration::from_millis(arguments.timeout_ms.unwrap_or(default_timeout_ms));
        if arguments.channel == AgentExecutionChannelNative::Pty {
            if arguments.background.unwrap_or(false) {
                return Err("Native PTY execution cannot detach".into());
            }
            let session_id = match &call.target {
                AgentToolTargetNative::Local { session_id, .. }
                | AgentToolTargetNative::Remote { session_id, .. } => session_id,
                _ => return Err("PTY execution requires a terminal target".into()),
            };
            let operation = self.pty.start(
                sessions,
                session_id,
                &context.request.task_id,
                &arguments.command,
                matches!(call.target, AgentToolTargetNative::Local { .. })
                    && cfg!(target_os = "windows"),
            )?;
            let snapshot = operation.wait(timeout)?;
            if snapshot.state == PtyLifecycleNative::TimedOut {
                self.pty
                    .interrupt(sessions, session_id, PtyLifecycleNative::TimedOut);
            }
            self.pty.remove(session_id)?;
            return Ok(AgentToolResultNative {
                request_id: context.request.request_id.clone(),
                call_id: call.call_id.clone(),
                tool_name: call.tool_name.clone(),
                target_id: call.target.target_id().to_string(),
                status: match snapshot.state {
                    PtyLifecycleNative::Exited => AgentToolResultStatusNative::Completed,
                    PtyLifecycleNative::Cancelled => AgentToolResultStatusNative::Cancelled,
                    PtyLifecycleNative::TimedOut => AgentToolResultStatusNative::TimedOut,
                    PtyLifecycleNative::Failed | PtyLifecycleNative::Running => {
                        AgentToolResultStatusNative::Failed
                    }
                },
                summary: snapshot
                    .error
                    .unwrap_or_else(|| format!("PTY command reached {:?}.", snapshot.state)),
                data: Some(json!({
                    "channel": "pty",
                    "state": "exited",
                    "exitCode": snapshot.exit_code,
                    "stdout": "",
                    "stderr": "",
                    "combinedOutput": snapshot.combined_output,
                    "truncated": snapshot.truncated,
                })),
                artifacts: Vec::new(),
                effects: vec![effect.clone()],
                truncated: Some(snapshot.truncated),
            });
        }

        if self.processes.running_count()? >= max_concurrency as usize {
            return Err("exec_command native concurrency limit was reached".into());
        }
        self.processes.ensure_capacity()?;
        validate_frozen_cwd(&call.target, arguments.cwd.as_deref())?;
        let process = match &call.target {
            AgentToolTargetNative::Local { target_id, cwd, .. } => spawn_local_process_native(
                context.request.task_id.clone(),
                context.request.request_id.clone(),
                target_id.clone(),
                &arguments.command,
                cwd.as_deref().map(Path::new),
                timeout,
            )?,
            AgentToolTargetNative::Remote { target_id, .. } => {
                let connection = connection_for_remote_target(&call.target, database, credentials)?;
                spawn_remote_process_native(RemoteProcessStartNative {
                    task_id: context.request.task_id.clone(),
                    request_id: context.request.request_id.clone(),
                    owner_target_id: target_id.clone(),
                    command: arguments.command,
                    connection,
                    known_hosts_path: known_hosts_path.to_path_buf(),
                    timeout,
                })?
            }
            _ => return Err("Direct Exec requires a local or remote target".into()),
        };
        self.processes.insert(Arc::clone(&process))?;
        let background = arguments.background.unwrap_or(false);
        let snapshot = if background {
            process.snapshot()?
        } else {
            process.wait(timeout.saturating_add(Duration::from_secs(1)))?
        };
        if !background {
            self.processes
                .remove_terminal(&snapshot.process_handle, snapshot.state)?;
        }
        Ok(exec_process_result(
            &context.request,
            call,
            effect,
            snapshot,
            background,
        ))
    }

    fn write_process(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: WriteStdinArgumentsNative =
            serde_json::from_value(call.arguments.clone())
                .map_err(|error| format!("invalid write_stdin arguments: {error}"))?;
        let accepted = self
            .processes
            .get(process_handle(&call.target)?)?
            .write_stdin(arguments.input, arguments.close.unwrap_or(false))?;
        Ok(completed_result(
            &context.request,
            call,
            effect,
            "Process input was accepted.",
            json!({ "acceptedBytes": accepted, "closed": arguments.close.unwrap_or(false) }),
            false,
        ))
    }

    fn wait_process(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: WaitProcessArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid wait_process arguments: {error}"))?;
        let handle = process_handle(&call.target)?;
        let snapshot = self.processes.get(handle)?.wait(Duration::from_millis(
            arguments.timeout_ms.unwrap_or(30_000),
        ))?;
        self.processes.remove_terminal(handle, snapshot.state)?;
        let limit = arguments.max_output_bytes.unwrap_or(1_048_576) as usize;
        let (stdout, stdout_cut) = truncate_utf8(&snapshot.stdout, limit.saturating_mul(3) / 4);
        let (stderr, stderr_cut) = truncate_utf8(&snapshot.stderr, limit / 4);
        let truncated =
            snapshot.stdout_truncated || snapshot.stderr_truncated || stdout_cut || stderr_cut;
        Ok(completed_result(
            &context.request,
            call,
            effect,
            if snapshot.state == ProcessLifecycleNative::Running {
                "Process is still running."
            } else {
                "Process reached a terminal state."
            },
            json!({
                "state": if snapshot.state == ProcessLifecycleNative::Running { "running" } else { "exited" },
                "exitCode": snapshot.exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "truncated": truncated,
            }),
            truncated,
        ))
    }

    fn kill_process(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: KillProcessArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid kill_process arguments: {error}"))?;
        let handle = process_handle(&call.target)?;
        let snapshot = self.processes.get(handle)?.kill(
            arguments.signal,
            Duration::from_millis(arguments.timeout_ms.unwrap_or(10_000)),
        )?;
        self.processes.remove_terminal(handle, snapshot.state)?;
        Ok(completed_result(
            &context.request,
            call,
            effect,
            "Process termination request was handled.",
            json!({ "state": format!("{:?}", snapshot.state) }),
            false,
        ))
    }

    fn execute_file_tool(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<AgentToolResultNative, String> {
        let checkpoint_root = self.checkpoint_root()?;
        let output = execute_file_tool_native(FileExecutionContextNative {
            task_id: &context.request.task_id,
            call,
            database,
            credentials,
            known_hosts_path,
            checkpoint_root: &checkpoint_root,
            checkpoints: &self.checkpoints,
            operations: &self.file_operations,
        })?;
        let mut observed = effect.clone();
        observed.paths = output.paths;
        Ok(completed_result(
            &context.request,
            call,
            &observed,
            &output.summary,
            output.data,
            output.truncated,
        ))
    }
}

fn native_prompt(
    context: &NativeExecutionContext,
    call: &AgentToolCallNative,
    effect: &AgentObservedEffectNative,
    scope: &super::CallPolicyScopeNative,
    preview: &AgentCallPreviewNative,
    ttl_ms: u64,
) -> String {
    let network = if scope.network_destinations.is_empty() {
        "none".to_string()
    } else {
        scope
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
    let exact_diff = preview
        .diff
        .as_deref()
        .map(|diff| format!("\n\nExact diff:\n{diff}"))
        .unwrap_or_default();
    format!(
        "Allow {} on {} for Session task {} / turn {} / step {}?\n\nNative effect: {:?}\nSensitive paths: {}\nNetwork destinations: {}\nTTL: {} ms\n{}{}",
        call.tool_name,
        call.target.target_id(),
        context.request.task_id,
        context.turn_id,
        context.step_id,
        effect.kind,
        scope.sensitive_path_count,
        network,
        ttl_ms,
        preview.summary,
        exact_diff,
    )
}

fn registry_error_message(error: ToolRegistryErrorNative) -> String {
    match error {
        ToolRegistryErrorNative::UnregisteredTool => "tool is not registered".into(),
        ToolRegistryErrorNative::ToolUnavailable => {
            "tool is not implemented by the native kernel".into()
        }
        _ => "native tool registry rejected the tool".into(),
    }
}

fn call_digest(call: &AgentToolCallNative) -> Result<String, String> {
    let bytes = serde_json::to_vec(&(
        call.request_id.as_str(),
        call.call_id.as_str(),
        call.tool_name.as_str(),
        &call.arguments,
        &call.target,
    ))
    .map_err(|error| format!("failed to digest native call: {error}"))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        Err(format!("invalid native {label}"))
    } else {
        Ok(())
    }
}

fn process_handle(target: &AgentToolTargetNative) -> Result<&str, String> {
    match target {
        AgentToolTargetNative::Process { process_handle, .. } => Ok(process_handle),
        _ => Err("tool requires a frozen process target".into()),
    }
}

fn validate_frozen_cwd(
    target: &AgentToolTargetNative,
    argument_cwd: Option<&str>,
) -> Result<(), String> {
    match target {
        AgentToolTargetNative::Local { cwd, .. } if cwd.as_deref() != argument_cwd => {
            Err("exec_command cwd differs from the frozen target".into())
        }
        AgentToolTargetNative::Remote { .. } if argument_cwd.is_some() => {
            Err("Native remote Direct Exec does not accept an unfrozen cwd".into())
        }
        _ => Ok(()),
    }
}

pub(super) fn connection_for_remote_target(
    target: &AgentToolTargetNative,
    database: &Database,
    credentials: &CredentialManager,
) -> Result<RemoteConnectionRequest, String> {
    let AgentToolTargetNative::Remote {
        profile_id: Some(profile_id),
        host,
        port,
        username,
        ..
    } = target
    else {
        return Err("remote execution requires a frozen profile id".into());
    };
    let profile = database
        .get_profile(profile_id)?
        .ok_or_else(|| "remote execution profile was not found".to_string())?;
    if profile.host != *host || profile.port != *port || profile.username != *username {
        return Err("remote execution profile identity drifted".into());
    }
    let auth_method = match profile.auth_method {
        ProfileAuthMethod::Password => AuthMethod::Password,
        ProfileAuthMethod::Key => AuthMethod::Key,
    };
    let mut jump_host = profile
        .jump_host_config
        .as_deref()
        .map(serde_json::from_str::<JumpHostConfig>)
        .transpose()
        .map_err(|error| format!("stored jump-host identity is invalid: {error}"))?;
    if let Some(jump) = jump_host.as_mut() {
        match jump.auth_method {
            AuthMethod::Password => {
                jump.password = credentials
                    .retrieve_profile_secret(profile_id, ProfileSecretKind::JumpPassword)?;
                if jump.password.is_none() {
                    return Err("jump-host password is unavailable".into());
                }
            }
            AuthMethod::Key => {
                jump.passphrase = credentials
                    .retrieve_profile_secret(profile_id, ProfileSecretKind::JumpPassphrase)?;
            }
        }
    }
    let mut connection = RemoteConnectionRequest {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        auth_method,
        password: if auth_method == AuthMethod::Password {
            credentials.retrieve_profile_password(profile_id)?
        } else {
            None
        },
        keychain_key_id: profile.keychain_key_id,
        private_key_data: None,
        passphrase: if auth_method == AuthMethod::Key {
            credentials.retrieve_profile_secret(profile_id, ProfileSecretKind::Passphrase)?
        } else {
            None
        },
        jump_host,
    };
    if auth_method == AuthMethod::Password && connection.password.is_none() {
        return Err("remote profile password is unavailable".into());
    }
    crate::commands::resolve_keychain_key_for_remote(credentials, &mut connection)?;
    if auth_method == AuthMethod::Key && connection.private_key_data.is_none() {
        return Err("remote profile private key is unavailable".into());
    }
    Ok(connection)
}

fn exec_process_result(
    request: &AgentRequestNative,
    call: &AgentToolCallNative,
    effect: &AgentObservedEffectNative,
    snapshot: ProcessSnapshotNative,
    background: bool,
) -> AgentToolResultNative {
    let status = if background && snapshot.state == ProcessLifecycleNative::Running {
        AgentToolResultStatusNative::Completed
    } else {
        match snapshot.state {
            ProcessLifecycleNative::Running | ProcessLifecycleNative::Failed => {
                AgentToolResultStatusNative::Failed
            }
            ProcessLifecycleNative::Exited => AgentToolResultStatusNative::Completed,
            ProcessLifecycleNative::Cancelled => AgentToolResultStatusNative::Cancelled,
            ProcessLifecycleNative::TimedOut => AgentToolResultStatusNative::TimedOut,
        }
    };
    let truncated = snapshot.stdout_truncated || snapshot.stderr_truncated;
    AgentToolResultNative {
        request_id: request.request_id.clone(),
        call_id: call.call_id.clone(),
        tool_name: call.tool_name.clone(),
        target_id: call.target.target_id().to_string(),
        status,
        summary: snapshot.error.unwrap_or_else(|| {
            if snapshot.state == ProcessLifecycleNative::Running {
                "Direct command is running under a native process handle.".into()
            } else {
                format!("Direct command reached {:?}.", snapshot.state)
            }
        }),
        data: Some(json!({
            "channel": "direct",
            "state": if snapshot.state == ProcessLifecycleNative::Running { "running" } else { "exited" },
            "exitCode": snapshot.exit_code,
            "stdout": snapshot.stdout,
            "stderr": snapshot.stderr,
            "processHandle": snapshot.process_handle,
            "durationMs": snapshot.completed_at_unix_ms.unwrap_or_else(current_unix_ms)
                .saturating_sub(snapshot.started_at_unix_ms),
            "truncated": truncated,
        })),
        artifacts: Vec::new(),
        effects: vec![effect.clone()],
        truncated: Some(truncated),
    }
}

fn completed_result(
    request: &AgentRequestNative,
    call: &AgentToolCallNative,
    effect: &AgentObservedEffectNative,
    summary: &str,
    data: Value,
    truncated: bool,
) -> AgentToolResultNative {
    AgentToolResultNative {
        request_id: request.request_id.clone(),
        call_id: call.call_id.clone(),
        tool_name: call.tool_name.clone(),
        target_id: call.target.target_id().to_string(),
        status: AgentToolResultStatusNative::Completed,
        summary: summary.into(),
        data: Some(data),
        artifacts: Vec::new(),
        effects: vec![effect.clone()],
        truncated: Some(truncated),
    }
}

fn truncate_utf8(value: &str, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value.to_string(), false);
    }
    let mut boundary = limit;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    (value[..boundary].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_context_is_call_scoped_and_rejects_missing_step_identity() {
        let context = NativeExecutionContext {
            request: AgentRequestNative {
                contract_version: crate::agent_runtime::NATIVE_TOOL_CONTRACT_VERSION,
                request_id: "request-a".into(),
                user_session_id: "session-a".into(),
                task_id: "task-a".into(),
                goal: "Inspect the workspace".into(),
                success_criteria: vec!["Return evidence".into()],
                targets: vec![AgentToolTargetNative::Local {
                    target_id: "target-a".into(),
                    session_id: "terminal-a".into(),
                    cwd: Some("/tmp".into()),
                }],
                permission_mode: AgentPermissionModeNative::RequestApproval,
            },
            turn_id: "turn-a".into(),
            step_id: String::new(),
        };
        assert_eq!(context.validate(), Err("invalid native step id".into()));
    }
}
