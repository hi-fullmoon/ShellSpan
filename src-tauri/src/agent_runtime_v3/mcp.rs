use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent_contract_v3::{AgentEffectKindV3, AgentRequestV3};
use crate::keychain::CredentialManager;
use crate::redaction::{redact_json_value, redact_sensitive_text};

use super::workspace_root_v3;

const MCP_CREDENTIAL_SERVICE: &str = "com.shellspan.mcp";
const MAX_MCP_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_MCP_SERVERS: usize = 16;
const MAX_MCP_TOOLS: usize = 256;
const MAX_MCP_SCHEMA_BYTES: usize = 128 * 1024;
const MAX_MCP_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_MCP_RESULT_BYTES: usize = 256 * 1024;
const MCP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum McpTransportV3 {
    Stdio,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum McpToolPolicyV3 {
    Disabled,
    ReadOnly,
    ExternalWrite,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpCredentialReferenceV3 {
    env: String,
    credential_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpServerConfigV3 {
    id: String,
    transport: McpTransportV3,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    enabled: bool,
    #[serde(default)]
    credential_refs: Vec<McpCredentialReferenceV3>,
    #[serde(default)]
    tool_policies: HashMap<String, McpToolPolicyV3>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpConfigFileV3 {
    version: u8,
    servers: Vec<McpServerConfigV3>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum McpServerHealthV3 {
    Disabled,
    Configured,
    Connecting,
    Healthy,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpToolCatalogEntryV3 {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) policy: McpToolPolicyV3,
    pub(crate) schema_loaded: bool,
    pub(crate) untrusted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpServerSnapshotV3 {
    pub(crate) id: String,
    pub(crate) transport: String,
    pub(crate) enabled: bool,
    pub(crate) health: McpServerHealthV3,
    pub(crate) uses_native_credentials: bool,
    pub(crate) tools: Vec<McpToolCatalogEntryV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error: Option<String>,
    pub(crate) failure_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) refreshed_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpToolSchemaV3 {
    pub(crate) server_id: String,
    pub(crate) tool_name: String,
    pub(crate) input_schema: Value,
    pub(crate) untrusted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpToolSchemaRequestV3 {
    pub(crate) task_id: String,
    pub(crate) server_id: String,
    pub(crate) tool_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSetEnabledRequestV3 {
    pub(crate) task_id: String,
    pub(crate) server_id: String,
    pub(crate) enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentMcpCallV3 {
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) server_id: String,
    pub(crate) tool_name: String,
    pub(crate) arguments: Value,
    pub(crate) target_id: String,
    pub(crate) capability_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentMcpAuthorizeRequestV3 {
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) server_id: String,
    pub(crate) tool_name: String,
    pub(crate) arguments: Value,
    pub(crate) target_id: String,
    #[serde(default)]
    pub(crate) ttl_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentMcpCapabilityGrantV3 {
    pub(crate) capability_id: String,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) assessed_effect: AgentEffectKindV3,
    pub(crate) effective_arguments: Value,
    pub(crate) hook_decisions: Vec<super::HookDecisionV3>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentMcpResultV3 {
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) server_id: String,
    pub(crate) tool_name: String,
    pub(crate) target_id: String,
    pub(crate) status: String,
    pub(crate) data: Value,
    pub(crate) effect: AgentEffectKindV3,
    pub(crate) untrusted: bool,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone)]
struct StoredMcpToolV3 {
    name: String,
    description: String,
    input_schema: Value,
    policy: McpToolPolicyV3,
    schema_exposed: bool,
}

#[derive(Debug, Clone)]
struct McpServerStateV3 {
    config: McpServerConfigV3,
    workspace_root: PathBuf,
    runtime_enabled: bool,
    health: McpServerHealthV3,
    tools: HashMap<String, StoredMcpToolV3>,
    last_error: Option<String>,
    failure_count: u32,
    refreshed_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct McpTaskStateV3 {
    request: AgentRequestV3,
    servers: HashMap<String, McpServerStateV3>,
    results: Vec<AgentMcpResultV3>,
}

#[derive(Debug, Clone)]
pub(crate) struct McpCallAssessmentV3 {
    pub(crate) canonical_tool_name: String,
    pub(crate) effect: AgentEffectKindV3,
    pub(crate) summary: String,
}

#[derive(Clone, Default)]
pub(crate) struct McpRuntimeV3 {
    states: Arc<Mutex<HashMap<String, McpTaskStateV3>>>,
}

impl McpRuntimeV3 {
    pub(crate) fn register_task(&self, request: &AgentRequestV3) -> Result<(), String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        if let Some(existing) = states.get(&request.task_id) {
            return if existing.request == *request {
                Ok(())
            } else {
                Err("MCP task id belongs to a different request".into())
            };
        }
        states.insert(
            request.task_id.clone(),
            McpTaskStateV3 {
                request: request.clone(),
                servers: HashMap::new(),
                results: Vec::new(),
            },
        );
        Ok(())
    }

    pub(crate) fn reload_config(&self, task_id: &str) -> Result<Vec<McpServerSnapshotV3>, String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        let state = states
            .get_mut(task_id)
            .ok_or_else(|| "MCP task was not found".to_string())?;
        let root = canonical_workspace_root(&state.request)?;
        let path = root.join(".shellspan").join("mcp.json");
        let config = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || metadata.len() > MAX_MCP_CONFIG_BYTES
                {
                    return Err("MCP config must be a bounded regular file, not a symlink".into());
                }
                let canonical = fs::canonicalize(&path)
                    .map_err(|error| format!("failed to canonicalize MCP config: {error}"))?;
                if !canonical.starts_with(&root) {
                    return Err("MCP config escaped the frozen workspace".into());
                }
                let raw = fs::read_to_string(&path)
                    .map_err(|error| format!("failed to read MCP config as UTF-8: {error}"))?;
                serde_json::from_str::<McpConfigFileV3>(&raw)
                    .map_err(|error| format!("invalid MCP config: {error}"))?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => McpConfigFileV3 {
                version: 1,
                servers: Vec::new(),
            },
            Err(error) => return Err(format!("failed to inspect MCP config: {error}")),
        };
        if config.version != 1 || config.servers.len() > MAX_MCP_SERVERS {
            return Err("MCP config is outside the experimental v1 bounds".into());
        }
        let mut server_ids = HashSet::new();
        let mut servers = HashMap::new();
        for server in config.servers {
            validate_server_config(&root, &server)?;
            if !server_ids.insert(server.id.clone()) {
                return Err("MCP config contains duplicate server ids".into());
            }
            let health = if server.enabled {
                McpServerHealthV3::Configured
            } else {
                McpServerHealthV3::Disabled
            };
            servers.insert(
                server.id.clone(),
                McpServerStateV3 {
                    config: server,
                    workspace_root: root.clone(),
                    runtime_enabled: true,
                    health,
                    tools: HashMap::new(),
                    last_error: None,
                    failure_count: 0,
                    refreshed_at_unix_ms: None,
                },
            );
        }
        state.servers = servers;
        Ok(server_snapshots(state))
    }

    pub(crate) fn snapshots(&self, task_id: &str) -> Result<Vec<McpServerSnapshotV3>, String> {
        let states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        states
            .get(task_id)
            .map(server_snapshots)
            .ok_or_else(|| "MCP task was not found".to_string())
    }

    pub(crate) fn results(&self, task_id: &str) -> Result<Vec<AgentMcpResultV3>, String> {
        let states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        states
            .get(task_id)
            .map(|state| state.results.clone())
            .ok_or_else(|| "MCP task was not found".to_string())
    }

    pub(crate) fn record_result(
        &self,
        task_id: &str,
        result: AgentMcpResultV3,
    ) -> Result<(), String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        let state = states
            .get_mut(task_id)
            .ok_or_else(|| "MCP task was not found".to_string())?;
        if state.results.len() >= 256 {
            return Err("MCP result history reached its native bound".into());
        }
        if state
            .results
            .iter()
            .any(|existing| existing.call_id == result.call_id)
        {
            return Err("MCP call id was already committed".into());
        }
        state.results.push(result);
        Ok(())
    }

    pub(crate) fn set_enabled(
        &self,
        input: McpSetEnabledRequestV3,
    ) -> Result<Vec<McpServerSnapshotV3>, String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        let state = states
            .get_mut(&input.task_id)
            .ok_or_else(|| "MCP task was not found".to_string())?;
        let server = state
            .servers
            .get_mut(&input.server_id)
            .ok_or_else(|| "MCP server was not configured".to_string())?;
        server.runtime_enabled = input.enabled;
        server.health = if server.config.enabled && input.enabled {
            McpServerHealthV3::Configured
        } else {
            McpServerHealthV3::Disabled
        };
        if !input.enabled {
            server.tools.clear();
        }
        Ok(server_snapshots(state))
    }

    pub(crate) fn refresh_server(
        &self,
        task_id: &str,
        server_id: &str,
        credentials: &CredentialManager,
    ) -> Result<McpServerSnapshotV3, String> {
        require_experimental_mcp()?;
        let (config, root) = {
            let mut states = self
                .states
                .lock()
                .map_err(|_| "MCP state is unavailable".to_string())?;
            let state = states
                .get_mut(task_id)
                .ok_or_else(|| "MCP task was not found".to_string())?;
            let server = state
                .servers
                .get_mut(server_id)
                .ok_or_else(|| "MCP server was not configured".to_string())?;
            if !server.config.enabled || !server.runtime_enabled {
                return Err("MCP server is disabled".into());
            }
            server.health = McpServerHealthV3::Connecting;
            (server.config.clone(), server.workspace_root.clone())
        };
        let outcome = discover_stdio_tools(&config, &root, credentials);
        let mut states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        let state = states
            .get_mut(task_id)
            .ok_or_else(|| "MCP task was not found".to_string())?;
        let server = state
            .servers
            .get_mut(server_id)
            .ok_or_else(|| "MCP server was removed during refresh".to_string())?;
        match outcome {
            Ok(tools) => {
                server.tools = tools
                    .into_iter()
                    .map(|tool| (tool.name.clone(), tool))
                    .collect();
                server.health = McpServerHealthV3::Healthy;
                server.last_error = None;
                server.refreshed_at_unix_ms = Some(current_unix_ms());
                Ok(server_snapshot(server))
            }
            Err(error) => {
                record_failure(server, &error);
                Err(error)
            }
        }
    }

    pub(crate) fn tool_schema(
        &self,
        input: McpToolSchemaRequestV3,
    ) -> Result<McpToolSchemaV3, String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        let state = states
            .get_mut(&input.task_id)
            .ok_or_else(|| "MCP task was not found".to_string())?;
        let server = state
            .servers
            .get_mut(&input.server_id)
            .ok_or_else(|| "MCP server was not configured".to_string())?;
        let tool = server
            .tools
            .get_mut(&input.tool_name)
            .ok_or_else(|| "MCP tool was not discovered".to_string())?;
        if tool.policy == McpToolPolicyV3::Disabled {
            return Err("MCP tool is disabled by native policy".into());
        }
        tool.schema_exposed = true;
        Ok(McpToolSchemaV3 {
            server_id: input.server_id,
            tool_name: input.tool_name,
            input_schema: redact_json_value(&tool.input_schema),
            untrusted: true,
        })
    }

    pub(crate) fn assess_call(
        &self,
        task_id: &str,
        server_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> Result<McpCallAssessmentV3, String> {
        let encoded = serde_json::to_vec(arguments)
            .map_err(|error| format!("failed to encode MCP arguments: {error}"))?;
        if !arguments.is_object() || encoded.len() > MAX_MCP_ARGUMENT_BYTES {
            return Err("MCP arguments must be a bounded object".into());
        }
        let states = self
            .states
            .lock()
            .map_err(|_| "MCP state is unavailable".to_string())?;
        let state = states
            .get(task_id)
            .ok_or_else(|| "MCP task was not found".to_string())?;
        let server = state
            .servers
            .get(server_id)
            .ok_or_else(|| "MCP server was not configured".to_string())?;
        if server.health != McpServerHealthV3::Healthy
            || !server.config.enabled
            || !server.runtime_enabled
        {
            return Err("MCP server is not healthy and enabled".into());
        }
        let tool = server
            .tools
            .get(tool_name)
            .ok_or_else(|| "MCP tool was not discovered".to_string())?;
        let effect = match tool.policy {
            McpToolPolicyV3::Disabled => return Err("MCP tool is disabled by native policy".into()),
            McpToolPolicyV3::ReadOnly => AgentEffectKindV3::SensitiveRead,
            McpToolPolicyV3::ExternalWrite => AgentEffectKindV3::ExternalSideEffect,
        };
        Ok(McpCallAssessmentV3 {
            canonical_tool_name: format!("mcp::{server_id}::{tool_name}"),
            effect,
            summary: format!(
                "MCP stdio call {} on server {} (external data is untrusted)",
                tool_name, server_id
            ),
        })
    }

    pub(crate) fn invoke_call(
        &self,
        task_id: &str,
        call: &AgentMcpCallV3,
        credentials: &CredentialManager,
    ) -> Result<(Value, bool), String> {
        require_experimental_mcp()?;
        self.assess_call(task_id, &call.server_id, &call.tool_name, &call.arguments)?;
        let (config, root) = {
            let states = self
                .states
                .lock()
                .map_err(|_| "MCP state is unavailable".to_string())?;
            let state = states
                .get(task_id)
                .ok_or_else(|| "MCP task was not found".to_string())?;
            let server = state
                .servers
                .get(&call.server_id)
                .ok_or_else(|| "MCP server was not configured".to_string())?;
            (server.config.clone(), server.workspace_root.clone())
        };
        let result = invoke_stdio_tool(
            &config,
            &root,
            credentials,
            &call.tool_name,
            &call.arguments,
        )?;
        let redacted = redact_json_value(&result);
        let encoded = serde_json::to_vec(&redacted)
            .map_err(|error| format!("failed to encode MCP result: {error}"))?;
        if encoded.len() <= MAX_MCP_RESULT_BYTES {
            return Ok((redacted, false));
        }
        Ok((
            json!({
                "truncated": true,
                "summary": "MCP result exceeded the native output limit",
                "byteLength": encoded.len(),
            }),
            true,
        ))
    }
}

pub(crate) fn experimental_mcp_enabled() -> bool {
    std::env::var("SHELLSPAN_AGENT_MCP_EXPERIMENTAL")
        .ok()
        .as_deref()
        == Some("enabled")
}

pub(crate) fn mcp_result_status(data: &Value) -> &'static str {
    if data.get("isError").and_then(Value::as_bool) == Some(true) {
        "failed"
    } else {
        "completed"
    }
}

fn require_experimental_mcp() -> Result<(), String> {
    if experimental_mcp_enabled() {
        Ok(())
    } else {
        Err("experimental MCP is disabled; set SHELLSPAN_AGENT_MCP_EXPERIMENTAL=enabled before launch".into())
    }
}

fn canonical_workspace_root(request: &AgentRequestV3) -> Result<PathBuf, String> {
    let root = workspace_root_v3(request)?;
    let metadata = fs::symlink_metadata(&root)
        .map_err(|error| format!("failed to inspect MCP workspace: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("MCP workspace must be a real directory".into());
    }
    let canonical = fs::canonicalize(root)
        .map_err(|error| format!("failed to canonicalize MCP workspace: {error}"))?;
    if canonical.parent().is_none() {
        return Err("filesystem roots cannot be MCP workspaces".into());
    }
    Ok(canonical)
}

fn validate_server_config(root: &Path, server: &McpServerConfigV3) -> Result<(), String> {
    validate_identifier(&server.id)?;
    if server.transport != McpTransportV3::Stdio
        || server.command.trim().is_empty()
        || server.command.len() > 1_024
        || server.command.contains(['\0', '\r', '\n'])
        || server.args.len() > 64
        || server
            .args
            .iter()
            .any(|argument| argument.len() > 4_096 || argument.contains(['\0', '\r', '\n']))
    {
        return Err("MCP stdio server command is outside the native bounds".into());
    }
    if let Some(cwd) = &server.cwd {
        let path = root.join(cwd);
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("failed to canonicalize MCP cwd: {error}"))?;
        if !canonical.starts_with(root) || !canonical.is_dir() {
            return Err("MCP cwd escaped the frozen workspace".into());
        }
    }
    let mut envs = HashSet::new();
    for credential in &server.credential_refs {
        if credential.env.is_empty()
            || credential.env.len() > 128
            || !credential
                .env
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            || !envs.insert(&credential.env)
        {
            return Err("MCP credential environment binding is invalid".into());
        }
        validate_identifier(&credential.credential_id)?;
    }
    for tool in server.tool_policies.keys() {
        validate_identifier(tool)?;
    }
    Ok(())
}

fn discover_stdio_tools(
    config: &McpServerConfigV3,
    root: &Path,
    credentials: &CredentialManager,
) -> Result<Vec<StoredMcpToolV3>, String> {
    let result = stdio_exchange(config, root, credentials, McpActionV3::ListTools)?;
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "MCP tools/list response has no tools array".to_string())?;
    if tools.len() > MAX_MCP_TOOLS {
        return Err("MCP server advertised too many tools".into());
    }
    let mut names = HashSet::new();
    let mut discovered = Vec::with_capacity(tools.len());
    for tool in tools {
        let object = tool
            .as_object()
            .ok_or_else(|| "MCP tool descriptor is not an object".to_string())?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "MCP tool descriptor has no name".to_string())?;
        validate_identifier(name)?;
        if !names.insert(name.to_string()) {
            return Err("MCP server advertised duplicate tool names".into());
        }
        let input_schema = object
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({"type":"object"}));
        if !input_schema.is_object()
            || serde_json::to_vec(&input_schema)
                .map_err(|error| format!("failed to encode MCP schema: {error}"))?
                .len()
                > MAX_MCP_SCHEMA_BYTES
        {
            return Err("MCP tool schema is invalid or too large".into());
        }
        let description = object
            .get("description")
            .and_then(Value::as_str)
            .map(redact_sensitive_text)
            .unwrap_or_default();
        discovered.push(StoredMcpToolV3 {
            name: name.to_string(),
            description,
            input_schema,
            policy: config
                .tool_policies
                .get(name)
                .copied()
                .unwrap_or(McpToolPolicyV3::Disabled),
            schema_exposed: false,
        });
    }
    Ok(discovered)
}

