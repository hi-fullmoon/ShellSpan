//! Native safe-execution kernel.
//!
//! Agent lifecycle, plans, recovery, notifications, and Fleet orchestration are
//! owned by the Session runtime. This module receives one immutable call
//! context and owns only safety validation plus the operating-system effect.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::{
    normalize_terminal_target_lookup_error, terminal_target_unavailable,
    validate_agent_request_native, validate_tool_arguments_native,
    AgentCapabilityVerificationContextNative, AgentEffectKindNative, AgentObservedEffectNative,
    AgentPermissionModeNative, AgentPolicyEngineNative, AgentPolicyEvaluationNative,
    AgentPolicyOutcomeNative, AgentRequestNative, AgentToolCallNative, AgentToolResultNative,
    AgentToolResultStatusNative, AgentToolTargetNative, ExecCommandArgumentsNative,
    NativeContractPolicyEngine,
};
use crate::db::Database;
use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::{
    AuthMethod, JumpHostConfig, ProfileAuthMethod, RemoteConnectionRequest, SessionManager,
    SessionStatus, SessionTerminalKind,
};
use crate::remote_sandbox::VisibleTerminalDispatch;

mod command_exec;
mod process_tools;
mod terminal_broker;
mod terminal_tools;
#[path = "vim.rs"]
mod vim;
use crate::terminal_broker::{
    TerminalIntegrationState, TerminalLeaseOwner, TerminalSessionBroker, TerminalTransportKind,
};

use super::{
    assess_effect_native, configured_tool_policy_native, current_unix_ms,
    enforce_native_call_policy_native, execute_file_tool_with_policy, execute_http_probe_native,
    execute_mcp_tool_native, inspect_call_policy_scope_with_managed_root_native,
    load_mcp_server_native, preview_file_call_native, AgentCallPreviewNative,
    CapabilityIssueRequestNative, CheckpointStoreNative, FileExecutionContextNative,
    FileOperationRegistryNative, IssuedCapabilityNative, McpServerConfigNative,
    McpToolPolicyNative, NativeCapabilityStoreNative, ProcessLifecycleNative,
    ProcessRegistryNative, RegisteredToolNative, TerminalExecuteRegistry,
    TerminalExecuteValidationStage, TerminalInteractiveRegistry,
    TerminalInteractiveValidationStage, TerminalLeaseManager, ToolProgressHub,
    ToolProgressPublisher, ToolRegistryErrorNative, ToolRegistryNative,
    TOOL_PROGRESS_THROTTLE_INTERVAL,
};

pub(crate) const DEFAULT_CAPABILITY_TTL_MS: u64 = 120_000;
pub(crate) const MAX_CAPABILITY_TTL_MS: u64 = 300_000;

fn resolve_runtime_storage_path(path: &Path) -> PathBuf {
    // A new file cannot canonicalize yet. Keep its missing suffix while
    // resolving the nearest existing ancestor, including Windows path prefixes.
    path.ancestors()
        .find_map(|ancestor| {
            let base = std::fs::canonicalize(ancestor).ok()?;
            Some(base.join(path.strip_prefix(ancestor).ok()?))
        })
        .unwrap_or_else(|| path.to_path_buf())
}

#[derive(Debug, Clone)]
pub(crate) struct NativeExecutionContext {
    #[cfg(windows)]
    pub(crate) windows_sandbox_required: bool,
    #[cfg(target_os = "macos")]
    pub(crate) mac_sandbox_required: bool,
    pub(crate) bound_terminal_surface: bool,
    pub(crate) request: AgentRequestNative,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
}

impl NativeExecutionContext {
    fn validate(&self) -> Result<(), String> {
        validate_agent_request_native(&self.request)
            .map_err(|_| "Invalid frozen Agent Session request".to_string())?;
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
            return Err("Native execution requires one frozen Session host target".into());
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
    #[cfg(windows)]
    pub(crate) windows_sandbox_digest: Option<String>,
    #[cfg(target_os = "macos")]
    pub(crate) mac_sandbox: Option<super::mac_sandbox::Workspace>,
    reviewed_command: Option<super::ReviewedReadCommand>,
    pub(crate) sandbox: Option<crate::remote_sandbox::Binding>,
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    desktop_sandbox: Option<mac_sandbox_acceptance::Binding>,
    #[cfg(all(test, target_os = "linux"))]
    local_sandbox: Option<local_sandbox_acceptance::Binding>,
    pub(crate) context: NativeExecutionContext,
    pub(crate) call: AgentToolCallNative,
    pub(crate) effect: AgentObservedEffectNative,
    ttl_ms: u64,
    pub(crate) requires_native_confirmation: bool,
    pub(crate) native_prompt: String,
}

#[cfg(all(
    feature = "native-input-acceptance",
    debug_assertions,
    target_os = "macos",
    target_arch = "aarch64"
))]
impl PreparedAuthorizationNative {
    pub(crate) fn desktop_sandbox_digest(&self) -> Option<&str> {
        self.desktop_sandbox
            .as_ref()
            .map(|binding| binding.digest.as_str())
    }
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
    terminal_execute: TerminalExecuteRegistry,
    terminal_interactive: TerminalInteractiveRegistry,
    pub(crate) terminal_leases: TerminalLeaseManager,
    terminal_broker: TerminalSessionBroker,
    checkpoints: CheckpointStoreNative,
    file_operations: FileOperationRegistryNative,
    checkpoint_root: Arc<Mutex<Option<PathBuf>>>,
    pub(crate) sudo_prompts: Arc<super::SudoPrompts>,
    pub(crate) tool_progress: ToolProgressHub,
    #[cfg(target_os = "macos")]
    mac_sandbox_paths: Arc<Mutex<Option<(PathBuf, Option<PathBuf>)>>>,
    session_sandbox_domains: Arc<Mutex<std::collections::HashMap<String, std::collections::BTreeSet<String>>>>,
    #[cfg(all(test, target_os = "linux"))]
    local_sandbox: Option<local_sandbox_acceptance::Launcher>,
}

impl Default for NativeToolEngine {
    fn default() -> Self {
        Self::with_terminal_broker(TerminalSessionBroker::default())
    }
}

impl NativeToolEngine {
    pub(crate) fn with_terminal_broker(terminal_broker: TerminalSessionBroker) -> Self {
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
            terminal_execute,
            terminal_interactive,
            terminal_leases,
            terminal_broker,
            checkpoints: CheckpointStoreNative::default(),
            file_operations: FileOperationRegistryNative::default(),
            checkpoint_root: Arc::new(Mutex::new(None)),
            sudo_prompts: Arc::default(),
            tool_progress: ToolProgressHub::default(),
            #[cfg(target_os = "macos")]
            mac_sandbox_paths: Arc::new(Mutex::new(None)),
            session_sandbox_domains: Arc::new(Mutex::new(std::collections::HashMap::new())),
            #[cfg(all(test, target_os = "linux"))]
            local_sandbox: None,
        }
    }
}

impl NativeToolEngine {
    pub(crate) fn allow_session_sandbox_domain(
        &self,
        session_id: &str,
        domain: &str,
    ) -> Result<Vec<String>, String> {
        let normalized = super::sandbox_proxy::normalize_domain_rule(domain)
            .ok_or_else(|| format!("Invalid sandbox domain rule: {domain}"))?;
        let mut guard = self
            .session_sandbox_domains
            .lock()
            .map_err(|_| "Session sandbox domain store is unavailable".to_string())?;
        let entry = guard.entry(session_id.to_string()).or_default();
        entry.insert(normalized);
        Ok(entry.iter().cloned().collect())
    }

