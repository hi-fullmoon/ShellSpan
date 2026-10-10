//! Host-account ownership only; this is not a sandbox capability or grant.
use super::*;

pub(super) fn controller_source(host: bool) -> String {
    if !host {
        return include_str!("remote_seatbelt.py").into();
    }
    // Load the unchanged legacy controller as a module, reusing its signed
    // framing and live Child/group ownership helpers without running its CLI.
    format!(
        "import sys,types\nm=types.ModuleType('shellspan_controller')\nsys.modules[m.__name__]=m\nexec({},m.__dict__)\nexec({})\n",
        serde_json::to_string(include_str!("remote_seatbelt.py")).expect("source string"),
        serde_json::to_string(include_str!("remote_host.py")).expect("source string"),
    )
}

impl RemoteSeatbeltJob {
    pub(crate) fn new_host(
        contract: &AgentSandboxContract,
        target: &AgentToolTargetNative,
        command: &str,
        timeout: Duration,
        connection: &RemoteConnectionRequest,
        known_hosts: &Path,
        sessions: &SessionManager,
        database: &Database,
    ) -> Result<Self, String> {
        if contract.policy != AgentSandboxPolicy::Host
            || connection.jump_host.is_some()
            || timeout.is_zero()
            || timeout > Duration::from_secs(3600)
        {
            return Err(
                "directOwnershipUnavailable: unsupported remote host controller binding".into(),
            );
        }
        let binding = RemoteExecutionBinding::capture(target, sessions, database)?
            .ok_or("directOwnershipUnavailable: remote identity missing")?;
        let session = open_ssh_execution_session(connection, known_hosts).map_err(|error| {
            let stage = if error.message.starts_with("ssh handshake failed:") {
                "SSH handshake"
            } else {
                "SSH connection or authentication"
            };
            format!(
                "directOwnershipUnavailable: remote inspection {stage} failed ({:?})",
                error.category
            )
        })?;
        session.target.set_timeout(2000);
        let host_key = fingerprint(&session.target)?;
        let sftp = session
            .target
            .sftp()
            .map_err(|_| "directOwnershipUnavailable: SFTP unavailable")?;
        let home = sftp
            .realpath(Path::new("."))
            .map_err(|_| "directOwnershipUnavailable: remote home unavailable")?;
        let root = contract
            .target
            .root_path
            .as_deref()
            .or(contract.target.cwd.as_deref())
            .map(Path::new)
            .unwrap_or(&home);
        let canonical = sftp
            .realpath(root)
            .map_err(|_| "directOwnershipUnavailable: remote cwd unavailable")?;
        let python = [
            "/usr/bin/python3",
            "/usr/local/bin/python3",
            "/opt/homebrew/bin/python3",
        ]
        .into_iter()
        .find(|path| sftp.stat(Path::new(path)).is_ok_and(|stat| stat.is_file()))
        .ok_or("directOwnershipUnavailable: Python 3 controller unavailable")?;
        let facts: Inspection = serde_json::from_value(fixed_json_peer(
            &session.target,
            python,
            &json!({"mode":"inspect", "hostController":true, "root":canonical}),
            connection,
            Duration::from_secs(5),
        )?)
        .map_err(|_| "directOwnershipUnavailable: invalid remote facts")?;
        if !matches!(facts.platform.as_str(), "linux" | "macos")
            || facts.root != canonical.to_string_lossy()
            || facts.home.is_empty()
            || facts.temp_base.is_empty()
        {
            return Err("directOwnershipUnavailable: unsupported remote facts".into());
        }
        binding.validate(target, sessions, database)?;
        let verification = Arc::new(ControllerVerification {
            target: target.clone(),
            binding,
            sessions: sessions.clone(),
            database: database.clone(),
            facts,
            python: python.into(),
            host_key,
        });
        let mut job = Self::build(
            verification,
            contract,
            command,
            timeout,
            connection,
            known_hosts,
        )?;
        job.request["hostController"] = json!(true);
        *job.control_peer
            .lock()
            .map_err(|_| "directOwnershipUnavailable")? = Some(session.target.clone());
        Ok(job)
    }
}
