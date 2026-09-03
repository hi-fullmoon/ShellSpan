use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::keychain::{CredentialManager, MCP_CREDENTIAL_SERVICE};
use crate::redaction::{redact_json_value, redact_sensitive_text};

const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_SERVERS: usize = 16;
const MAX_TOOLS: usize = 256;
const MAX_SCHEMA_BYTES: usize = 128 * 1024;
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_RESULT_BYTES: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum McpTransportNative {
    Stdio,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum McpToolPolicyNative {
    Disabled,
    ReadOnly,
    ExternalWrite,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpCredentialReferenceNative {
    env: String,
    credential_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct McpServerConfigNative {
    id: String,
    transport: McpTransportNative,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    enabled: bool,
    #[serde(default)]
    credential_refs: Vec<McpCredentialReferenceNative>,
    #[serde(default)]
    tool_policies: HashMap<String, McpToolPolicyNative>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpConfigFileNative {
    version: u8,
    servers: Vec<McpServerConfigNative>,
}

#[derive(Debug)]
struct DiscoveredToolNative {
    name: String,
    input_schema: Value,
}

pub(super) fn load_mcp_server_native(
    workspace_root: &Path,
    server_id: &str,
) -> Result<(PathBuf, McpServerConfigNative), String> {
    validate_identifier(server_id)?;
    let root = canonical_workspace_root(workspace_root)?;
    let config_path = root.join(".shellspan").join("mcp.json");
    let metadata = fs::symlink_metadata(&config_path)
        .map_err(|error| format!("failed to inspect MCP config: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err("MCP config must be a bounded regular file".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(&config_path)
        .and_then(|file| file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("failed to read MCP config: {error}"))?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err("MCP config exceeded the native bound".into());
    }
    let config: McpConfigFileNative =
        serde_json::from_slice(&bytes).map_err(|error| format!("invalid MCP config: {error}"))?;
    if config.version != 1 || config.servers.len() > MAX_SERVERS {
        return Err("MCP config has unsupported version or server count".into());
    }
    let mut ids = HashSet::new();
    let mut selected = None;
    for server in config.servers {
        validate_server_config(&root, &server)?;
        if !ids.insert(server.id.clone()) {
            return Err("MCP config contains duplicate server ids".into());
        }
        if server.id == server_id {
            selected = Some(server);
        }
    }
    let server = selected.ok_or_else(|| "MCP server is not configured".to_string())?;
    if !server.enabled {
        return Err("MCP server is disabled".into());
    }
    Ok((root, server))
}

pub(super) fn configured_tool_policy_native(
    server: &McpServerConfigNative,
    tool_name: &str,
) -> Result<McpToolPolicyNative, String> {
    validate_identifier(tool_name)?;
    let policy = server
        .tool_policies
        .get(tool_name)
        .copied()
        .unwrap_or(McpToolPolicyNative::Disabled);
    if policy == McpToolPolicyNative::Disabled {
        return Err("MCP tool is not enabled by native policy".into());
    }
    Ok(policy)
}

pub(super) fn execute_mcp_tool_native(
    server: &McpServerConfigNative,
    root: &Path,
    credentials: &CredentialManager,
    tool_name: &str,
    arguments: &Value,
) -> Result<(Value, bool), String> {
    if !arguments.is_object()
        || serde_json::to_vec(arguments)
            .map_err(|error| format!("failed to encode MCP arguments: {error}"))?
            .len()
            > MAX_ARGUMENT_BYTES
    {
        return Err("MCP arguments must be a bounded object".into());
    }
    let result = discover_and_invoke_stdio_tool(server, root, credentials, tool_name, arguments)?;
    let encoded = serde_json::to_vec(&result)
        .map_err(|error| format!("failed to encode MCP result: {error}"))?;
    if encoded.len() > MAX_RESULT_BYTES {
        return Ok((
            json!({
                "isError": true,
                "content": [{"type":"text","text":"MCP result exceeded the native bound"}],
            }),
            true,
        ));
    }
    Ok((redact_json_value(&result), false))
}

fn canonical_workspace_root(root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("failed to inspect MCP workspace: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("MCP workspace must be a real directory".into());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("failed to canonicalize MCP workspace: {error}"))?;
    if root.parent().is_none() {
        return Err("filesystem roots cannot be MCP workspaces".into());
    }
    Ok(root)
}

fn validate_server_config(root: &Path, server: &McpServerConfigNative) -> Result<(), String> {
    validate_identifier(&server.id)?;
    if server.transport != McpTransportNative::Stdio
        || server.command.trim().is_empty()
        || server.command.len() > 1_024
        || server.command.contains(['\0', '\r', '\n'])
        || server.args.len() > 64
        || server
            .args
            .iter()
            .any(|argument| argument.len() > 4_096 || argument.contains(['\0', '\r', '\n']))
    {
        return Err("MCP stdio server command is outside native bounds".into());
    }
    if let Some(cwd) = &server.cwd {
        let canonical = fs::canonicalize(root.join(cwd))
            .map_err(|error| format!("failed to canonicalize MCP cwd: {error}"))?;
        if !canonical.starts_with(root) || !canonical.is_dir() {
            return Err("MCP cwd escaped the frozen workspace".into());
        }
    }
    let mut envs = HashSet::new();
    for reference in &server.credential_refs {
        if reference.env.is_empty()
            || reference.env.len() > 128
            || !reference
                .env
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            || !envs.insert(&reference.env)
        {
            return Err("MCP credential environment binding is invalid".into());
        }
        validate_identifier(&reference.credential_id)?;
    }
    for tool_name in server.tool_policies.keys() {
        validate_identifier(tool_name)?;
    }
    Ok(())
}

fn parse_discovered_tools(result: &Value) -> Result<Vec<DiscoveredToolNative>, String> {
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "MCP tools/list response has no tools array".to_string())?;
    if tools.len() > MAX_TOOLS {
        return Err("MCP server advertised too many tools".into());
    }
    let mut names = HashSet::new();
    tools
        .iter()
        .map(|value| {
            let object = value
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
            let schema = object
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({"type":"object"}));
            if !schema.is_object()
                || serde_json::to_vec(&schema)
                    .map_err(|error| format!("failed to encode MCP schema: {error}"))?
                    .len()
                    > MAX_SCHEMA_BYTES
            {
                return Err("MCP tool schema is invalid or too large".into());
            }
            Ok(DiscoveredToolNative {
                name: name.to_string(),
                input_schema: schema,
            })
        })
        .collect()
}

fn discover_and_invoke_stdio_tool(
    config: &McpServerConfigNative,
    root: &Path,
    credentials: &CredentialManager,
    tool_name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let mut command = Command::new(resolve_executable(config, root)?);
    command
        .args(&config.args)
        .current_dir(resolve_cwd(config, root)?)
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
    let result = (|| {
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
            for line in BufReader::new(stdout).lines().take(1_024) {
                let _ = sender.send(line);
            }
        });
        send_json(
            &mut stdin,
            &json!({
                "jsonrpc":"2.0", "id":1, "method":"initialize",
                "params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ShellSpan","version":"2.1.0"}}
            }),
        )?;
        let deadline = Instant::now() + TIMEOUT;
        wait_for_response(&receiver, 1, deadline)?;
        send_json(
            &mut stdin,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
        )?;
        send_json(
            &mut stdin,
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        )?;
        let discovered = wait_for_response(&receiver, 2, deadline)?;
        let tool = parse_discovered_tools(&discovered)?
            .into_iter()
            .find(|tool| tool.name == tool_name)
            .ok_or_else(|| "MCP server did not advertise the approved tool".to_string())?;
        validate_json_shape(arguments, &tool.input_schema)?;
        send_json(
            &mut stdin,
            &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":tool_name,"arguments":arguments}}),
        )?;
        wait_for_response(&receiver, 3, deadline)
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn send_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| format!("failed to encode MCP request: {error}"))?;
    if encoded.len() > MAX_ARGUMENT_BYTES {
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
        if line.len() > MAX_RESULT_BYTES {
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

fn resolve_executable(config: &McpServerConfigNative, root: &Path) -> Result<PathBuf, String> {
    let path = Path::new(&config.command);
    if path.is_absolute() || path.components().count() == 1 {
        return Ok(path.to_path_buf());
    }
    let candidate = fs::canonicalize(root.join(path))
        .map_err(|error| format!("failed to resolve MCP executable: {error}"))?;
    if !candidate.starts_with(root) {
        return Err("MCP executable escaped the frozen workspace".into());
    }
    Ok(candidate)
}

fn resolve_cwd(config: &McpServerConfigNative, root: &Path) -> Result<PathBuf, String> {
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

fn validate_json_shape(arguments: &Value, schema: &Value) -> Result<(), String> {
    if !arguments.is_object() {
        return Err("MCP arguments must be an object".into());
    }
    validate_json_value(arguments, schema, schema, "$", 0)
}

fn validate_json_value(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
    depth: u8,
) -> Result<(), String> {
    if depth > 64 {
        return Err("MCP schema nesting exceeded the native bound".into());
    }
    if let Some(allowed) = schema.as_bool() {
        return allowed
            .then_some(())
            .ok_or_else(|| format!("MCP arguments were rejected at {path}"));
    }
    let schema = schema
        .as_object()
        .ok_or_else(|| "MCP tool schema is not a JSON Schema object".to_string())?;
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let pointer = reference
            .strip_prefix('#')
            .ok_or_else(|| "MCP schema contains a non-local reference".to_string())?;
        let resolved = root
            .pointer(pointer)
            .ok_or_else(|| "MCP schema contains an unresolved local reference".to_string())?;
        validate_json_value(value, resolved, root, path, depth + 1)?;
    }
    if let Some(expected) = schema.get("const") {
        if value != expected {
            return Err(format!("MCP argument at {path} does not match const"));
        }
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.contains(value) {
            return Err(format!("MCP argument at {path} is outside enum"));
        }
    }
    for keyword in ["allOf", "anyOf", "oneOf"] {
        if let Some(branches) = schema.get(keyword).and_then(Value::as_array) {
            let successes = branches
                .iter()
                .filter(|branch| validate_json_value(value, branch, root, path, depth + 1).is_ok())
                .count();
            let valid = match keyword {
                "allOf" => successes == branches.len(),
                "anyOf" => successes > 0,
                "oneOf" => successes == 1,
                _ => unreachable!(),
            };
            if !valid {
                return Err(format!("MCP argument at {path} failed {keyword}"));
            }
        }
    }
    if let Some(expected) = schema.get("type") {
        let matches = match expected {
            Value::String(kind) => json_type_matches(value, kind),
            Value::Array(kinds) => kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| json_type_matches(value, kind)),
            _ => false,
        };
        if !matches {
            return Err(format!("MCP argument at {path} has the wrong type"));
        }
    }
    if let Some(object) = value.as_object() {
        let properties = schema.get("properties").and_then(Value::as_object);
        if let Some(required) = schema.get("required") {
            let required = required
                .as_array()
                .ok_or_else(|| "MCP schema required must be an array".to_string())?;
            for name in required {
                let name = name
                    .as_str()
                    .ok_or_else(|| "MCP schema required entries must be strings".to_string())?;
                if !object.contains_key(name) {
                    return Err(format!("MCP arguments are missing required field {name}"));
                }
            }
        }
        for (name, item) in object {
            if let Some(property_schema) = properties.and_then(|values| values.get(name)) {
                validate_json_value(
                    item,
                    property_schema,
                    root,
                    &format!("{path}.{name}"),
                    depth + 1,
                )?;
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(format!("MCP arguments contain unknown field {name}"));
            } else if let Some(additional_schema) = schema
                .get("additionalProperties")
                .filter(|candidate| candidate.is_object())
            {
                validate_json_value(
                    item,
                    additional_schema,
                    root,
                    &format!("{path}.{name}"),
                    depth + 1,
                )?;
            }
        }
        validate_usize_bound(object.len(), schema, "minProperties", "maxProperties", path)?;
    }
    if let Some(array) = value.as_array() {
        validate_usize_bound(array.len(), schema, "minItems", "maxItems", path)?;
        if schema.get("uniqueItems").and_then(Value::as_bool) == Some(true)
            && array
                .iter()
                .enumerate()
                .any(|(index, item)| array[..index].contains(item))
        {
            return Err(format!("MCP argument at {path} contains duplicate items"));
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in array.iter().enumerate() {
                validate_json_value(
                    item,
                    item_schema,
                    root,
                    &format!("{path}[{index}]"),
                    depth + 1,
                )?;
            }
        }
    }
    if let Some(text) = value.as_str() {
        validate_usize_bound(text.chars().count(), schema, "minLength", "maxLength", path)?;
    }
    if let Some(number) = value.as_f64() {
        if schema
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|minimum| number < minimum)
            || schema
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|maximum| number > maximum)
        {
            return Err(format!("MCP numeric argument at {path} is outside bounds"));
        }
    }
    Ok(())
}

fn json_type_matches(value: &Value, expected: &str) -> bool {
    match expected {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "string" => value.is_string(),
        _ => false,
    }
}

fn validate_usize_bound(
    actual: usize,
    schema: &serde_json::Map<String, Value>,
    minimum_key: &str,
    maximum_key: &str,
    path: &str,
) -> Result<(), String> {
    if schema
        .get(minimum_key)
        .and_then(Value::as_u64)
        .is_some_and(|minimum| actual < minimum as usize)
        || schema
            .get(maximum_key)
            .and_then(Value::as_u64)
            .is_some_and(|maximum| actual > maximum as usize)
    {
        return Err(format!("MCP argument at {path} is outside size bounds"));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_load_does_not_spawn_the_stdio_command() {
        let root = tempfile::tempdir().unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        credentials
            .set_credential(MCP_CREDENTIAL_SERVICE, "fixture-token", "secret")
            .unwrap();
        fs::create_dir(root.path().join(".shellspan")).unwrap();
        fs::write(
            root.path().join(".shellspan/mcp.json"),
            r#"{"version":1,"servers":[{"id":"fixture","transport":"stdio","command":"definitely-not-a-real-command","enabled":true,"credentialRefs":[{"env":"FIXTURE_TOKEN","credentialId":"fixture-token"}],"toolPolicies":{"read":"readOnly"}}]}"#,
        )
        .unwrap();
        let (_, server) = load_mcp_server_native(root.path(), "fixture").unwrap();
        assert_eq!(
            configured_tool_policy_native(&server, "read").unwrap(),
            McpToolPolicyNative::ReadOnly
        );
        drop(credentials);
    }

    #[test]
    fn unknown_tools_are_disabled_before_any_process_can_start() {
        let server = McpServerConfigNative {
            id: "fixture".into(),
            transport: McpTransportNative::Stdio,
            command: "fixture".into(),
            args: Vec::new(),
            cwd: None,
            enabled: true,
            credential_refs: Vec::new(),
            tool_policies: HashMap::new(),
        };
        assert_eq!(
            configured_tool_policy_native(&server, "missing"),
            Err("MCP tool is not enabled by native policy".into())
        );
    }

    #[test]
    fn discovered_schema_is_enforced_recursively_before_tool_invocation() {
        let schema = json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["query", "options"],
            "properties": {
                "query": { "type": "string", "minLength": 2 },
                "options": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["limit"],
                    "properties": {
                        "limit": { "type": "integer", "minimum": 1, "maximum": 10 }
                    }
                }
            }
        });
        assert!(validate_json_shape(
            &json!({ "query": "ok", "options": { "limit": 3 } }),
            &schema
        )
        .is_ok());
        assert!(validate_json_shape(
            &json!({ "query": "ok", "options": { "limit": "3" } }),
            &schema
        )
        .is_err());
        assert!(validate_json_shape(
            &json!({ "query": "ok", "options": { "limit": 3, "extra": true } }),
            &schema
        )
        .is_err());
    }
}
