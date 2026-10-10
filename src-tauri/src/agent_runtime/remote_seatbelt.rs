//! Target-bound remote Seatbelt facts and short-lived SSH control receipts.
//! The existing interpreter is invoked in memory; no remote component installs.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
#[path = "remote_cleanup.rs"]
pub(crate) mod cleanup;
#[path = "remote_host.rs"]
mod host;

use super::remote_binding::RemoteExecutionBinding;
use super::{
    AgentExecutionSurface, AgentSandboxCapability, AgentSandboxCapabilityStatus,
    AgentSandboxContract, AgentSandboxNetworkPolicy, AgentSandboxPolicy, AgentSessionHeader,
    AgentSessionTarget, AgentToolTargetNative,
};
use crate::db::Database;
use crate::execution::{
    execute_ssh_channel_with_input, known_connection_secret_values, open_ssh_execution_session,
    open_ssh_execution_session_pinned, ExecutionCancellationRegistry, ExecutionOutputPolicy,
    SshChannelExecutionOutcome,
};
use crate::keychain::CredentialManager;
use crate::models::{RemoteConnectionRequest, SessionManager};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inspection {
    root: String,
    home: String,
    temp_base: String,
    platform: String,
    uid: u32,
}

#[derive(Clone)]
struct Verification {
    header: AgentSessionHeader,
    target: AgentToolTargetNative,
    binding: RemoteExecutionBinding,
    sessions: SessionManager,
    database: Database,
    facts: Inspection,
    python: String,
    host_key: String,
}

impl Verification {
    fn valid(&self) -> bool {
        self.binding
            .validate(&self.target, &self.sessions, &self.database)
            .is_ok()
    }
}

fn cache() -> &'static Mutex<HashMap<String, Arc<Verification>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Verification>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cache_key(header: &AgentSessionHeader) -> Result<String, String> {
    let data = serde_json::to_vec(&(
        &header.session_id,
        header.created_at_unix_ms,
        header.sandbox_binding_revision,
        &header.target,
        header.sandbox_policy,
        header.execution_surface,
    ))
    .map_err(|_| "sandboxAuthorizationInvalid: remote binding serialization failed")?;
    Ok(hex::encode(Sha256::digest(data)))
}

fn records() -> Vec<Arc<Verification>> {
    cache()
        .lock()
        .map(|entries| entries.values().cloned().collect())
        .unwrap_or_default()
}

fn for_contract(contract: &AgentSandboxContract) -> Result<Arc<Verification>, String> {
    records()
        .into_iter()
        .find(|entry| {
            entry.header.target.as_ref() == Some(&contract.target)
                && entry.header.created_at_unix_ms == contract.session_created_at_unix_ms
                && entry.header.sandbox_binding_revision == contract.binding_revision
                && entry
                    .header
                    .sandbox_policy
                    .unwrap_or(AgentSandboxPolicy::Host)
                    == contract.policy
                && entry.valid()
        })
        .ok_or_else(|| {
            "sandboxBackendUnavailable: this SSH identity has no verified remote Seatbelt backend"
                .into()
        })
}

pub(crate) fn root_for(target: &AgentSessionTarget) -> Result<String, String> {
    records()
        .into_iter()
        .find(|entry| entry.header.target.as_ref() == Some(target) && entry.valid())
        .map(|entry| entry.facts.root.clone())
        .ok_or_else(|| {
            "sandboxBackendUnavailable: remote project has not been verified over SSH".into()
        })
}

