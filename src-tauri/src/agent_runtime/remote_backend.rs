//! Remote infrastructure facts are not admission or resource grants.
//! No probe result is cached across reconnect, account changes or restart.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Database;
use crate::execution::{
    execute_reviewed_ssh_command_with_handle, CancellationHandle, ExecutionOutputPolicy,
    ExecutionStatus, FrozenTargetIdentity, ReviewedSshCommand, ReviewedSshExecutionRequest,
};
use crate::keychain::CredentialManager;
use crate::models::{SessionManager, SessionStatus, SessionTerminalKind};

use super::{AgentSessionHeader, AgentToolTargetNative};

// Fixed script only: no model command, project path or connection field is
// interpolated. Namespaces/temp mounts disappear with the short-lived probe.
const PROBE_COMMAND: &str = r#"case "$(uname -s)" in
Linux)
  if command -v bwrap >/dev/null 2>&1; then
    if bwrap --unshare-all --die-with-parent --new-session --ro-bind / / --tmpfs /home --tmpfs /root --tmpfs /tmp --proc /proc --dev /dev --chdir / /bin/sh -c 'test ! -e /home/shellspan && test -w /tmp' >/dev/null 2>&1; then
      printf '%s\n' '{"platform":"linux","backend":"bubblewrap","installed":true,"launcherAvailable":true}'
    else
      printf '%s\n' '{"platform":"linux","backend":"bubblewrap","installed":true,"launcherAvailable":false}'
    fi
  else
    printf '%s\n' '{"platform":"linux","backend":"bubblewrap","installed":false,"launcherAvailable":false}'
  fi ;;
Darwin)
  if test -x /usr/bin/sandbox-exec; then
    if /usr/bin/sandbox-exec -p '(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)(deny file-read* (literal "/etc/passwd"))(deny network*)(deny file-write*)' /bin/sh -c 'test ! -r /etc/passwd' >/dev/null 2>&1; then
      printf '%s\n' '{"platform":"macos","backend":"seatbelt","installed":true,"launcherAvailable":true}'
    else
      printf '%s\n' '{"platform":"macos","backend":"seatbelt","installed":true,"launcherAvailable":false}'
    fi
  else
    printf '%s\n' '{"platform":"macos","backend":"seatbelt","installed":false,"launcherAvailable":false}'
  fi ;;
*) printf '%s\n' '{"platform":"unsupported","backend":null,"installed":false,"launcherAvailable":false}' ;;
esac"#;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InfrastructureFacts {
    platform: String,
    backend: Option<String>,
    installed: bool,
    launcher_available: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSandboxBackendProbe {
    pub(crate) target: super::AgentSessionTarget,
    pub(crate) binding_revision: u64,
    pub(crate) infrastructure_available: bool,
    pub(crate) launcher_available: bool,
    pub(crate) execution_os: String,
    pub(crate) backend: Option<String>,
    pub(crate) workspace_verified: bool,
    pub(crate) admission_enabled: bool,
    pub(crate) gaps: Vec<String>,
}

pub(crate) fn probe_operation_id(session_id: &str, request_id: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(request_id).map_err(|_| "Invalid remote sandbox probe request id")?;
    let digest = Sha256::digest(session_id.as_bytes());
    Ok(format!(
        "sandbox-probe-{}-{request_id}",
        hex::encode(&digest[..16])
    ))
}

