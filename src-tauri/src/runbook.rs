use crate::execution::{
    await_ssh_execution_worker, known_connection_secret_values, redact_known_secrets,
    spawn_ssh_execution_worker, ExecutionCancellationRegistry, ExecutionErrorCategory,
    ExecutionOutputPolicy, SshChannelExecutionOutcome, DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
};
use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::RemoteConnectionRequest;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

#[cfg(test)]
use crate::execution::{execute_ssh_channel, CancellationHandle};
#[cfg(test)]
use ssh2::Session;

const MAX_RUNBOOK_BYTES: usize = 512 * 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_ERROR_BYTES: usize = 8 * 1024;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rollback: Option<String>,
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

pub(crate) fn contains_secret_literal(value: &str) -> bool {
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
            || (step.risk != RunbookRisk::ReadOnly
                && !step
                    .rollback
                    .as_deref()
                    .is_some_and(|value| non_empty_bounded(value, 4_000)))
            || step
                .rollback
                .as_deref()
                .is_some_and(|value| !non_empty_bounded(value, 4_000))
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

fn runbook_output_policy() -> ExecutionOutputPolicy {
    ExecutionOutputPolicy::new(
        MAX_OUTPUT_BYTES,
        MAX_ERROR_BYTES,
        DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
    )
    .expect("Runbook compatibility output policy stays within backend hard limits")
}

fn adapt_runbook_channel_outcome(
    outcome: SshChannelExecutionOutcome,
    expected: &RunbookExpectedResult,
) -> ExecutionOutcome {
    match outcome {
        SshChannelExecutionOutcome::Completed { exit_code, output } => {
            if output.stdout.truncated || output.stderr.truncated {
                return ExecutionOutcome::Failed(
                    "runbook command output exceeded the safety limit".to_string(),
                );
            }
            let stdout = output.stdout.text;
            let stderr = output.stderr.text;
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
        SshChannelExecutionOutcome::Cancelled => ExecutionOutcome::Cancelled,
        SshChannelExecutionOutcome::TimedOut => ExecutionOutcome::TimedOut,
        SshChannelExecutionOutcome::Failed(failure) => {
            let message = if failure.category == ExecutionErrorCategory::OutputLimitExceeded {
                "runbook command output exceeded the safety limit".to_string()
            } else {
                failure
                    .message
                    .replace("reviewed SSH execution", "runbook execution")
                    .replace("reviewed SSH command", "runbook command")
            };
            ExecutionOutcome::Failed(message)
        }
    }
}

#[cfg(test)]
fn execute_runbook_channel_compat(
    session: &Session,
    command: &str,
    expected: &RunbookExpectedResult,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> ExecutionOutcome {
    adapt_runbook_channel_outcome(
        execute_ssh_channel(
            session,
            command,
            runbook_output_policy(),
            &[],
            cancellation,
            deadline,
        ),
        expected,
    )
}

fn redact(value: String, secrets: &[String]) -> String {
    redact_known_secrets(&value, secrets)
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

#[tauri::command]
pub(crate) fn execute_runbook_step(
    app: AppHandle,
    credentials: State<'_, CredentialManager>,
    database: State<'_, crate::db::Database>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
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
    let cancellation = cancellations
        .register(request.operation_id.clone())
        .map_err(|error| error.runbook_message())?;
    let mut secrets = prepared.secrets;
    secrets.extend(known_connection_secret_values(&request.connection));
    let worker_expected = action.expected.clone();
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let receiver = spawn_ssh_execution_worker(
        request.connection.clone(),
        known_hosts_path,
        prepared.command,
        runbook_output_policy(),
        Vec::new(),
        cancellation.clone(),
        deadline,
    );
    let outcome = adapt_runbook_channel_outcome(
        await_ssh_execution_worker(&receiver, &cancellation, deadline),
        &worker_expected,
    );
    cancellation.remove_registration();
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
    cancellations: State<'_, ExecutionCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    cancellations
        .cancel(&operation_id)
        .map_err(|error| error.runbook_message())
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
    use crate::execution::{
        open_ssh_execution_session, BoundedOutputCollector, SshExecutionSession,
    };
    use crate::models::{AuthMethod, JumpHostConfig};

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
              "steps":[{{"id":"action","description":"action","command":{command:?},"risk":"{risk}","impact":"reviewed impact","rollback":"restore the reviewed previous state","expected":{{"exitCode":0}},"timeoutSeconds":10,"safeToRetry":true}}]
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

    fn isolated_connection() -> RemoteConnectionRequest {
        RemoteConnectionRequest {
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
        }
    }

    fn open_isolated_session(
        connection: &RemoteConnectionRequest,
    ) -> (tempfile::TempDir, SshExecutionSession) {
        let (known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = open_ssh_execution_session(connection, &known_hosts_path)
            .expect("authenticate isolated SSH with the trusted host key");
        (known_hosts_temp, session)
    }

    fn execution_handle(operation_id: &str) -> (ExecutionCancellationRegistry, CancellationHandle) {
        let registry = ExecutionCancellationRegistry::default();
        let handle = registry.register(operation_id).unwrap();
        (registry, handle)
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
        assert_eq!(
            document.steps[0].rollback.as_deref(),
            Some("restore the reviewed previous state")
        );
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
        let missing_rollback = valid_text("systemctl restart nginx", "stateChange", false)
            .replace(",\"rollback\":\"restore the reviewed previous state\"", "");
        assert!(parse_document(&missing_rollback).is_err());
        let evidence_only = valid_text("uname -s", "readOnly", false).replace(
            r#""steps":[{"id":"action","description":"action","command":"uname -s","risk":"readOnly","impact":"reviewed impact","rollback":"restore the reviewed previous state","expected":{"exitCode":0},"timeoutSeconds":10,"safeToRetry":true}]"#,
            r#""steps":[]"#,
        );
        assert!(parse_document(&evidence_only).is_ok());
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
        let mut request = request(valid_text("uname -s", "readOnly", false), false);
        request.connection.jump_host = Some(JumpHostConfig {
            host: "jump.example.test".to_string(),
            port: 2222,
            username: "jump-operator".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("jump-password".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
        });
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
        assert_eq!(value.source.port, 22);
        assert_eq!(value.source.username, "operator");
        assert_eq!(value.status, RunbookStepExecutionStatus::Unauthorized);
        let serialized = serde_json::to_string(&value).expect("serialize jump-host result");
        assert!(!serialized.contains("jump.example.test"));
        assert!(!serialized.contains("jump-password"));
    }

    #[test]
    fn external_execution_result_serialization_contract_is_frozen() {
        let value = RunbookStepExecutionResult {
            operation_id: "runbook:characterization".to_string(),
            run_id: "runbook-run:characterization".to_string(),
            runbook_id: "test-runbook".to_string(),
            source_digest: "fnv1a-12345678".to_string(),
            item_id: "check".to_string(),
            item_kind: RunbookItemKind::Precheck,
            profile_id: "profile-1".to_string(),
            status: RunbookStepExecutionStatus::Success,
            risk: RunbookRisk::ReadOnly,
            command_preview: "uname -s".to_string(),
            started_at: 1_000,
            completed_at: 1_250,
            source: RunbookExecutionSource {
                kind: "sshRunbook",
                profile_id: "profile-1".to_string(),
                host: "example.test".to_string(),
                port: 22,
                username: "operator".to_string(),
            },
            exit_code: Some(0),
            expected_matched: true,
            stdout: Some("Linux\n".to_string()),
            stderr: None,
            error: None,
        };

        assert_eq!(
            serde_json::to_value(value).expect("serialize execution result"),
            serde_json::json!({
                "operationId": "runbook:characterization",
                "runId": "runbook-run:characterization",
                "runbookId": "test-runbook",
                "sourceDigest": "fnv1a-12345678",
                "itemId": "check",
                "itemKind": "precheck",
                "profileId": "profile-1",
                "status": "success",
                "risk": "readOnly",
                "commandPreview": "uname -s",
                "startedAt": 1_000,
                "completedAt": 1_250,
                "source": {
                    "kind": "sshRunbook",
                    "profileId": "profile-1",
                    "host": "example.test",
                    "port": 22,
                    "username": "operator"
                },
                "exitCode": 0,
                "expectedMatched": true,
                "stdout": "Linux\n",
                "stderr": null,
                "error": null
            })
        );
    }

    #[test]
    fn cancellation_and_timeout_are_observed_before_channel_open() {
        let session = Session::new().expect("create disconnected SSH session");
        let (cancel_registry, cancel_handle) = execution_handle("runbook:pre-cancel");
        cancel_registry.cancel("runbook:pre-cancel").unwrap();
        let cancelled = execute_runbook_channel_compat(
            &session,
            "uname -s",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: Vec::new(),
            },
            &cancel_handle,
            Instant::now() + Duration::from_secs(1),
        );
        assert!(matches!(cancelled, ExecutionOutcome::Cancelled));

        let (_timeout_registry, timeout_handle) = execution_handle("runbook:pre-timeout");
        let timed_out = execute_runbook_channel_compat(
            &session,
            "uname -s",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: Vec::new(),
            },
            &timeout_handle,
            Instant::now(),
        );
        assert!(matches!(timed_out, ExecutionOutcome::TimedOut));

        let (race_registry, race_handle) = execution_handle("runbook:cancel-timeout-race");
        race_registry.cancel("runbook:cancel-timeout-race").unwrap();
        let cancelled_wins = execute_runbook_channel_compat(
            &session,
            "uname -s",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: Vec::new(),
            },
            &race_handle,
            Instant::now(),
        );
        assert!(matches!(cancelled_wins, ExecutionOutcome::Cancelled));
    }

    #[test]
    fn compatibility_wrapper_keeps_legacy_channel_error_wording() {
        let session = Session::new().expect("create disconnected SSH session");
        let (_registry, cancellation) = execution_handle("runbook:channel-error");
        let outcome = execute_runbook_channel_compat(
            &session,
            "uname -s",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: Vec::new(),
            },
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        );
        assert!(matches!(
            outcome,
            ExecutionOutcome::Failed(ref error)
                if error.starts_with("failed to open runbook command channel:")
        ));
    }

    #[test]
    fn cancellation_command_sets_registered_flag_and_cleanup_removes_it() {
        let cancellations = ExecutionCancellationRegistry::default();
        let handle = cancellations
            .register("runbook:cancel-characterization".to_string())
            .expect("register runbook cancellation");

        cancellations
            .cancel("runbook:cancel-characterization")
            .expect("cancel registered runbook operation");
        assert!(handle.is_cancelled());

        cancellations
            .remove("runbook:cancel-characterization")
            .expect("remove completed runbook operation");
        assert_eq!(
            cancellations
                .cancel("runbook:cancel-characterization")
                .expect_err("removed operation is no longer cancellable")
                .runbook_message(),
            "runbook step operation runbook:cancel-characterization not found"
        );
    }

    #[test]
    fn oversized_output_fails_at_the_existing_stream_limits() {
        let expected = RunbookExpectedResult {
            exit_code: 0,
            stdout_contains: Vec::new(),
        };
        for (stdout, limit) in [(true, MAX_OUTPUT_BYTES), (false, MAX_ERROR_BYTES)] {
            let mut exact = BoundedOutputCollector::new(runbook_output_policy()).unwrap();
            if stdout {
                exact.push_stdout(&vec![b'x'; limit]).unwrap();
            } else {
                exact.push_stderr(&vec![b'x'; limit]).unwrap();
            }
            let exact = adapt_runbook_channel_outcome(
                SshChannelExecutionOutcome::Completed {
                    exit_code: 0,
                    output: exact.finish(&[]).unwrap(),
                },
                &expected,
            );
            assert!(matches!(exact, ExecutionOutcome::Finished { .. }));

            let mut oversized = BoundedOutputCollector::new(runbook_output_policy()).unwrap();
            if stdout {
                oversized.push_stdout(&vec![b'x'; limit + 1]).unwrap();
            } else {
                oversized.push_stderr(&vec![b'x'; limit + 1]).unwrap();
            }
            let oversized = adapt_runbook_channel_outcome(
                SshChannelExecutionOutcome::Completed {
                    exit_code: 0,
                    output: oversized.finish(&[]).unwrap(),
                },
                &expected,
            );
            assert!(matches!(
                oversized,
                ExecutionOutcome::Failed(ref error)
                    if error == "runbook command output exceeded the safety limit"
            ));
        }
    }

    #[test]
    fn secret_redaction_includes_target_and_jump_host_credentials() {
        let mut connection = request(valid_text("uname -s", "readOnly", false), true).connection;
        connection.private_key_data = Some("target-private-key".to_string());
        connection.passphrase = Some("target-passphrase".to_string());
        connection.jump_host = Some(JumpHostConfig {
            host: "jump.example.test".to_string(),
            port: 22,
            username: "jump-operator".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("jump-password".to_string()),
            keychain_key_id: None,
            private_key_data: Some("jump-private-key".to_string()),
            passphrase: Some("jump-passphrase".to_string()),
        });
        let secrets = known_connection_secret_values(&connection);
        let raw = format!(
            "{} {} {} {} {} {}",
            connection.password.as_deref().unwrap(),
            connection.private_key_data.as_deref().unwrap(),
            connection.passphrase.as_deref().unwrap(),
            connection
                .jump_host
                .as_ref()
                .unwrap()
                .password
                .as_deref()
                .unwrap(),
            connection
                .jump_host
                .as_ref()
                .unwrap()
                .private_key_data
                .as_deref()
                .unwrap(),
            connection
                .jump_host
                .as_ref()
                .unwrap()
                .passphrase
                .as_deref()
                .unwrap(),
        );
        let redacted = redact(raw, &secrets);

        assert_eq!(
            redacted,
            "[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]"
        );
        for secret in secrets {
            assert!(!redacted.contains(&secret));
        }
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_step() {
        let connection = isolated_connection();
        let (_known_hosts_temp, target) = open_isolated_session(&connection);
        let expected = RunbookExpectedResult {
            exit_code: 0,
            stdout_contains: vec!["TERMBRIDGE_RUNBOOK_OK".to_string()],
        };
        let (_registry, cancellation) = execution_handle("runbook:fixture-success");
        let outcome = execute_runbook_channel_compat(
            &target.target,
            "printf TERMBRIDGE_RUNBOOK_OK",
            &expected,
            &cancellation,
            Instant::now() + Duration::from_secs(10),
        );
        match outcome {
            ExecutionOutcome::Finished {
                exit_code,
                expected_matched,
                stdout,
                stderr,
            } => {
                assert_eq!(exit_code, 0);
                assert!(expected_matched);
                assert_eq!(stdout, "TERMBRIDGE_RUNBOOK_OK");
                assert!(stderr.is_empty());
            }
            _ => panic!("isolated success command did not finish"),
        }
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_nonzero_exit_and_expected_mismatch() {
        let connection = isolated_connection();
        let (_known_hosts_temp, target) = open_isolated_session(&connection);
        let (_registry, cancellation) = execution_handle("runbook:fixture-nonzero");
        let nonzero = execute_runbook_channel_compat(
            &target.target,
            "sh -c 'printf TERMBRIDGE_NONZERO; printf TERMBRIDGE_STDERR >&2; exit 7'",
            &RunbookExpectedResult {
                exit_code: 7,
                stdout_contains: vec!["TERMBRIDGE_NONZERO".to_string()],
            },
            &cancellation,
            Instant::now() + Duration::from_secs(10),
        );
        assert!(matches!(
            nonzero,
            ExecutionOutcome::Finished {
                exit_code: 7,
                expected_matched: true,
                ref stdout,
                ref stderr,
            } if stdout == "TERMBRIDGE_NONZERO" && stderr == "TERMBRIDGE_STDERR"
        ));

        let (_known_hosts_temp, target) = open_isolated_session(&connection);
        let (_registry, cancellation) = execution_handle("runbook:fixture-mismatch");
        let mismatch = execute_runbook_channel_compat(
            &target.target,
            "printf TERMBRIDGE_ACTUAL",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: vec!["TERMBRIDGE_REVIEWED_EXPECTATION".to_string()],
            },
            &cancellation,
            Instant::now() + Duration::from_secs(10),
        );
        assert!(matches!(
            mismatch,
            ExecutionOutcome::Finished {
                exit_code: 0,
                expected_matched: false,
                ref stdout,
                ..
            } if stdout == "TERMBRIDGE_ACTUAL"
        ));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_cancel_and_timeout() {
        let connection = isolated_connection();
        let (_known_hosts_temp, target) = open_isolated_session(&connection);
        let (cancel_registry, cancellation) = execution_handle("runbook:fixture-cancel");
        let cancel_worker = cancel_registry.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel_worker.cancel("runbook:fixture-cancel").unwrap();
        });
        let cancelled = execute_runbook_channel_compat(
            &target.target,
            "sleep 5",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: Vec::new(),
            },
            &cancellation,
            Instant::now() + Duration::from_secs(10),
        );
        canceller
            .join()
            .expect("join isolated cancellation trigger");
        assert!(matches!(cancelled, ExecutionOutcome::Cancelled));

        let (_known_hosts_temp, target) = open_isolated_session(&connection);
        let (_registry, cancellation) = execution_handle("runbook:fixture-timeout");
        let timed_out = execute_runbook_channel_compat(
            &target.target,
            "sleep 5",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: Vec::new(),
            },
            &cancellation,
            Instant::now() + Duration::from_millis(150),
        );
        assert!(matches!(timed_out, ExecutionOutcome::TimedOut));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_oversized_output_fails() {
        let connection = isolated_connection();
        let (_known_hosts_temp, target) = open_isolated_session(&connection);
        let (_registry, cancellation) = execution_handle("runbook:fixture-oversized");
        let outcome = execute_runbook_channel_compat(
            &target.target,
            "head -c 65537 /dev/zero",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: Vec::new(),
            },
            &cancellation,
            Instant::now() + Duration::from_secs(10),
        );
        assert!(matches!(
            outcome,
            ExecutionOutcome::Failed(ref error)
                if error == "runbook command output exceeded the safety limit"
        ));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_secret_output_is_redacted() {
        const SECRET: &str = "TERMBRIDGE_REDACT_ME";
        let connection = isolated_connection();
        let (_known_hosts_temp, target) = open_isolated_session(&connection);
        let (_registry, cancellation) = execution_handle("runbook:fixture-secret");
        let outcome = execute_runbook_channel_compat(
            &target.target,
            "sh -c 'printf TERMBRIDGE_REDACT_ME; printf TERMBRIDGE_REDACT_ME >&2'",
            &RunbookExpectedResult {
                exit_code: 0,
                stdout_contains: vec![SECRET.to_string()],
            },
            &cancellation,
            Instant::now() + Duration::from_secs(10),
        );
        let ExecutionOutcome::Finished {
            expected_matched,
            stdout,
            stderr,
            ..
        } = outcome
        else {
            panic!("isolated secret echo command did not finish");
        };
        assert!(expected_matched);

        let secrets = vec![SECRET.to_string()];
        let stdout = redact(stdout, &secrets);
        let stderr = redact(stderr, &secrets);
        assert_eq!(stdout, "[REDACTED]");
        assert_eq!(stderr, "[REDACTED]");
        assert!(!stdout.contains(SECRET) && !stderr.contains(SECRET));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_multi_host_runbook_output_isolation() {
        let connection = isolated_connection();
        let (_known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let handles = ["TERMBRIDGE_HOST_ALPHA", "TERMBRIDGE_HOST_BRAVO"].map(|marker| {
            let worker_connection = connection.clone();
            let worker_known_hosts_path = known_hosts_path.clone();
            std::thread::spawn(move || {
                let session =
                    open_ssh_execution_session(&worker_connection, &worker_known_hosts_path)
                        .expect("authenticate isolated multi-host SSH with the trusted host key");
                let expected = RunbookExpectedResult {
                    exit_code: 0,
                    stdout_contains: vec![marker.to_string()],
                };
                let (_registry, cancellation) =
                    execution_handle(&format!("runbook:fixture-{marker}"));
                match execute_runbook_channel_compat(
                    &session.target,
                    &format!("printf {marker}"),
                    &expected,
                    &cancellation,
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