fn deny_paths(facts: &Inspection) -> Vec<String> {
    let mut paths = [
        ".shellspan",
        ".shellspan-dev",
        ".ssh",
        ".aws",
        ".gnupg",
        ".codex",
        ".config",
        ".cargo/credentials",
        ".cargo/credentials.toml",
        "Library/Keychains",
        "Library/Application Support",
        "Library/Application Support/com.shellspan",
        "Library/Application Support/com.shellspan-dev",
    ]
    .into_iter()
    .map(|path| crate::posix_join(&facts.home, path))
    .collect::<Vec<_>>();
    paths.extend(
        [
            "/Library/Keychains",
            "/private/etc/ssh",
            "/private/etc/master.passwd",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    paths.extend(
        [".env", ".npmrc", ".netrc", ".pypirc", ".git-credentials"]
            .into_iter()
            .map(|file| crate::posix_join(&facts.root, file)),
    );
    paths
}

pub(crate) fn deny_for(target: &AgentSessionTarget) -> Result<Vec<String>, String> {
    records()
        .into_iter()
        .find(|entry| entry.header.target.as_ref() == Some(target) && entry.valid())
        .map(|entry| deny_paths(&entry.facts))
        .ok_or_else(|| "sandboxBackendUnavailable: remote deny paths are not verified".into())
}

pub(crate) fn authorize(contract: &AgentSandboxContract) -> Result<(), String> {
    let entry = for_contract(contract)?;
    if contract.execution_surface != AgentExecutionSurface::Direct
        || contract.root.as_deref() != Some(entry.facts.root.as_str())
        || contract.network != AgentSandboxNetworkPolicy::Deny
        || contract.deny != deny_paths(&entry.facts)
        || contract.read_allow != vec![entry.facts.root.clone()]
        || contract.write_allow
            != if contract.policy == AgentSandboxPolicy::Workspace {
                vec![entry.facts.root.clone()]
            } else {
                vec![]
            }
    {
        return Err("sandboxAuthorizationInvalid: remote path or execution binding changed".into());
    }
    if !contract.resource_grants.is_empty() {
        return Err(
            "sandboxPolicyUnsupported: remote resource and network extensions are not implemented"
                .into(),
        );
    }
    Ok(())
}

pub(crate) fn capability(header: &AgentSessionHeader) -> Option<AgentSandboxCapability> {
    let key = cache_key(header).ok()?;
    let entry = cache().lock().ok()?.get(&key).cloned()?;
    entry.valid().then(partial_capability)
}

pub(crate) fn stamp(contract: &AgentSandboxContract) -> Result<String, String> {
    let entry = for_contract(contract)?;
    let value = serde_json::to_vec(&(
        entry.binding.digest()?,
        &entry.facts,
        &entry.python,
        &entry.host_key,
    ))
    .map_err(|_| "sandboxAuthorizationInvalid: remote verification digest unavailable")?;
    Ok(hex::encode(Sha256::digest(value)))
}

pub(crate) fn dispatch_digest(
    contract: &AgentSandboxContract,
    stamp: Option<&str>,
) -> Result<String, String> {
    let base = super::sandbox_authorization::contract_digest(contract)?;
    if contract.target.kind == "remote" && contract.policy != AgentSandboxPolicy::Host {
        let stamp =
            stamp.ok_or("sandboxAuthorizationInvalid: frozen remote verification missing")?;
        return Ok(hex::encode(Sha256::digest(
            serde_json::to_vec(&("remote-sandbox-dispatch-v1", base, stamp))
                .map_err(|_| "sandboxRemoteRequestInvalid")?,
        )));
    }
    Ok(base)
}

pub(crate) fn partial_capability() -> AgentSandboxCapability {
    AgentSandboxCapability {
        status: AgentSandboxCapabilityStatus::Partial, files: true, network: true, process_lifecycle: false,
        gaps: vec![
            "Remote Seatbelt path rules do not isolate hard-link aliases or hostile same-account filesystem races",
            "Remote controller process groups do not contain hostile descendants that escape their group",
            "Only verified macOS SSH Direct and its owned process controls are supported; remote resource/network grants and non-Shell tools remain unsupported",
        ],
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSandboxVerification {
    target: AgentSessionTarget,
    policy: AgentSandboxPolicy,
    execution_surface: AgentExecutionSurface,
    canonical_root: String,
    remote_uid: u32,
    ssh_host_key_sha256: String,
    source_binding_digest: String,
    capability: AgentSandboxCapability,
}

pub(crate) fn verification_summary(
    header: &AgentSessionHeader,
) -> Result<RemoteSandboxVerification, String> {
    let entry = cache()
        .lock()
        .map_err(|_| "sandboxRemoteCacheUnavailable")?
        .get(&cache_key(header)?)
        .cloned()
        .ok_or("sandboxBackendUnavailable: verified remote facts missing")?;
    if !entry.valid() {
        return Err("sandboxAuthorizationInvalid: remote verification became stale".into());
    }
    Ok(RemoteSandboxVerification {
        target: header
            .target
            .clone()
            .ok_or("sandboxRemoteIdentityMissing")?,
        policy: header.sandbox_policy.ok_or("sandboxRemotePolicyMissing")?,
        execution_surface: header.execution_surface,
        canonical_root: entry.facts.root.clone(),
        remote_uid: entry.facts.uid,
        ssh_host_key_sha256: entry.host_key.clone(),
        source_binding_digest: entry.binding.digest()?,
        capability: partial_capability(),
    })
}

fn fingerprint(session: &ssh2::Session) -> Result<String, String> {
    session
        .host_key()
        .map(|(key, _)| hex::encode(Sha256::digest(key)))
        .ok_or_else(|| "sandboxAuthorizationInvalid: SSH host key evidence is missing".into())
}

fn controller_command(python: &str, host: bool) -> Result<String, String> {
    let bootstrap = "import json,sys;exec(json.loads(sys.stdin.buffer.readline(65536)))";
    if host {
        // Isolate Python imports without changing the account environment
        // inherited by the user's host command.
        return shlex::try_join([python, "-I", "-c", bootstrap])
            .map_err(|_| "sandboxRemoteRequestInvalid: argument encoding failed".into());
    }
    shlex::try_join([
        "/usr/bin/env",
        "-i",
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG=C",
        python,
        "-c",
        bootstrap,
    ])
    .map_err(|_| "sandboxRemoteRequestInvalid: argument encoding failed".into())
}

fn request_line(request: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(request).map_err(|_| "sandboxRemoteRequestInvalid")?;
    if bytes.len() >= 65536 {
        return Err(
            "sandboxPolicyUnsupported: remote control request exceeds its bounded input".into(),
        );
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn controller_input(request: &Value) -> Result<Vec<u8>, String> {
    let source = host::controller_source(request["hostController"] == true);
    let mut input = request_line(&json!(source))?;
    input.extend(request_line(request)?);
    Ok(input)
}

fn fixed_json(
    python: &str,
    request: &Value,
    connection: &RemoteConnectionRequest,
    known_hosts: &Path,
    expected_key: &str,
    timeout: Duration,
) -> Result<Value, String> {
    // Owned process workers are ordinary threads. Scoped DNS/handshake
    // deadlines need an IO runtime even when no Tauri task entered this thread.
    let _runtime_guard = if tokio::runtime::Handle::try_current().is_err() {
        static IO_RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
        let runtime = IO_RUNTIME.get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .map_err(|_| "sandboxRemoteControllerUnavailable".to_owned())
        });
        Some(runtime.as_ref().map_err(Clone::clone)?.enter())
    } else {
        None
    };
    let deadline = Instant::now() + timeout;
    crate::connection::with_scoped_connection_io(
        tokio_util::sync::CancellationToken::new(),
        deadline,
        || {
            let session = open_ssh_execution_session_pinned(connection, known_hosts, expected_key)
                .map_err(|_| "sandboxRemoteConnectionFailed")?;
            if fingerprint(&session.target)? != expected_key {
                return Err(
            "sandboxAuthorizationInvalid: SSH host key changed; reconnect before verifying again"
                .into(),
        );
            }
            fixed_json_peer(&session.target, python, request, connection, timeout)
        },
    )
}

fn fixed_json_peer(
    session: &ssh2::Session,
    python: &str,
    request: &Value,
    connection: &RemoteConnectionRequest,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    session.set_timeout(timeout.as_millis().clamp(1, 2000) as u32);
    let cancellation = ExecutionCancellationRegistry::default()
        .register(Uuid::new_v4().to_string())
        .map_err(|_| "sandboxRemoteControllerUnavailable")?;
    let mut secrets = known_connection_secret_values(connection);
    if let Some(token) = request["token"].as_str() {
        secrets.push(token.to_owned());
    }
    let result = execute_ssh_channel_with_input(
        session,
        &controller_command(python, request["hostController"] == true)?,
        Some(&controller_input(request)?),
        ExecutionOutputPolicy::new(64 * 1024, 4096, 128 * 1024)
            .map_err(|_| "sandboxRemoteOutputInvalid")?,
        &secrets,
        &cancellation,
        deadline,
    );
    match result {
        SshChannelExecutionOutcome::Completed {
            exit_code: 0,
            output,
        } => serde_json::from_str(&output.stdout.text).map_err(|_| {
            "sandboxRemoteReceiptInvalid: structured controller output is missing".into()
        }),
        SshChannelExecutionOutcome::Failed(error) => Err(format!(
            "sandboxRemoteControllerFailed: {:?}: {}",
            error.category,
            crate::execution::redact_known_secrets(&error.message, &secrets),
        )),
        SshChannelExecutionOutcome::TimedOut => {
            Err("sandboxRemoteControllerFailed: bounded SSH controller operation timed out".into())
        }
        SshChannelExecutionOutcome::Cancelled => {
            Err("sandboxRemoteControllerFailed: bounded SSH controller operation cancelled".into())
        }
        SshChannelExecutionOutcome::Completed {
            exit_code: 125,
            output,
        } => Err(format!(
            "sandboxRemoteControllerFailed: controller exited with status 125: {}",
            output
                .stderr
                .text
                .chars()
                .take(512)
                .collect::<String>()
                .trim()
        )),
        SshChannelExecutionOutcome::Completed { exit_code, .. } => Err(format!(
            "sandboxRemoteControllerFailed: controller exited with status {exit_code}"
        )),
    }
}

fn token() -> [u8; 32] {
    let mut result = [0; 32];
    result[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    result[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    result
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    data: Value,
    encoded: String,
    proof: String,
}

fn verify_receipt(value: Value, key: &[u8; 32], job_id: &str) -> Result<Value, String> {
    let envelope: Envelope =
        serde_json::from_value(value).map_err(|_| "sandboxRemoteReceiptInvalid")?;
    let bytes = STANDARD
        .decode(envelope.encoded)
        .map_err(|_| "sandboxRemoteReceiptInvalid")?;
    let proof = hex::decode(envelope.proof).map_err(|_| "sandboxRemoteReceiptInvalid")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| "sandboxRemoteReceiptInvalid")?;
    mac.update(&bytes);
    mac.verify_slice(&proof)
        .map_err(|_| "sandboxRemoteReceiptInvalid: controller proof does not match")?;
    let parsed: Value =
        serde_json::from_slice(&bytes).map_err(|_| "sandboxRemoteReceiptInvalid")?;
    if parsed != envelope.data || parsed["jobId"] != job_id {
        return Err("sandboxRemoteReceiptInvalid: controller job binding changed".into());
    }
    Ok(parsed)
}

#[cfg(test)]
pub(crate) fn verify_header(
    header: &AgentSessionHeader,
    sessions: &SessionManager,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts: &Path,
    admission: Option<super::shutdown_admission::ShutdownAdmission>,
) -> Result<(), String> {
    verify_header_owned(
        header,
        sessions,
        database,
        credentials,
        known_hosts,
        admission,
        None,
    )
}

pub(crate) fn verify_header_owned(
    header: &AgentSessionHeader,
    sessions: &SessionManager,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts: &Path,
    admission: Option<super::shutdown_admission::ShutdownAdmission>,
    engine: Option<&super::NativeToolEngine>,
) -> Result<(), String> {
    let key = cache_key(header)?;
    if cache()
        .lock()
        .map_err(|_| "sandboxRemoteCacheUnavailable")?
        .get(&key)
        .is_some_and(|entry| entry.valid())
    {
        return Ok(());
    }
    let native_target = super::remote_backend::validate_probe_target(header, sessions)?;
    let binding = RemoteExecutionBinding::capture(&native_target, sessions, database)?
        .ok_or("sandboxRemoteIdentityMissing")?;
    let target = header
        .target
        .as_ref()
        .ok_or("sandboxRemoteIdentityMissing")?;
    let request_id = Uuid::new_v4().to_string();
    let mut intent = None;
    let root = target
        .root_path
        .as_ref()
        .or(target.cwd.as_ref())
        .ok_or("sandboxWorkspaceMissing: select a remote project directory")?;
    let connection = super::connection_for_remote_target(&native_target, database, credentials)?;
    if connection.jump_host.is_some() {
        return Err(
            "sandboxPolicyUnsupported: restricted SSH jump-host bindings are not yet verified"
                .into(),
        );
    }
    // Facts remain immutable within a live source/config binding, including
    // the host key. Trust changes require reconnect rather than silently
    // moving a pending approval to another server with the same endpoint.
    let existing = records()
        .into_iter()
        .find(|entry| entry.header.target.as_ref() == Some(target) && entry.valid());
    let entry = if let Some(existing) = existing {
        Verification {
            header: header.clone(),
            target: native_target,
            binding,
            sessions: sessions.clone(),
            database: database.clone(),
            facts: existing.facts.clone(),
            python: existing.python.clone(),
            host_key: existing.host_key.clone(),
        }
    } else {
        let session = open_ssh_execution_session(&connection, known_hosts)
            .map_err(|_| "sandboxRemoteConnectionFailed")?;
        session.target.set_timeout(2000);
        let host_key = fingerprint(&session.target)?;
        let sftp = session
            .target
            .sftp()
            .map_err(|_| "sandboxRemoteSftpUnavailable")?;
        let canonical = sftp
            .realpath(Path::new(root))
            .map_err(|_| "sandboxWorkspaceInvalid: remote project is unavailable")?;
        if !sftp
            .stat(&canonical)
            .map_err(|_| "sandboxWorkspaceInvalid")?
            .is_dir()
        {
            return Err("sandboxWorkspaceInvalid: remote root is not a directory".into());
        }
        let home = sftp
            .realpath(Path::new("."))
            .map_err(|_| "sandboxRemoteHomeUnavailable")?;
        let python = [
            "/Library/Developer/CommandLineTools/usr/bin/python3",
            "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
        ]
        .into_iter()
        .find_map(|path| {
            sftp.realpath(Path::new(path))
                .ok()
                .filter(|path| sftp.stat(path).is_ok_and(|stat| stat.is_file()))
        })
        .ok_or(
            "sandboxBackendUnavailable: remote target has no supported existing Python interpreter",
        )?;
        let python = python.to_str().ok_or("sandboxPathInvalid")?.to_owned();
        let root = canonical.to_str().ok_or("sandboxPathInvalid")?;
        let home = home.to_str().ok_or("sandboxPathInvalid")?;
        let inspect_request = json!({"mode":"inspect", "root":root, "home":home});
        let facts: Inspection = serde_json::from_value(fixed_json(
            &python,
            &inspect_request,
            &connection,
            known_hosts,
            &host_key,
            Duration::from_secs(10),
        )?)
        .map_err(|_| "sandboxRemoteReceiptInvalid")?;
        if facts.platform != "macos"
            || facts.root != root
            || facts.home != home
            || sftp.realpath(Path::new(&facts.temp_base)).ok().as_deref()
                != Some(Path::new(&facts.temp_base))
        {
            return Err(
                "sandboxRemoteReceiptInvalid: remote canonical paths or platform changed".into(),
            );
        }
        if facts.uid == 0 {
            return Err(
                "sandboxPolicyUnsupported: remote root-account containment is not verified".into(),
            );
        }
        if deny_paths(&facts)
            .iter()
            .any(|path| super::remote_path_within(path, root))
        {
            return Err(
                "sandboxWorkspaceInvalid: remote project overlaps sensitive account storage".into(),
            );
        }
        let secret = token();
        let id = Uuid::new_v4().to_string();
        let request = json!({"mode":"selftest","root":root,"home":home,"uid":facts.uid,"deny":deny_paths(&facts),"policy":"workspace","jobId":id,"token":hex::encode(secret)});
        intent = engine
            .map(|engine| {
                engine.begin_direct_ownership(&header.task_id, &request_id, &target.target_id)
            })
            .transpose()?
            .flatten();
        let receipt = verify_receipt(
            fixed_json(
                &python,
                &request,
                &connection,
                known_hosts,
                &host_key,
                Duration::from_secs(15),
            )?,
            &secret,
            &id,
        )?;
        if receipt["verified"] != true
            || receipt["root"] != root
            || receipt["home"] != home
            || receipt["tempBase"] != facts.temp_base
            || receipt["uid"] != facts.uid
        {
            return Err("sandboxRemoteReceiptInvalid: remote selftest binding changed".into());
        }
        Verification {
            header: header.clone(),
            target: native_target,
            binding,
            sessions: sessions.clone(),
            database: database.clone(),
            facts,
            python,
            host_key,
        }
    };
    if !entry.valid() {
        return Err("sandboxAuthorizationInvalid: SSH identity changed during verification".into());
    }
    let entry = Arc::new(entry);
    let mut contract = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        target,
        AgentExecutionSurface::Direct,
        0,
    )?
    .bind_to_session(header);
    contract.policy = header.sandbox_policy.ok_or("sandboxRemotePolicyMissing")?;
    contract.network = AgentSandboxNetworkPolicy::Deny;
    contract.root = Some(entry.facts.root.clone());
    contract.read_allow = vec![entry.facts.root.clone()];
    contract.write_allow = if contract.policy == AgentSandboxPolicy::Workspace {
        vec![entry.facts.root.clone()]
    } else {
        vec![]
    };
    contract.deny = deny_paths(&entry.facts);
    let probe_command = "read value; test \"$value\" = sandbox-remote-input || exit 1; printf sandbox-remote-input; exec sleep 30";
    let job = RemoteSeatbeltJob::build(
        entry.controller(),
        &contract,
        probe_command,
        Duration::from_secs(20),
        &connection,
        known_hosts,
    )?;
    if intent.is_none() {
        intent = engine
            .map(|engine| {
                engine.begin_direct_ownership(&header.task_id, &request_id, &target.target_id)
            })
            .transpose()?
            .flatten();
    }
    if let Some(intent) = &intent {
        intent.protect_remote(&job, credentials)?;
    }
    let process = super::spawn_remote_process_native(super::RemoteProcessStartNative {
        remote_sandbox: Some(job),
        admission: admission.clone(),
        task_id: "remote-sandbox-preflight".into(),
        request_id,
        owner_target_id: target.target_id.clone(),
        command: probe_command.into(),
        connection: connection.clone(),
        known_hosts_path: known_hosts.to_owned(),
        timeout: Duration::from_secs(20),
    })?;
    if let Some(intent) = intent {
        process.bind_direct_intent(intent)?;
    }
    let checked = (|| {
        process.write_stdin("sandbox-remote-input\n".into(), false)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if process.snapshot()?.stdout == "sandbox-remote-input" {
                break;
            }
            if Instant::now() >= deadline {
                return Err(
                    "sandboxRemotePreflightFailed: actual stdin did not reach the child"
                        .to_string(),
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    })();
    let cleanup = process.kill(super::ProcessSignalNative::Kill, Duration::from_secs(8))?;
    if cleanup.termination_confirmed {
        process.resolve_direct_ownership()?;
    }
    if checked.is_err()
        || !cleanup.termination_confirmed
        || !entry.valid()
        || admission
            .as_ref()
            .is_some_and(|gate| gate.ensure_open().is_err())
    {
        return Err(format!(
            "sandboxRemotePreflightFailed: actual remote input or cleanup is not confirmed (input={}, state={:?}, terminationConfirmed={}, controllerError={})",
            checked.is_ok(), cleanup.state, cleanup.termination_confirmed, cleanup.error.as_deref().unwrap_or("none")
        ));
    }
    let mut entries = cache()
        .lock()
        .map_err(|_| "sandboxRemoteCacheUnavailable")?;
    entries.retain(|_, entry| entry.valid());
    if entries.len() >= 128 {
        return Err("sandboxRemoteCacheUnavailable: verified target capacity reached".into());
    }
    entries.insert(key, entry);
    Ok(())
}

#[derive(Clone)]
pub(crate) struct RemoteSeatbeltJob {
    control_peer: Arc<Mutex<Option<ssh2::Session>>>,
    completed_receipt: Arc<Mutex<Option<Value>>>,
    selected_signal: Arc<Mutex<super::ProcessSignalNative>>,
    contract: AgentSandboxContract,
    verification: Arc<ControllerVerification>,
    key: [u8; 32],
    request: Value,
    connection: RemoteConnectionRequest,
    known_hosts: PathBuf,
}

struct ControllerVerification {
    target: AgentToolTargetNative,
    binding: RemoteExecutionBinding,
    sessions: SessionManager,
    database: Database,
    facts: Inspection,
    python: String,
    host_key: String,
}

impl ControllerVerification {
    fn valid(&self) -> bool {
        self.binding
            .validate(&self.target, &self.sessions, &self.database)
            .is_ok()
    }
}

impl Verification {
    fn controller(&self) -> Arc<ControllerVerification> {
        Arc::new(ControllerVerification {
            target: self.target.clone(),
            binding: self.binding.clone(),
            sessions: self.sessions.clone(),
            database: self.database.clone(),
            facts: self.facts.clone(),
            python: self.python.clone(),
            host_key: self.host_key.clone(),
        })
    }
}

impl RemoteSeatbeltJob {
    pub(crate) fn new(
        contract: &AgentSandboxContract,
        raw_command: &str,
        timeout: Duration,
        connection: &RemoteConnectionRequest,
        known_hosts: &Path,
    ) -> Result<Self, String> {
        authorize(contract)?;
        if timeout.is_zero() || timeout > Duration::from_secs(300) {
            return Err(
                "sandboxPolicyUnsupported: remote command deadline must be within five minutes"
                    .into(),
            );
        }
        let verified = for_contract(contract)?;
        let verification = verified.controller();
        Self::build(
            verification,
            contract,
            raw_command,
            timeout,
            connection,
            known_hosts,
        )
    }

    fn build(
        verification: Arc<ControllerVerification>,
        contract: &AgentSandboxContract,
        raw_command: &str,
        timeout: Duration,
        connection: &RemoteConnectionRequest,
        known_hosts: &Path,
    ) -> Result<Self, String> {
        let key = token();
        let digest = hex::encode(Sha256::digest(
            serde_json::to_vec(&(contract, raw_command))
                .map_err(|_| "sandboxRemoteRequestInvalid")?,
        ));
        let request = json!({"mode":"run","root":verification.facts.root,"home":verification.facts.home,"tempBase":verification.facts.temp_base,
            "uid":verification.facts.uid,"readAllow":contract.read_allow,"writeAllow":contract.write_allow,"deny":contract.deny,
            "policy":contract.policy,"jobId":Uuid::new_v4().to_string(),"token":hex::encode(key),"command":raw_command,"timeoutMs":timeout.as_millis() as u64,"digest":digest});
        Ok(Self {
            control_peer: Arc::new(Mutex::new(None)),
            completed_receipt: Arc::new(Mutex::new(None)),
            selected_signal: Arc::new(Mutex::new(super::ProcessSignalNative::Terminate)),
            contract: contract.clone(),
            verification,
            key,
            request,
            connection: connection.clone(),
            known_hosts: known_hosts.to_owned(),
        })
    }
    pub(crate) fn launch_command(&self) -> Result<String, String> {
        controller_command(
            &self.verification.python,
            self.request["hostController"] == true,
        )
    }
    pub(crate) fn contract(&self) -> &AgentSandboxContract {
        &self.contract
    }
    #[cfg(any(test, debug_assertions))]
    pub(crate) fn owned_directory(&self) -> PathBuf {
        Path::new(&self.verification.facts.temp_base).join(format!(
            "shellspan-native-remote-{}",
            self.request["jobId"].as_str().unwrap_or_default()
        ))
    }
    pub(crate) fn launch_input(&self) -> Result<Vec<u8>, String> {
        controller_input(&self.request)
    }
    pub(crate) fn ready(&self) -> Result<bool, String> {
        Ok(self.control("status", Duration::from_secs(2))?["started"] == true)
    }
    pub(crate) fn valid(&self) -> bool {
        self.verification.valid()
    }
    pub(crate) fn check_host_key(&self, session: &ssh2::Session) -> Result<(), String> {
        if fingerprint(session)? != self.verification.host_key {
            return Err("sandboxAuthorizationInvalid: frozen SSH host key changed".into());
        }
        Ok(())
    }
    pub(crate) fn open_session(&self) -> Result<crate::execution::SshExecutionSession, String> {
        open_ssh_execution_session_pinned(
            &self.connection,
            &self.known_hosts,
            &self.verification.host_key,
        )
        .map_err(|error| {
            format!(
                "sandboxRemoteConnectionFailed: frozen SSH peer could not be authenticated ({:?}: {})",
                error.category,
                crate::execution::redact_known_secrets(
                    &error.message,
                    &known_connection_secret_values(&self.connection),
                )
            )
        })
    }
    pub(crate) fn secret(&self) -> String {
        hex::encode(self.key)
    }
    fn control(&self, mode: &str, timeout: Duration) -> Result<Value, String> {
        self.control_with_signal(mode, timeout, None)
    }
    fn control_with_signal(
        &self,
        mode: &str,
        timeout: Duration,
        signal: Option<super::ProcessSignalNative>,
    ) -> Result<Value, String> {
        let mut request = self.request.clone();
        request["mode"] = json!(mode);
        if let Some(signal) = signal {
            request["signal"] = json!(signal);
        }
        if let Some(fields) = request.as_object_mut() {
            for field in [
                "command",
                "timeoutMs",
                "readAllow",
                "writeAllow",
                "deny",
                "policy",
            ] {
                fields.remove(field);
            }
        }
        let mut peer = self
            .control_peer
            .lock()
            .map_err(|_| "sandboxRemoteControllerUnavailable")?;
        let response = if let Some(session) = peer.as_ref() {
            if fingerprint(session)? != self.verification.host_key {
                return Err("sandboxAuthorizationInvalid: control peer changed".into());
            }
            let response = fixed_json_peer(
                session,
                &self.verification.python,
                &request,
                &self.connection,
                timeout,
            );
            if response.is_err() {
                *peer = None;
            }
            response
        } else {
            fixed_json(
                &self.verification.python,
                &request,
                &self.connection,
                &self.known_hosts,
                &self.verification.host_key,
                timeout,
            )
        };
        let data = verify_receipt(
            response?,
            &self.key,
            self.request["jobId"]
                .as_str()
                .ok_or("sandboxRemoteRequestInvalid")?,
        )?;
        if data["root"] != self.request["root"] || data["digest"] != self.request["digest"] {
            return Err("sandboxRemoteReceiptInvalid: frozen command or root changed".into());
        }
        Ok(data)
    }
    pub(crate) fn cleanup(&self, stop: bool) -> bool {
        let signal = self
            .selected_signal
            .lock()
            .map(|value| *value)
            .unwrap_or(super::ProcessSignalNative::Kill);
        self.cleanup_with_signal(stop, signal)
    }
    pub(crate) fn select_signal(&self, signal: super::ProcessSignalNative) {
        if let Ok(mut selected) = self.selected_signal.lock() {
            *selected = signal;
        }
    }
    pub(crate) fn cleanup_with_signal(
        &self,
        stop: bool,
        signal: super::ProcessSignalNative,
    ) -> bool {
        if self
            .completed_receipt
            .lock()
            .is_ok_and(|receipt| receipt.is_some())
        {
            return true;
        }
        if stop {
            let _ = self.control_with_signal("stop", Duration::from_secs(4), Some(signal));
        }
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            if let Ok(data) = self.control("status", Duration::from_secs(2)) {
                if data["controllerFinished"] == true && data["terminationConfirmed"] == true {
                    if let Ok(cleaned) = self.control("cleanup", Duration::from_secs(2)) {
                        if cleaned["controllerFinished"] == true
                            && cleaned["terminationConfirmed"] == true
                        {
                            if let Ok(mut saved) = self.completed_receipt.lock() {
                                *saved = Some(cleaned);
                                return true;
                            }
                        }
                    }
                    return false;
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    pub(crate) fn completion(&self) -> Result<Value, String> {
        if let Some(data) = self
            .completed_receipt
            .lock()
            .map_err(|_| "sandboxRemoteReceiptUnavailable")?
            .clone()
        {
            return Ok(data);
        }
        self.control("status", Duration::from_secs(2))
    }
}

#[cfg(all(any(test, debug_assertions), target_os = "macos"))]
#[path = "tests/remote_seatbelt.rs"]
pub(crate) mod tests;