fn invoke_stdio_tool(
    config: &McpServerConfigV3,
    root: &Path,
    credentials: &CredentialManager,
    tool_name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    stdio_exchange(
        config,
        root,
        credentials,
        McpActionV3::Call {
            tool_name,
            arguments,
        },
    )
}

enum McpActionV3<'a> {
    ListTools,
    Call {
        tool_name: &'a str,
        arguments: &'a Value,
    },
}

fn stdio_exchange(
    config: &McpServerConfigV3,
    root: &Path,
    credentials: &CredentialManager,
    action: McpActionV3<'_>,
) -> Result<Value, String> {
    let executable = resolve_executable(config, root)?;
    let cwd = resolve_cwd(config, root)?;
    let mut command = Command::new(executable);
    command
        .args(&config.args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for reference in &config.credential_refs {
        let value = credentials
            .get_credential(MCP_CREDENTIAL_SERVICE, &reference.credential_id)?
            .ok_or_else(|| "MCP native credential reference could not be resolved".to_string())?;
        command.env(&reference.env, value);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start MCP stdio server: {error}"))?;
    let result = exchange_with_child(&mut child, action);
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn exchange_with_child(child: &mut Child, action: McpActionV3<'_>) -> Result<Value, String> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "MCP server stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP server stdout is unavailable".to_string())?;
    let (sender, receiver) = mpsc::sync_channel(64);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().take(1_024) {
            let _ = sender.send(line);
        }
    });
    send_json(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name":"ShellSpan","version":"2.1.0"}
            }
        }),
    )?;
    let deadline = Instant::now() + MCP_TIMEOUT;
    wait_for_response(&receiver, 1, deadline)?;
    send_json(
        &mut stdin,
        &json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
    )?;
    let request = match action {
        McpActionV3::ListTools => json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"tools/list",
            "params":{}
        }),
        McpActionV3::Call {
            tool_name,
            arguments,
        } => json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"tools/call",
            "params":{"name":tool_name,"arguments":arguments}
        }),
    };
    send_json(&mut stdin, &request)?;
    wait_for_response(&receiver, 2, deadline)
}

