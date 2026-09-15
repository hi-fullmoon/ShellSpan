//! Native safe-execution kernel.
//!
//! Agent lifecycle, plans, recovery, notifications, and Fleet orchestration are
//! owned by the Session runtime. This module receives one immutable call
//! context and owns only safety validation plus the operating-system effect.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::{
    validate_agent_request_native, validate_tool_arguments_native,
    AgentCapabilityVerificationContextNative, AgentEffectKindNative, AgentExecutionChannelNative,
    AgentObservedEffectNative, AgentPermissionModeNative, AgentPolicyEngineNative,
    AgentPolicyEvaluationNative, AgentPolicyOutcomeNative, AgentRequestNative, AgentToolCallNative,
    AgentToolResultNative, AgentToolResultStatusNative, AgentToolTargetNative,
    ExecCommandArgumentsNative, KillProcessArgumentsNative, NativeContractPolicyEngine,
    ReadTerminalArgumentsNative, TerminalExecuteArgumentsNative, WaitProcessArgumentsNative,
    WaitTerminalArgumentsNative, WriteStdinArgumentsNative, WriteTerminalInputArgumentsNative,
};
use crate::db::Database;
use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::{
    AuthMethod, JumpHostConfig, ProfileAuthMethod, RemoteConnectionRequest, SessionManager,
    SessionStatus, SessionTerminalKind,
};
use crate::terminal_broker::{
    TerminalBrokerAttachment, TerminalBrokerSnapshot, TerminalGenerationCloseReason,
    TerminalGeometry, TerminalRawOutputFrame, TerminalSessionBroker, TerminalTransportKind,
    TerminalVisibleCommandRoute, TerminalWaitReason,
};
use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};

use super::{
    assess_effect_native, configured_tool_policy_native, current_unix_ms,
    enforce_native_call_policy_native, execute_file_tool_native, execute_mcp_tool_native,
    inspect_call_policy_scope_native, load_mcp_server_native, preview_file_call_native,
    spawn_local_process_native, spawn_remote_process_native, AgentCallPreviewNative,
    CapabilityIssueRequestNative, CheckpointStoreNative, FileExecutionContextNative,
    FileOperationRegistryNative, IssuedCapabilityNative, McpServerConfigNative,
    McpToolPolicyNative, NativeCapabilityStoreNative, ProcessLifecycleNative,
    ProcessRegistryNative, ProcessSnapshotNative, PtyLifecycleNative, PtyRegistryNative,
    PtyShellKindNative, RegisteredToolNative, RemoteProcessStartNative, TerminalExecuteRegistry,
    TerminalInputSource, TerminalInteractiveRegistry, TerminalLeaseManager,
    TerminalLeaseReleaseReason, ToolRegistryErrorNative, ToolRegistryNative,
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
    terminal_execute: TerminalExecuteRegistry,
    terminal_interactive: TerminalInteractiveRegistry,
    terminal_leases: TerminalLeaseManager,
    terminal_broker: TerminalSessionBroker,
    checkpoints: CheckpointStoreNative,
    file_operations: FileOperationRegistryNative,
    checkpoint_root: Arc<Mutex<Option<PathBuf>>>,
}

impl Default for NativeToolEngine {
    fn default() -> Self {
        let terminal_broker = TerminalSessionBroker::default();
        let terminal_leases = TerminalLeaseManager::new(terminal_broker.clone());
        let terminal_execute =
            TerminalExecuteRegistry::new(terminal_leases.clone(), terminal_broker.clone());
        let terminal_interactive =
            TerminalInteractiveRegistry::new(terminal_leases.clone(), terminal_broker.clone());
        Self {
            registry: Arc::new(
                ToolRegistryNative::from_builtin_manifest().expect("valid native tool manifest"),
            ),
            capabilities: NativeCapabilityStoreNative::default(),
            processes: ProcessRegistryNative::default(),
            pty: PtyRegistryNative::new(terminal_leases.clone()),
            terminal_execute,
            terminal_interactive,
            terminal_leases,
            terminal_broker,
            checkpoints: CheckpointStoreNative::default(),
            file_operations: FileOperationRegistryNative::default(),
            checkpoint_root: Arc::new(Mutex::new(None)),
        }
    }
}