pub(crate) fn validate_probe_target(
    header: &AgentSessionHeader,
    sessions: &SessionManager,
) -> Result<AgentToolTargetNative, String> {
    let target = header
        .target
        .as_ref()
        .ok_or("Remote sandbox probe requires a target")?;
    if target.kind != "remote" {
        return Err("Remote sandbox probe requires an SSH target".into());
    }
    let host = target
        .host
        .clone()
        .ok_or("Remote sandbox probe requires a frozen host")?;
    let port = target
        .port
        .ok_or("Remote sandbox probe requires a frozen port")?;
    let username = target
        .username
        .clone()
        .ok_or("Remote sandbox probe requires a frozen account")?;
    let state = sessions.target_state(&target.session_id).map_err(|error| {
        super::normalize_terminal_target_lookup_error(&target.session_id, error)
    })?;
    if state.terminal_kind != SessionTerminalKind::Remote
        || state.status != SessionStatus::Connected
        || state.identity.host != host
        || state.identity.port != port
        || state.identity.username != username
    {
        return Err(super::terminal_target_unavailable(
            "Remote sandbox probe target identity changed or disconnected",
        ));
    }
    Ok(AgentToolTargetNative::Remote {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        profile_id: target.profile_id.clone(),
        host,
        port,
        username,
        root_path: target.root_path.clone(),
        local_root: target.local_root.clone(),
    })
}

pub(crate) fn probe_remote_backend(
    header: &AgentSessionHeader,
    native_target: &AgentToolTargetNative,
    database: &Database,
    credentials: &CredentialManager,
    cancellation: CancellationHandle,
    known_hosts_path: &Path,
    request_id: &str,
) -> Result<RemoteSandboxBackendProbe, String> {
    let connection = super::connection_for_remote_target(native_target, database, credentials)?;
    let profile_id = header
        .target
        .as_ref()
        .and_then(|t| t.profile_id.clone())
        .ok_or("Remote sandbox probe requires a frozen profile")?;
    let frozen = FrozenTargetIdentity::from_connection(profile_id, &connection)
        .map_err(|error| error.message)?;
    let request = ReviewedSshExecutionRequest {
        operation_id: probe_operation_id(&header.session_id, request_id)?,
        target: frozen,
        connection,
        command: ReviewedSshCommand::new(
            PROBE_COMMAND.into(),
            "Remote sandbox infrastructure probe".into(),
            vec![],
        )
        .map_err(|error| error.message)?,
        timeout: Duration::from_secs(15),
        output_policy: ExecutionOutputPolicy::new(4096, 4096, 16 * 1024)
            .map_err(|error| error.message)?,
    };
    let result = execute_reviewed_ssh_command_with_handle(
        database,
        credentials,
        known_hosts_path,
        request,
        cancellation.clone(),
        crate::db::current_timestamp_ms(),
    );
    cancellation.remove_registration();
    if result.status != ExecutionStatus::Completed || result.exit_code != Some(0) {
        return Err(format!(
            "remoteSandboxProbeFailed: {:?}",
            result.error_category
        ));
    }
    let facts: InfrastructureFacts = serde_json::from_str(&result.stdout).map_err(|_| {
        "remoteSandboxProbeInvalid: expected bounded structured infrastructure facts"
    })?;
    probe_from_facts(header, facts)
}

fn probe_from_facts(
    header: &AgentSessionHeader,
    facts: InfrastructureFacts,
) -> Result<RemoteSandboxBackendProbe, String> {
    if !matches!(
        (facts.platform.as_str(), facts.backend.as_deref()),
        ("linux", Some("bubblewrap")) | ("macos", Some("seatbelt")) | ("unsupported", None)
    ) || facts.launcher_available && !facts.installed
        || facts.platform == "unsupported" && (facts.installed || facts.launcher_available)
    {
        return Err("remoteSandboxProbeInvalid: inconsistent backend facts".into());
    }
    Ok(RemoteSandboxBackendProbe {
        target: header.target.clone().ok_or("Remote sandbox probe target missing")?,
        binding_revision: header.sandbox_binding_revision,
        infrastructure_available: facts.installed,
        launcher_available: facts.launcher_available,
        execution_os: facts.platform,
        backend: facts.backend,
        workspace_verified: false,
        admission_enabled: false,
        gaps: vec![
            "Infrastructure detection does not verify project paths, sensitive reads, network targets or remote process cleanup".into(),
            "Restricted remote execution requires target-specific real acceptance; no remote grants or commands are enabled by this probe".into(),
        ],
    })
}

#[cfg(test)]
#[path = "tests/remote_backend.rs"]
mod tests;