fn send_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| format!("failed to encode MCP request: {error}"))?;
    if encoded.len() > MAX_MCP_ARGUMENT_BYTES {
        return Err("MCP request exceeded the native bound".into());
    }
    stdin
        .write_all(&encoded)
        .and_then(|()| stdin.write_all(b"\n"))
        .and_then(|()| stdin.flush())
        .map_err(|error| format!("failed to write MCP stdio request: {error}"))
}

fn wait_for_response(
    receiver: &mpsc::Receiver<Result<String, std::io::Error>>,
    id: u64,
    deadline: Instant,
) -> Result<Value, String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("MCP stdio request timed out".into());
        }
        let line = receiver
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => "MCP stdio request timed out".to_string(),
                mpsc::RecvTimeoutError::Disconnected => {
                    "MCP stdio server closed before responding".to_string()
                }
            })?
            .map_err(|error| format!("failed to read MCP stdio response: {error}"))?;
        if line.len() > MAX_MCP_RESULT_BYTES {
            return Err("MCP stdio response line exceeded the native bound".into());
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!(
                "MCP server returned an error: {}",
                redact_sensitive_text(&error.to_string())
            ));
        }
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| "MCP response has no result".to_string());
    }
}

fn resolve_executable(config: &McpServerConfigV3, root: &Path) -> Result<PathBuf, String> {
    let path = Path::new(&config.command);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    if path.components().count() == 1 {
        return Ok(path.to_path_buf());
    }
    let candidate = fs::canonicalize(root.join(path))
        .map_err(|error| format!("failed to resolve MCP executable: {error}"))?;
    if !candidate.starts_with(root) {
        return Err("MCP executable escaped the frozen workspace".into());
    }
    Ok(candidate)
}