impl NativeToolEngine {
    pub(crate) fn configure_terminal_broker_rollout(&self) -> Result<(), String> {
        self.terminal_broker.configure_from_trusted_environment()?;
        if !self.terminal_broker.interactive_tools_enabled()? {
            self.terminal_interactive.shutdown_all()?;
        }
        Ok(())
    }

    pub(crate) fn attach_terminal_broker_transport(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        self.terminal_broker.attach_transport(
            transport_session_id,
            predecessor_transport_session_id,
            transport_kind,
            geometry,
        )
    }

    pub(crate) fn attach_agent_ssh_terminal_broker_candidate(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        geometry: TerminalGeometry,
        owner: crate::terminal_broker::TerminalAgentPtyOwner,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        self.terminal_broker.attach_agent_ssh_candidate_transport(
            transport_session_id,
            predecessor_transport_session_id,
            geometry,
            owner,
        )
    }

    pub(crate) fn promote_agent_ssh_terminal_broker_candidate<T>(
        &self,
        transport_session_id: &str,
        expected_predecessor_transport_session_id: Option<&str>,
        publish: impl FnOnce(TerminalBrokerAttachment) -> Result<T, String>,
    ) -> Result<T, String> {
        self.terminal_broker.promote_agent_ssh_candidate_transport(
            transport_session_id,
            expected_predecessor_transport_session_id,
            publish,
        )
    }

    pub(crate) fn abort_agent_ssh_terminal_broker_candidate(
        &self,
        transport_session_id: &str,
    ) -> Result<bool, String> {
        self.terminal_broker
            .abort_agent_ssh_candidate_transport(transport_session_id)
    }

    pub(crate) fn terminal_broker_attachment(
        &self,
        transport_session_id: &str,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        self.terminal_broker
            .attachment_for_transport(transport_session_id)
    }

    pub(crate) fn observe_terminal_raw_output(
        &self,
        transport_session_id: &str,
        bytes: &[u8],
    ) -> Result<Option<TerminalRawOutputFrame>, String> {
        self.terminal_broker
            .observe_raw_output(transport_session_id, bytes)
    }

    pub(crate) fn close_terminal_broker_transport(
        &self,
        transport_session_id: &str,
        reason: TerminalGenerationCloseReason,
    ) -> Result<bool, String> {
        self.terminal_broker
            .close_transport(transport_session_id, reason)
    }

    pub(crate) fn resize_terminal_broker(
        &self,
        transport_session_id: &str,
        geometry: TerminalGeometry,
    ) -> Result<(), String> {
        self.terminal_broker.resize(transport_session_id, geometry)
    }

    pub(crate) fn mark_terminal_broker_output_ready(
        &self,
        transport_session_id: &str,
    ) -> Result<(), String> {
        self.terminal_broker.mark_output_ready(transport_session_id)
    }

    pub(crate) fn set_terminal_broker_output_paused(
        &self,
        transport_session_id: &str,
        paused: bool,
    ) -> Result<(), String> {
        self.terminal_broker
            .set_output_paused(transport_session_id, paused)
    }

    pub(crate) fn terminal_broker_snapshot(
        &self,
        transport_session_id: Option<&str>,
    ) -> Result<TerminalBrokerSnapshot, String> {
        self.terminal_broker.snapshot(transport_session_id)
    }

    pub(crate) fn terminal_shell_integration_enabled(&self) -> Result<bool, String> {
        self.terminal_broker.shell_integration_enabled()
    }

