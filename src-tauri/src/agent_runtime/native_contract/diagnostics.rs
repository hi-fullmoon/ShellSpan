//! Bounded, typed diagnostic inputs shared by model schemas and native admission.
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspectHostArguments {
    #[serde(default)]
    pub fields: Vec<HostField>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostField {
    System,
    Cpu,
    Memory,
    Disk,
    Capabilities,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspectServiceArguments {
    pub service: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QueryLogsArguments {
    pub service: String,
    pub since_unix_ms: u64,
    pub until_unix_ms: u64,
    pub keyword: Option<String>,
    pub cursor: Option<String>,
    pub max_entries: Option<u16>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiagnoseEndpointArguments {
    pub host: String,
    pub port: u16,
    pub protocol: EndpointProtocol,
    pub path: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum EndpointProtocol {
    Tcp,
    Tls,
    Http,
    Https,
}

fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|_| "invalid diagnostic arguments".into())
}

fn unit(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b))
    {
        return Err(
            "service must be an exact systemd unit name, without patterns or options".into(),
        );
    }
    Ok(())
}

pub(crate) fn validate_diagnostic_arguments(name: &str, value: &Value) -> Result<(), String> {
    if !value.is_object()
        || value
            .as_object()
            .is_some_and(|object| object.values().any(Value::is_null))
    {
        return Err(
            "diagnostic arguments must be an object with absent optional fields, not nulls".into(),
        );
    }
    if crate::redaction::redact_json_value(value) != *value {
        return Err("diagnostic arguments must not contain credential values".into());
    }
    let timeout = match name {
        "inspect_host" => {
            let a: InspectHostArguments = decode(value)?;
            if a.fields.len() > 5
                || a.fields
                    .iter()
                    .enumerate()
                    .any(|(i, f)| a.fields[..i].contains(f))
            {
                return Err("host fields must be unique".into());
            }
            a.timeout_ms
        }
        "inspect_service" => {
            let a: InspectServiceArguments = decode(value)?;
            unit(&a.service)?;
            a.timeout_ms
        }
        "query_logs" => {
            let a: QueryLogsArguments = decode(value)?;
            unit(&a.service)?;
            if a.since_unix_ms >= a.until_unix_ms
                || a.until_unix_ms - a.since_unix_ms > 86_400_000
                || a.until_unix_ms > 253_402_300_799_000
                || a.max_entries.is_some_and(|n| n == 0 || n > 200)
                || a.keyword.as_ref().is_some_and(|s| {
                    s.is_empty() || s.len() > 256 || s.chars().any(char::is_control)
                })
                || a.cursor.as_ref().is_some_and(|s| {
                    s.is_empty()
                        || s.len() > 4096
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_=+/.".contains(&b))
                })
            {
                return Err(
                    "logs require an increasing UTC window of at most 24 hours and bounded filters"
                        .into(),
                );
            }
            a.timeout_ms
        }
        "diagnose_endpoint" => {
            let a: DiagnoseEndpointArguments = decode(value)?;
            if a.port == 0
                || a.host.is_empty()
                || a.host.len() > 253
                || !a.host.is_ascii()
                || a.host.chars().any(char::is_control)
                || a.host.contains(['/', '\\', '@', '%', '?', '#', ' '])
            {
                return Err(
                    "endpoint requires an ASCII DNS name or IP literal and one explicit port"
                        .into(),
                );
            }
            // Use the URL parser for host/IP syntax; the collector pins each resolved address.
            url::Host::parse(&a.host).map_err(|_| "invalid endpoint host".to_string())?;
            crate::connection::validate_host(&a.host)?;
            if let Some(path) = a.path.as_deref() {
                if !matches!(a.protocol, EndpointProtocol::Http | EndpointProtocol::Https)
                    || path.len() > 2048
                    || !path.starts_with('/')
                    || path.starts_with("//")
                    || !path.is_ascii()
                    || path.chars().any(char::is_control)
                    || path.contains(['#', '\\', ' '])
                {
                    return Err("HTTP path must be a bounded origin-form request target".into());
                }
            }
            a.timeout_ms
        }
        _ => return Err("unknown diagnostic tool".into()),
    };
    if timeout.is_some_and(|ms| !(100..=30_000).contains(&ms)) {
        return Err("diagnostic timeoutMs must be between 100 and 30000".into());
    }
    Ok(())
}

pub(crate) fn diagnostic_model_tools() -> Vec<super::super::ModelToolDefinition> {
    let timeout = json!({"type":"integer","minimum":100,"maximum":30000,"default":10000});
    let service = json!({"type":"string","minLength":1,"maxLength":256,"pattern":"^[a-zA-Z0-9_.@:][a-zA-Z0-9_.@:-]*$"});
    [
        ("inspect_host", "Inspect selected host facts on the frozen target: OS, logical CPUs/load averages, physical memory, root filesystem capacity and diagnostic dependencies. Requires Python 3.8+; missing metrics are unavailable, never zero. No installation, privilege elevation or process/environment dump.", json!({"fields":{"type":"array","maxItems":5,"uniqueItems":true,"items":{"type":"string","enum":["system","cpu","memory","disk","capabilities"]}},"timeoutMs":timeout}), json!([])),
        ("inspect_service", "Inspect one exact systemd service on the frozen target. Returns load/active/sub states, result, PID, restart count and exit status, without environment, command line or implicit journal access. Unsupported managers and denied reads are explicit; an inactive one-shot unit is not necessarily unhealthy.", json!({"service":service,"timeoutMs":timeout}), json!(["service"])),
        ("query_logs", "Read bounded systemd journal evidence for one exact unit and a required UTC window of at most 24 hours. Literal keyword, chronological entries, opaque query/target-bound continuation cursor, at most 200 entries and 2000 scanned records per call. Sensitive read. Keep filters and time window unchanged when continuing; no entries does not prove absence of failures or full journal access. No follow, sudo or arbitrary file reads.", json!({"service":service,"sinceUnixMs":{"type":"integer","minimum":0},"untilUnixMs":{"type":"integer","minimum":1},"keyword":{"type":"string","minLength":1,"maxLength":256},"cursor":{"type":"string","minLength":1,"maxLength":4096},"maxEntries":{"type":"integer","minimum":1,"maximum":200,"default":100},"timeoutMs":timeout}), json!(["service","sinceUnixMs","untilUnixMs"])),
        ("diagnose_endpoint", "Diagnose one explicit host/port from the frozen target, with separate DNS, TCP, verified TLS and HTTP HEAD evidence. Requires Python 3.8+ with SSL for TLS. Never follows redirects, uses proxies, sends credentials or disables certificate verification. Resolved addresses are pinned for connection; prohibited link-local/multicast/unspecified destinations are rejected. A successful HEAD is not business verification; failure is scoped to the sampled address. External-side-effect authorization applies.", json!({"host":{"type":"string","minLength":1,"maxLength":253},"port":{"type":"integer","minimum":1,"maximum":65535},"protocol":{"type":"string","enum":["tcp","tls","http","https"]},"path":{"type":"string","minLength":1,"maxLength":2048},"timeoutMs":timeout}), json!(["host","port","protocol"])),
    ].into_iter().map(|(name, description, properties, required)| super::super::ModelToolDefinition {
        name: name.into(), description: description.into(),
        input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
    }).collect()
}