    pub(crate) fn session_sandbox_domains(&self, session_id: &str) -> Vec<String> {
        self.session_sandbox_domains
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).map(|set| set.iter().cloned().collect()))
            .unwrap_or_default()
    }

    pub(crate) fn clear_session_sandbox_domains(&self, session_id: &str) {
        if let Ok(mut guard) = self.session_sandbox_domains.lock() {
            guard.remove(session_id);
        }
    }

    pub(crate) fn effective_sandbox_network_policy(
        &self,
        database: &Database,
        session_id: &str,
    ) -> Result<super::sandbox_proxy::SandboxNetworkPolicy, String> {
        let global = database.agent_sandbox_network_policy()?;
        let extra = self.session_sandbox_domains(session_id);
        Ok(global.with_extra_domains(&extra))
    }
    pub(crate) fn set_tool_progress_publisher(
        &self,
        publisher: ToolProgressPublisher,
    ) -> Result<(), String> {
        self.tool_progress.set_publisher(publisher)
    }

    pub(crate) fn configure_checkpoint_root(&self, root: PathBuf) -> Result<(), String> {
        let mut stored = self
            .checkpoint_root
            .lock()
            .map_err(|_| "Native checkpoint root is unavailable".to_string())?;
        if let Some(existing) = stored.as_ref() {
            if existing != &root {
                return Err("Native checkpoint root changed during a Session".into());
            }
        } else {
            *stored = Some(root);
        }
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) fn reclaim_windows_sandbox_workspace(&self, cwd: &Path) -> Result<(), String> {
        let root = self.checkpoint_root()?;
        super::windows_sandbox::remove_workspace(&root, cwd)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn configure_mac_sandbox_paths(
        &self,
        data_dir: PathBuf,
        resource_dir: Option<PathBuf>,
    ) -> Result<(), String> {
        let mut stored = self
            .mac_sandbox_paths
            .lock()
            .map_err(|_| "macOS sandbox paths are unavailable".to_string())?;
        *stored = Some((data_dir, resource_dir));
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(super) fn mac_sandbox_paths(&self) -> Result<(PathBuf, Option<PathBuf>), String> {
        let stored = self
            .mac_sandbox_paths
            .lock()
            .map_err(|_| "macOS sandbox paths are unavailable".to_string())?;
        if let Some(paths) = stored.as_ref() {
            return Ok(paths.clone());
        }
        if let Ok(root) = self.checkpoint_root() {
            return Ok((root, None));
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| "Unable to resolve HOME for macOS sandbox".to_string())?;
        Ok((crate::shellspan_data_dir(&home), None))
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn reclaim_mac_sandbox_workspace(&self, cwd: &Path) -> Result<(), String> {
        let (data_dir, _) = self.mac_sandbox_paths()?;
        super::mac_sandbox::remove_workspace(&data_dir, cwd)
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
            return Err("Native call is outside the frozen Agent Session request".into());
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
        let sandbox = call_sandbox_binding(&context, &call, database, known_hosts_path)?;
        #[cfg(windows)]
        let windows_sandbox_digest = self
            .windows_sandbox_binding(&context, &call, database)?
            .map(|binding| binding.digest);
        #[cfg(target_os = "macos")]
        let mac_sandbox = self.mac_sandbox_binding(&context, &call, database)?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let desktop_sandbox = {
            let binding = mac_sandbox_acceptance::resolve(&context, &call)?;
            if binding.is_some() {
                database.require_agent_sandbox_enabled()?;
            }
            binding
        };
        #[cfg(all(test, target_os = "linux"))]
        let local_sandbox = self.local_sandbox_binding(&call, database)?;
        if call.tool_name == "exec_command" && call.arguments["elevated"] == json!(true) {
            let arguments: ExecCommandArgumentsNative =
                serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
            crate::sudo_policy::verify_grant(database, &call.target, &arguments)?;
        } else {
            ensure_unmanaged_call(database, &context, &call)?;
        }
        self.revalidate_target(&context, &call.target, sessions, database)?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let managed_workspace = desktop_sandbox
            .as_ref()
            .map(|binding| binding.workspace.as_path())
            .or_else(|| {
                mac_sandbox
                    .as_ref()
                    .map(|binding| binding.workspace.as_path())
            });
        #[cfg(all(
            target_os = "macos",
            not(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_arch = "aarch64"
            ))
        ))]
        let managed_workspace = mac_sandbox
            .as_ref()
            .map(|binding| binding.workspace.as_path());
        #[cfg(windows)]
        let managed_workspace = if windows_sandbox_digest.is_some() {
            match &call.target {
                AgentToolTargetNative::Local { cwd: Some(cwd), .. } => Some(Path::new(cwd)),
                _ => None,
            }
        } else {
            None
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let managed_workspace = None;
        let mut effect = assess_effect_native(&tool.descriptor, &call)?;
        let scope = inspect_call_policy_scope_with_managed_root_native(&call, managed_workspace)?;
        enforce_native_call_policy_native(&call, &effect, &scope)?;
        self.enforce_runtime_storage_policy_for_session(
            &context,
            &call,
            &effect,
            &scope,
            managed_workspace,
        )?;
        let ttl_ms = input.ttl_ms.unwrap_or(DEFAULT_CAPABILITY_TTL_MS);
        if ttl_ms == 0 || ttl_ms > MAX_CAPABILITY_TTL_MS {
            return Err("Capability TTL is outside the native limit".into());
        }
        let preview_call = || {
            preview_file_call_native(
                &call,
                database,
                credentials,
                known_hosts_path,
                sandbox.as_ref(),
            )
        };
        let preview = if sandbox.as_ref().is_some_and(|b| b.state.policy.is_some())
            && matches!(
                call.tool_name.as_str(),
                "write_file" | "edit_file" | "apply_patch"
            )
            && tokio::runtime::Handle::try_current().is_ok()
        {
            // Approval preparation can run on a Tokio worker. The synchronous
            // file driver owns a separate runtime for its SSH/SFTP transport.
            std::thread::scope(|scope| scope.spawn(preview_call).join())
                .map_err(|_| "Sandbox SFTP preview worker failed")??
        } else {
            preview_call()?
        };
        let review = super::review_call(
            context.request.permission_mode,
            &call,
            &effect,
            &scope,
            managed_workspace,
        );
        effect
            .summary
            .push_str(&format!(" Approval review: {}.", review.reason));
        let native_prompt = format!(
            "{}\nApproval review: {}{}",
            native_prompt(&context, &call, &effect, &scope, &preview, ttl_ms),
            review.reason,
            if call.tool_name == "exec_command" && call.arguments["elevated"] == json!(true) {
                "\nExecution boundary: runs outside any remote Bubblewrap sandbox via the configured restricted sudo runner."
                    .to_string()
            } else {
                sandbox
                    .as_ref()
                    .and_then(|b| b.state.policy.as_ref())
                    .map(|p| {
                        format!(
                            "\nRemote Bubblewrap sandbox: {} ({:?}). Network is disabled.",
                            p.workspace, p.mode
                        )
                    })
                    .unwrap_or_default()
            }
        );
        #[cfg(target_os = "macos")]
        let native_prompt = match &mac_sandbox {
            Some(binding) => format!(
                "{native_prompt}\nLocal macOS nono sandbox: {}. {}",
                binding.workspace.display(),
                binding.network_policy.prompt_summary()
            ),
            None => native_prompt,
        };
        #[cfg(windows)]
        let native_prompt = if windows_sandbox_digest.is_some() {
            let root = match &call.target {
                AgentToolTargetNative::Local { cwd: Some(cwd), .. } => cwd.as_str(),
                _ => "<managed workspace>",
            };
            format!(
                "{native_prompt}\nLocal Windows AppContainer sandbox: {root}. Outbound network is blocked."
            )
        } else {
            native_prompt
        };
        #[cfg(all(test, target_os = "linux"))]
        let native_prompt = match &local_sandbox {
            Some(binding) => format!(
                "{native_prompt}\nLocal nono acceptance sandbox: {}. Internet sockets are blocked.",
                binding.workspace.display()
            ),
            None => native_prompt,
        };
        Ok(PreparedAuthorizationNative {
            #[cfg(windows)]
            windows_sandbox_digest,
            #[cfg(target_os = "macos")]
            mac_sandbox,
            reviewed_command: review.command,
            native_prompt,
            sandbox,
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            desktop_sandbox,
            #[cfg(all(test, target_os = "linux"))]
            local_sandbox,
            context,
            call,
            effect,
            ttl_ms,
            requires_native_confirmation: review.requires_approval,
        })
    }

    pub(crate) fn issue_prepared_authorization(
        &self,
        prepared: &PreparedAuthorizationNative,
        approved: bool,
    ) -> Result<AgentCapabilityGrantNative, String> {
        if prepared.requires_native_confirmation && !approved {
            return Err("Native capability approval was denied".into());
        }
        let sandbox_digest = prepared
            .sandbox
            .as_ref()
            .map(|binding| binding.digest.as_str());
        #[cfg(windows)]
        let sandbox_digest = prepared
            .windows_sandbox_digest
            .as_deref()
            .or(sandbox_digest);
        #[cfg(target_os = "macos")]
        let sandbox_digest = prepared
            .mac_sandbox
            .as_ref()
            .map(|binding| binding.digest.as_str())
            .or(sandbox_digest);
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let sandbox_digest = prepared.desktop_sandbox_digest().or(sandbox_digest);
        #[cfg(all(test, target_os = "linux"))]
        let sandbox_digest = prepared
            .local_sandbox
            .as_ref()
            .map(|binding| binding.digest.as_str())
            .or(sandbox_digest);
        let IssuedCapabilityNative {
            capability_id,
            expires_at_unix_ms: _,
        } = self
            .capabilities
            .issue(
                CapabilityIssueRequestNative {
                    reviewed_command: prepared.reviewed_command.clone(),
                    request_id: prepared.context.request.request_id.clone(),
                    user_session_id: prepared.context.request.user_session_id.clone(),
                    call_id: prepared.call.call_id.clone(),
                    call_digest: bound_call_digest(&prepared.call, sandbox_digest)?,
                    allowed_tools: vec![prepared.call.tool_name.clone()],
                    allowed_effects: vec![prepared.effect.kind],
                    target_ids: vec![prepared.call.target.target_id().to_string()],
                    ttl_ms: prepared.ttl_ms,
                    max_uses: 1,
                },
                current_unix_ms(),
            )
            .map_err(|error| format!("Native capability issuance failed: {error:?}"))?;
        Ok(AgentCapabilityGrantNative {
            capability_id,
            effective_arguments: prepared.call.arguments.clone(),
        })
    }

    pub(crate) fn revoke_capability(&self, capability_id: &str) -> Result<(), String> {
        self.capabilities
            .revoke(capability_id)
            .map_err(|error| format!("Native capability revocation failed: {error:?}"))
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
        if prepared.context.request.permission_mode != AgentPermissionModeNative::Operator
            && !approved
        {
            return Err("native MCP capability approval was denied".into());
        }
        let IssuedCapabilityNative {
            capability_id,
            expires_at_unix_ms: _,
        } = self
            .capabilities
            .issue(
                CapabilityIssueRequestNative {
                    reviewed_command: None,
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
        runner_journal: Option<crate::agent_runtime::RunnerDispatchJournal>,
    ) -> Result<AgentToolResultNative, String> {
        context.validate()?;
        if call.request_id != context.request.request_id
            || !context
                .request
                .targets
                .iter()
                .any(|target| target == &call.target)
        {
            return Err("Dispatch target is outside the frozen Agent Session request".into());
        }
        let tool = self
            .registry
            .executable(&call.tool_name)
            .map_err(registry_error_message)?;
        let sandbox = call_sandbox_binding(context, &call, database, known_hosts_path)?;
        #[cfg(windows)]
        let windows_sandbox = self.windows_sandbox_binding(context, &call, database)?;
        #[cfg(target_os = "macos")]
        let mac_sandbox = self.mac_sandbox_binding(context, &call, database)?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let desktop_sandbox = mac_sandbox_acceptance::resolve(context, &call)?;
        #[cfg(all(test, target_os = "linux"))]
        let local_sandbox = self.local_sandbox_binding(&call, database)?;
        let sandbox_digest = sandbox.as_ref().map(|binding| binding.digest.as_str());
        #[cfg(windows)]
        let sandbox_digest = windows_sandbox
            .as_ref()
            .map(|binding| {
                super::local_sandbox_digest(
                    binding,
                    crate::agent_runtime::LocalSandboxKind::WindowsAppContainer,
                )
            })
            .or(sandbox_digest);
        #[cfg(target_os = "macos")]
        let sandbox_digest = mac_sandbox
            .as_ref()
            .map(|binding| {
                super::local_sandbox_digest(
                    binding,
                    crate::agent_runtime::LocalSandboxKind::MacNono,
                )
            })
            .or(sandbox_digest);
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let sandbox_digest = desktop_sandbox
            .as_ref()
            .map(|binding| binding.digest.as_str())
            .or(sandbox_digest);
        #[cfg(all(test, target_os = "linux"))]
        let sandbox_digest = local_sandbox
            .as_ref()
            .map(|binding| binding.digest.as_str())
            .or(sandbox_digest);
        self.revalidate_target(context, &call.target, sessions, database)?;
        if !(call.tool_name == "exec_command" && call.arguments["elevated"] == json!(true)) {
            ensure_unmanaged_call(database, context, &call)?;
        }
        let effect = assess_effect_native(&tool.descriptor, &call)?;
        if !matches!(
            effect.kind,
            AgentEffectKindNative::None | AgentEffectKindNative::ReadOnly
        ) && !self
            .terminal_broker
            .recovered_submissions_for_agent(&context.request.user_session_id)?
            .is_empty()
        {
            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: a durable terminal submission has no trusted settlement; inspect its outcome before further writes; no automatic replay".into());
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let managed_workspace = desktop_sandbox
            .as_ref()
            .map(|binding| binding.workspace.as_path())
            .or_else(|| {
                mac_sandbox
                    .as_ref()
                    .map(|binding| binding.workspace.as_path())
            });
        #[cfg(all(
            target_os = "macos",
            not(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_arch = "aarch64"
            ))
        ))]
        let managed_workspace = mac_sandbox
            .as_ref()
            .map(|binding| binding.workspace.as_path());
        #[cfg(windows)]
        let managed_workspace = if windows_sandbox.is_some() {
            match &call.target {
                AgentToolTargetNative::Local { cwd: Some(cwd), .. } => Some(Path::new(cwd)),
                _ => None,
            }
        } else {
            None
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let managed_workspace = None;
        let scope = inspect_call_policy_scope_with_managed_root_native(&call, managed_workspace)?;
        enforce_native_call_policy_native(&call, &effect, &scope)?;
        self.enforce_runtime_storage_policy_for_session(
            context,
            &call,
            &effect,
            &scope,
            managed_workspace,
        )?;
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
                &bound_call_digest(&call, sandbox_digest)?,
                current_unix_ms(),
            )
            .map_err(|error| format!("Native capability verification failed: {error:?}"))?;
        let decision = NativeContractPolicyEngine.evaluate(AgentPolicyEvaluationNative {
            request: &context.request,
            call: &call,
            assessed_effect: Some(&effect),
            capability: Some(&capability),
            now_unix_ms: current_unix_ms(),
        });
        if decision.outcome != AgentPolicyOutcomeNative::Allow {
            return Err(format!(
                "Native contract policy denied dispatch: {:?}",
                decision.reason
            ));
        }
        let reviewed_command = self
            .capabilities
            .reviewed_command(&call.capability_id)
            .map_err(|error| format!("Native execution review unavailable: {error:?}"))?;
        self.capabilities
            .consume(&call.capability_id, current_unix_ms())
            .map_err(|error| format!("Native capability consumption failed: {error:?}"))?;

        let terminal_dispatch = context.request.targets.iter().find_map(|target| {
            matches!(target, AgentToolTargetNative::Remote { .. }).then_some(
                VisibleTerminalDispatch {
                    target,
                    binding: sandbox.as_ref(),
                    database,
                    known_hosts: known_hosts_path,
                },
            )
        });
        match call.tool_name.as_str() {
            "inspect_host" | "inspect_service" | "query_logs" | "diagnose_endpoint" => {
                let remote = match &call.target {
                    AgentToolTargetNative::Remote { .. } => Some(connection_for_remote_target(
                        &call.target,
                        database,
                        credentials,
                    )?),
                    _ => None,
                };
                super::diagnostics::execute_diagnostic(
                    &context.request,
                    &call,
                    &effect,
                    remote,
                    known_hosts_path,
                    &self.processes,
                    cancellation,
                )
            }
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
                reviewed_command.as_ref(),
                cancellation,
                runner_journal,
                sandbox.as_ref(),
                #[cfg(windows)]
                windows_sandbox,
                #[cfg(target_os = "macos")]
                mac_sandbox.as_ref(),
                #[cfg(all(
                    feature = "native-input-acceptance",
                    debug_assertions,
                    target_os = "macos",
                    target_arch = "aarch64"
                ))]
                desktop_sandbox.as_ref(),
                #[cfg(all(test, target_os = "linux"))]
                local_sandbox.as_ref(),
            ),
            "terminal_execute" => self.execute_terminal_command(
                context,
                &call,
                &effect,
                sessions,
                Some(database),
                tool.descriptor.default_timeout_ms,
                cancellation,
                terminal_dispatch.as_ref(),
            ),
            "probe_http" => {
                let remote_connection = match &call.target {
                    AgentToolTargetNative::Remote { .. } => Some(connection_for_remote_target(
                        &call.target,
                        database,
                        credentials,
                    )?),
                    AgentToolTargetNative::Local { .. } => None,
                    _ => return Err("probe_http requires a frozen host target".into()),
                };
                match execute_http_probe_native(
                    &call,
                    remote_connection.as_ref(),
                    known_hosts_path,
                    cancellation,
                ) {
                    Ok(output) => Ok(completed_result(
                        &context.request,
                        &call,
                        &effect,
                        &output.summary,
                        output.data,
                        output.truncated,
                    )),
                    Err(error) if cancellation.is_cancelled() => Ok(AgentToolResultNative {
                        request_id: context.request.request_id.clone(),
                        call_id: call.call_id.clone(),
                        tool_name: call.tool_name.clone(),
                        target_id: call.target.target_id().to_string(),
                        status: AgentToolResultStatusNative::Cancelled,
                        summary: error,
                        data: None,
                        artifacts: Vec::new(),
                        effects: vec![effect],
                        truncated: Some(false),
                    }),
                    Err(error) => Err(error),
                }
            }
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
            name if crate::terminal_vim_bridge::is_tool(name) => self.execute_vim_tool(
                context,
                &call,
                &effect,
                sessions,
                cancellation,
                terminal_dispatch
                    .as_ref()
                    .ok_or("Vim tools require a bound SSH terminal")?,
            ),
            "write_stdin" => self.write_process(context, &call, &effect),
            "wait_process" => self.wait_process(
                context,
                &call,
                &effect,
                sessions,
                cancellation,
                terminal_dispatch.as_ref(),
            ),
            "kill_process" => self.kill_process(
                context,
                &call,
                &effect,
                sessions,
                cancellation,
                terminal_dispatch.as_ref(),
            ),
            "read_file" | "list_directory" | "search_text" | "write_file" | "edit_file"
            | "apply_patch" | "transfer_file" | "trash_file" => {
                #[cfg(target_os = "macos")]
                if let Some(binding) = mac_sandbox.as_ref() {
                    database.with_local_sandbox_dispatch(|| binding.revalidate())?;
                }
                #[cfg(windows)]
                if windows_sandbox.is_some() {
                    database.with_local_sandbox_dispatch(|| Ok(()))?;
                }
                self.execute_file_tool(
                    context,
                    &call,
                    &effect,
                    database,
                    credentials,
                    known_hosts_path,
                    sandbox.as_ref(),
                    cancellation,
                )
            }
            _ => Err("Tool is outside the native execution kernel".into()),
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
        if let Err(error) = self.terminal_execute.cancel_task(sessions, task_id) {
            errors.push(error);
        }
        if let Err(error) = self.terminal_interactive.cancel_task(sessions, task_id) {
            errors.push(error);
        }
        if let Err(error) = self
            .terminal_execute
            .cleanup_shell_jobs(sessions, Some(task_id))
        {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub(crate) fn scratch_task_processes(
        &self,
        task_id: &str,
    ) -> Result<Vec<Arc<super::ManagedProcessNative>>, String> {
        self.processes.task_processes(task_id)
    }

    pub(crate) fn scratch_process_outcome(
        &self,
        handle: &str,
        session: &str,
        task: &str,
        target: &crate::agent_runtime::AgentSessionTarget,
    ) -> Option<bool> {
        if handle.starts_with("proc-") {
            let snapshot = self.processes.get(handle).ok()?.snapshot().ok()?;
            if snapshot.owner_target_id != target.target_id
                || snapshot.task_id != task
                || snapshot.request_id
                    != crate::agent_runtime::native_adapter::stable_native_id("request", session)
                || snapshot.state == ProcessLifecycleNative::Running
                || !snapshot.termination_confirmed
            {
                return None;
            }
            Some(snapshot.state != ProcessLifecycleNative::Exited || snapshot.exit_code != Some(0))
        } else {
            let job = self
                .terminal_broker
                .shell_job(handle, &target.target_id, session, task)
                .ok()?;
            (matches!(job.state.as_str(), "exited" | "rejected")
                && job.native_active == Some(false))
            .then_some(job.state == "rejected" || job.exit_code != Some(0))
        }
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
        match self.terminal_execute.cleanup_shell_jobs(sessions, None) {
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
            .map_err(|_| "Native checkpoint root is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "Native checkpoint root was not configured".into())
    }

    pub(crate) fn list_file_checkpoints(
        &self,
        task_id: &str,
    ) -> Result<Vec<super::AgentFileCheckpointNative>, String> {
        let root = self.checkpoint_root()?;
        self.checkpoints.list_for_task(&root, task_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn preview_file_checkpoint(
        &self,
        task_id: &str,
        checkpoint_id: &str,
        target: &AgentToolTargetNative,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        sandbox: Option<&crate::remote_sandbox::Binding>,
    ) -> Result<super::FileCheckpointDiffPreview, String> {
        let root = self.checkpoint_root()?;
        super::preview_file_checkpoint_native(
            &root,
            &self.checkpoints,
            &self.file_operations,
            task_id,
            checkpoint_id,
            target,
            database,
            credentials,
            known_hosts_path,
            sandbox,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn restore_file_checkpoint(
        &self,
        task_id: &str,
        checkpoint_id: &str,
        target: &AgentToolTargetNative,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        sandbox: Option<&crate::remote_sandbox::Binding>,
        allow_conflict_overwrite: bool,
    ) -> Result<super::FileCheckpointRestoreResult, String> {
        let root = self.checkpoint_root()?;
        super::restore_file_checkpoint_native(
            &root,
            &self.checkpoints,
            &self.file_operations,
            task_id,
            checkpoint_id,
            target,
            database,
            credentials,
            known_hosts_path,
            sandbox,
            allow_conflict_overwrite,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn restore_file_checkpoints_batch(
        &self,
        task_id: &str,
        checkpoint_ids: &[String],
        target: &AgentToolTargetNative,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        sandbox: Option<&crate::remote_sandbox::Binding>,
        allow_conflict_overwrite: bool,
    ) -> Result<super::FileCheckpointBatchRestoreResult, String> {
        let root = self.checkpoint_root()?;
        super::restore_file_checkpoints_batch_native(
            &root,
            &self.checkpoints,
            &self.file_operations,
            task_id,
            checkpoint_ids,
            target,
            database,
            credentials,
            known_hosts_path,
            sandbox,
            allow_conflict_overwrite,
        )
    }

    fn enforce_runtime_storage_policy_for_session(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        scope: &super::CallPolicyScopeNative,
        managed_workspace: Option<&Path>,
    ) -> Result<(), String> {
        if crate::agent_runtime::scratch::is_file_tool(&call.tool_name) {
            let stored = self
                .checkpoint_root
                .lock()
                .map_err(|_| "Native runtime storage policy is unavailable")?;
            if let Some(root) = stored.as_ref() {
                if crate::agent_runtime::scratch::owns_target(
                    root,
                    &context.request.user_session_id,
                    &call.target,
                )? {
                    // File drivers separately enforce root containment, no-follow
                    // paths, digest preconditions and approval/dispatch checks.
                    return Ok(());
                }
                let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
                let managed = [root.join("agent-runtime/scratch"), root.join("tmp")];
                if scope.paths.iter().any(|path| {
                    let path = Path::new(path);
                    let resolved = matches!(call.target, AgentToolTargetNative::Local { .. })
                        .then(|| resolve_runtime_storage_path(path));
                    managed.iter().any(|root| {
                        path.starts_with(root)
                            || resolved.as_ref().is_some_and(|path| path.starts_with(root))
                    })
                }) {
                    return Err(
                        "AGENT_SCRATCH_SCOPE_DENIED: use this session's fileScope=scratch target"
                            .into(),
                    );
                }
            }
            if scope.paths.iter().any(|path| {
                path.split('/')
                    .any(|p| p.starts_with(".shellspan-agent-scratch-"))
            }) {
                return Err(
                    "AGENT_SCRATCH_SCOPE_DENIED: use this session's fileScope=scratch target"
                        .into(),
                );
            }
        }
        self.enforce_runtime_storage_policy(call, effect, scope, managed_workspace)
    }

    fn enforce_runtime_storage_policy(
        &self,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        scope: &super::CallPolicyScopeNative,
        managed_workspace: Option<&Path>,
    ) -> Result<(), String> {
        let paths = match &call.target {
            AgentToolTargetNative::Local { .. }
                if matches!(
                    effect.kind,
                    AgentEffectKindNative::StateChange | AgentEffectKindNative::Destructive
                ) =>
            {
                scope.paths.clone()
            }
            AgentToolTargetNative::Remote {
                local_root: Some(root),
                ..
            } if call.tool_name == "transfer_file" => {
                let arguments: crate::agent_runtime::TransferFileArgumentsNative =
                    serde_json::from_value(call.arguments.clone()).map_err(|_| {
                        "Invalid transfer_file storage policy arguments".to_string()
                    })?;
                if arguments.direction != crate::agent_runtime::TransferDirectionNative::Download {
                    return Ok(());
                }
                vec![Path::new(root)
                    .join(&arguments.destination_path)
                    .to_string_lossy()
                    .into_owned()]
            }
            _ => return Ok(()),
        };
        let stored = self
            .checkpoint_root
            .lock()
            .map_err(|_| "Native runtime storage policy is unavailable".to_string())?;
        if let Some(root) = stored.as_ref() {
            let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
            let allowed_managed = managed_workspace
                .map(|ws| std::fs::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf()));
            if paths.iter().any(|path| {
                let path = resolve_runtime_storage_path(Path::new(path));
                path.starts_with(&root)
                    && !allowed_managed
                        .as_ref()
                        .is_some_and(|ws| path.starts_with(ws))
            }) {
                return Err("AGENT_CRITICAL_OPERATION_DENIED: Agent tools cannot modify ShellSpan application data, approvals or recovery records".into());
            }
        }
        Ok(())
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
                let state = sessions
                    .target_state(session_id)
                    .map_err(|error| normalize_terminal_target_lookup_error(session_id, error))?;
                if state.terminal_kind != SessionTerminalKind::Local
                    || state.status != SessionStatus::Connected
                    || state.identity.host != "local"
                {
                    return Err(terminal_target_unavailable(
                        "The frozen local terminal is disconnected or its identity changed",
                    ));
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
                let state = sessions
                    .target_state(session_id)
                    .map_err(|error| normalize_terminal_target_lookup_error(session_id, error))?;
                if state.terminal_kind != SessionTerminalKind::Remote
                    || state.status != SessionStatus::Connected
                    || state.identity.host != *host
                    || state.identity.port != *port
                    || state.identity.username != *username
                {
                    return Err(terminal_target_unavailable(
                        "The frozen remote terminal is disconnected or its identity changed",
                    ));
                }
                if let Some(profile_id) = profile_id {
                    let profile = database.get_profile(profile_id)?.ok_or_else(|| {
                        terminal_target_unavailable("The frozen remote profile no longer exists")
                    })?;
                    if profile.host != *host
                        || profile.port != *port
                        || profile.username != *username
                    {
                        return Err(terminal_target_unavailable(
                            "The stored remote profile no longer matches the frozen target",
                        ));
                    }
                }
                Ok(())
            }
            AgentToolTargetNative::Process {
                target_id,
                owner_target_id,
                process_handle,
            } => {
                if process_handle.starts_with("job-") {
                    let job = self.terminal_broker.shell_job(
                        process_handle,
                        owner_target_id,
                        &context.request.user_session_id,
                        &context.request.task_id,
                    )?;
                    if *target_id != format!("process-{process_handle}") {
                        return Err("TERMINAL_JOB_OWNER_MISMATCH".into());
                    }
                    if !job.control_lost {
                        self.revalidate_target(context, &job.frozen_target, sessions, database)?;
                    }
                    return Ok(());
                }
                let snapshot = self.processes.get(process_handle)?.snapshot()?;
                if snapshot.target_id != *target_id
                    || snapshot.owner_target_id != *owner_target_id
                    || snapshot.request_id != context.request.request_id
                    || snapshot.task_id != context.request.task_id
                {
                    return Err("Process handle does not match its frozen Session owner".into());
                }
                Ok(())
            }
        }
    }

    fn terminal_target_session_id(
        &self,
        target: &AgentToolTargetNative,
        sessions: &SessionManager,
    ) -> Result<String, String> {
        match target {
            AgentToolTargetNative::Local { session_id, .. } => {
                let state = sessions
                    .target_state(session_id)
                    .map_err(|error| normalize_terminal_target_lookup_error(session_id, error))?;
                if state.terminal_kind != SessionTerminalKind::Local
                    || state.status != SessionStatus::Connected
                    || state.identity.host != "local"
                {
                    return Err(terminal_target_unavailable(
                        "The frozen local terminal is disconnected or its identity changed",
                    ));
                }
                Ok(session_id.clone())
            }
            AgentToolTargetNative::Remote {
                session_id,
                host,
                port,
                username,
                ..
            } => {
                let state = sessions
                    .target_state(session_id)
                    .map_err(|error| normalize_terminal_target_lookup_error(session_id, error))?;
                if state.terminal_kind != SessionTerminalKind::Remote
                    || state.status != SessionStatus::Connected
                    || state.identity.host != *host
                    || state.identity.port != *port
                    || state.identity.username != *username
                {
                    return Err(terminal_target_unavailable(
                        "The frozen remote terminal is disconnected or its identity changed",
                    ));
                }
                Ok(session_id.clone())
            }
            _ => Err("Terminal tool requires a frozen terminal target".into()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn revalidate_terminal_execution(
        &self,
        target: &AgentToolTargetNative,
        sessions: &SessionManager,
        expected_terminal_session_id: &str,
        expected_terminal_generation: u64,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        stage: TerminalExecuteValidationStage,
    ) -> Result<(), String> {
        let transport_session_id = self.terminal_target_session_id(target, sessions)?;
        let broker_snapshot = self.terminal_broker.snapshot(Some(&transport_session_id))?;
        if !broker_snapshot.terminal_execute_rollout.enabled {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        let remote = matches!(target, AgentToolTargetNative::Remote { .. });
        if remote && !broker_snapshot.remote_bound_terminal_rollout.enabled {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        let terminal = broker_snapshot
            .session
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        if !terminal.open
            || terminal.transport_session_id != transport_session_id
            || terminal.terminal_session_id != expected_terminal_session_id
            || terminal.terminal_generation != expected_terminal_generation
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        if (remote && terminal.transport_kind != TerminalTransportKind::SshPty)
            || (!remote && terminal.transport_kind == TerminalTransportKind::SshPty)
        {
            return Err("TERMINAL_BROKER_TRANSPORT_IDENTITY_MISMATCH".into());
        }
        if terminal.integration_state != TerminalIntegrationState::Ready
            || terminal.integration_shell.is_none()
        {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }

        let lease_matches_agent = terminal.lease.as_ref().is_some_and(|lease| {
            matches!(
                &lease.owner,
                TerminalLeaseOwner::Agent {
                    agent_session_id: expected_agent,
                    task_id: expected_task,
                    operation_id: expected_operation,
                    ..
                } if expected_agent == agent_session_id
                    && expected_task == task_id
                    && expected_operation == operation_id
            )
        });
        match stage {
            TerminalExecuteValidationStage::LeaseAcquisition => {
                if !terminal
                    .lease
                    .as_ref()
                    .is_some_and(|lease| matches!(lease.owner, TerminalLeaseOwner::User { .. }))
                {
                    return Err("TERMINAL_BROKER_LEASE_BUSY".into());
                }
                if !terminal.prompt_ready || terminal.active_command_id.is_some() {
                    return Err("TERMINAL_VISIBLE_COMMAND_BUSY".into());
                }
            }
            TerminalExecuteValidationStage::CommandCreation => {
                if !lease_matches_agent {
                    return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
                }
                let own_waiting = terminal
                    .input_observation
                    .active_command
                    .as_ref()
                    .is_some_and(|command| {
                        command.operation_id == operation_id
                            && command.phase
                                == crate::terminal_command::state::CommandPhase::AwaitingReady
                    });
                if !terminal.prompt_ready || terminal.active_command_id.is_some() && !own_waiting {
                    return Err("TERMINAL_VISIBLE_COMMAND_BUSY".into());
                }
            }
            TerminalExecuteValidationStage::InputWrite => {
                if !lease_matches_agent {
                    return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
                }
                if terminal.prompt_ready || terminal.active_command_id.is_none() {
                    return Err("TERMINAL_COMMAND_LIFECYCLE_MISMATCH".into());
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn revalidate_terminal_interactive_write(
        &self,
        target: &AgentToolTargetNative,
        sessions: &SessionManager,
        expected_terminal_session_id: &str,
        expected_terminal_generation: u64,
        agent_session_id: &str,
        task_id: &str,
        stage: TerminalInteractiveValidationStage,
    ) -> Result<(), String> {
        let transport_session_id = self.terminal_target_session_id(target, sessions)?;
        let broker_snapshot = self.terminal_broker.snapshot(Some(&transport_session_id))?;
        let remote = matches!(target, AgentToolTargetNative::Remote { .. });
        if !broker_snapshot.interactive_tools_rollout.enabled
            || (remote
                && (!broker_snapshot.remote_bound_terminal_rollout.enabled
                    || !broker_snapshot.remote_interactive_tools_rollout.enabled))
        {
            return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
        }
        let terminal = broker_snapshot
            .session
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        if !terminal.open
            || terminal.transport_session_id != transport_session_id
            || terminal.terminal_session_id != expected_terminal_session_id
            || terminal.terminal_generation != expected_terminal_generation
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        if (remote && terminal.transport_kind != TerminalTransportKind::SshPty)
            || (!remote && terminal.transport_kind == TerminalTransportKind::SshPty)
        {
            return Err("TERMINAL_BROKER_TRANSPORT_IDENTITY_MISMATCH".into());
        }
        if terminal.integration_state != TerminalIntegrationState::Ready {
            return Err("TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY".into());
        }
        if stage == TerminalInteractiveValidationStage::BeforeWrite
            && !terminal.lease.as_ref().is_some_and(|lease| {
                matches!(
                    &lease.owner,
                    TerminalLeaseOwner::Agent {
                        agent_session_id: expected_agent,
                        task_id: expected_task,
                        ..
                    } if expected_agent == agent_session_id && expected_task == task_id
                )
            })
        {
            return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
        }
        Ok(())
    }

    fn execute_file_tool(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        sandbox: Option<&crate::remote_sandbox::Binding>,
        cancellation: &CancellationToken,
    ) -> Result<AgentToolResultNative, String> {
        let checkpoint_root = self.checkpoint_root()?;
        let output = execute_file_tool_with_policy(
            FileExecutionContextNative {
                task_id: &context.request.task_id,
                call,
                database,
                credentials,
                known_hosts_path,
                checkpoint_root: &checkpoint_root,
                checkpoints: &self.checkpoints,
                operations: &self.file_operations,
            },
            sandbox,
            cancellation.clone(),
        );
        let output = match output {
            Err(error) if error.contains("SANDBOX_SFTP_UNCERTAIN") => {
                let mut result = completed_result(
                    &context.request,
                    call,
                    effect,
                    &error,
                    json!({"sandbox":"bubblewrap","terminationConfirmed":false,"doNotRetry":true}),
                    false,
                );
                result.status = AgentToolResultStatusNative::Uncertain;
                return Ok(result);
            }
            result => result?,
        };
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
        ToolRegistryErrorNative::UnregisteredTool => "Tool is not registered".into(),
        ToolRegistryErrorNative::ToolUnavailable => {
            "Tool is not implemented by the native kernel".into()
        }
        _ => "Native tool registry rejected the tool".into(),
    }
}

fn call_digest(call: &AgentToolCallNative) -> Result<String, String> {
    bound_call_digest(call, None)
}

fn bound_call_digest(
    call: &AgentToolCallNative,
    sandbox_digest: Option<&str>,
) -> Result<String, String> {
    let bytes = serde_json::to_vec(&(
        call.request_id.as_str(),
        call.call_id.as_str(),
        call.tool_name.as_str(),
        &call.arguments,
        &call.target,
        sandbox_digest,
    ))
    .map_err(|error| format!("Failed to digest native call: {error}"))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(all(test, target_os = "linux"))]
#[path = "__tests__/local_sandbox_acceptance.rs"]
mod local_sandbox_acceptance;

#[cfg(all(
    feature = "native-input-acceptance",
    debug_assertions,
    target_os = "macos",
    target_arch = "aarch64"
))]
#[path = "mac_sandbox_acceptance.rs"]
mod mac_sandbox_acceptance;

#[cfg(all(
    feature = "native-input-acceptance",
    debug_assertions,
    target_os = "macos",
    target_arch = "aarch64"
))]
pub(crate) use mac_sandbox_acceptance::EXECUTOR as MAC_SANDBOX_ACCEPTANCE_EXECUTOR;
#[cfg(all(
    feature = "native-input-acceptance",
    debug_assertions,
    target_os = "macos",
    target_arch = "aarch64"
))]
pub(crate) use mac_sandbox_acceptance::{
    active as mac_sandbox_trial_active, automated as mac_sandbox_automated,
    preview_active as mac_sandbox_preview_active,
};

fn call_sandbox_binding(
    context: &NativeExecutionContext,
    call: &AgentToolCallNative,
    database: &Database,
    known_hosts: &Path,
) -> Result<Option<crate::remote_sandbox::Binding>, String> {
    if call.tool_name == "exec_command" && call.arguments["elevated"] == json!(true) {
        return Ok(None);
    }
    let owner = match &call.target {
        AgentToolTargetNative::Process {
            owner_target_id, ..
        } => context
            .request
            .targets
            .iter()
            .find(|target| target.target_id() == owner_target_id)
            .ok_or("Process has no frozen owner")?,
        _ => &call.target,
    };
    let binding = crate::remote_sandbox::binding_for_target(owner, database, known_hosts)?;
    crate::remote_sandbox::guard_tool(
        database,
        binding.as_ref(),
        &call.tool_name,
        &call.arguments,
    )?;
    if let Some(policy) = binding.as_ref().and_then(|b| b.state.policy.as_ref()) {
        if call.tool_name == "exec_command" {
            if call.arguments["cwd"]
                .as_str()
                .is_some_and(|cwd| cwd != policy.workspace)
            {
                return Err(
                    "SANDBOX_WORKSPACE_MISMATCH: the executor starts in the configured workspace"
                        .into(),
                );
            }
        } else if !matches!(owner, AgentToolTargetNative::Remote { root_path: Some(root), .. } if policy.contains(root))
        {
            return Err("SANDBOX_WORKSPACE_MISMATCH: the Agent file root must be within the configured workspace".into());
        }
    }
    Ok(binding)
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        Err(format!("Invalid native {label}"))
    } else {
        Ok(())
    }
}

fn ensure_unmanaged_call(
    database: &Database,
    context: &NativeExecutionContext,
    call: &AgentToolCallNative,
) -> Result<(), String> {
    if let AgentToolTargetNative::Process {
        owner_target_id, ..
    } = &call.target
    {
        let owner = context
            .request
            .targets
            .iter()
            .find(|target| target.target_id() == owner_target_id)
            .ok_or("Native process owner is not on the frozen request")?;
        return crate::sudo_policy::require_ordinary_remote_account(database, owner);
    }
    crate::sudo_policy::require_ordinary_remote_account(database, &call.target)
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
        return Err("Remote execution requires a frozen profile id".into());
    };
    connection_for_saved_profile(profile_id, host, *port, username, database, credentials)
}

pub(crate) fn connection_for_saved_profile(
    profile_id: &str,
    host: &str,
    port: u16,
    username: &str,
    database: &Database,
    credentials: &CredentialManager,
) -> Result<RemoteConnectionRequest, String> {
    let profile = database
        .get_profile(profile_id)?
        .ok_or_else(|| "Remote execution profile was not found".to_string())?;
    if profile.host != host || profile.port != port || profile.username != username {
        return Err("Remote execution profile identity drifted".into());
    }
    let auth_method = match profile.auth_method {
        ProfileAuthMethod::Password => AuthMethod::Password,
        ProfileAuthMethod::Key => AuthMethod::Key,
        ProfileAuthMethod::Agent => AuthMethod::Agent,
        ProfileAuthMethod::KeyboardInteractive => AuthMethod::KeyboardInteractive,
    };
    let jump_host =
        resolve_profile_jump_host(profile_id, profile.jump_host_config.as_deref(), credentials)?;
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
        return Err("Remote profile password is unavailable".into());
    }
    crate::commands::resolve_keychain_key_for_remote(credentials, &mut connection)?;
    if auth_method == AuthMethod::Key && connection.private_key_data.is_none() {
        return Err("Remote profile private key is unavailable".into());
    }
    Ok(connection)
}

fn resolve_profile_jump_host(
    profile_id: &str,
    config: Option<&str>,
    credentials: &CredentialManager,
) -> Result<Option<JumpHostConfig>, String> {
    let Some(config) = config else {
        return Ok(None);
    };
    let mut jump: JumpHostConfig =
        serde_json::from_str(config).map_err(|_| "Stored jump-host identity is invalid")?;
    match jump.auth_method {
        AuthMethod::Password => {
            jump.password = Some(
                credentials
                    .retrieve_profile_secret(profile_id, ProfileSecretKind::JumpPassword)?
                    .ok_or("jump-host password is unavailable")?,
            );
        }
        AuthMethod::Key => {
            jump.passphrase = credentials
                .retrieve_profile_secret(profile_id, ProfileSecretKind::JumpPassphrase)?;
        }
        AuthMethod::Agent | AuthMethod::KeyboardInteractive => {}
    }
    Ok(Some(jump))
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

#[cfg(test)]
mod tests {
    use super::super::inspect_call_policy_scope_native;
    use super::*;
    use crate::agent_runtime::native::TerminalSubmissionError;
    use crate::agent_runtime::{TerminalInteractiveInputKindNative, TerminalKeyNative};
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, StatusEvent,
    };
    use crate::terminal_broker::TerminalGeometry;
    use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};
    use crossbeam_channel::unbounded;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    #[test]
    fn terminal_reconnect_reports_unavailable_integration_for_visible_execution() {
        const TERMINAL: &str = "plain-ssh";
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        broker
            .attach_transport(
                TERMINAL,
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        let engine = NativeToolEngine::with_terminal_broker(broker);
        assert!(engine
            .verify_reconnect_transport("previous", TERMINAL, true)
            .unwrap_err()
            .starts_with("TERMINAL_RECONNECT_BUSY:"));

        for (reason, error) in [
            (
                crate::session::SSH_NATIVE_RESOURCES_UNAVAILABLE,
                "TERMINAL_RECONNECT_NATIVE_RESOURCES_UNAVAILABLE",
            ),
            (
                "nativeProfileMismatch",
                "TERMINAL_RECONNECT_INTEGRATION_UNAVAILABLE",
            ),
        ] {
            engine
                .mark_terminal_integration_unavailable(TERMINAL, TerminalShellKind::Bash, reason)
                .unwrap();
            assert_eq!(
                engine.verify_reconnect_transport("previous", TERMINAL, true),
                Err(error.into())
            );
            assert_eq!(
                engine.verify_reconnect_transport("previous", TERMINAL, false),
                Ok(false)
            );
        }
    }

    fn engine_with_terminal_broker_for_test(
        terminal_broker: TerminalSessionBroker,
    ) -> NativeToolEngine {
        let terminal_leases = TerminalLeaseManager::new(terminal_broker.clone());
        let acknowledger = terminal_leases.clone();
        terminal_leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let terminal_execute =
            TerminalExecuteRegistry::new(terminal_leases.clone(), terminal_broker.clone());
        let terminal_interactive =
            TerminalInteractiveRegistry::new(terminal_leases.clone(), terminal_broker.clone());
        NativeToolEngine {
            registry: Arc::new(
                ToolRegistryNative::from_builtin_manifest().expect("valid native tool manifest"),
            ),
            capabilities: NativeCapabilityStoreNative::default(),
            processes: ProcessRegistryNative::default(),
            terminal_execute,
            terminal_interactive,
            terminal_leases,
            terminal_broker,
            checkpoints: CheckpointStoreNative::default(),
            file_operations: FileOperationRegistryNative::default(),
            checkpoint_root: Arc::new(Mutex::new(None)),
            sudo_prompts: Arc::default(),
            tool_progress: ToolProgressHub::default(),
            #[cfg(target_os = "macos")]
            mac_sandbox_paths: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "linux")]
            local_sandbox: None,
        }
    }

    #[test]
    fn manual_handoff_releases_only_the_same_agents_settled_interactive_lease() {
        const TERMINAL: &str = "manual-handoff-pty";
        const INTEGRATION: &str = "manual-handoff-integration";
        const AGENT: &str = "manual-handoff-agent";
        const TASK: &str = "manual-handoff-task";
        let broker = TerminalSessionBroker::phase5_enabled_for_test(4096);
        broker
            .attach_transport(
                TERMINAL,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        broker
            .register_integration_channel(TERMINAL, INTEGRATION, TerminalShellKind::Bash)
            .unwrap();
        let observe = |event| {
            broker
                .accept_integration_event(TERMINAL, INTEGRATION, event)
                .unwrap()
        };
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        observe(TerminalIntegrationControlEvent::Ready {
            shell: TerminalShellKind::Bash,
        });
        observe(TerminalIntegrationControlEvent::PromptStart { cwd: cwd.clone() });
        observe(TerminalIntegrationControlEvent::PromptEnd);

        let engine = engine_with_terminal_broker_for_test(broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                TERMINAL.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: TERMINAL.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "bash".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        engine.begin_terminal_turn(TERMINAL, AGENT).unwrap();
        engine
            .terminal_interactive
            .write(
                &sessions,
                TERMINAL,
                AGENT,
                TASK,
                TerminalInteractiveInputKindNative::Text,
                Some("pwd"),
                None,
            )
            .unwrap();
        engine
            .terminal_interactive
            .write(
                &sessions,
                TERMINAL,
                AGENT,
                TASK,
                TerminalInteractiveInputKindNative::Key,
                None,
                Some(TerminalKeyNative::Enter),
            )
            .unwrap();
        assert!(
            matches!(receiver.try_recv().unwrap(), SessionCommand::Write(input) if input == "pwd")
        );
        assert!(
            matches!(receiver.try_recv().unwrap(), SessionCommand::Write(input) if input == "\r")
        );
        assert_eq!(
            engine
                .with_terminal_manual_input::<()>(TERMINAL, AGENT, TASK, true, || {
                    panic!("the prompt predates the last interactive input")
                })
                .unwrap_err(),
            super::super::TERMINAL_MANUAL_HANDOFF_BUSY
        );
        observe(TerminalIntegrationControlEvent::CommandStart {
            command_line: "pwd".into(),
            cwd: cwd.clone(),
        });
        assert_eq!(
            engine
                .with_terminal_manual_input::<()>(TERMINAL, AGENT, TASK, true, || {
                    panic!("a foreground command still owns the terminal")
                })
                .unwrap_err(),
            super::super::TERMINAL_MANUAL_HANDOFF_BUSY
        );
        observe(TerminalIntegrationControlEvent::CommandEnd {
            exit_code: 0,
            cwd: cwd.clone(),
        });
        observe(TerminalIntegrationControlEvent::PromptStart { cwd });
        observe(TerminalIntegrationControlEvent::PromptEnd);
        assert_eq!(
            engine
                .with_terminal_manual_input::<()>(TERMINAL, "other-agent", TASK, true, || {
                    panic!("another Agent cannot release this lease")
                })
                .unwrap_err(),
            super::super::TERMINAL_MANUAL_HANDOFF_BUSY
        );
        assert!(engine.terminal_interactive.has_operation(TERMINAL).unwrap());

        engine
            .with_terminal_manual_input(TERMINAL, AGENT, TASK, true, || Ok(()))
            .unwrap();
        assert!(!engine.terminal_interactive.has_operation(TERMINAL).unwrap());
        assert_eq!(
            engine.terminal_turn_owner(TERMINAL).unwrap().as_deref(),
            Some(AGENT)
        );
        engine
            .write_user_terminal_input(&sessions, TERMINAL, "pwd\r".into())
            .unwrap();
        assert!(
            matches!(receiver.try_recv().unwrap(), SessionCommand::Write(input) if input == "pwd\r")
        );
    }

    #[test]
    fn submission_cancellation_preserves_execution_and_recovery_boundaries() {
        let engine = NativeToolEngine::default();
        let target = AgentToolTargetNative::Local {
            target_id: "cancel-target".into(),
            session_id: "cancel-terminal".into(),
            cwd: None,
        };
        let context = NativeExecutionContext {
            #[cfg(windows)]
            windows_sandbox_required: false,
            #[cfg(target_os = "macos")]
            mac_sandbox_required: false,
            bound_terminal_surface: false,
            request: AgentRequestNative {
                contract_version: crate::agent_runtime::NATIVE_TOOL_CONTRACT_VERSION,
                request_id: "cancel-request".into(),
                user_session_id: "cancel-agent".into(),
                task_id: "cancel-task".into(),
                goal: "cancel before submission".into(),
                success_criteria: vec!["preserve uncertainty and recovery".into()],
                targets: vec![target.clone()],
                permission_mode: AgentPermissionModeNative::Operator,
            },
            turn_id: "cancel-turn".into(),
            step_id: "cancel-step".into(),
        };
        let call = AgentToolCallNative {
            request_id: context.request.request_id.clone(),
            call_id: "cancel-operation".into(),
            tool_name: "terminal_execute".into(),
            arguments: json!({ "command": "must not execute" }),
            target,
            capability_id: "cancel-capability".into(),
        };
        let effect = AgentObservedEffectNative {
            kind: AgentEffectKindNative::StateChange,
            target_id: "cancel-target".into(),
            summary: "cancel test".into(),
            paths: Vec::new(),
            network_destinations: Vec::new(),
        };
        for (message, attempted, status, state, execution, code, action) in [
            (
                "TERMINAL_SUBMISSION_CANCELLED",
                false,
                AgentToolResultStatusNative::Cancelled,
                "cancelled",
                "notStarted",
                "TERMINAL_SUBMISSION_CANCELLED",
                "recoverTerminal",
            ),
            (
                "TERMINAL_JOB_LAUNCH_CANCELLED",
                false,
                AgentToolResultStatusNative::Cancelled,
                "cancelled",
                "notStarted",
                "TERMINAL_SUBMISSION_CANCELLED",
                "recoverTerminal",
            ),
            (
                "TERMINAL_SUBMISSION_CANCELLED",
                true,
                AgentToolResultStatusNative::Uncertain,
                "uncertain",
                "unknown",
                "TERMINAL_SUBMISSION_UNCONFIRMED",
                "reconcile",
            ),
            (
                "TERMINAL_JOB_LAUNCH_CANCELLED",
                true,
                AgentToolResultStatusNative::Uncertain,
                "uncertain",
                "unknown",
                "TERMINAL_SUBMISSION_UNCONFIRMED",
                "reconcile",
            ),
            (
                "TERMINAL_NATIVE_INPUT_REQUIRED",
                false,
                AgentToolResultStatusNative::Failed,
                "failed",
                "notStarted",
                "TERMINAL_SUBMISSION_REJECTED",
                "recoverTerminal",
            ),
        ] {
            let result = engine
                .terminal_submission_failure(
                    &context,
                    &call,
                    &effect,
                    "cancel-terminal",
                    None,
                    TerminalSubmissionError {
                        message: message.into(),
                        submission_attempted: attempted,
                    },
                )
                .unwrap();
            assert_eq!(result.status, status, "{message}/{attempted}");
            let data = result.data.unwrap();
            assert_eq!(data["state"], state);
            assert_eq!(data["execution"], execution);
            assert_eq!(data["errorDetails"]["code"], code);
            assert_eq!(data["errorDetails"]["nextAction"], action);
            // A result label cannot manufacture a clear receipt or reopen input.
            assert_eq!(data["errorDetails"]["terminalRecoveryRequired"], true);
            assert_eq!(data["noAutoReplay"], true);
            assert_eq!(data["operationId"], call.call_id);
        }
    }

    #[test]
    fn mcp_capability_issuance_preserves_full_access_and_gates_other_modes() {
        let engine = NativeToolEngine::default();
        let workspace = tempfile::tempdir().unwrap();
        let target = AgentToolTargetNative::Local {
            target_id: "target".into(),
            session_id: "terminal".into(),
            cwd: Some(workspace.path().to_string_lossy().into()),
        };
        let mut prepared = PreparedMcpAuthorizationNative {
            context: NativeExecutionContext {
                #[cfg(windows)]
                windows_sandbox_required: false,
                #[cfg(target_os = "macos")]
                mac_sandbox_required: false,
                bound_terminal_surface: false,
                request: AgentRequestNative {
                    contract_version: crate::agent_runtime::NATIVE_TOOL_CONTRACT_VERSION,
                    request_id: "request".into(), user_session_id: "session".into(), task_id: "task".into(),
                    goal: "Inspect workspace".into(), success_criteria: vec![], targets: vec![target.clone()],
                    permission_mode: AgentPermissionModeNative::Operator,
                },
                turn_id: "turn".into(), step_id: "step".into(),
            },
            call: AgentToolCallNative {
                request_id: "request".into(), call_id: "call".into(), tool_name: "mcp:local:read".into(),
                arguments: json!({}), target, capability_id: "pending".into(),
            },
            server: serde_json::from_value(json!({"id":"local", "transport":"stdio", "command":"true", "args":[], "enabled":true})).unwrap(),
            tool_name: "read".into(), workspace_root: workspace.path().into(),
            effect: AgentObservedEffectNative { kind: AgentEffectKindNative::ReadOnly, target_id: "target".into(), summary: "Read workspace".into(), paths: vec![], network_destinations: vec![] },
            ttl_ms: DEFAULT_CAPABILITY_TTL_MS, native_prompt: "Approve read".into(),
        };
        assert!(engine
            .issue_prepared_mcp_authorization(&prepared, false)
            .is_ok());
        for mode in [
            AgentPermissionModeNative::RequestApproval,
            AgentPermissionModeNative::ScopedAutopilot,
        ] {
            prepared.context.request.permission_mode = mode;
            assert!(engine
                .issue_prepared_mcp_authorization(&prepared, false)
                .unwrap_err()
                .contains("approval was denied"));
        }
        assert!(engine
            .issue_prepared_mcp_authorization(&prepared, true)
            .is_ok());
    }

    #[test]
    fn portable_scratch_paths_resolve_missing_descendants_with_directory_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path().join("tmp");
        let sibling = root.path().join("tmp-other");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let canonical = std::fs::canonicalize(&managed).unwrap();
        for path in [
            managed.join("future/nested/script.ps1"),
            managed.join("..").join("tmp/future/script.ps1"),
        ] {
            let portable = crate::portable_local_path(&path);
            assert!(resolve_runtime_storage_path(Path::new(&portable)).starts_with(&canonical));
        }
        let portable = crate::portable_local_path(&sibling.join("script.ps1"));
        assert!(!resolve_runtime_storage_path(Path::new(&portable)).starts_with(&canonical));
    }

    #[test]
    fn portable_scratch_paths_are_denied_before_approval() {
        let engine = NativeToolEngine::default();
        let root = tempfile::tempdir().unwrap();
        let data_root = root.path().join("data");
        let workspace = root.path().join("work");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&data_root).unwrap();
        engine.configure_checkpoint_root(data_root.clone()).unwrap();
        let target = AgentToolTargetNative::Local {
            target_id: "reader-terminal".into(),
            session_id: "terminal".into(),
            cwd: Some(crate::portable_local_path(&workspace)),
        };
        let context = NativeExecutionContext {
            #[cfg(windows)]
            windows_sandbox_required: false,
            #[cfg(target_os = "macos")]
            mac_sandbox_required: false,
            bound_terminal_surface: false,
            request: AgentRequestNative {
                contract_version: crate::agent_runtime::NATIVE_TOOL_CONTRACT_VERSION,
                request_id: "request".into(),
                user_session_id: "scratch-reader".into(),
                task_id: "scratch-reader".into(),
                goal: "Read a proposed file".into(),
                success_criteria: vec![],
                targets: vec![target.clone()],
                permission_mode: AgentPermissionModeNative::RequestApproval,
            },
            turn_id: "turn".into(),
            step_id: "step".into(),
        };
        for relative in [
            "tmp/0123456789abcdef/owner.ps1",
            "agent-runtime/scratch/records/owner.json",
        ] {
            let file = data_root.join(relative);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "owner-only").unwrap();
            let canonical = std::fs::canonicalize(&file).unwrap();
            for path in [
                crate::portable_local_path(&canonical),
                canonical.to_string_lossy().into_owned(),
            ] {
                let call = AgentToolCallNative {
                    request_id: "request".into(),
                    call_id: "reader-read".into(),
                    tool_name: "read_file".into(),
                    arguments: json!({"path": path, "encoding": "utf8"}),
                    target: target.clone(),
                    capability_id: "pending-native-capability".into(),
                };
                let effect =
                    assess_effect_native(&engine.tool("read_file").unwrap().descriptor, &call)
                        .unwrap();
                let scope = inspect_call_policy_scope_native(&call).unwrap();
                let result = engine.enforce_runtime_storage_policy_for_session(
                    &context, &call, &effect, &scope, None,
                );
                assert!(
                    result.is_err_and(|error| error.starts_with("AGENT_SCRATCH_SCOPE_DENIED")),
                    "managed scratch path reached approval policy: {path}"
                );
                assert_eq!(std::fs::read_to_string(&file).unwrap(), "owner-only");
            }
        }
    }

    #[test]
    fn agent_file_tools_cannot_modify_runtime_storage() {
        let engine = NativeToolEngine::default();
        let root = tempfile::tempdir().unwrap();
        engine
            .configure_checkpoint_root(root.path().into())
            .unwrap();
        let call = AgentToolCallNative {
            request_id: "request".into(),
            call_id: "call".into(),
            tool_name: "write_file".into(),
            arguments: json!({"path":"approvals.json", "content":"{}", "precondition":{"mustNotExist":true}}),
            target: AgentToolTargetNative::Local {
                target_id: "local".into(),
                session_id: "terminal".into(),
                cwd: Some(root.path().to_string_lossy().into()),
            },
            capability_id: "pending".into(),
        };
        let effect =
            assess_effect_native(&engine.tool("write_file").unwrap().descriptor, &call).unwrap();
        let scope = inspect_call_policy_scope_native(&call).unwrap();
        assert!(engine
            .enforce_runtime_storage_policy(&call, &effect, &scope, None)
            .unwrap_err()
            .starts_with("AGENT_CRITICAL_OPERATION_DENIED"));
        assert!(!root.path().join("approvals.json").exists());
        let mut download = call.clone();
        download.tool_name = "transfer_file".into();
        download.target = AgentToolTargetNative::Remote {
            target_id: "remote".into(),
            session_id: "terminal".into(),
            profile_id: Some("profile".into()),
            host: "localhost".into(),
            port: 22,
            username: "operator".into(),
            root_path: Some("/workspace".into()),
            local_root: Some(root.path().to_string_lossy().into()),
        };
        download.arguments = json!({"direction":"download", "sourcePath":"approvals.json", "destinationPath":"approvals.json", "overwrite":false});
        let effect =
            assess_effect_native(&engine.tool("transfer_file").unwrap().descriptor, &download)
                .unwrap();
        let scope = inspect_call_policy_scope_native(&download).unwrap();
        assert!(engine
            .enforce_runtime_storage_policy(&download, &effect, &scope, None)
            .unwrap_err()
            .starts_with("AGENT_CRITICAL_OPERATION_DENIED"));

        // Verified managed sandbox workspace under <data_dir>/sandboxes/<hash>/workspace
        // may be written to, while sibling data/ and ShellSpan data files remain protected.
        let workspace = root
            .path()
            .join("sandboxes/0123456789abcdef0123456789abcdef/workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let ws_call = AgentToolCallNative {
            request_id: "request".into(),
            call_id: "ws-write".into(),
            tool_name: "write_file".into(),
            arguments: json!({"path":"src/index.ts", "content":"export {};", "precondition":{"mustNotExist":true}}),
            target: AgentToolTargetNative::Local {
                target_id: "local".into(),
                session_id: "terminal".into(),
                cwd: Some(workspace.to_string_lossy().into()),
            },
            capability_id: "pending".into(),
        };
        let ws_effect =
            assess_effect_native(&engine.tool("write_file").unwrap().descriptor, &ws_call).unwrap();
        let ws_scope =
            inspect_call_policy_scope_with_managed_root_native(&ws_call, Some(&workspace)).unwrap();
        assert!(engine
            .enforce_runtime_storage_policy(&ws_call, &ws_effect, &ws_scope, Some(&workspace))
            .is_ok());
        assert!(engine
            .enforce_runtime_storage_policy(&ws_call, &ws_effect, &ws_scope, None)
            .unwrap_err()
            .starts_with("AGENT_CRITICAL_OPERATION_DENIED"));
        let escape_call = AgentToolCallNative {
            arguments: json!({"path":"../data/identity", "content":"bad", "precondition":{"mustNotExist":true}}),
            ..ws_call
        };
        let escape_scope =
            inspect_call_policy_scope_with_managed_root_native(&escape_call, Some(&workspace))
                .unwrap();
        assert!(engine
            .enforce_runtime_storage_policy(
                &escape_call,
                &ws_effect,
                &escape_scope,
                Some(&workspace),
            )
            .unwrap_err()
            .starts_with("AGENT_CRITICAL_OPERATION_DENIED"));
    }

    #[test]
    fn execution_context_is_call_scoped_and_rejects_missing_step_identity() {
        let context = NativeExecutionContext {
            #[cfg(windows)]
            windows_sandbox_required: false,
            #[cfg(target_os = "macos")]
            mac_sandbox_required: false,
            bound_terminal_surface: false,
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
        assert_eq!(context.validate(), Err("Invalid native step id".into()));
    }

    #[test]
    fn native_confirmation_respects_the_frozen_permission_mode() {
        assert!(super::super::requires_call_confirmation_native(
            AgentPermissionModeNative::RequestApproval,
            "list_directory",
            AgentEffectKindNative::ReadOnly,
            0,
        ));
        assert!(super::super::requires_call_confirmation_native(
            AgentPermissionModeNative::ScopedAutopilot,
            "read_terminal",
            AgentEffectKindNative::SensitiveRead,
            0,
        ));
        assert!(super::super::requires_call_confirmation_native(
            AgentPermissionModeNative::ScopedAutopilot,
            "write_file",
            AgentEffectKindNative::StateChange,
            0,
        ));
        assert!(super::super::requires_call_confirmation_native(
            AgentPermissionModeNative::ScopedAutopilot,
            "list_directory",
            AgentEffectKindNative::ReadOnly,
            1,
        ));
        assert!(!super::super::requires_call_confirmation_native(
            AgentPermissionModeNative::ScopedAutopilot,
            "list_directory",
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
            assert!(!super::super::requires_call_confirmation_native(
                AgentPermissionModeNative::Operator,
                "exec_command",
                effect,
                1,
            ));
        }
        assert!(!super::super::requires_call_confirmation_native(
            AgentPermissionModeNative::Operator,
            "apply_patch",
            AgentEffectKindNative::Destructive,
            0,
        ));
    }

    #[test]
    fn operator_skips_confirmation_for_local_remote_and_terminal_calls() {
        let scoped_local = AgentToolCallNative {
            request_id: "request-scope".into(),
            call_id: "call-scope".into(),
            tool_name: "exec_command".into(),
            arguments: json!({}),
            target: AgentToolTargetNative::Local {
                target_id: "target-local".into(),
                session_id: "terminal-local".into(),
                cwd: Some("/workspace".into()),
            },
            capability_id: "pending".into(),
        };

        let mut unrooted = scoped_local.clone();
        unrooted.target = AgentToolTargetNative::Local {
            target_id: "target-local".into(),
            session_id: "terminal-local".into(),
            cwd: None,
        };

        let mut remote = scoped_local.clone();
        remote.target = AgentToolTargetNative::Remote {
            target_id: "target-remote".into(),
            session_id: "terminal-remote".into(),
            profile_id: Some("profile-remote".into()),
            host: "example.test".into(),
            port: 22,
            username: "tester".into(),
            root_path: Some("/workspace".into()),
            local_root: None,
        };
        for mut call in [scoped_local, unrooted, remote] {
            for tool in ["exec_command", "terminal_execute", "write_terminal_input"] {
                call.tool_name = tool.into();
                call.arguments = json!({
                    "command": "ls -la /usr/share/nginx/html/ 2>/dev/null; cat /etc/nginx/nginx.conf | head -20",
                    "explanation": "inspect nginx configuration"
                });
                let scope = inspect_call_policy_scope_native(&call).unwrap();
                assert!(!super::super::requires_call_confirmation_native(
                    AgentPermissionModeNative::Operator,
                    tool,
                    AgentEffectKindNative::StateChange,
                    scope.sensitive_path_count,
                ));
                assert!(super::super::requires_call_confirmation_native(
                    AgentPermissionModeNative::ScopedAutopilot,
                    tool,
                    AgentEffectKindNative::StateChange,
                    scope.sensitive_path_count,
                ));
            }
        }
    }

    #[test]
    #[cfg(unix)]
    fn operator_direct_execution_can_write_outside_its_working_directory() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let target = AgentToolTargetNative::Local {
            target_id: "target-full-access".into(),
            session_id: "terminal-full-access".into(),
            cwd: Some(workspace.to_str().unwrap().into()),
        };
        let context = NativeExecutionContext {
            #[cfg(windows)]
            windows_sandbox_required: false,
            #[cfg(target_os = "macos")]
            mac_sandbox_required: false,
            bound_terminal_surface: false,
            request: AgentRequestNative {
                contract_version: crate::agent_runtime::NATIVE_TOOL_CONTRACT_VERSION,
                request_id: "request-full-access".into(),
                user_session_id: "session-full-access".into(),
                task_id: "task-full-access".into(),
                goal: "write outside the working directory".into(),
                success_criteria: vec!["file exists outside the workspace".into()],
                targets: vec![target.clone()],
                permission_mode: AgentPermissionModeNative::Operator,
            },
            turn_id: "turn-full-access".into(),
            step_id: "step-full-access".into(),
        };
        let call = AgentToolCallNative {
            request_id: context.request.request_id.clone(),
            call_id: "call-full-access".into(),
            tool_name: "exec_command".into(),
            arguments: json!({
                "command": "printf full-access > ../outside.txt",
                "explanation": "verify full-access filesystem execution",
                "cwd": workspace.to_str().unwrap(),
                "channel": "direct"
            }),
            target,
            capability_id: "pending".into(),
        };
        let engine = NativeToolEngine::default();
        let effect =
            assess_effect_native(&engine.tool("exec_command").unwrap().descriptor, &call).unwrap();
        let database = Database::open(&directory.path().join("runtime.db")).unwrap();
        let result = engine
            .execute_command(
                &context,
                &call,
                &effect,
                &SessionManager::default(),
                &database,
                &CredentialManager::new(),
                &directory.path().join("known_hosts"),
                5_000,
                1,
                None,
                &CancellationToken::new(),
                None,
                None,
                #[cfg(windows)]
                None,
                #[cfg(target_os = "macos")]
                None,
                #[cfg(all(
                    feature = "native-input-acceptance",
                    debug_assertions,
                    target_os = "macos",
                    target_arch = "aarch64"
                ))]
                None,
                #[cfg(target_os = "linux")]
                None,
            )
            .unwrap();
        assert_eq!(result.status, AgentToolResultStatusNative::Completed);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("outside.txt")).unwrap(),
            "full-access"
        );
    }

    #[test]
    fn remote_terminal_execute_reuses_the_frozen_source_and_rejects_raw_agent_input() {
        const SOURCE_SESSION_ID: &str = "user-owned-remote-terminal";
        const INTEGRATION_ID: &str = "integration-user-owned-remote-terminal";
        const COMMAND: &str = "printf source-shell";

        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        broker
            .attach_transport(
                SOURCE_SESSION_ID,
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap();
        broker
            .register_integration_channel(
                SOURCE_SESSION_ID,
                INTEGRATION_ID,
                TerminalShellKind::Bash,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Bash,
            },
            TerminalIntegrationControlEvent::PromptStart {
                cwd: "/home/tester".into(),
            },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event(SOURCE_SESSION_ID, INTEGRATION_ID, event)
                .unwrap();
        }

        let engine = engine_with_terminal_broker_for_test(broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                SOURCE_SESSION_ID.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: SOURCE_SESSION_ID.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Remote,
                    identity: SessionIdentity {
                        title: "fixture.example".into(),
                        host: "fixture.example".into(),
                        port: 22,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();

        let target = AgentToolTargetNative::Remote {
            target_id: "target-remote".into(),
            session_id: SOURCE_SESSION_ID.into(),
            profile_id: Some("profile-remote".into()),
            host: "fixture.example".into(),
            port: 22,
            username: "tester".into(),
            root_path: None,
            local_root: None,
        };
        let context = NativeExecutionContext {
            #[cfg(windows)]
            windows_sandbox_required: false,
            #[cfg(target_os = "macos")]
            mac_sandbox_required: false,
            bound_terminal_surface: false,
            request: AgentRequestNative {
                contract_version: crate::agent_runtime::NATIVE_TOOL_CONTRACT_VERSION,
                request_id: "request-remote-source".into(),
                user_session_id: "agent-session-1".into(),
                task_id: "task-1".into(),
                goal: "reuse the visible remote shell".into(),
                success_criteria: vec!["command runs in the frozen source Session".into()],
                targets: vec![target.clone()],
                permission_mode: AgentPermissionModeNative::Operator,
            },
            turn_id: "turn-1".into(),
            step_id: "step-1".into(),
        };
        let call = AgentToolCallNative {
            request_id: context.request.request_id.clone(),
            call_id: "operation-1".into(),
            tool_name: "terminal_execute".into(),
            arguments: json!({
                "command": COMMAND,
                "explanation": "verify source terminal routing",
                "timeoutMs": 1_000
            }),
            target,
            capability_id: "test-capability".into(),
        };
        let effect = AgentObservedEffectNative {
            kind: AgentEffectKindNative::StateChange,
            target_id: "target-remote".into(),
            summary: "execute in the visible remote shell".into(),
            paths: Vec::new(),
            network_destinations: Vec::new(),
        };

        assert_eq!(
            engine
                .interactive_terminal_session_id(&context, &call, &sessions)
                .unwrap(),
            SOURCE_SESSION_ID,
            "remote interactive tools must resolve the same frozen source sessionId"
        );

        let session_count_before = sessions.session_count().unwrap();
        let first_result = engine.execute_terminal_command(
            &context,
            &call,
            &effect,
            &sessions,
            None,
            1_000,
            &CancellationToken::new(),
            None,
        );
        let mut second_call = call.clone();
        second_call.call_id = "operation-2".into();
        let second_result = engine.execute_terminal_command(
            &context,
            &second_call,
            &effect,
            &sessions,
            None,
            1_000,
            &CancellationToken::new(),
            None,
        );
        assert!(
            first_result.is_ok() && second_result.is_ok(),
            "consecutive remote terminal_execute calls must reuse the frozen source session: first={first_result:?} second={second_result:?}"
        );
        for result in [first_result.unwrap(), second_result.unwrap()] {
            assert_eq!(result.status, AgentToolResultStatusNative::Failed);
            assert!(result.summary.contains("TERMINAL_NATIVE_INPUT_REQUIRED"));
            let data = result.data.unwrap();
            assert_eq!(data["execution"], "notStarted");
            assert_eq!(data["noAutoReplay"], true);
        }
        assert_eq!(
            engine
                .interactive_terminal_session_id(&context, &second_call, &sessions)
                .unwrap(),
            SOURCE_SESSION_ID,
        );
        assert_eq!(sessions.session_count().unwrap(), session_count_before);
        assert!(
            receiver.try_recv().is_err(),
            "raw Agent refusal must not write PTY bytes"
        );
        let terminal = broker
            .snapshot(Some(SOURCE_SESSION_ID))
            .unwrap()
            .session
            .unwrap();
        assert!(
            terminal.open
                && matches!(
                    terminal.lease.unwrap().owner,
                    TerminalLeaseOwner::User { .. }
                )
        );
        engine
            .write_user_terminal_input(&sessions, SOURCE_SESSION_ID, "ordinary-user-input".into())
            .unwrap();
        assert!(
            matches!(receiver.recv_timeout(Duration::from_millis(250)).unwrap(), SessionCommand::Write(input) if input == "ordinary-user-input")
        );
    }

    #[test]
    fn remote_rollout_disable_releases_agent_protection_without_closing_user_transport() {
        const SOURCE_SESSION_ID: &str = "user-owned-remote-terminal";
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        broker
            .attach_transport(
                SOURCE_SESSION_ID,
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap();
        broker
            .register_integration_channel(
                SOURCE_SESSION_ID,
                "integration-user-owned-remote-terminal",
                TerminalShellKind::Bash,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Bash,
            },
            TerminalIntegrationControlEvent::PromptStart {
                cwd: "/home/tester".into(),
            },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event(
                    SOURCE_SESSION_ID,
                    "integration-user-owned-remote-terminal",
                    event,
                )
                .unwrap();
        }
        let engine = engine_with_terminal_broker_for_test(broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                SOURCE_SESSION_ID.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: SOURCE_SESSION_ID.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Remote,
                    identity: SessionIdentity {
                        title: "fixture.example".into(),
                        host: "fixture.example".into(),
                        port: 22,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        engine
            .begin_terminal_turn(SOURCE_SESSION_ID, "agent-session-1")
            .unwrap();
        engine
            .terminal_leases
            .acquire(
                SOURCE_SESSION_ID,
                "agent-session-1",
                "task-1",
                "operation-1",
                None,
            )
            .unwrap();

        broker.set_remote_visible_rollout_for_test(false).unwrap();
        engine.reconcile_remote_visible_rollout().unwrap();

        let snapshot = broker
            .snapshot(Some(SOURCE_SESSION_ID))
            .unwrap()
            .session
            .unwrap();
        assert!(snapshot.open);
        assert!(matches!(
            snapshot.lease.unwrap().owner,
            TerminalLeaseOwner::User { .. }
        ));
        assert!(!engine.has_terminal_lease(SOURCE_SESSION_ID).unwrap());
        assert_eq!(
            engine
                .begin_terminal_turn(SOURCE_SESSION_ID, "agent-session-1")
                .unwrap_err(),
            "TERMINAL_VISIBLE_COMMAND_UNAVAILABLE"
        );
        engine
            .write_user_terminal_input(&sessions, SOURCE_SESSION_ID, "user-input".into())
            .unwrap();
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(250)).unwrap(),
            SessionCommand::Write(data) if data == "user-input"
        ));
    }

    #[test]
    fn remote_terminal_execution_revalidates_frozen_identity_after_lease_before_write() {
        const SOURCE_SESSION_ID: &str = "user-owned-remote-terminal";
        const INTEGRATION_ID: &str = "integration-user-owned-remote-terminal";
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        broker
            .attach_transport(
                SOURCE_SESSION_ID,
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap();
        broker
            .register_integration_channel(
                SOURCE_SESSION_ID,
                INTEGRATION_ID,
                TerminalShellKind::Bash,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Bash,
            },
            TerminalIntegrationControlEvent::PromptStart {
                cwd: "/home/tester".into(),
            },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event(SOURCE_SESSION_ID, INTEGRATION_ID, event)
                .unwrap();
        }
        let engine = engine_with_terminal_broker_for_test(broker);
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                SOURCE_SESSION_ID.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: SOURCE_SESSION_ID.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Remote,
                    identity: SessionIdentity {
                        title: "fixture.example".into(),
                        host: "fixture.example".into(),
                        port: 22,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        let acknowledger = engine.terminal_leases.clone();
        let drifting_sessions = sessions.clone();
        engine
            .terminal_leases
            .set_publisher(Arc::new(move |event| {
                if event.state != super::super::TerminalLeaseEventState::Acquired {
                    return;
                }
                let (drift_sender, _drift_receiver) = unbounded();
                drifting_sessions
                    .insert(
                        SOURCE_SESSION_ID.into(),
                        ManagedSession {
                            sender: SessionCommandSender::Event(drift_sender),
                            waker: None,
                            output_state_sender: None,
                            status: StatusEvent {
                                session_id: SOURCE_SESSION_ID.into(),
                                status: SessionStatus::Connected,
                                message: None,
                            },
                            output_ready: Arc::new(AtomicBool::new(true)),
                            output_paused: Arc::new(AtomicBool::new(false)),
                            terminal_kind: SessionTerminalKind::Remote,
                            identity: SessionIdentity {
                                title: "drifted.example".into(),
                                host: "drifted.example".into(),
                                port: 2222,
                                username: "other".into(),
                            },
                        },
                    )
                    .unwrap();
                acknowledger
                    .acknowledge_frontend_ready(
                        &event.session_id,
                        &event.agent_session_id,
                        &event.operation_id,
                        true,
                        true,
                        false,
                        false,
                        false,
                    )
                    .unwrap();
            }))
            .unwrap();

        let target = AgentToolTargetNative::Remote {
            target_id: "target-remote".into(),
            session_id: SOURCE_SESSION_ID.into(),
            profile_id: Some("profile-remote".into()),
            host: "fixture.example".into(),
            port: 22,
            username: "tester".into(),
            root_path: None,
            local_root: None,
        };
        let context = NativeExecutionContext {
            #[cfg(windows)]
            windows_sandbox_required: false,
            #[cfg(target_os = "macos")]
            mac_sandbox_required: false,
            bound_terminal_surface: false,
            request: AgentRequestNative {
                contract_version: crate::agent_runtime::NATIVE_TOOL_CONTRACT_VERSION,
                request_id: "request-remote-revalidate".into(),
                user_session_id: "agent-session-1".into(),
                task_id: "task-1".into(),
                goal: "reject identity drift".into(),
                success_criteria: vec!["no bytes reach a drifted Session".into()],
                targets: vec![target.clone()],
                permission_mode: AgentPermissionModeNative::Operator,
            },
            turn_id: "turn-1".into(),
            step_id: "step-1".into(),
        };
        let call = AgentToolCallNative {
            request_id: context.request.request_id.clone(),
            call_id: "operation-1".into(),
            tool_name: "terminal_execute".into(),
            arguments: json!({
                "command": "printf must-not-run",
                "explanation": "verify post-lease revalidation",
                "timeoutMs": 1_000
            }),
            target,
            capability_id: "test-capability".into(),
        };
        let effect = AgentObservedEffectNative {
            kind: AgentEffectKindNative::StateChange,
            target_id: "target-remote".into(),
            summary: "must reject drift".into(),
            paths: Vec::new(),
            network_destinations: Vec::new(),
        };

        // Exercise the actual post-lease validation independently of native
        // source admission. This fixture has no NIP producer and grants none.
        let before = engine
            .terminal_broker
            .snapshot(Some(SOURCE_SESSION_ID))
            .unwrap()
            .session
            .unwrap();
        let validate = |stage| {
            engine.revalidate_terminal_execution(
                &call.target,
                &sessions,
                &before.terminal_session_id,
                before.terminal_generation,
                &context.request.user_session_id,
                &context.request.task_id,
                &call.call_id,
                stage,
            )
        };
        validate(TerminalExecuteValidationStage::LeaseAcquisition).unwrap();
        engine
            .terminal_leases
            .acquire_command(
                SOURCE_SESSION_ID,
                &context.request.user_session_id,
                &context.request.task_id,
                &call.call_id,
                Some("printf must-not-run"),
                None,
            )
            .unwrap();
        assert_eq!(
            sessions
                .target_state(SOURCE_SESSION_ID)
                .unwrap()
                .identity
                .host,
            "drifted.example"
        );
        let message = validate(TerminalExecuteValidationStage::CommandCreation).unwrap_err();
        let final_error = validate(TerminalExecuteValidationStage::InputWrite).unwrap_err();
        assert!(crate::agent_runtime::is_terminal_target_unavailable(
            &final_error
        ));
        assert!(crate::agent_runtime::is_terminal_target_unavailable(
            &message
        ));
        let result = engine
            .terminal_submission_failure(
                &context,
                &call,
                &effect,
                SOURCE_SESSION_ID,
                None,
                TerminalSubmissionError {
                    message,
                    submission_attempted: false,
                },
            )
            .unwrap();
        assert_eq!(result.status, AgentToolResultStatusNative::Failed);
        assert!(
            crate::agent_runtime::is_terminal_target_unavailable(&result.summary),
            "unexpected post-lease validation result: {result:?}"
        );
        let data = result.data.unwrap();
        assert_eq!(data["execution"], "notStarted");
        assert_eq!(data["errorDetails"]["terminalRecoveryRequired"], true);
        assert_eq!(data["errorDetails"]["nextAction"], "recoverTerminal");
        assert!(
            receiver.try_recv().is_err(),
            "identity drift must write no PTY bytes"
        );
        assert!(engine
            .terminal_leases
            .release_terminal(
                SOURCE_SESSION_ID,
                super::super::TerminalLeaseReleaseReason::Failed
            )
            .unwrap());
    }
}
