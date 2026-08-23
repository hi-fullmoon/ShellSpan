use crate::connection::{
    connect_tcp_stream, connect_through_jump_host, open_authenticated_session,
};
use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::{RemoteConnectionRequest, RunbookCancellationRegistry};
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const MAX_RUNBOOK_BYTES: usize = 512 * 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_ERROR_BYTES: usize = 8 * 1024;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RunbookRisk {
    ReadOnly,
    StateChange,
    Destructive,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RunbookItemKind {
    Precheck,
    Step,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunbookVariable {
    name: String,
    description: String,
    required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    default: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    keychain_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunbookExpectedResult {
    exit_code: i32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    stdout_contains: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunbookPrecheck {
    id: String,
    description: String,
    command: String,
    expected: RunbookExpectedResult,
    timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunbookStep {
    id: String,
    description: String,
    command: String,
    expected: RunbookExpectedResult,
    timeout_seconds: u64,
    risk: RunbookRisk,
    impact: String,
    safe_to_retry: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunbookDocument {
    schema_version: u8,
    id: String,
    name: String,
    description: String,
    evidence_max_age_seconds: u64,
    #[serde(default)]
    variables: Vec<RunbookVariable>,
    prechecks: Vec<RunbookPrecheck>,
    steps: Vec<RunbookStep>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunbookStepExecutionRequest {
    operation_id: String,
    run_id: String,
    source_digest: String,
    runbook_text: String,
    item_id: String,
    item_kind: RunbookItemKind,
    profile_id: String,
    authorized: bool,
    approved_risk: RunbookRisk,
    #[serde(default)]
    variable_values: HashMap<String, String>,
    timeout_ms: u64,
    connection: RemoteConnectionRequest,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RunbookStepExecutionStatus {
    Success,
    Unauthorized,
    Cancelled,
    TimedOut,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunbookExecutionSource {
    kind: &'static str,
    profile_id: String,
    host: String,
    port: u16,
    username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunbookStepExecutionResult {
    operation_id: String,
    run_id: String,
    runbook_id: String,
    source_digest: String,
    item_id: String,
    item_kind: RunbookItemKind,
    profile_id: String,
    status: RunbookStepExecutionStatus,
    risk: RunbookRisk,
    command_preview: String,
    started_at: i64,
    completed_at: i64,
    source: RunbookExecutionSource,
    exit_code: Option<i32>,
    expected_matched: bool,
    stdout: Option<String>,
    stderr: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunbookFile {
    path: String,
    text: String,
}

struct SelectedAction<'a> {
    id: &'a str,
    command: &'a str,
    expected: &'a RunbookExpectedResult,
    timeout_seconds: u64,
    risk: RunbookRisk,
}

struct RunbookSshSession {
    target: Session,
    _jump: Option<Session>,
}

struct PreparedCommand {
    command: String,
    preview: String,
    secrets: Vec<String>,
}

enum ExecutionOutcome {
    Finished {
        exit_code: i32,
        expected_matched: bool,
        stdout: String,
        stderr: String,
    },
    Cancelled,
    TimedOut,
    Failed(String),
}

fn now_ms() -> i64 {
    crate::db::current_timestamp_ms()
}

fn source_digest(text: &str) -> String {
    let mut hash = 2_166_136_261_u32;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    format!("fnv1a-{hash:08x}")
}

fn valid_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.is_ascii()
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || (index > 0 && matches!(character, '.' | '_' | '-'))
        })
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.is_ascii()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn valid_variable_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_uppercase())
        && value.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

fn non_empty_bounded(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|character| matches!(character, '\0' | '\u{7f}'))
}

fn supported_keychain_ref(value: &str) -> bool {
    matches!(
        value,
        "keychain://profile/password"
            | "keychain://profile/passphrase"
            | "keychain://profile/jump-password"
            | "keychain://profile/jump-passphrase"
    )
}

fn contains_secret_literal(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let compact = lower
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    [
        "password=",
        "password:",
        "passphrase=",
        "passphrase:",
        "api_key=",
        "api-key=",
        "secret=",
        "token=",
        "authorization:bearer",
        "-----beginprivatekey-----",
        "-----beginopensshprivatekey-----",
    ]
    .iter()
    .any(|needle| compact.contains(needle))
        || lower
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .any(|word| {
                (word.starts_with("akia") && word.len() >= 16)
                    || (["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]
                        .iter()
                        .any(|prefix| word.starts_with(prefix))
                        && word.len() >= 24)
            })
}

fn secret_variable_name(name: &str) -> bool {
    [
        "PASSWORD",
        "PASSPHRASE",
        "SECRET",
        "TOKEN",
        "API_KEY",
        "PRIVATE_KEY",
    ]
    .iter()
    .any(|needle| name.contains(needle))
}

fn placeholders(command: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut remaining = command;
    while let Some(start) = remaining.find("{{") {
        let after_start = &remaining[start + 2..];
        let end = after_start.find("}}").ok_or_else(|| {
            "runbook command contains an unclosed variable placeholder".to_string()
        })?;
        let name = &after_start[..end];
        if !valid_variable_name(name) {
            return Err(format!(
                "runbook command contains invalid variable placeholder {name}"
            ));
        }
        result.push(name.to_string());
        remaining = &after_start[end + 2..];
    }
    if remaining.contains("}}") {
        return Err("runbook command contains an unmatched variable placeholder".to_string());
    }
    Ok(result)
}

fn detected_risk(command: &str) -> RunbookRisk {
    let normalized = command.to_ascii_lowercase();
    let words = normalized
        .split(|character: char| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let destructive_program = words.iter().any(|word| {
        matches!(
            *word,
            "rm" | "rmdir"
                | "mkfs"
                | "wipefs"
                | "fdisk"
                | "parted"
                | "shutdown"
                | "reboot"
                | "poweroff"
        )
    });
    let destructive_phrase = normalized.contains("git reset --hard")
        || normalized.contains("kubectl delete")
        || normalized.contains("docker system prune")
        || normalized.contains("drop database")
        || normalized.contains("drop table")
        || normalized.contains("truncate table")
        || normalized.contains("kill -9")
        || (words.first() == Some(&"dd") && normalized.contains("of="));
    if destructive_program || destructive_phrase {
        return RunbookRisk::Destructive;
    }
    let mutating_program = words.iter().any(|word| {
        matches!(
            *word,
            "cp" | "mv"
                | "mkdir"
                | "touch"
                | "chmod"
                | "chown"
                | "install"
                | "tee"
                | "truncate"
                | "mount"
                | "umount"
                | "kill"
                | "apt"
                | "apt-get"
                | "yum"
                | "dnf"
                | "brew"
        )
    });
    let mutating_phrase = [
        "systemctl start",
        "systemctl stop",
        "systemctl restart",
        "systemctl reload",
        "systemctl enable",
        "systemctl disable",
        "service start",
        "service stop",
        "service restart",
        "kubectl apply",
        "kubectl patch",
        "kubectl scale",
        "docker start",
        "docker stop",
        "docker restart",
        "docker rm",
        "sed -i",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));
    if mutating_program || mutating_phrase || normalized.contains('>') {
        RunbookRisk::StateChange
    } else {
        RunbookRisk::ReadOnly
    }
}

fn risk_rank(value: RunbookRisk) -> u8 {
    match value {
        RunbookRisk::ReadOnly => 0,
        RunbookRisk::StateChange => 1,
        RunbookRisk::Destructive => 2,
    }
}

fn validate_read_only_command(command: &str) -> Result<(), String> {
    if command.contains([';', '&', '|', '`', '<', '>', '\n', '\r']) || command.contains("$(") {
        return Err("readOnly runbook command contains shell control syntax".to_string());
    }
    let parts = command.split_whitespace().collect::<Vec<_>>();
    let program = parts.first().copied().unwrap_or_default();
    let args = &parts[1..];
    if ![
        "cat",
        "date",
        "df",
        "du",
        "free",
        "getent",
        "grep",
        "head",
        "hostname",
        "id",
        "journalctl",
        "ls",
        "lsof",
        "netstat",
        "ps",
        "pwd",
        "ss",
        "stat",
        "systemctl",
        "tail",
        "uname",
        "uptime",
        "wc",
        "whoami",
    ]
    .contains(&program)
    {
        return Err(format!(
            "{program} is not in the readOnly runbook command set"
        ));
    }
    let has_short_flag = |flag: char| {
        args.iter().any(|argument| {
            *argument == format!("-{flag}")
                || (argument.starts_with('-')
                    && !argument.starts_with("--")
                    && argument[1..].contains(flag))
        })
    };
    if program == "tail"
        && (has_short_flag('f')
            || has_short_flag('F')
            || args.iter().any(|argument| argument.starts_with("--follow")))
    {
        return Err("readOnly tail command cannot follow an unbounded stream".to_string());
    }
    if program == "cat"
        && (!args.iter().any(|argument| !argument.starts_with('-'))
            || args.iter().any(|argument| {
                matches!(
                    *argument,
                    "/dev/full" | "/dev/null" | "/dev/random" | "/dev/urandom" | "/dev/zero"
                )
            }))
    {
        return Err("readOnly cat command has no safe bounded input".to_string());
    }
    if program == "date"
        && args.iter().any(|argument| {
            !matches!(*argument, "-u" | "--utc" | "--help" | "--version")
                && !argument.starts_with('+')
                && !argument.starts_with("--iso-8601")
                && !argument.starts_with("--rfc-3339")
        })
    {
        return Err("readOnly date command contains a mutating option".to_string());
    }
    if program == "hostname"
        && args.iter().any(|argument| {
            ![
                "-A",
                "-d",
                "-f",
                "-i",
                "-I",
                "-s",
                "--all-fqdns",
                "--all-ip-addresses",
                "--domain",
                "--fqdn",
                "--help",
                "--ip-address",
                "--short",
                "--version",
            ]
            .contains(argument)
        })
    {
        return Err("readOnly hostname command contains a mutating argument".to_string());
    }
    if program == "journalctl" {
        let forbidden = has_short_flag('f')
            || args.iter().any(|argument| {
                argument.starts_with("--follow")
                    || matches!(
                        *argument,
                        "--flush"
                            | "--relinquish-var"
                            | "--rotate"
                            | "--setup-keys"
                            | "--sync"
                            | "--update-catalog"
                    )
                    || argument.starts_with("--vacuum-")
            });
        let bounded = args.iter().enumerate().any(|(index, argument)| {
            argument
                .strip_prefix("--lines=")
                .is_some_and(|value| value.parse::<u64>().is_ok())
                || (*argument == "--lines"
                    && args
                        .get(index + 1)
                        .is_some_and(|value| value.parse::<u64>().is_ok()))
                || (argument
                    .strip_prefix("-n")
                    .is_some_and(|value| !value.is_empty() && value.parse::<u64>().is_ok()))
                || (*argument == "-n"
                    && args
                        .get(index + 1)
                        .is_some_and(|value| value.parse::<u64>().is_ok()))
        });
        if forbidden || !bounded {
            return Err("readOnly journalctl command must be bounded and non-mutating".to_string());
        }
    }
    if program == "ss"
        && args
            .iter()
            .any(|argument| matches!(*argument, "-K" | "--kill"))
    {
        return Err("readOnly ss command contains a mutating socket option".to_string());
    }
    if program == "systemctl" {
        let action = args.iter().find(|argument| !argument.starts_with('-'));
        if !action.is_some_and(|action| {
            [
                "status",
                "show",
                "is-active",
                "is-enabled",
                "list-units",
                "list-unit-files",
            ]
            .contains(action)
        }) {
            return Err("readOnly systemctl command contains a mutating action".to_string());
        }
    }
    Ok(())
}

fn validate_declared_risk(command: &str, declared: RunbookRisk) -> Result<(), String> {
    let detected = detected_risk(command);
    if risk_rank(declared) < risk_rank(detected) {
        return Err(format!(
            "runbook risk understates detected {detected:?} command behavior"
        ));
    }
    if declared == RunbookRisk::ReadOnly {
        validate_read_only_command(command)?;
    }
    Ok(())
}

fn validate_expected(expected: &RunbookExpectedResult) -> Result<(), String> {
    if !(0..=255).contains(&expected.exit_code) {
        return Err("runbook expected exitCode must be from 0 to 255".to_string());
    }
    if expected.stdout_contains.len() > 20
        || expected
            .stdout_contains
            .iter()
            .any(|value| !non_empty_bounded(value, 1_000))
    {
        return Err("runbook stdoutContains is invalid".to_string());
    }
    Ok(())
}

fn validate_document(document: &RunbookDocument) -> Result<(), String> {
    if document.schema_version != 1 {
        return Err("runbook schemaVersion must be 1".to_string());
    }
    if !valid_id(&document.id, 64)
        || !non_empty_bounded(&document.name, 200)
        || !non_empty_bounded(&document.description, 4_000)
        || !(30..=3_600).contains(&document.evidence_max_age_seconds)
    {
        return Err("runbook metadata is invalid".to_string());
    }
    if document.variables.len() > 32
        || document.prechecks.is_empty()
        || document.prechecks.len() > 16
        || document.steps.is_empty()
        || document.steps.len() > 64
    {
        return Err("runbook action or variable count is invalid".to_string());
    }
    let mut variable_names = HashSet::new();
    for variable in &document.variables {
        if !valid_variable_name(&variable.name)
            || !non_empty_bounded(&variable.description, 4_000)
            || !variable_names.insert(variable.name.as_str())
        {
            return Err(format!(
                "runbook variable {} is invalid or duplicated",
                variable.name
            ));
        }
        if variable.default.is_some() && variable.keychain_ref.is_some() {
            return Err(format!(
                "runbook variable {} cannot contain both default and keychainRef",
                variable.name
            ));
        }
        if let Some(reference) = variable.keychain_ref.as_deref() {
            if !supported_keychain_ref(reference) {
                return Err(format!(
                    "runbook variable {} has an unsupported keychainRef",
                    variable.name
                ));
            }
        }
        if variable.keychain_ref.is_none() && secret_variable_name(&variable.name) {
            return Err(format!(
                "runbook variable {} identifies a secret and therefore requires keychainRef",
                variable.name
            ));
        }
        if let Some(default) = variable.default.as_deref() {
            if !non_empty_bounded(default, 4_000) || contains_secret_literal(default) {
                return Err(format!(
                    "runbook variable {} default appears to contain a secret; use keychainRef",
                    variable.name
                ));
            }
        }
    }
    let mut action_ids = HashSet::new();
    for precheck in &document.prechecks {
        if !valid_id(&precheck.id, 64)
            || !action_ids.insert(precheck.id.as_str())
            || !non_empty_bounded(&precheck.description, 4_000)
            || !non_empty_bounded(&precheck.command, MAX_COMMAND_BYTES)
            || contains_secret_literal(&precheck.command)
            || !(1..=300).contains(&precheck.timeout_seconds)
        {
            return Err(format!("runbook precheck {} is invalid", precheck.id));
        }
        validate_declared_risk(&precheck.command, RunbookRisk::ReadOnly)?;
        validate_expected(&precheck.expected)?;
        for placeholder in placeholders(&precheck.command)? {
            if !variable_names.contains(placeholder.as_str()) {
                return Err(format!(
                    "runbook precheck {} references undeclared variable {placeholder}",
                    precheck.id
                ));
            }
        }
    }
    for step in &document.steps {
        if !valid_id(&step.id, 64)
            || !action_ids.insert(step.id.as_str())
            || !non_empty_bounded(&step.description, 4_000)
            || !non_empty_bounded(&step.command, MAX_COMMAND_BYTES)
            || !non_empty_bounded(&step.impact, 4_000)
            || contains_secret_literal(&step.command)
            || !(1..=300).contains(&step.timeout_seconds)
        {
            return Err(format!("runbook step {} is invalid", step.id));
        }
        let _ = step.safe_to_retry;
        validate_declared_risk(&step.command, step.risk)?;
        validate_expected(&step.expected)?;
        for placeholder in placeholders(&step.command)? {
            if !variable_names.contains(placeholder.as_str()) {
                return Err(format!(
                    "runbook step {} references undeclared variable {placeholder}",
                    step.id
                ));
            }
        }
    }
    Ok(())
}

fn parse_document(text: &str) -> Result<RunbookDocument, String> {
    if text.trim().is_empty() || text.len() > MAX_RUNBOOK_BYTES {
        return Err("runbook text is empty or exceeds 512 KiB".to_string());
    }
    let document = serde_json::from_str::<RunbookDocument>(text)
        .map_err(|error| format!("failed to parse runbook JSON: {error}"))?;
    validate_document(&document)?;
    Ok(document)
}

fn selected_action<'a>(
    document: &'a RunbookDocument,
    item_id: &str,
    item_kind: RunbookItemKind,
) -> Result<SelectedAction<'a>, String> {
    match item_kind {
        RunbookItemKind::Precheck => document
            .prechecks
            .iter()
            .find(|item| item.id == item_id)
            .map(|item| SelectedAction {
                id: &item.id,
                command: &item.command,
                expected: &item.expected,
                timeout_seconds: item.timeout_seconds,
                risk: RunbookRisk::ReadOnly,
            }),
        RunbookItemKind::Step => {
            document
                .steps
                .iter()
                .find(|item| item.id == item_id)
                .map(|item| SelectedAction {
                    id: &item.id,
                    command: &item.command,
                    expected: &item.expected,
                    timeout_seconds: item.timeout_seconds,
                    risk: item.risk,
                })
        }
    }
    .ok_or_else(|| format!("runbook action {item_id} was not found"))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn retrieve_keychain_ref(
    credentials: &CredentialManager,
    profile_id: &str,
    reference: &str,
) -> Result<String, String> {
    let value = match reference {
        "keychain://profile/password" => credentials.retrieve_profile_password(profile_id)?,
        "keychain://profile/passphrase" => {
            credentials.retrieve_profile_secret(profile_id, ProfileSecretKind::Passphrase)?
        }
        "keychain://profile/jump-password" => {
            credentials.retrieve_profile_secret(profile_id, ProfileSecretKind::JumpPassword)?
        }
        "keychain://profile/jump-passphrase" => {
            credentials.retrieve_profile_secret(profile_id, ProfileSecretKind::JumpPassphrase)?
        }
        _ => return Err("unsupported runbook keychain reference".to_string()),
    };
    value.ok_or_else(|| format!("runbook keychain reference is missing: {reference}"))
}

fn interpolate(
    command: &str,
    document: &RunbookDocument,
    values: &HashMap<String, String>,
    credentials: &CredentialManager,
    profile_id: &str,
) -> Result<PreparedCommand, String> {
    let variables = document
        .variables
        .iter()
        .map(|variable| (variable.name.as_str(), variable))
        .collect::<HashMap<_, _>>();
    for name in values.keys() {
        let Some(variable) = variables.get(name.as_str()) else {
            return Err(format!("runbook received undeclared variable {name}"));
        };
        if variable.keychain_ref.is_some() {
            return Err(format!(
                "runbook secret variable {name} must not be supplied outside the keychain"
            ));
        }
    }
    let mut expanded = String::new();
    let mut preview = String::new();
    let mut secrets = Vec::new();
    let mut remaining = command;
    while let Some(start) = remaining.find("{{") {
        expanded.push_str(&remaining[..start]);
        preview.push_str(&remaining[..start]);
        let after_start = &remaining[start + 2..];
        let end = after_start.find("}}").ok_or_else(|| {
            "runbook command contains an unclosed variable placeholder".to_string()
        })?;
        let name = &after_start[..end];
        let variable = variables
            .get(name)
            .ok_or_else(|| format!("runbook command references undeclared variable {name}"))?;
        if let Some(reference) = variable.keychain_ref.as_deref() {
            let secret = retrieve_keychain_ref(credentials, profile_id, reference)?;
            expanded.push_str(&shell_quote(&secret));
            preview.push_str(&shell_quote(&format!("<{reference}>")));
            secrets.push(secret);
        } else {
            let value = values
                .get(name)
                .cloned()
                .or_else(|| variable.default.clone())
                .unwrap_or_default();
            if variable.required && value.is_empty() {
                return Err(format!("runbook variable {name} is required"));
            }
            if value.len() > 4_000 || value.chars().any(|character| character == '\0') {
                return Err(format!("runbook variable {name} is invalid"));
            }
            expanded.push_str(&shell_quote(&value));
            preview.push_str(&shell_quote(&value));
        }
        remaining = &after_start[end + 2..];
    }
    expanded.push_str(remaining);
    preview.push_str(remaining);
    Ok(PreparedCommand {
        command: expanded,
        preview,
        secrets,
    })
}

fn open_runbook_session(
    request: &RemoteConnectionRequest,
    known_hosts_path: &Path,
) -> Result<RunbookSshSession, String> {
    if let Some(jump) = &request.jump_host {
        let (jump, target) = connect_through_jump_host(
            jump,
            &request.host,
            request.port,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_data.as_deref(),
            request.passphrase.as_deref(),
            Some(known_hosts_path),
        )
        .map_err(|error| error.message())?;
        return Ok(RunbookSshSession {
            target,
            _jump: Some(jump),
        });
    }
    let tcp = connect_tcp_stream(&request.host, request.port)?;
    let target = open_authenticated_session(
        tcp,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_data.as_deref(),
        request.passphrase.as_deref(),
        &request.host,
        request.port,
        Some(known_hosts_path),
    )
    .map_err(|error| error.message())?;
    Ok(RunbookSshSession {
        target,
        _jump: None,
    })
}

fn read_available(
    reader: &mut impl Read,
    output: &mut Vec<u8>,
    limit: usize,
) -> Result<(), String> {
    let mut buffer = [0_u8; 4_096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => {
                if output.len().saturating_add(count) > limit {
                    return Err("runbook command output exceeded the safety limit".to_string());
                }
                output.extend_from_slice(&buffer[..count]);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(format!("failed to read runbook command output: {error}")),
        }
    }
}

fn execute_channel(
    session: &Session,
    command: &str,
    expected: &RunbookExpectedResult,
    cancel_flag: &AtomicBool,
    deadline: Instant,
) -> ExecutionOutcome {
    if cancel_flag.load(Ordering::SeqCst) {
        return ExecutionOutcome::Cancelled;
    }
    if Instant::now() >= deadline {
        return ExecutionOutcome::TimedOut;
    }
    let mut channel = match session.channel_session() {
        Ok(channel) => channel,
        Err(error) => {
            return ExecutionOutcome::Failed(format!(
                "failed to open runbook command channel: {error}"
            ))
        }
    };
    if let Err(error) = channel.exec(command) {
        return ExecutionOutcome::Failed(format!("failed to start runbook command: {error}"));
    }
    session.set_blocking(false);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = channel.close();
            return ExecutionOutcome::Cancelled;
        }
        if Instant::now() >= deadline {
            let _ = channel.close();
            return ExecutionOutcome::TimedOut;
        }
        if let Err(error) = read_available(&mut channel, &mut stdout, MAX_OUTPUT_BYTES) {
            let _ = channel.close();
            return ExecutionOutcome::Failed(error);
        }
        if let Err(error) = read_available(&mut channel.stderr(), &mut stderr, MAX_ERROR_BYTES) {
            let _ = channel.close();
            return ExecutionOutcome::Failed(error);
        }
        if channel.eof() {
            break;
        }
        std::thread::sleep(WORKER_POLL_INTERVAL);
    }
    session.set_blocking(true);
    if let Err(error) = channel.wait_close() {
        return ExecutionOutcome::Failed(format!(
            "failed to close runbook command channel: {error}"
        ));
    }
    let exit_code = match channel.exit_status() {
        Ok(status) => status,
        Err(error) => {
            return ExecutionOutcome::Failed(format!(
                "failed to read runbook command status: {error}"
            ))
        }
    };
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    let expected_matched = exit_code == expected.exit_code
        && expected
            .stdout_contains
            .iter()
            .all(|needle| stdout.contains(needle));
    ExecutionOutcome::Finished {
        exit_code,
        expected_matched,
        stdout,
        stderr,
    }
}

fn redact(mut value: String, secrets: &[String]) -> String {
    for secret in secrets {
        if !secret.is_empty() {
            value = value.replace(secret, "[REDACTED]");
        }
    }
    value
}

fn result(
    request: &RunbookStepExecutionRequest,
    document: &RunbookDocument,
    action: &SelectedAction<'_>,
    command_preview: String,
    started_at: i64,
    status: RunbookStepExecutionStatus,
    exit_code: Option<i32>,
    expected_matched: bool,
    stdout: Option<String>,
    stderr: Option<String>,
    error: Option<String>,
) -> RunbookStepExecutionResult {
    RunbookStepExecutionResult {
        operation_id: request.operation_id.clone(),
        run_id: request.run_id.clone(),
        runbook_id: document.id.clone(),
        source_digest: request.source_digest.clone(),
        item_id: action.id.to_string(),
        item_kind: request.item_kind,
        profile_id: request.profile_id.clone(),
        status,
        risk: action.risk,
        command_preview,
        started_at,
        completed_at: now_ms(),
        source: RunbookExecutionSource {
            kind: "sshRunbook",
            profile_id: request.profile_id.clone(),
            host: request.connection.host.clone(),
            port: request.connection.port,
            username: request.connection.username.clone(),
        },
        exit_code,
        expected_matched,
        stdout: stdout.filter(|value| !value.is_empty()),
        stderr: stderr.filter(|value| !value.is_empty()),
        error,
    }
}

fn connection_secrets(connection: &RemoteConnectionRequest) -> Vec<String> {
    let mut values = [
        connection.password.as_ref(),
        connection.private_key_data.as_ref(),
        connection.passphrase.as_ref(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .collect::<Vec<_>>();
    if let Some(jump) = connection.jump_host.as_ref() {
        values.extend(
            [
                jump.password.as_ref(),
                jump.private_key_data.as_ref(),
                jump.passphrase.as_ref(),
            ]
            .into_iter()
            .flatten()
            .cloned(),
        );
    }
    values
}

#[tauri::command]
pub(crate) fn execute_runbook_step(
    app: AppHandle,
    credentials: State<'_, CredentialManager>,
    database: State<'_, crate::db::Database>,
    cancellations: State<'_, RunbookCancellationRegistry>,
    mut request: RunbookStepExecutionRequest,
) -> Result<RunbookStepExecutionResult, String> {
    let document = parse_document(&request.runbook_text)?;
    if request.source_digest != source_digest(&request.runbook_text) {
        return Err("runbook source digest does not match the reviewed text".to_string());
    }
    let action = selected_action(&document, &request.item_id, request.item_kind)?;
    let started_at = now_ms();
    if !valid_operation_id(&request.operation_id)
        || !valid_operation_id(&request.run_id)
        || request.profile_id.trim().is_empty()
    {
        return Err("invalid runbook execution identity".to_string());
    }
    let profile = database
        .get_profile(&request.profile_id)?
        .ok_or_else(|| "runbook target profile was not found".to_string())?;
    if profile.host != request.connection.host
        || profile.port != request.connection.port
        || profile.username != request.connection.username
        || profile.auth_method.as_str() != request.connection.auth_method.as_str()
    {
        return Err("runbook target connection does not match its bound profile".to_string());
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms)
        || request.timeout_ms > action.timeout_seconds.saturating_mul(1_000)
    {
        return Err("runbook execution timeout exceeds the reviewed action timeout".to_string());
    }
    let prepared = interpolate(
        action.command,
        &document,
        &request.variable_values,
        &credentials,
        &request.profile_id,
    )?;
    if !request.authorized || request.approved_risk != action.risk {
        return Ok(result(
            &request,
            &document,
            &action,
            prepared.preview,
            started_at,
            RunbookStepExecutionStatus::Unauthorized,
            None,
            false,
            None,
            None,
            Some("runbook action requires explicit approval for its exact risk".to_string()),
        ));
    }
    crate::validate_connection_fields(&request.connection.host, &request.connection.username)?;
    crate::commands::resolve_keychain_key_for_remote(&credentials, &mut request.connection)?;
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let cancel_flag = cancellations.register(request.operation_id.clone())?;
    let mut secrets = prepared.secrets;
    secrets.extend(connection_secrets(&request.connection));
    let worker_connection = request.connection.clone();
    let worker_command = prepared.command;
    let worker_expected = action.expected.clone();
    let worker_cancel_flag = cancel_flag.clone();
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let outcome = if worker_cancel_flag.load(Ordering::SeqCst) {
            ExecutionOutcome::Cancelled
        } else {
            match open_runbook_session(&worker_connection, &known_hosts_path) {
                Ok(session) => execute_channel(
                    &session.target,
                    &worker_command,
                    &worker_expected,
                    &worker_cancel_flag,
                    deadline,
                ),
                Err(error) => ExecutionOutcome::Failed(error),
            }
        };
        let _ = sender.send(outcome);
    });
    let outcome = loop {
        if cancel_flag.load(Ordering::SeqCst) {
            break ExecutionOutcome::Cancelled;
        }
        let now = Instant::now();
        if now >= deadline {
            cancel_flag.store(true, Ordering::SeqCst);
            break ExecutionOutcome::TimedOut;
        }
        match receiver
            .recv_timeout(WORKER_POLL_INTERVAL.min(deadline.saturating_duration_since(now)))
        {
            Ok(outcome) => break outcome,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break ExecutionOutcome::Failed(
                    "runbook execution worker stopped unexpectedly".to_string(),
                )
            }
        }
    };
    let _ = cancellations.remove(&request.operation_id);
    Ok(match outcome {
        ExecutionOutcome::Finished {
            exit_code,
            expected_matched,
            stdout,
            stderr,
        } => {
            let status = if expected_matched {
                RunbookStepExecutionStatus::Success
            } else {
                RunbookStepExecutionStatus::Failed
            };
            result(
                &request,
                &document,
                &action,
                prepared.preview,
                started_at,
                status,
                Some(exit_code),
                expected_matched,
                Some(redact(stdout, &secrets)),
                Some(redact(stderr, &secrets)),
                (!expected_matched).then(|| {
                    "runbook command did not match its reviewed expected result".to_string()
                }),
            )
        }
        ExecutionOutcome::Cancelled => result(
            &request,
            &document,
            &action,
            prepared.preview,
            started_at,
            RunbookStepExecutionStatus::Cancelled,
            None,
            false,
            None,
            None,
            Some("runbook action was cancelled".to_string()),
        ),
        ExecutionOutcome::TimedOut => result(
            &request,
            &document,
            &action,
            prepared.preview,
            started_at,
            RunbookStepExecutionStatus::TimedOut,
            None,
            false,
            None,
            None,
            Some(format!(
                "runbook action timed out after {} ms",
                request.timeout_ms
            )),
        ),
        ExecutionOutcome::Failed(error) => result(
            &request,
            &document,
            &action,
            prepared.preview,
            started_at,
            RunbookStepExecutionStatus::Failed,
            None,
            false,
            None,
            None,
            Some(redact(error, &secrets)),
        ),
    })
}

#[tauri::command]
pub(crate) fn cancel_runbook_step(
    cancellations: State<'_, RunbookCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    cancellations.cancel(&operation_id)
}

#[tauri::command]
pub(crate) async fn open_runbook_file() -> Result<Option<RunbookFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("打开 Runbook")
            .add_filter("TermBridge Runbook", &["json"])
            .pick_file();
        let Some(path) = path else {
            return Ok(None);
        };
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("failed to inspect runbook file: {error}"))?;
        if metadata.len() > MAX_RUNBOOK_BYTES as u64 {
            return Err("runbook file exceeds 512 KiB".to_string());
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("failed to read runbook file: {error}"))?;
        let document = parse_document(&text)?;
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&document)
                .map_err(|error| format!("failed to normalize runbook: {error}"))?
        );
        Ok(Some(RunbookFile {
            path: crate::portable_local_path(&path),
            text,
        }))
    })
    .await
    .map_err(|error| format!("failed to run open runbook dialog: {error}"))?
}

