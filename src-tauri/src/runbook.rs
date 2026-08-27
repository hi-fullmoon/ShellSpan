use crate::execution::{
    execute_reviewed_ssh_command, ExecutionCancellationError, ExecutionCancellationErrorKind,
    ExecutionCancellationRegistry, ExecutionErrorCategory, ExecutionOutputPolicy, ExecutionStatus,
    FrozenTargetIdentity, ReviewedSshCommand, ReviewedSshExecutionRequest,
    ReviewedSshExecutionResult, DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
};
use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::RemoteConnectionRequest;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, State};

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
    interpolate_with_secret_resolver(command, document, values, |reference| {
        retrieve_keychain_ref(credentials, profile_id, reference)
    })
}

fn interpolate_with_secret_resolver(
    command: &str,
    document: &RunbookDocument,
    values: &HashMap<String, String>,
    mut resolve_secret: impl FnMut(&str) -> Result<String, String>,
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
            let secret = resolve_secret(reference)?;
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

fn runbook_execution_error(execution: &ReviewedSshExecutionResult) -> String {
    if execution.error_category == Some(ExecutionErrorCategory::OutputLimitExceeded) {
        return "runbook command output exceeded the safety limit".to_string();
    }
    match execution.error.as_deref() {
        Some("reviewed execution operation ID is already registered") => format!(
            "runbook step operation {} is already registered",
            execution.operation_id
        ),
        Some("reviewed execution cancellation registry is unavailable") => {
            "runbook step cancellation registry poisoned".to_string()
        }
        message => message
            .unwrap_or("runbook execution failed without an error message")
            .replace("reviewed SSH execution", "runbook execution")
            .replace("reviewed SSH command", "runbook command"),
    }
}

fn runbook_cancellation_error(operation_id: &str, error: ExecutionCancellationError) -> String {
    match error.kind {
        ExecutionCancellationErrorKind::InvalidOperationId => {
            "invalid runbook execution identity".to_string()
        }
        ExecutionCancellationErrorKind::DuplicateOperationId => {
            format!("runbook step operation {operation_id} is already registered")
        }
        ExecutionCancellationErrorKind::OperationNotFound => {
            format!("runbook step operation {operation_id} not found")
        }
        ExecutionCancellationErrorKind::RegistryPoisoned => {
            "runbook step cancellation registry poisoned".to_string()
        }
    }
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

fn map_reviewed_execution_result(
    request: &RunbookStepExecutionRequest,
    document: &RunbookDocument,
    action: &SelectedAction<'_>,
    command_preview: String,
    started_at: i64,
    execution: ReviewedSshExecutionResult,
) -> RunbookStepExecutionResult {
    match execution.status {
        ExecutionStatus::Completed if execution.stdout_truncated || execution.stderr_truncated => {
            result(
                request,
                document,
                action,
                command_preview,
                started_at,
                RunbookStepExecutionStatus::Failed,
                None,
                false,
                None,
                None,
                Some("runbook command output exceeded the safety limit".to_string()),
            )
        }
        ExecutionStatus::Completed => {
            let Some(exit_code) = execution.exit_code else {
                return result(
                    request,
                    document,
                    action,
                    command_preview,
                    started_at,
                    RunbookStepExecutionStatus::Failed,
                    None,
                    false,
                    None,
                    None,
                    Some("runbook execution completed without an exit code".to_string()),
                );
            };
            let expected_matched = exit_code == action.expected.exit_code
                && action
                    .expected
                    .stdout_contains
                    .iter()
                    .all(|needle| execution.stdout.contains(needle));
            result(
                request,
                document,
                action,
                command_preview,
                started_at,
                if expected_matched {
                    RunbookStepExecutionStatus::Success
                } else {
                    RunbookStepExecutionStatus::Failed
                },
                Some(exit_code),
                expected_matched,
                Some(execution.stdout),
                Some(execution.stderr),
                (!expected_matched).then(|| {
                    "runbook command did not match its reviewed expected result".to_string()
                }),
            )
        }
        ExecutionStatus::Cancelled => result(
            request,
            document,
            action,
            command_preview,
            started_at,
            RunbookStepExecutionStatus::Cancelled,
            None,
            false,
            None,
            None,
            Some("runbook action was cancelled".to_string()),
        ),
        ExecutionStatus::TimedOut => result(
            request,
            document,
            action,
            command_preview,
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
        ExecutionStatus::Failed => {
            let error = runbook_execution_error(&execution);
            result(
                request,
                document,
                action,
                command_preview,
                started_at,
                RunbookStepExecutionStatus::Failed,
                None,
                false,
                None,
                None,
                Some(error),
            )
        }
    }
}

fn execute_runbook_step_with_known_hosts(
    credentials: &CredentialManager,
    database: &crate::db::Database,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: impl FnOnce() -> Result<PathBuf, String>,
    request: RunbookStepExecutionRequest,
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
        credentials,
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

    let target =
        FrozenTargetIdentity::from_connection(request.profile_id.clone(), &request.connection)
            .map_err(|error| error.message.to_string())?;
    let command_preview = prepared.preview.clone();
    let command = ReviewedSshCommand::new(prepared.command, prepared.preview, prepared.secrets)
        .map_err(|error| error.message.to_string())?;
    let reviewed_request = ReviewedSshExecutionRequest {
        operation_id: request.operation_id.clone(),
        target,
        connection: request.connection.clone(),
        command,
        timeout: Duration::from_millis(request.timeout_ms),
        output_policy: runbook_output_policy(),
    };
    let execution = execute_reviewed_ssh_command(
        database,
        credentials,
        cancellations,
        &known_hosts_path()?,
        reviewed_request,
    );
    if execution.status == ExecutionStatus::Failed
        && (matches!(
            execution.error_category,
            Some(
                ExecutionErrorCategory::InvalidRequest
                    | ExecutionErrorCategory::CredentialUnavailable
            )
        ) || execution.error.as_deref()
            == Some("reviewed execution cancellation registry is unavailable"))
    {
        return Err(runbook_execution_error(&execution));
    }
    Ok(map_reviewed_execution_result(
        &request,
        &document,
        &action,
        command_preview,
        started_at,
        execution,
    ))
}

#[tauri::command]
pub(crate) fn execute_runbook_step(
    app: AppHandle,
    credentials: State<'_, CredentialManager>,
    database: State<'_, crate::db::Database>,
    cancellations: State<'_, ExecutionCancellationRegistry>,
    request: RunbookStepExecutionRequest,
) -> Result<RunbookStepExecutionResult, String> {
    execute_runbook_step_with_known_hosts(
        &credentials,
        &database,
        &cancellations,
        || crate::known_hosts::known_hosts_path(&app),
        request,
    )
}

#[tauri::command]
pub(crate) fn cancel_runbook_step(
    cancellations: State<'_, ExecutionCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    cancellations
        .cancel(&operation_id)
        .map_err(|error| runbook_cancellation_error(&operation_id, error))
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
    use crate::models::{AuthMethod, JumpHostConfig, ProfileAuthMethod, ProfileRow};
    use std::sync::Arc;

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

    fn profile_for_connection(
        profile_id: &str,
        connection: &RemoteConnectionRequest,
    ) -> ProfileRow {
        ProfileRow {
            id: profile_id.to_string(),
            name: "Runbook fixture".to_string(),
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            auth_method: match connection.auth_method {
                AuthMethod::Password => ProfileAuthMethod::Password,
                AuthMethod::Key => ProfileAuthMethod::Key,
            },
            keychain_key_id: connection.keychain_key_id.clone(),
            jump_host_config: connection.jump_host.as_ref().map(|jump| {
                serde_json::json!({
                    "host": jump.host,
                    "port": jump.port,
                    "username": jump.username,
                    "authMethod": jump.auth_method,
                    "keychainKeyId": jump.keychain_key_id,
                })
                .to_string()
            }),
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn adapter_database(
        profile_id: &str,
        connection: &RemoteConnectionRequest,
    ) -> (tempfile::TempDir, crate::db::Database) {
        let directory = tempfile::tempdir().expect("create Runbook adapter database directory");
        let database = crate::db::Database::open(&directory.path().join("termbridge.db"))
            .expect("open Runbook adapter database");
        database
            .insert_profile(&profile_for_connection(profile_id, connection))
            .expect("insert Runbook adapter profile");
        (directory, database)
    }

    fn execution_text(
        command: &str,
        risk: &str,
        expected_exit_code: i32,
        stdout_contains: &[&str],
    ) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "id": "test-runbook",
            "name": "Test",
            "description": "Test runbook",
            "evidenceMaxAgeSeconds": 300,
            "variables": [],
            "prechecks": [{
                "id": "check",
                "description": "check",
                "command": "uname -s",
                "expected": { "exitCode": 0 },
                "timeoutSeconds": 10
            }],
            "steps": [{
                "id": "action",
                "description": "action",
                "command": command,
                "risk": risk,
                "impact": "reviewed impact",
                "rollback": "restore the reviewed previous state",
                "expected": {
                    "exitCode": expected_exit_code,
                    "stdoutContains": stdout_contains
                },
                "timeoutSeconds": 10,
                "safeToRetry": true
            }]
        })
        .to_string()
    }

    fn execution_request(
        operation_id: &str,
        connection: RemoteConnectionRequest,
        command: &str,
        risk: RunbookRisk,
        expected_exit_code: i32,
        stdout_contains: &[&str],
    ) -> RunbookStepExecutionRequest {
        let risk_name = match risk {
            RunbookRisk::ReadOnly => "readOnly",
            RunbookRisk::StateChange => "stateChange",
            RunbookRisk::Destructive => "destructive",
        };
        let text = execution_text(command, risk_name, expected_exit_code, stdout_contains);
        RunbookStepExecutionRequest {
            operation_id: operation_id.to_string(),
            run_id: format!("run:{operation_id}"),
            source_digest: source_digest(&text),
            runbook_text: text,
            item_id: "action".to_string(),
            item_kind: RunbookItemKind::Step,
            profile_id: "profile-1".to_string(),
            authorized: true,
            approved_risk: risk,
            variable_values: HashMap::new(),
            timeout_ms: 10_000,
            connection,
        }
    }

    fn reviewed_result(
        request: &RunbookStepExecutionRequest,
        status: ExecutionStatus,
        exit_code: Option<i32>,
        stdout: &str,
        stderr: &str,
    ) -> ReviewedSshExecutionResult {
        ReviewedSshExecutionResult {
            operation_id: request.operation_id.clone(),
            target: FrozenTargetIdentity::from_connection(
                request.profile_id.clone(),
                &request.connection,
            )
            .expect("freeze mapped result target"),
            status,
            started_at: 1_000,
            completed_at: 1_250,
            exit_code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            stdout_bytes_captured: stdout.len() as u64,
            stderr_bytes_captured: stderr.len() as u64,
            stdout_bytes_read: stdout.len() as u64,
            stderr_bytes_read: stderr.len() as u64,
            stdout_truncated: false,
            stderr_truncated: false,
            error_category: None,
            error: None,
        }
    }

    fn map_reviewed_result(
        request: &RunbookStepExecutionRequest,
        execution: ReviewedSshExecutionResult,
    ) -> RunbookStepExecutionResult {
        let document = parse_document(&request.runbook_text).expect("parse mapped Runbook");
        let action = selected_action(&document, &request.item_id, request.item_kind)
            .expect("select mapped Runbook action");
        map_reviewed_execution_result(
            request,
            &document,
            &action,
            action.command.to_string(),
            900,
            execution,
        )
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
        let prepared = interpolate_with_secret_resolver(
            document.steps[0].command.as_str(),
            &document,
            &HashMap::new(),
            |reference| {
                assert_eq!(reference, "keychain://profile/password");
                Ok("s'ecret".to_string())
            },
        )
        .expect("resolve reviewed secret reference");
        assert_eq!(prepared.command, "cat 's'\"'\"'ecret'");
        assert_eq!(prepared.preview, "cat '<keychain://profile/password>'");
        assert_eq!(prepared.secrets, vec!["s'ecret"]);
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
    fn unauthorized_adapter_result_keeps_exact_risk_and_does_not_enter_the_kernel() {
        let connection = isolated_connection();
        let (_database_temp, database) = adapter_database("profile-1", &connection);
        let mut request = execution_request(
            "runbook:adapter-unauthorized",
            connection,
            "printf APPROVAL_REQUIRED",
            RunbookRisk::StateChange,
            0,
            &[],
        );
        request.approved_risk = RunbookRisk::ReadOnly;
        let known_hosts_requested = std::sync::atomic::AtomicBool::new(false);
        let mapped = execute_runbook_step_with_known_hosts(
            &CredentialManager::new(),
            &database,
            &ExecutionCancellationRegistry::default(),
            || {
                known_hosts_requested.store(true, std::sync::atomic::Ordering::SeqCst);
                Err("kernel must not be reached without exact approval".to_string())
            },
            request,
        )
        .expect("return unauthorized Runbook result");

        assert_eq!(mapped.status, RunbookStepExecutionStatus::Unauthorized);
        assert_eq!(mapped.risk, RunbookRisk::StateChange);
        assert_eq!(mapped.command_preview, "printf APPROVAL_REQUIRED");
        assert!(!known_hosts_requested.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn adapter_freezes_then_revalidates_the_profile_before_network_access() {
        let connection = isolated_connection();
        let (_database_temp, database) = adapter_database("profile-1", &connection);
        let database_during_dispatch = database.clone();
        let changed_connection = connection.clone();
        let mapped = execute_runbook_step_with_known_hosts(
            &CredentialManager::new(),
            &database,
            &ExecutionCancellationRegistry::default(),
            move || {
                let mut changed = profile_for_connection("profile-1", &changed_connection);
                changed.host = "changed.example.test".to_string();
                database_during_dispatch
                    .update_profile("profile-1", &changed)
                    .expect("change profile after adapter freeze");
                Ok(PathBuf::from("unused-known-hosts"))
            },
            execution_request(
                "runbook:adapter-profile-drift",
                connection.clone(),
                "uname -s",
                RunbookRisk::ReadOnly,
                0,
                &[],
            ),
        )
        .expect("map target drift into the Runbook result");

        assert_eq!(mapped.status, RunbookStepExecutionStatus::Failed);
        assert_eq!(mapped.source.host, connection.host);
        assert_eq!(
            mapped.error.as_deref(),
            Some("stored profile identity does not match the frozen target")
        );
    }

    #[test]
    fn generic_completed_results_keep_runbook_expected_matching_and_identity() {
        let request = execution_request(
            "runbook:adapter-nonzero",
            isolated_connection(),
            "uname -s",
            RunbookRisk::ReadOnly,
            7,
            &["Linux", "x86"],
        );
        let execution = reviewed_result(
            &request,
            ExecutionStatus::Completed,
            Some(7),
            "Linux x86\n",
            "warning\n",
        );
        let mapped = map_reviewed_result(&request, execution);

        assert_eq!(mapped.status, RunbookStepExecutionStatus::Success);
        assert_eq!(mapped.exit_code, Some(7));
        assert!(mapped.expected_matched);
        assert_eq!(mapped.stdout.as_deref(), Some("Linux x86\n"));
        assert_eq!(mapped.stderr.as_deref(), Some("warning\n"));
        assert_eq!(mapped.command_preview, "uname -s");
        assert_eq!(mapped.source.kind, "sshRunbook");
        assert_eq!(mapped.source.profile_id, "profile-1");
        assert_eq!(mapped.source.host, request.connection.host);
        assert_eq!(mapped.source.port, request.connection.port);
        assert_eq!(mapped.source.username, request.connection.username);

        let mismatch = reviewed_result(
            &request,
            ExecutionStatus::Completed,
            Some(7),
            "Linux arm\n",
            "",
        );
        let mismatch = map_reviewed_result(&request, mismatch);
        assert_eq!(mismatch.status, RunbookStepExecutionStatus::Failed);
        assert_eq!(mismatch.exit_code, Some(7));
        assert!(!mismatch.expected_matched);
        assert_eq!(
            mismatch.error.as_deref(),
            Some("runbook command did not match its reviewed expected result")
        );
    }

    #[test]
    fn generic_terminal_states_map_to_the_existing_runbook_contract() {
        let request = execution_request(
            "runbook:adapter-terminals",
            isolated_connection(),
            "uname -s",
            RunbookRisk::ReadOnly,
            0,
            &[],
        );
        for (status, expected_status, expected_error) in [
            (
                ExecutionStatus::Cancelled,
                RunbookStepExecutionStatus::Cancelled,
                "runbook action was cancelled".to_string(),
            ),
            (
                ExecutionStatus::TimedOut,
                RunbookStepExecutionStatus::TimedOut,
                "runbook action timed out after 10000 ms".to_string(),
            ),
        ] {
            let mapped = map_reviewed_result(
                &request,
                reviewed_result(&request, status, None, "discarded", "discarded"),
            );
            assert_eq!(mapped.status, expected_status);
            assert_eq!(mapped.exit_code, None);
            assert_eq!(mapped.stdout, None);
            assert_eq!(mapped.stderr, None);
            assert_eq!(mapped.error, Some(expected_error));
        }

        let mut failure = reviewed_result(&request, ExecutionStatus::Failed, None, "", "");
        failure.error_category = Some(ExecutionErrorCategory::ChannelOpenFailed);
        failure.error = Some("failed to open reviewed SSH command channel: fixture".to_string());
        let mapped = map_reviewed_result(&request, failure);
        assert_eq!(mapped.status, RunbookStepExecutionStatus::Failed);
        assert_eq!(
            mapped.error.as_deref(),
            Some("failed to open runbook command channel: fixture")
        );
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
            runbook_cancellation_error(
                "runbook:cancel-characterization",
                cancellations
                    .cancel("runbook:cancel-characterization")
                    .expect_err("removed operation is no longer cancellable"),
            ),
            "runbook step operation runbook:cancel-characterization not found"
        );
    }

    #[test]
    fn duplicate_operation_registration_keeps_the_existing_command_error() {
        let connection = isolated_connection();
        let (_database_temp, database) = adapter_database("profile-1", &connection);
        let cancellations = ExecutionCancellationRegistry::default();
        let _existing = cancellations
            .register("runbook:duplicate-operation")
            .expect("reserve Runbook operation ID");

        let error = execute_runbook_step_with_known_hosts(
            &CredentialManager::new(),
            &database,
            &cancellations,
            || Ok(PathBuf::from("unused-known-hosts")),
            execution_request(
                "runbook:duplicate-operation",
                connection,
                "uname -s",
                RunbookRisk::ReadOnly,
                0,
                &[],
            ),
        )
        .expect_err("duplicate Runbook operation must remain a command error");
        assert_eq!(
            error,
            "runbook step operation runbook:duplicate-operation is already registered"
        );
    }

    #[test]
    fn oversized_output_fails_at_the_existing_stream_limits() {
        let request = execution_request(
            "runbook:adapter-truncation",
            isolated_connection(),
            "uname -s",
            RunbookRisk::ReadOnly,
            0,
            &[],
        );
        for stdout_truncated in [true, false] {
            let mut execution = reviewed_result(
                &request,
                ExecutionStatus::Completed,
                Some(0),
                "captured stdout",
                "captured stderr",
            );
            execution.stdout_truncated = stdout_truncated;
            execution.stderr_truncated = !stdout_truncated;
            execution.stdout_bytes_read = (MAX_OUTPUT_BYTES + 1) as u64;
            execution.stderr_bytes_read = (MAX_ERROR_BYTES + 1) as u64;
            let mapped = map_reviewed_result(&request, execution);

            assert_eq!(mapped.status, RunbookStepExecutionStatus::Failed);
            assert_eq!(mapped.exit_code, None);
            assert_eq!(mapped.stdout, None);
            assert_eq!(mapped.stderr, None);
            assert_eq!(
                mapped.error.as_deref(),
                Some("runbook command output exceeded the safety limit")
            );
        }

        let mut hard_limit = reviewed_result(&request, ExecutionStatus::Failed, None, "", "");
        hard_limit.error_category = Some(ExecutionErrorCategory::OutputLimitExceeded);
        hard_limit.error = Some("reviewed SSH output exceeded the hard limit".to_string());
        assert_eq!(
            map_reviewed_result(&request, hard_limit).error.as_deref(),
            Some("runbook command output exceeded the safety limit")
        );
    }

    fn execute_isolated_adapter(
        request: RunbookStepExecutionRequest,
    ) -> RunbookStepExecutionResult {
        let connection = request.connection.clone();
        let (_known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let (_database_temp, database) = adapter_database(&request.profile_id, &connection);
        execute_runbook_step_with_known_hosts(
            &CredentialManager::new(),
            &database,
            &ExecutionCancellationRegistry::default(),
            || Ok(known_hosts_path),
            request,
        )
        .expect("execute Runbook through the reviewed SSH adapter")
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_step() {
        let result = execute_isolated_adapter(execution_request(
            "runbook:fixture-success",
            isolated_connection(),
            "printf TERMBRIDGE_RUNBOOK_OK",
            RunbookRisk::StateChange,
            0,
            &["TERMBRIDGE_RUNBOOK_OK"],
        ));
        assert_eq!(result.status, RunbookStepExecutionStatus::Success);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.expected_matched);
        assert_eq!(result.stdout.as_deref(), Some("TERMBRIDGE_RUNBOOK_OK"));
        assert_eq!(result.stderr, None);
        assert_eq!(result.source.kind, "sshRunbook");
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_nonzero_exit_and_expected_mismatch() {
        let connection = isolated_connection();
        let nonzero = execute_isolated_adapter(execution_request(
            "runbook:fixture-nonzero",
            connection.clone(),
            "sh -c 'printf TERMBRIDGE_NONZERO; printf TERMBRIDGE_STDERR >&2; exit 7'",
            RunbookRisk::StateChange,
            7,
            &["TERMBRIDGE_NONZERO"],
        ));
        assert_eq!(nonzero.status, RunbookStepExecutionStatus::Success);
        assert_eq!(nonzero.exit_code, Some(7));
        assert!(nonzero.expected_matched);
        assert_eq!(nonzero.stdout.as_deref(), Some("TERMBRIDGE_NONZERO"));
        assert_eq!(nonzero.stderr.as_deref(), Some("TERMBRIDGE_STDERR"));

        let mismatch = execute_isolated_adapter(execution_request(
            "runbook:fixture-mismatch",
            connection,
            "printf TERMBRIDGE_ACTUAL",
            RunbookRisk::StateChange,
            0,
            &["TERMBRIDGE_REVIEWED_EXPECTATION"],
        ));
        assert_eq!(mismatch.status, RunbookStepExecutionStatus::Failed);
        assert_eq!(mismatch.exit_code, Some(0));
        assert!(!mismatch.expected_matched);
        assert_eq!(mismatch.stdout.as_deref(), Some("TERMBRIDGE_ACTUAL"));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_cancel_and_timeout() {
        let connection = isolated_connection();
        let (_known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let (_database_temp, database) = adapter_database("profile-1", &connection);
        let cancellations = ExecutionCancellationRegistry::default();
        let cancel_worker = cancellations.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel_worker.cancel("runbook:fixture-cancel").unwrap();
        });
        let cancelled = execute_runbook_step_with_known_hosts(
            &CredentialManager::new(),
            &database,
            &cancellations,
            || Ok(known_hosts_path.clone()),
            execution_request(
                "runbook:fixture-cancel",
                connection.clone(),
                "sleep 5",
                RunbookRisk::StateChange,
                0,
                &[],
            ),
        )
        .expect("execute cancellable Runbook adapter fixture");
        canceller
            .join()
            .expect("join isolated cancellation trigger");
        assert_eq!(cancelled.status, RunbookStepExecutionStatus::Cancelled);

        let mut timeout_request = execution_request(
            "runbook:fixture-timeout",
            connection,
            "sleep 5",
            RunbookRisk::StateChange,
            0,
            &[],
        );
        timeout_request.timeout_ms = 1_000;
        let timed_out = execute_runbook_step_with_known_hosts(
            &CredentialManager::new(),
            &database,
            &cancellations,
            || Ok(known_hosts_path),
            timeout_request,
        )
        .expect("execute timed Runbook adapter fixture");
        assert_eq!(timed_out.status, RunbookStepExecutionStatus::TimedOut);
        assert_eq!(
            timed_out.error.as_deref(),
            Some("runbook action timed out after 1000 ms")
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_oversized_output_fails() {
        let result = execute_isolated_adapter(execution_request(
            "runbook:fixture-oversized",
            isolated_connection(),
            "head -c 65537 /dev/zero",
            RunbookRisk::ReadOnly,
            0,
            &[],
        ));
        assert_eq!(result.status, RunbookStepExecutionStatus::Failed);
        assert_eq!(result.exit_code, None);
        assert_eq!(result.stdout, None);
        assert_eq!(
            result.error.as_deref(),
            Some("runbook command output exceeded the safety limit")
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_runbook_secret_output_is_redacted() {
        const SECRET: &str = "TERMBRIDGE_REDACT_ME";
        let mut connection = isolated_connection();
        connection.passphrase = Some(SECRET.to_string());
        let result = execute_isolated_adapter(execution_request(
            "runbook:fixture-secret",
            connection,
            "sh -c 'printf TERMBRIDGE_RED\"\"ACT_ME; printf TERMBRIDGE_RED\"\"ACT_ME >&2'",
            RunbookRisk::StateChange,
            0,
            &[],
        ));
        assert_eq!(result.status, RunbookStepExecutionStatus::Success);
        assert_eq!(result.stdout.as_deref(), Some("[REDACTED]"));
        assert_eq!(result.stderr.as_deref(), Some("[REDACTED]"));
        assert!(!serde_json::to_string(&result).unwrap().contains(SECRET));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_multi_host_runbook_output_isolation() {
        let connection = isolated_connection();
        let (_known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let (_database_temp, database) = adapter_database("profile-1", &connection);
        let database = Arc::new(database);
        let credentials = Arc::new(CredentialManager::new());
        let cancellations = ExecutionCancellationRegistry::default();
        let handles = ["TERMBRIDGE_HOST_ALPHA", "TERMBRIDGE_HOST_BRAVO"].map(|marker| {
            let worker_connection = connection.clone();
            let worker_known_hosts_path = known_hosts_path.clone();
            let worker_database = Arc::clone(&database);
            let worker_credentials = Arc::clone(&credentials);
            let worker_cancellations = cancellations.clone();
            std::thread::spawn(move || {
                execute_runbook_step_with_known_hosts(
                    &worker_credentials,
                    &worker_database,
                    &worker_cancellations,
                    || Ok(worker_known_hosts_path),
                    execution_request(
                        &format!("runbook:fixture-{marker}"),
                        worker_connection,
                        &format!("printf {marker}"),
                        RunbookRisk::StateChange,
                        0,
                        &[marker],
                    ),
                )
                .expect("execute isolated multi-host Runbook adapter")
            })
        });
        let [alpha, bravo] = handles.map(|handle| handle.join().expect("join multi-host worker"));

        assert_eq!(alpha.status, RunbookStepExecutionStatus::Success);
        assert_eq!(bravo.status, RunbookStepExecutionStatus::Success);
        assert_eq!(alpha.exit_code, Some(0));
        assert_eq!(bravo.exit_code, Some(0));
        assert!(alpha.expected_matched && bravo.expected_matched);
        assert_eq!(alpha.stdout.as_deref(), Some("TERMBRIDGE_HOST_ALPHA"));
        assert_eq!(bravo.stdout.as_deref(), Some("TERMBRIDGE_HOST_BRAVO"));
        assert!(!alpha.stdout.as_deref().unwrap().contains("BRAVO"));
        assert!(!bravo.stdout.as_deref().unwrap().contains("ALPHA"));
        assert_eq!(alpha.stderr, None);
        assert_eq!(bravo.stderr, None);
    }
}
