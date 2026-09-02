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
use crate::models::SessionManager;

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

    fn configure(&self, runtime: &NativeToolEngine) -> Result<(), String> {
        let root = self
            .app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve Agent native runtime root: {error}"))?;
        runtime.configure_checkpoint_root(root)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalCommandArguments {
    command: String,
    explanation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpCallArguments {
    server_id: String,
    tool_name: String,
    arguments: Value,
}

impl NativeToolRuntime for NativeToolAdapter {
    fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
        let runtime = &self.engine;
        let sessions = self.app.state::<SessionManager>();
        let database = self.app.state::<Database>();
        let credentials = self.app.state::<CredentialManager>();
        self.configure(runtime)?;
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

        let (native_name, arguments) = normalize_arguments(&request, &target)?;
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
            arguments: prepared.call.arguments.clone(),
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
        self.configure(runtime)?;
        let known_hosts_path = crate::known_hosts::known_hosts_path(&self.app)?;
        match stored.authorization {
            PreparedAuthorization::Tool(prepared) => {
                let native_request_id = prepared.call.request_id.clone();
                let native_call_id = prepared.call.call_id.clone();
                let native_tool_name = prepared.call.tool_name.clone();
                let native_target = prepared.call.target.clone();
                let grant = runtime.issue_prepared_authorization(&prepared, approved)?;
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
                let result =
                    runtime.execute_mcp_call(&prepared, grant.capability_id, &credentials)?;
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
        return Ok((
            "exec_command".into(),
            json!({
                "command": arguments.command,
                "explanation": arguments.explanation,
                "channel": "direct",
                "cwd": cwd,
                "background": false,
                "elevated": false
            }),
        ));
    }
    match request.model_call.name.as_str() {
        "exec_command" | "read_file" | "list_directory" | "search_text" | "apply_patch"
        | "transfer_file" => Ok((
            request.model_call.name.clone(),
            request.model_call.arguments.clone(),
        )),
        _ => Err("model requested a tool outside the Agent Runtime native registry".into()),
    }
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
    use super::*;
    use crate::agent_runtime::ModelToolCall;

    fn local_target() -> AgentSessionTarget {
        AgentSessionTarget {
            kind: "local".into(),
            target_id: "target-local".into(),
            session_id: "terminal-local".into(),
            label: Some("Local".into()),
            profile_id: None,
            host: None,
            port: None,
            username: None,
            cwd: Some("/workspace".into()),
            root_path: None,
            local_root: None,
        }
    }

    fn request(name: &str, arguments: Value) -> NativeToolRequest {
        NativeToolRequest {
            session_id: "session-native".into(),
            task_id: "task-native".into(),
            goal: "inspect safely".into(),
            success_criteria: vec!["evidence recorded".into()],
            turn_id: "turn-native".into(),
            step_id: "step-native".into(),
            request_id: "request-native".into(),
            model_call: ModelToolCall {
                call_id: "call-native".into(),
                provider_call_id: Some("provider-native".into()),
                name: name.into(),
                arguments,
            },
            target: local_target(),
            permission_mode: AgentSessionPermissionMode::RequestApproval,
        }
    }

    #[test]
    fn terminal_alias_is_strict_and_cannot_supply_effect_or_execution_policy() {
        let target = target_native(&local_target()).unwrap();
        let (name, arguments) = normalize_arguments(
            &request(
                "run_terminal_command",
                json!({ "command": "pwd", "explanation": "inspect" }),
            ),
            &target,
        )
        .unwrap();
        assert_eq!(name, "exec_command");
        assert_eq!(arguments["channel"], "direct");
        assert_eq!(arguments["cwd"], "/workspace");
        assert_eq!(arguments["background"], false);
        assert_eq!(arguments["elevated"], false);

        assert!(normalize_arguments(
            &request(
                "run_terminal_command",
                json!({
                    "command": "pwd",
                    "explanation": "inspect",
                    "effect": "readOnly"
                }),
            ),
            &target,
        )
        .unwrap_err()
        .contains("schema rejected"));
    }

    #[test]
    fn direct_native_tools_preserve_arguments_but_unknown_tools_fail_closed() {
        let target = target_native(&local_target()).unwrap();
        let arguments = json!({ "path": ".", "pageSize": 20 });
        assert_eq!(
            normalize_arguments(&request("list_directory", arguments.clone()), &target,).unwrap(),
            ("list_directory".into(), arguments)
        );
        assert!(normalize_arguments(&request("browser_eval", json!({})), &target).is_err());
        assert_eq!(
            stable_native_id("call", "same"),
            stable_native_id("call", "same")
        );
        assert_ne!(
            stable_native_id("call", "same"),
            stable_native_id("call", "other")
        );
    }
}