fn resolve_cwd(config: &McpServerConfigV3, root: &Path) -> Result<PathBuf, String> {
    match &config.cwd {
        Some(cwd) => {
            let canonical = fs::canonicalize(root.join(cwd))
                .map_err(|error| format!("failed to resolve MCP cwd: {error}"))?;
            if !canonical.starts_with(root) {
                return Err("MCP cwd escaped the frozen workspace".into());
            }
            Ok(canonical)
        }
        None => Ok(root.to_path_buf()),
    }
}

fn record_failure(server: &mut McpServerStateV3, error: &str) {
    server.health = McpServerHealthV3::Failed;
    server.failure_count = server.failure_count.saturating_add(1);
    server.last_error = Some(redact_sensitive_text(error));
    server.refreshed_at_unix_ms = Some(current_unix_ms());
    server.tools.clear();
}

fn server_snapshots(state: &McpTaskStateV3) -> Vec<McpServerSnapshotV3> {
    let mut snapshots = state
        .servers
        .values()
        .map(server_snapshot)
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| left.id.cmp(&right.id));
    snapshots
}

fn server_snapshot(server: &McpServerStateV3) -> McpServerSnapshotV3 {
    let mut tools = server
        .tools
        .values()
        .map(|tool| McpToolCatalogEntryV3 {
            name: tool.name.clone(),
            description: tool.description.clone(),
            policy: tool.policy,
            schema_loaded: tool.schema_exposed,
            untrusted: true,
        })
        .collect::<Vec<_>>();
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    McpServerSnapshotV3 {
        id: server.config.id.clone(),
        transport: "stdio".into(),
        enabled: server.config.enabled && server.runtime_enabled,
        health: server.health,
        uses_native_credentials: !server.config.credential_refs.is_empty(),
        tools,
        last_error: server.last_error.clone(),
        failure_count: server.failure_count,
        refreshed_at_unix_ms: server.refreshed_at_unix_ms,
    }
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err("MCP identifier is invalid".into());
    }
    Ok(())
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_contract_v3::{
        AgentPermissionModeV3, AgentRequestSourceV3, AgentToolTargetV3,
    };

    fn request(root: &Path) -> AgentRequestV3 {
        AgentRequestV3 {
            contract_version: 3,
            request_id: "req-mcp".into(),
            user_session_id: "user-mcp".into(),
            task_id: "task-mcp".into(),
            goal: "test MCP".into(),
            success_criteria: vec!["bounded".into()],
            targets: vec![AgentToolTargetV3::Local {
                target_id: "local-mcp".into(),
                session_id: "session-mcp".into(),
                cwd: Some(root.to_string_lossy().to_string()),
            }],
            permission_mode: AgentPermissionModeV3::RequestApproval,
            source_contract: AgentRequestSourceV3::V3,
        }
    }

    fn write_config(root: &Path) {
        fs::create_dir_all(root.join(".shellspan")).unwrap();
        fs::write(
            root.join(".shellspan/mcp.json"),
            r#"{
              "version": 1,
              "servers": [{
                "id": "fixture",
                "transport": "stdio",
                "command": "fixture-mcp",
                "enabled": true,
                "credentialRefs": [{"env":"FIXTURE_TOKEN","credentialId":"fixture-token"}],
                "toolPolicies": {"read_status":"readOnly","write_status":"externalWrite"}
              }]
            }"#,
        )
        .unwrap();
    }

    #[test]
    fn config_exposes_only_credential_presence_and_defaults_unknown_tools_to_disabled() {
        let workspace = tempfile::tempdir().unwrap();
        write_config(workspace.path());
        let runtime = McpRuntimeV3::default();
        runtime.register_task(&request(workspace.path())).unwrap();
        let snapshots = runtime.reload_config("task-mcp").unwrap();
        assert_eq!(snapshots.len(), 1);
        assert!(snapshots[0].uses_native_credentials);
        let encoded = serde_json::to_string(&snapshots).unwrap();
        assert!(!encoded.contains("fixture-token"));
        assert!(!encoded.contains("FIXTURE_TOKEN"));
    }

    #[test]
    fn failure_then_success_updates_health_and_lazy_schema_without_leaking_schema_by_default() {
        let workspace = tempfile::tempdir().unwrap();
        write_config(workspace.path());
        let runtime = McpRuntimeV3::default();
        runtime.register_task(&request(workspace.path())).unwrap();
        runtime.reload_config("task-mcp").unwrap();
        {
            let mut states = runtime.states.lock().unwrap();
            let server = states
                .get_mut("task-mcp")
                .unwrap()
                .servers
                .get_mut("fixture")
                .unwrap();
            record_failure(server, "Authorization: Bearer should-not-leak");
            assert_eq!(server.health, McpServerHealthV3::Failed);
            server.tools.insert(
                "read_status".into(),
                StoredMcpToolV3 {
                    name: "read_status".into(),
                    description: "external description".into(),
                    input_schema: json!({"type":"object","properties":{"id":{"type":"string"}}}),
                    policy: McpToolPolicyV3::ReadOnly,
                    schema_exposed: false,
                },
            );
            server.health = McpServerHealthV3::Healthy;
            server.last_error = None;
        }
        let snapshot = runtime.snapshots("task-mcp").unwrap();
        assert_eq!(snapshot[0].health, McpServerHealthV3::Healthy);
        assert!(!snapshot[0].tools[0].schema_loaded);
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("properties"));
        let schema = runtime
            .tool_schema(McpToolSchemaRequestV3 {
                task_id: "task-mcp".into(),
                server_id: "fixture".into(),
                tool_name: "read_status".into(),
            })
            .unwrap();
        assert_eq!(schema.input_schema["type"], "object");
        assert!(runtime.snapshots("task-mcp").unwrap()[0].tools[0].schema_loaded);
    }

    #[test]
    fn server_reported_tool_errors_are_never_recorded_as_completed() {
        assert_eq!(mcp_result_status(&json!({"isError": true})), "failed");
        assert_eq!(mcp_result_status(&json!({"isError": false})), "completed");
        assert_eq!(mcp_result_status(&json!({"content": []})), "completed");
    }
}
