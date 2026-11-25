use serde::{Deserialize, Serialize};

use crate::{
    agent_runtime::{AgentToolTargetNative, ExecCommandArgumentsNative},
    db::Database,
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SudoOperation {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) command: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileSudoPolicy {
    pub(crate) profile_binding: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    #[serde(skip)]
    pub(crate) jump_host_config: Option<String>,
    pub(crate) revision: Option<String>,
    pub(crate) runner: Option<SudoRunner>,
    pub(crate) operations: Vec<SudoOperation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveProfileSudoPolicy {
    pub(crate) profile_binding: String,
    pub(crate) revision: Option<String>,
    #[serde(default)]
    pub(crate) runner: Option<SudoRunner>,
    pub(crate) operations: Vec<SudoOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SudoRunner {
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) host_key_sha256: String,
}

impl SudoRunner {
    pub(crate) fn validate(&self, policy: &ProfileSudoPolicy) -> Result<(), String> {
        use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
        if self.port == 0
            || self.port == policy.port
            || self.username == policy.username
            || self.username == "root"
            || policy.username == "root"
            || self.username.is_empty()
            || self.username.len() > 32
            || !self
                .username
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
            || self
                .host_key_sha256
                .strip_prefix("SHA256:")
                .and_then(|key| STANDARD_NO_PAD.decode(key).ok())
                .is_none_or(|key| key.len() != 32)
        {
            return Err("AGENT_SUDO_INVALID_RUNNER".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SudoOperationGrant {
    pub(crate) id: String,
    pub(crate) revision: String,
    pub(crate) runner_username: String,
    pub(crate) runner_port: u16,
}

pub(crate) fn validate_operations(
    operations: Vec<SudoOperation>,
) -> Result<Vec<SudoOperation>, String> {
    if operations.len() > 32 {
        return Err("AGENT_SUDO_POLICY_TOO_LARGE".into());
    }
    let mut ids = std::collections::HashSet::new();
    operations
        .into_iter()
        .enumerate()
        .map(|(index, mut operation)| {
            let invalid =
                |field: &str| format!("AGENT_SUDO_INVALID_OPERATION:{}:{field}", index + 1);
            let id = operation.id.as_bytes();
            if id.len() > 64
                || !id.first().is_some_and(u8::is_ascii_lowercase)
                || !id.iter().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-')
                })
                || !ids.insert(operation.id.clone())
            {
                return Err(invalid("id"));
            }
            operation.label = operation.label.trim().to_owned();
            if operation.label.is_empty()
                || operation.label.len() > 120
                || operation.label.chars().any(char::is_control)
                || crate::redaction::redact_sensitive_text(&operation.label) != operation.label
            {
                return Err(invalid("label"));
            }
            operation.command = crate::agent_runtime::literal_sudo_command(&operation.command)
                .map_err(|_| invalid("command"))?;
            if crate::redaction::redact_sensitive_text(&operation.command) != operation.command {
                return Err(invalid("command"));
            }
            Ok(operation)
        })
        .collect()
}

pub(crate) fn policy_for_target(
    database: &Database,
    target: &AgentToolTargetNative,
) -> Result<ProfileSudoPolicy, String> {
    let AgentToolTargetNative::Remote {
        profile_id: Some(profile_id),
        host,
        port,
        username,
        ..
    } = target
    else {
        return Err("AGENT_SUDO_UNAVAILABLE: a saved remote SSH profile is required".into());
    };
    let policy = database.profile_sudo_policy(profile_id)?;
    if policy.host != *host || policy.port != *port || policy.username != *username {
        return Err("AGENT_SUDO_POLICY_CHANGED: SSH profile identity changed".into());
    }
    Ok(policy)
}

pub(crate) fn verify_grant(
    database: &Database,
    target: &AgentToolTargetNative,
    arguments: &ExecCommandArgumentsNative,
) -> Result<(), String> {
    let policy = policy_for_target(database, target)?;
    verify_policy(&policy, target, arguments)
}

pub(crate) fn verify_policy(
    policy: &ProfileSudoPolicy,
    target: &AgentToolTargetNative,
    arguments: &ExecCommandArgumentsNative,
) -> Result<(), String> {
    let grant = arguments
        .sudo_operation
        .as_ref()
        .ok_or("AGENT_SUDO_UNAVAILABLE: a configured operation must be selected")?;
    let AgentToolTargetNative::Remote {
        host,
        port,
        username,
        ..
    } = target
    else {
        return Err("AGENT_SUDO_UNAVAILABLE".into());
    };
    if !policy.runner.as_ref().is_some_and(|runner| {
        runner.port == grant.runner_port && runner.username == grant.runner_username
    }) || policy.host != *host
        || policy.port != *port
        || policy.username != *username
        || policy.revision.as_deref() != Some(&grant.revision)
        || !policy
            .operations
            .iter()
            .any(|op| op.id == grant.id && op.command == arguments.command)
    {
        return Err("AGENT_SUDO_POLICY_CHANGED: approve a current configured operation".into());
    }
    Ok(())
}

pub(crate) fn require_ordinary_remote_account(
    db: &Database,
    target: &AgentToolTargetNative,
) -> Result<(), String> {
    if let AgentToolTargetNative::Remote {
        host,
        port,
        username,
        ..
    } = target
    {
        if db.is_managed_sudo_account(host, *port, username)? {
            return Err("AGENT_MANAGED_RUNNER_ONLY: select a configured remote operation; ordinary Agent tools are disabled for this managed account".into());
        }
    }
    Ok(())
}