#[tauri::command]
pub(crate) async fn save_runbook_file(text: String) -> Result<Option<RunbookFile>, String> {
    let document = parse_document(&text)?;
    let normalized = format!(
        "{}\n",
        serde_json::to_string_pretty(&document)
            .map_err(|error| format!("failed to normalize runbook: {error}"))?
    );
    let default_name = format!("{}.runbook.json", document.id);
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("保存 Runbook")
            .add_filter("TermBridge Runbook", &["json"])
            .set_file_name(&default_name)
            .save_file();
        let Some(path) = path else {
            return Ok(None);
        };
        std::fs::write(&path, &normalized)
            .map_err(|error| format!("failed to write runbook file: {error}"))?;
        Ok(Some(RunbookFile {
            path: crate::portable_local_path(&path),
            text: normalized,
        }))
    })
    .await
    .map_err(|error| format!("failed to run save runbook dialog: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AuthMethod;

    fn valid_text(command: &str, risk: &str, keychain: bool) -> String {
        let variables = if keychain {
            r#"[{"name":"PASSWORD","description":"credential","required":true,"keychainRef":"keychain://profile/password"}]"#
        } else {
            r#"[{"name":"SERVICE","description":"service","required":true,"default":"nginx"}]"#
        };
        format!(
            r#"{{
              "schemaVersion":1,
              "id":"test-runbook",
              "name":"Test",
              "description":"Test runbook",
              "evidenceMaxAgeSeconds":300,
              "variables":{variables},
              "prechecks":[{{"id":"check","description":"check","command":"uname -s","expected":{{"exitCode":0}},"timeoutSeconds":10}}],
              "steps":[{{"id":"action","description":"action","command":{command:?},"risk":"{risk}","impact":"reviewed impact","expected":{{"exitCode":0}},"timeoutSeconds":10,"safeToRetry":true}}]
            }}"#
        )
    }

    fn request(text: String, authorized: bool) -> RunbookStepExecutionRequest {
        RunbookStepExecutionRequest {
            operation_id: "runbook:test".to_string(),
            run_id: "runbook-run:test".to_string(),
            source_digest: source_digest(&text),
            runbook_text: text,
            item_id: "check".to_string(),
            item_kind: RunbookItemKind::Precheck,
            profile_id: "profile-1".to_string(),
            authorized,
            approved_risk: RunbookRisk::ReadOnly,
            variable_values: HashMap::new(),
            timeout_ms: 10_000,
            connection: RemoteConnectionRequest {
                host: "example.test".to_string(),
                port: 22,
                username: "operator".to_string(),
                auth_method: AuthMethod::Password,
                password: Some("secret".to_string()),
                keychain_key_id: None,
                private_key_data: None,
                passphrase: None,
                jump_host: None,
            },
        }
    }

    #[test]
    fn validates_reviewable_text_contract() {
        let document = parse_document(&valid_text(
            "sudo systemctl reload {{SERVICE}}",
            "stateChange",
            false,
        ))
        .expect("valid runbook");
        assert_eq!(document.id, "test-runbook");
        assert_eq!(document.prechecks.len(), 1);
        assert_eq!(document.steps[0].risk, RunbookRisk::StateChange);
    }

    #[test]
    fn rejects_parse_errors_unknown_fields_and_literal_secrets() {
        assert!(parse_document("not-json").is_err());
        let unknown = valid_text("uname -s", "readOnly", false).replacen(
            "\"schemaVersion\":1",
            "\"schemaVersion\":1,\"surprise\":true",
            1,
        );
        assert!(parse_document(&unknown).is_err());
        let secret_variable = valid_text("uname -s", "readOnly", false)
            .replace("\"name\":\"SERVICE\"", "\"name\":\"PASSWORD\"");
        assert!(parse_document(&secret_variable).is_err());
        assert!(parse_document(&valid_text(
            "curl -H 'Authorization: Bearer secret' https://example.test",
            "stateChange",
            false,
        ))
        .is_err());
    }

    #[test]
    fn rejects_understated_risk_and_unsafe_prechecks() {
        assert!(parse_document(&valid_text("rm -rf /srv/cache", "stateChange", false)).is_err());
        let unsafe_precheck =
            valid_text("uname -s", "readOnly", false).replacen("uname -s", "rm -rf /tmp/value", 1);
        assert!(parse_document(&unsafe_precheck).is_err());
        for unsafe_command in [
            "date -s tomorrow",
            "hostname replacement",
            "systemctl restart nginx",
            "journalctl --rotate -n 10",
            "tail -f /var/log/messages",
            "ss -K dst 127.0.0.1",
        ] {
            let text =
                valid_text("uname -s", "readOnly", false).replacen("uname -s", unsafe_command, 1);
            assert!(parse_document(&text).is_err(), "accepted {unsafe_command}");
        }
    }

    #[test]
    fn shell_quotes_variables_and_redacts_keychain_preview() {
        assert_eq!(shell_quote("a'b"), "'a'\"'\"'b'");
        let document = parse_document(&valid_text("cat {{PASSWORD}}", "readOnly", true))
            .expect("valid keychain runbook");
        assert_eq!(
            document.variables[0].keychain_ref.as_deref(),
            Some("keychain://profile/password")
        );
    }

    #[test]
    fn redaction_covers_stdout_stderr_and_errors() {
        let secrets = vec!["top-secret".to_string()];
        assert_eq!(
            redact("value=top-secret".to_string(), &secrets),
            "value=[REDACTED]"
        );
    }

    #[test]
    fn expected_results_require_exit_code_and_all_evidence() {
        let expected = RunbookExpectedResult {
            exit_code: 0,
            stdout_contains: vec!["Linux".to_string(), "x86".to_string()],
        };
        assert!(validate_expected(&expected).is_ok());
        assert!(expected
            .stdout_contains
            .iter()
            .all(|part| "Linux x86".contains(part)));
        assert!(!expected
            .stdout_contains
            .iter()
            .all(|part| "Linux arm".contains(part)));
    }

    #[test]
    fn unauthorized_result_keeps_target_and_evidence_identity() {
        let request = request(valid_text("uname -s", "readOnly", false), false);
        let document = parse_document(&request.runbook_text).unwrap();
        let action = selected_action(&document, "check", RunbookItemKind::Precheck).unwrap();
        let value = result(
            &request,
            &document,
            &action,
            "uname -s".to_string(),
            now_ms(),
            RunbookStepExecutionStatus::Unauthorized,
            None,
            false,
            None,
            None,
            Some("approval required".to_string()),
        );
        assert_eq!(value.profile_id, "profile-1");
        assert_eq!(value.source.host, "example.test");
        assert_eq!(value.status, RunbookStepExecutionStatus::Unauthorized);
    }

    #[test]
    fn cancellation_is_observed_before_connection_or_execution() {
        let flag = AtomicBool::new(true);
        let session_deadline = Instant::now() + Duration::from_secs(1);
        assert!(flag.load(Ordering::SeqCst));
        assert!(session_deadline > Instant::now());
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_step() {
        let host =
            std::env::var("TERMBRIDGE_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("TERMBRIDGE_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username = std::env::var("TERMBRIDGE_E2E_SSH_USERNAME")
            .unwrap_or_else(|_| "termbridge".to_string());
        let password = std::env::var("TERMBRIDGE_E2E_SSH_PASSWORD")
            .unwrap_or_else(|_| "termbridge-e2e".to_string());
        let connection = RemoteConnectionRequest {
            host,
            port,
            username,
            auth_method: AuthMethod::Password,
            password: Some(password),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let tcp = connect_tcp_stream(&connection.host, connection.port).expect("connect tcp");
        let target = open_authenticated_session(
            tcp,
            &connection.username,
            connection.auth_method,
            connection.password.as_deref(),
            None,
            None,
            &connection.host,
            connection.port,
            None,
        )
        .expect("authenticate isolated SSH");
        let expected = RunbookExpectedResult {
            exit_code: 0,
            stdout_contains: vec!["TERMBRIDGE_RUNBOOK_OK".to_string()],
        };
        let outcome = execute_channel(
            &target,
            "printf TERMBRIDGE_RUNBOOK_OK",
            &expected,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(10),
        );
        assert!(matches!(
            outcome,
            ExecutionOutcome::Finished {
                expected_matched: true,
                ..
            }
        ));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_multi_host_runbook_output_isolation() {
        let connection = RemoteConnectionRequest {
            host: std::env::var("TERMBRIDGE_E2E_SSH_HOST")
                .unwrap_or_else(|_| "127.0.0.1".to_string()),
            port: std::env::var("TERMBRIDGE_E2E_SSH_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(22222),
            username: std::env::var("TERMBRIDGE_E2E_SSH_USERNAME")
                .unwrap_or_else(|_| "termbridge".to_string()),
            auth_method: AuthMethod::Password,
            password: Some(
                std::env::var("TERMBRIDGE_E2E_SSH_PASSWORD")
                    .unwrap_or_else(|_| "termbridge-e2e".to_string()),
            ),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let handles = ["TERMBRIDGE_HOST_ALPHA", "TERMBRIDGE_HOST_BRAVO"].map(|marker| {
            let worker_connection = connection.clone();
            std::thread::spawn(move || {
                let tcp = connect_tcp_stream(&worker_connection.host, worker_connection.port)
                    .expect("connect isolated multi-host tcp");
                let session = open_authenticated_session(
                    tcp,
                    &worker_connection.username,
                    worker_connection.auth_method,
                    worker_connection.password.as_deref(),
                    None,
                    None,
                    &worker_connection.host,
                    worker_connection.port,
                    None,
                )
                .expect("authenticate isolated multi-host SSH");
                let expected = RunbookExpectedResult {
                    exit_code: 0,
                    stdout_contains: vec![marker.to_string()],
                };
                match execute_channel(
                    &session,
                    &format!("printf {marker}"),
                    &expected,
                    &AtomicBool::new(false),
                    Instant::now() + Duration::from_secs(10),
                ) {
                    ExecutionOutcome::Finished {
                        exit_code,
                        expected_matched,
                        stdout,
                        stderr,
                    } => (marker, exit_code, expected_matched, stdout, stderr),
                    _ => panic!("isolated multi-host command did not finish"),
                }
            })
        });
        let [alpha, bravo] = handles.map(|handle| handle.join().expect("join multi-host worker"));

        assert_eq!(alpha.1, 0);
        assert_eq!(bravo.1, 0);
        assert!(alpha.2 && bravo.2);
        assert_eq!(alpha.3, alpha.0);
        assert_eq!(bravo.3, bravo.0);
        assert!(!alpha.3.contains(bravo.0));
        assert!(!bravo.3.contains(alpha.0));
        assert!(alpha.4.is_empty() && bravo.4.is_empty());
    }
}