    pub(crate) fn terminal_visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.terminal_broker
            .visible_command_route(transport_session_id)
    }

    pub(crate) fn terminal_remote_visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.terminal_broker
            .remote_visible_command_route(transport_session_id)
    }

    pub(crate) fn remote_agent_pty_new_operation_route(
        &self,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.terminal_broker.remote_agent_pty_new_operation_route()
    }

    pub(crate) fn register_terminal_integration_channel(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        shell: TerminalShellKind,
    ) -> Result<(), String> {
        self.terminal_broker.register_integration_channel(
            transport_session_id,
            integration_id,
            shell,
        )
    }

    pub(crate) fn accept_terminal_integration_event(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        event: TerminalIntegrationControlEvent,
    ) -> Result<(), String> {
        self.terminal_broker
            .accept_integration_event(transport_session_id, integration_id, event)
    }

    pub(crate) fn terminal_integration_channel_closed(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.terminal_broker.integration_channel_closed(
            transport_session_id,
            integration_id,
            reason,
        )
    }

    pub(crate) fn mark_terminal_integration_degraded(
        &self,
        transport_session_id: &str,
        shell: TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.terminal_broker
            .mark_integration_degraded(transport_session_id, shell, reason)
    }

    pub(crate) fn mark_terminal_integration_unavailable(
        &self,
        transport_session_id: &str,
        shell: TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.terminal_broker
            .mark_integration_unavailable(transport_session_id, shell, reason)
    }

    pub(crate) fn has_terminal_lease(&self, session_id: &str) -> Result<bool, String> {
        self.terminal_leases.has_lease(session_id)
    }

    pub(crate) fn release_terminal_turn(&self, agent_session_id: &str) -> Result<(), String> {
        self.terminal_interactive.release_turn(agent_session_id)?;
        self.terminal_leases.release_turn(agent_session_id)
    }

    pub(crate) fn begin_terminal_turn(
        &self,
        terminal_session_id: &str,
        agent_session_id: &str,
    ) -> Result<(), String> {
        self.terminal_leases
            .begin_turn(terminal_session_id, agent_session_id)
    }

    pub(crate) fn set_terminal_lease_publisher(
        &self,
        publisher: Arc<dyn Fn(&super::AgentTerminalLeaseEvent) + Send + Sync>,
    ) -> Result<(), String> {
        self.terminal_leases.set_publisher(publisher)
    }

    pub(crate) fn write_user_terminal_input(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        data: String,
    ) -> Result<(), String> {
        self.terminal_leases
            .write(sessions, session_id, data, TerminalInputSource::User)
    }

    pub(crate) fn acknowledge_terminal_lease_ready(
        &self,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
        terminal_connected: bool,
        output_listener_ready: bool,
        has_pending_user_input: bool,
        has_unverified_user_submission: bool,
        has_credential_prompt: bool,
    ) -> Result<bool, String> {
        self.terminal_leases.acknowledge_frontend_ready(
            session_id,
            agent_session_id,
            operation_id,
            terminal_connected,
            output_listener_ready,
            has_pending_user_input,
            has_unverified_user_submission,
            has_credential_prompt,
        )
    }

    pub(crate) fn takeover_terminal(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        if self.terminal_interactive.has_operation(session_id)? {
            self.terminal_interactive
                .takeover(sessions, session_id, agent_session_id, operation_id)
        } else if self.terminal_execute.has_operation(session_id)? {
            self.terminal_execute
                .takeover(sessions, session_id, agent_session_id, operation_id)
        } else {
            self.pty
                .takeover(sessions, session_id, agent_session_id, operation_id)
        }
    }

    pub(crate) fn terminal_closed(&self, session_id: &str) -> Result<bool, String> {
        let interactive = self.terminal_interactive.terminal_closed(session_id)?;
        let visible = self.terminal_execute.terminal_closed(session_id)?;
        let legacy = self.pty.terminal_closed(session_id)?;
        Ok(interactive || visible || legacy)
    }

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
        let requires_native_confirmation = requires_native_confirmation(
            context.request.permission_mode,
            effect.kind,
            scope.sensitive_path_count,
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
        cancellation: &tokio_util::sync::CancellationToken,
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
            cancellation,
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
        cancellation: &CancellationToken,
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
            "terminal_execute" => self.execute_terminal_command(
                context,
                &call,
                &effect,
                sessions,
                tool.descriptor.default_timeout_ms,
            ),
            "read_terminal" => self.read_terminal(context, &call, &effect, sessions),
            "write_terminal_input" => self.write_terminal_input(context, &call, &effect, sessions),
            "wait_terminal" => self.wait_terminal(
                context,
                &call,
                &effect,
                sessions,
                tool.descriptor.default_timeout_ms,
                cancellation,
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
        let mut errors = Vec::new();
        if let Err(error) = self.file_operations.cancel_task(task_id) {
            errors.push(error);
        }
        if let Err(error) = self.processes.cancel_task(task_id) {
            errors.push(error);
        }
        if let Err(error) = self.pty.cancel_task(sessions, task_id) {
            errors.push(error);
        }
        if let Err(error) = self.terminal_execute.cancel_task(sessions, task_id) {
            errors.push(error);
        }
        if let Err(error) = self.terminal_interactive.cancel_task(sessions, task_id) {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub(crate) fn observe_pty_output(&self, session_id: &str, chunk: &str) -> String {
        self.pty.observe(session_id, chunk)
    }

    pub(crate) fn prepare_for_shutdown(&self, sessions: &SessionManager) -> Result<usize, String> {
        let mut cancelled = 0;
        let mut errors = Vec::new();
        match self.processes.owner_task_ids() {
            Ok(task_ids) => {
                for task_id in task_ids {
                    if let Err(error) = self.file_operations.cancel_task(&task_id) {
                        errors.push(error);
                    }
                    if let Err(error) = self.processes.cancel_task(&task_id) {
                        errors.push(error);
                    }
                    cancelled += 1;
                }
            }
            Err(error) => errors.push(error),
        }
        match self.terminal_execute.shutdown_all(sessions) {
            Ok(count) => cancelled += count,
            Err(error) => errors.push(error),
        }
        match self.terminal_interactive.shutdown_all() {
            Ok(count) => cancelled += count,
            Err(error) => errors.push(error),
        }
        match self.pty.shutdown_all(sessions) {
            Ok(count) => cancelled += count,
            Err(error) => errors.push(error),
        }
        if let Err(error) = self.terminal_broker.shutdown() {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(cancelled)
        } else {
            Err(errors.join("; "))
        }
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
            let terminal_state = sessions.target_state(session_id)?;
            if !legacy_pty_wrapper_available(&terminal_state) {
                return Err(
                    "TERMINAL_LEGACY_WRAPPER_REMOVED_ON_WINDOWS: use terminal_execute or Direct execution"
                        .into(),
                );
            }
            let shell_kind = pty_shell_kind(&terminal_state)?;
            let operation = self.pty.start(
                sessions,
                session_id,
                &context.request.user_session_id,
                &context.request.task_id,
                &call.call_id,
                &arguments.command,
                shell_kind,
            )?;
            let snapshot = match operation.wait(timeout) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let _ = self.pty.complete(
                        session_id,
                        &context.request.user_session_id,
                        &context.request.task_id,
                        &call.call_id,
                        TerminalLeaseReleaseReason::Failed,
                    );
                    return Err(error);
                }
            };
            if snapshot.state == PtyLifecycleNative::TimedOut {
                self.pty
                    .interrupt_timed_out(sessions, session_id, &call.call_id)?;
            } else {
                let reason = match snapshot.state {
                    PtyLifecycleNative::Exited => TerminalLeaseReleaseReason::Completed,
                    PtyLifecycleNative::Cancelled => TerminalLeaseReleaseReason::Cancelled,
                    PtyLifecycleNative::TimedOut => TerminalLeaseReleaseReason::TimedOut,
                    PtyLifecycleNative::TakenOver => TerminalLeaseReleaseReason::TakenOver,
                    PtyLifecycleNative::Failed | PtyLifecycleNative::Running => {
                        TerminalLeaseReleaseReason::Failed
                    }
                };
                self.pty.complete(
                    session_id,
                    &context.request.user_session_id,
                    &context.request.task_id,
                    &call.call_id,
                    reason,
                )?;
            }
            let model_output = crate::redaction::redact_sensitive_text(&super::strip_ansi(
                &snapshot.combined_output,
            ));
            let summary = crate::redaction::redact_sensitive_text(
                &snapshot
                    .error
                    .clone()
                    .unwrap_or_else(|| format!("PTY command reached {:?}.", snapshot.state)),
            );
            let result_state = pty_lifecycle_wire_state(snapshot.state);
            return Ok(AgentToolResultNative {
                request_id: context.request.request_id.clone(),
                call_id: call.call_id.clone(),
                tool_name: call.tool_name.clone(),
                target_id: call.target.target_id().to_string(),
                status: match snapshot.state {
                    PtyLifecycleNative::Exited => AgentToolResultStatusNative::Completed,
                    PtyLifecycleNative::Cancelled => AgentToolResultStatusNative::Cancelled,
                    PtyLifecycleNative::TakenOver => AgentToolResultStatusNative::Cancelled,
                    PtyLifecycleNative::TimedOut => AgentToolResultStatusNative::TimedOut,
                    PtyLifecycleNative::Failed | PtyLifecycleNative::Running => {
                        AgentToolResultStatusNative::Failed
                    }
                },
                summary,
                data: Some(json!({
                    "channel": "pty",
                    "state": result_state,
                    "exitCode": snapshot.exit_code,
                    "stdout": "",
                    "stderr": "",
                    "combinedOutput": model_output,
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

    fn execute_terminal_command(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        default_timeout_ms: u64,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: TerminalExecuteArgumentsNative =
            serde_json::from_value(call.arguments.clone())
                .map_err(|error| format!("invalid terminal_execute arguments: {error}"))?;
        let dedicated_session_id;
        let session_id = match &call.target {
            AgentToolTargetNative::Local { session_id, .. } => session_id,
            AgentToolTargetNative::Remote {
                target_id,
                session_id: source_session_id,
                host,
                port,
                username,
                ..
            } => {
                let binding = sessions
                    .agent_remote_terminal(&context.request.user_session_id, target_id)?
                    .ok_or_else(|| {
                        "TERMINAL_EXECUTE_REQUIRES_DEDICATED_AGENT_SSH_PTY".to_string()
                    })?;
                if binding.owner.source_session_id != *source_session_id
                    || binding.state.terminal_kind != SessionTerminalKind::Remote
                    || binding.state.status != SessionStatus::Connected
                    || binding.state.identity.host != *host
                    || binding.state.identity.port != *port
                    || binding.state.identity.username != *username
                {
                    return Err("Agent SSH PTY no longer matches its frozen remote target".into());
                }
                dedicated_session_id = binding.session_id;
                &dedicated_session_id
            }
            _ => return Err("terminal_execute requires a terminal target".into()),
        };
        let broker_snapshot = self
            .terminal_broker
            .snapshot(Some(session_id))?
            .session
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        let shell = broker_snapshot
            .integration_shell
            .ok_or_else(|| "TERMINAL_INTEGRATION_SHELL_UNKNOWN".to_string())?;
        let operation = self.terminal_execute.start(
            sessions,
            session_id,
            &context.request.user_session_id,
            &context.request.task_id,
            &call.call_id,
            &arguments.command,
            shell.enter(),
        )?;
        let timeout = Duration::from_millis(arguments.timeout_ms.unwrap_or(default_timeout_ms));
        let snapshot = self
            .terminal_execute
            .wait(sessions, session_id, &operation, timeout)?;
        let model_output =
            crate::redaction::redact_sensitive_text(&super::strip_ansi(&snapshot.combined_output));
        let state = terminal_command_wire_state(snapshot.state);
        let summary = crate::redaction::redact_sensitive_text(&format!(
            "Visible terminal command reached {state}."
        ));
        Ok(AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: match snapshot.state {
                crate::terminal_broker::TerminalCommandState::Completed => {
                    AgentToolResultStatusNative::Completed
                }
                crate::terminal_broker::TerminalCommandState::Cancelled
                | crate::terminal_broker::TerminalCommandState::TakenOver => {
                    AgentToolResultStatusNative::Cancelled
                }
                crate::terminal_broker::TerminalCommandState::TimedOut => {
                    AgentToolResultStatusNative::TimedOut
                }
                crate::terminal_broker::TerminalCommandState::Uncertain => {
                    AgentToolResultStatusNative::Uncertain
                }
                crate::terminal_broker::TerminalCommandState::Submitted
                | crate::terminal_broker::TerminalCommandState::Running
                | crate::terminal_broker::TerminalCommandState::CancelRequested
                | crate::terminal_broker::TerminalCommandState::Failed => {
                    AgentToolResultStatusNative::Failed
                }
            },
            summary,
            data: Some(json!({
                "contractVersion": 1,
                "channel": "terminal",
                "state": state,
                "terminalSessionId": snapshot.terminal_session_id,
                "terminalGeneration": snapshot.terminal_generation,
                "operationId": snapshot.operation_id,
                "commandId": snapshot.command_id,
                "commandLine": snapshot.command_line,
                "exitCode": snapshot.exit_code,
                "cwd": snapshot.cwd,
                "stdout": "",
                "stderr": "",
                "combinedOutput": model_output,
                "captureStartSequence": snapshot.capture_start_sequence,
                "captureEndSequence": snapshot.capture_end_sequence,
                "truncated": snapshot.capture_truncated,
                "noAutoReplay": snapshot.no_auto_replay,
            })),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(snapshot.capture_truncated),
        })
    }

    fn read_terminal(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
    ) -> Result<AgentToolResultNative, String> {
        let _: ReadTerminalArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid read_terminal arguments: {error}"))?;
        let session_id = self.interactive_terminal_session_id(context, call, sessions)?;
        let snapshot = self.terminal_interactive.read(&session_id)?;
        let (snapshot, credential_like_prompt) = super::sanitize_terminal_screen(snapshot);
        Ok(AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: AgentToolResultStatusNative::Completed,
            summary: if credential_like_prompt {
                "Terminal screen was read with credential-like content redacted.".into()
            } else {
                "Terminal screen was read.".into()
            },
            data: Some(json!({
                "contractVersion": 1,
                "snapshot": snapshot,
                "credentialLikePrompt": credential_like_prompt,
            })),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(false),
        })
    }

    fn write_terminal_input(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: WriteTerminalInputArgumentsNative =
            serde_json::from_value(call.arguments.clone())
                .map_err(|error| format!("invalid write_terminal_input arguments: {error}"))?;
        let session_id = self.interactive_terminal_session_id(context, call, sessions)?;
        let result = self.terminal_interactive.write(
            sessions,
            &session_id,
            &context.request.user_session_id,
            &context.request.task_id,
            arguments.input_kind,
            arguments.text.as_deref(),
            arguments.key,
        )?;
        Ok(AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: AgentToolResultStatusNative::Completed,
            summary: "Terminal input was accepted by the active Agent lease.".into(),
            data: Some(json!({
                "contractVersion": 1,
                "receipt": result,
            })),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(false),
        })
    }

    fn wait_terminal(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        default_timeout_ms: u64,
        cancellation: &CancellationToken,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: WaitTerminalArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid wait_terminal arguments: {error}"))?;
        let session_id = self.interactive_terminal_session_id(context, call, sessions)?;
        let timeout = Duration::from_millis(
            arguments
                .timeout_ms
                .unwrap_or(default_timeout_ms)
                .min(60_000),
        );
        let deadline = Instant::now() + timeout;
        let base_request = crate::terminal_broker::TerminalWaitRequest {
            after_screen_version: arguments.after_screen_version,
            after_output_sequence: arguments.after_output_sequence,
            after_lifecycle_sequence: arguments.after_lifecycle_sequence,
            text: arguments.text,
            case_sensitive: arguments.case_sensitive.unwrap_or(false),
            idle: arguments.idle_ms.map(Duration::from_millis),
            timeout,
        };
        let result = loop {
            if cancellation.is_cancelled() {
                return Ok(AgentToolResultNative {
                    request_id: context.request.request_id.clone(),
                    call_id: call.call_id.clone(),
                    tool_name: call.tool_name.clone(),
                    target_id: call.target.target_id().to_string(),
                    status: AgentToolResultStatusNative::Cancelled,
                    summary: "Terminal wait was cancelled.".into(),
                    data: None,
                    artifacts: Vec::new(),
                    effects: vec![effect.clone()],
                    truncated: Some(false),
                });
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let slice = remaining.min(Duration::from_millis(100));
            let mut request = base_request.clone();
            request.timeout = slice;
            let result = self.terminal_interactive.wait(&session_id, request)?;
            if result.reason != TerminalWaitReason::TimedOut || slice == remaining {
                break result;
            }
        };
        let (snapshot, credential_like_prompt) = match result.snapshot {
            Some(snapshot) => {
                let (snapshot, credential_like_prompt) = super::sanitize_terminal_screen(snapshot);
                (Some(snapshot), credential_like_prompt)
            }
            None => (None, false),
        };
        Ok(AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: AgentToolResultStatusNative::Completed,
            summary: "Terminal wait reached a bounded observation condition.".into(),
            data: Some(json!({
                "contractVersion": 1,
                "reason": result.reason,
                "lifecycleSequence": result.lifecycle_sequence,
                "open": result.open,
                "snapshot": snapshot,
                "credentialLikePrompt": credential_like_prompt,
            })),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(false),
        })
    }

    fn interactive_terminal_session_id(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        sessions: &SessionManager,
    ) -> Result<String, String> {
        match &call.target {
            AgentToolTargetNative::Local { session_id, .. } => Ok(session_id.clone()),
            AgentToolTargetNative::Remote {
                target_id,
                session_id: source_session_id,
                host,
                port,
                username,
                ..
            } => {
                let binding = sessions
                    .agent_remote_terminal(&context.request.user_session_id, target_id)?
                    .ok_or_else(|| {
                        "TERMINAL_INTERACTIVE_REQUIRES_DEDICATED_AGENT_SSH_PTY".to_string()
                    })?;
                if binding.owner.source_session_id != *source_session_id
                    || binding.state.terminal_kind != SessionTerminalKind::Remote
                    || binding.state.status != SessionStatus::Connected
                    || binding.state.identity.host != *host
                    || binding.state.identity.port != *port
                    || binding.state.identity.username != *username
                {
                    return Err("Agent SSH PTY no longer matches its frozen remote target".into());
                }
                Ok(binding.session_id)
            }
            _ => Err("interactive terminal tools require a terminal target".into()),
        }
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

fn pty_shell_kind(
    state: &crate::models::SessionTargetState,
) -> Result<Option<PtyShellKindNative>, String> {
    if state.terminal_kind == SessionTerminalKind::Remote {
        // Remote profiles do not currently freeze a shell executable. Probe
        // the already-connected interactive shell after the frontend ready
        // gate; the probe is hidden by the raw/display protocol splitter.
        return Ok(None);
    }
    let shell = state.identity.title.to_ascii_lowercase();
    if matches!(
        shell.as_str(),
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe"
    ) {
        return Ok(Some(PtyShellKindNative::PowerShell));
    }
    if matches!(shell.as_str(), "sh" | "bash" | "zsh" | "dash" | "ksh") {
        return Ok(Some(PtyShellKindNative::Posix));
    }
    Err(format!(
        "PTY_SHELL_UNSUPPORTED: local shell `{}` is not supported; use direct execution",
        state.identity.title
    ))
}

fn legacy_pty_wrapper_available(state: &crate::models::SessionTargetState) -> bool {
    !cfg!(target_os = "windows") || state.terminal_kind == SessionTerminalKind::Remote
}

fn pty_lifecycle_wire_state(state: PtyLifecycleNative) -> &'static str {
    match state {
        PtyLifecycleNative::Running => "running",
        PtyLifecycleNative::Exited => "exited",
        PtyLifecycleNative::Cancelled => "cancelled",
        PtyLifecycleNative::TimedOut => "timedOut",
        PtyLifecycleNative::TakenOver => "takenOver",
        PtyLifecycleNative::Failed => "failed",
    }
}

fn terminal_command_wire_state(
    state: crate::terminal_broker::TerminalCommandState,
) -> &'static str {
    use crate::terminal_broker::TerminalCommandState;
    match state {
        TerminalCommandState::Submitted => "submitted",
        TerminalCommandState::Running => "running",
        TerminalCommandState::CancelRequested => "cancelRequested",
        TerminalCommandState::Completed => "completed",
        TerminalCommandState::Cancelled => "cancelled",
        TerminalCommandState::TimedOut => "timedOut",
        TerminalCommandState::TakenOver => "takenOver",
        TerminalCommandState::Uncertain => "uncertain",
        TerminalCommandState::Failed => "failed",
    }
}

pub(crate) fn connection_for_remote_target(
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

fn requires_native_confirmation(
    permission_mode: AgentPermissionModeNative,
    effect: AgentEffectKindNative,
    sensitive_path_count: usize,
) -> bool {
    match permission_mode {
        AgentPermissionModeNative::RequestApproval => true,
        AgentPermissionModeNative::ScopedAutopilot => {
            sensitive_path_count > 0
                || matches!(
                    effect,
                    AgentEffectKindNative::StateChange
                        | AgentEffectKindNative::Destructive
                        | AgentEffectKindNative::ExternalSideEffect
                )
        }
        AgentPermissionModeNative::Operator => false,
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

    #[test]
    fn native_confirmation_respects_the_frozen_permission_mode() {
        assert!(requires_native_confirmation(
            AgentPermissionModeNative::RequestApproval,
            AgentEffectKindNative::ReadOnly,
            0,
        ));
        assert!(requires_native_confirmation(
            AgentPermissionModeNative::ScopedAutopilot,
            AgentEffectKindNative::StateChange,
            0,
        ));
        assert!(requires_native_confirmation(
            AgentPermissionModeNative::ScopedAutopilot,
            AgentEffectKindNative::ReadOnly,
            1,
        ));
        assert!(!requires_native_confirmation(
            AgentPermissionModeNative::ScopedAutopilot,
            AgentEffectKindNative::ReadOnly,
            0,
        ));

        for effect in [
            AgentEffectKindNative::ReadOnly,
            AgentEffectKindNative::SensitiveRead,
            AgentEffectKindNative::StateChange,
            AgentEffectKindNative::Destructive,
            AgentEffectKindNative::ExternalSideEffect,
        ] {
            assert!(!requires_native_confirmation(
                AgentPermissionModeNative::Operator,
                effect,
                1,
            ));
        }
    }

    #[test]
    fn pty_shell_routing_is_explicit_for_local_and_probed_for_remote() {
        let state = |terminal_kind, title: &str| crate::models::SessionTargetState {
            terminal_kind,
            identity: crate::models::SessionIdentity {
                title: title.into(),
                host: if terminal_kind == SessionTerminalKind::Local {
                    "local".into()
                } else {
                    "example.test".into()
                },
                port: 22,
                username: "tester".into(),
            },
            status: SessionStatus::Connected,
        };
        assert_eq!(
            pty_shell_kind(&state(SessionTerminalKind::Local, "bash")).unwrap(),
            Some(PtyShellKindNative::Posix)
        );
        assert_eq!(
            pty_shell_kind(&state(SessionTerminalKind::Local, "powershell")).unwrap(),
            Some(PtyShellKindNative::PowerShell)
        );
        assert_eq!(
            pty_shell_kind(&state(SessionTerminalKind::Remote, "Production")).unwrap(),
            None
        );
        assert_eq!(
            legacy_pty_wrapper_available(&state(SessionTerminalKind::Local, "powershell")),
            !cfg!(target_os = "windows"),
            "the Phase 6 Windows local route must not reach the legacy wrapper"
        );
        assert!(legacy_pty_wrapper_available(&state(
            SessionTerminalKind::Remote,
            "Production"
        )));
        assert!(pty_shell_kind(&state(SessionTerminalKind::Local, "fish"))
            .unwrap_err()
            .starts_with("PTY_SHELL_UNSUPPORTED:"));
        assert_eq!(
            pty_lifecycle_wire_state(PtyLifecycleNative::TakenOver),
            "takenOver"
        );
        assert_eq!(
            pty_lifecycle_wire_state(PtyLifecycleNative::TimedOut),
            "timedOut"
        );
    }
}
