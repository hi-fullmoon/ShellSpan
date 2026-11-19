//! Runs the native Direct tool against a real Linux nono acceptance launcher.
use super::*;
use crate::models::{ManagedSession, SessionCommandSender, SessionIdentity, StatusEvent};
use std::fs;
use std::net::UdpSocket;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::process::Command;
use std::sync::atomic::AtomicBool;

#[derive(Clone, Debug)]
pub(super) struct Launcher {
    pub(super) executable: PathBuf,
    pub(super) node: PathBuf,
}

#[derive(Debug, Clone)]
pub(super) struct Binding {
    pub(super) launcher: Launcher,
    pub(super) workspace: PathBuf,
    pub(super) digest: String,
}

impl Binding {
    fn new(launcher: Launcher, workspace: PathBuf) -> Result<Self, String> {
        let mut binding = Self {
            launcher,
            workspace,
            digest: String::new(),
        };
        binding.digest = binding.current_digest()?;
        Ok(binding)
    }

    fn current_digest(&self) -> Result<String, String> {
        let root = fs::symlink_metadata(&self.workspace)
            .map_err(|error| format!("Sandbox workspace unavailable: {error}"))?;
        if !self.workspace.is_absolute() || !root.is_dir() || self.workspace.parent().is_none() {
            return Err("Local sandbox requires an absolute non-root workspace directory".into());
        }
        let file_identity = |path: &Path| {
            let metadata = fs::symlink_metadata(path).map_err(|error| {
                format!("Sandbox launcher or fixture interpreter unavailable: {error}")
            })?;
            if !path.is_absolute() || !metadata.is_file() {
                return Err("Expected an absolute sandbox executable path".into());
            }
            Ok::<_, String>((
                metadata.dev(),
                metadata.ino(),
                metadata.mode(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ))
        };
        let identity = serde_json::to_vec(&(
            "nono-linux-seccomp-acceptance-v1",
            &self.workspace,
            root.dev(),
            root.ino(),
            &self.launcher.executable,
            file_identity(&self.launcher.executable)?,
            &self.launcher.node,
            file_identity(&self.launcher.node)?,
        ))
        .map_err(|error| error.to_string())?;
        Ok(hex::encode(Sha256::digest(identity)))
    }

    pub(super) fn revalidate(&self) -> Result<(), String> {
        if self.digest != self.current_digest()? {
            return Err("Local sandbox workspace or launcher changed after authorization".into());
        }
        Ok(())
    }
}

impl NativeToolEngine {
    pub(super) fn local_sandbox_binding(
        &self,
        call: &AgentToolCallNative,
        database: &Database,
    ) -> Result<Option<Binding>, String> {
        let (Some(launcher), AgentToolTargetNative::Local { cwd, .. }, "exec_command") =
            (&self.local_sandbox, &call.target, call.tool_name.as_str())
        else {
            return Ok(None);
        };
        database.require_agent_sandbox_enabled()?;
        let workspace = cwd
            .as_deref()
            .ok_or("A frozen workspace is required for local sandbox execution")?;
        Binding::new(launcher.clone(), PathBuf::from(workspace)).map(Some)
    }
}

struct Fixture {
    engine: NativeToolEngine,
    sessions: SessionManager,
    database: Database,
    credentials: CredentialManager,
    directory: tempfile::TempDir,
    workspace: PathBuf,
    target: AgentToolTargetNative,
}

impl Fixture {
    fn new(launcher: Launcher) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let database = Database::open(&directory.path().join("preferences.sqlite")).unwrap();
        let terminal = "sandbox-acceptance-local";
        let sessions = SessionManager::default();
        let (sender, _) = crossbeam_channel::unbounded();
        sessions
            .insert(
                terminal.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: terminal.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "Direct sandbox acceptance".into(),
                        host: "local".into(),
                        port: 0,
                        username: "shellspan".into(),
                    },
                },
            )
            .unwrap();
        let target = AgentToolTargetNative::Local {
            target_id: terminal.into(),
            session_id: terminal.into(),
            cwd: Some(workspace.to_str().unwrap().into()),
        };
        let data_root = directory.path().join("app-data");
        fs::create_dir(&data_root).unwrap();
        let engine = NativeToolEngine {
            local_sandbox: Some(launcher),
            ..NativeToolEngine::default()
        };
        engine
            .configure_terminal_submission_root(&data_root)
            .unwrap();
        engine.configure_checkpoint_root(data_root).unwrap();
        Self {
            engine,
            sessions,
            database,
            credentials: CredentialManager::new(),
            directory,
            workspace,
            target,
        }
    }

    fn prepare(
        &self,
        name: &str,
        command: &str,
        timeout_ms: u64,
        background: bool,
    ) -> Result<PreparedAuthorizationNative, String> {
        let request_id = format!("request-{name}");
        let context = NativeExecutionContext {
            request: AgentRequestNative {
                contract_version: crate::agent_runtime::NATIVE_TOOL_CONTRACT_VERSION,
                request_id: request_id.clone(),
                user_session_id: "session-sandbox-acceptance".into(),
                task_id: format!("task-{name}"),
                goal: "Verify Linux native Direct sandbox".into(),
                success_criteria: vec!["Execute only within the authorized boundary".into()],
                targets: vec![self.target.clone()],
                permission_mode: AgentPermissionModeNative::RequestApproval,
            },
            turn_id: "turn-sandbox-acceptance".into(),
            step_id: format!("step-{name}"),
        };
        self.engine.prepare_authorization(
            context,
            AgentAuthorizeCallRequestNative {
                request_id,
                call_id: format!("call-{name}"),
                tool_name: "exec_command".into(),
                arguments: json!({
                    "command": command,
                    "explanation": "Run a sandbox acceptance fixture command",
                    "cwd": self.workspace,
                    "channel": "direct",
                    "timeoutMs": timeout_ms,
                    "background": background,
                }),
                target: self.target.clone(),
                ttl_ms: None,
            },
            &self.sessions,
            &self.database,
            &self.credentials,
            &self.directory.path().join("known_hosts"),
        )
    }

    fn approve(&self, prepared: &PreparedAuthorizationNative) -> AgentToolCallNative {
        assert!(prepared.requires_native_confirmation);
        assert!(prepared
            .native_prompt
            .contains("Local nono acceptance sandbox"));
        assert!(self
            .engine
            .issue_prepared_authorization(prepared, false)
            .is_err());
        let grant = self
            .engine
            .issue_prepared_authorization(prepared, true)
            .unwrap();
        let mut call = prepared.call.clone();
        call.capability_id = grant.capability_id;
        call.arguments = grant.effective_arguments;
        call
    }

    fn dispatch(
        &self,
        prepared: &PreparedAuthorizationNative,
        call: AgentToolCallNative,
    ) -> Result<AgentToolResultNative, String> {
        self.engine.execute_tool(
            &prepared.context,
            call,
            &self.sessions,
            &self.database,
            &self.credentials,
            &self.directory.path().join("known_hosts"),
            &CancellationToken::new(),
            None,
        )
    }

    fn run(
        &self,
        name: &str,
        command: &str,
        timeout_ms: u64,
        background: bool,
    ) -> AgentToolResultNative {
        let prepared = self.prepare(name, command, timeout_ms, background).unwrap();
        self.dispatch(&prepared, self.approve(&prepared)).unwrap()
    }
}

fn child_running(pid: i32) -> bool {
    let output = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8(output.stdout).unwrap();
    output.status.success() && !state.trim().is_empty() && !state.trim().starts_with('Z')
}

fn started_child(path: &Path) -> i32 {
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if let Some(pid) = fs::read_to_string(path)
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
        {
            if pid > 0 && child_running(pid) {
                return pid;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("test child did not start: {path:?}");
}

#[test]
#[ignore = "requires the real Linux acceptance launcher and interpreter"]
fn linux_direct_sandbox_acceptance() {
    let launcher = Launcher {
        executable: fs::canonicalize(std::env::var_os("SHELLSPAN_ACCEPTANCE_NONO").unwrap())
            .unwrap(),
        node: fs::canonicalize(std::env::var_os("SHELLSPAN_ACCEPTANCE_NODE").unwrap()).unwrap(),
    };
    let fixture = Fixture::new(launcher.clone());
    let off = fixture
        .prepare("default-off", "printf blocked > off", 5_000, false)
        .unwrap_err();
    assert!(off.starts_with("AGENT_SANDBOX_DISABLED:"), "{off}");
    fixture.database.set_agent_sandbox_enabled(true).unwrap();
    let pending = fixture
        .prepare("switch-off", "printf blocked > pending", 5_000, false)
        .unwrap();
    let authorized = fixture.approve(&pending);
    fixture.database.set_agent_sandbox_enabled(false).unwrap();
    let error = fixture.dispatch(&pending, authorized).unwrap_err();
    assert!(error.starts_with("AGENT_SANDBOX_DISABLED:"), "{error}");
    assert!(!fixture.workspace.join("pending").exists());
    fixture.database.set_agent_sandbox_enabled(true).unwrap();

    let result = fixture.run("file-boundary",
        "printf inside > inside; printf stdout; printf stderr >&2; ! (printf outside > ../outside) && exit 42",
        5_000, false);
    let data = result.data.unwrap();
    assert_eq!(data["sandbox"], "nonoLinuxSeccompAcceptance");
    assert_eq!(data["exitCode"], 42, "{data}");
    assert_eq!(data["stdout"], "stdout");
    assert!(data["stderr"].as_str().unwrap().contains("stderr"));
    assert!(data["stderr"]
        .as_str()
        .unwrap()
        .contains("Permission denied"));
    assert_eq!(
        fs::read(fixture.workspace.join("inside")).unwrap(),
        b"inside"
    );
    assert!(!fixture.directory.path().join("outside").exists());
    assert!(!result.effects.is_empty());

    fs::write(
        fixture.workspace.join("network-probe.mjs"),
        include_str!("../../../../../scripts/agent-sandbox/network-probe.mjs"),
    )
    .unwrap();
    let loopback = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
    let port = loopback.local_addr().unwrap().port();
    let network = fixture.run(
        "udp-boundary",
        &format!("\"$SHELLSPAN_ACCEPTANCE_NODE\" ./network-probe.mjs udp {port}"),
        5_000,
        false,
    );
    let network = network.data.unwrap();
    assert_eq!(network["exitCode"], 73, "{network}");
    assert!(network["stderr"]
        .as_str()
        .unwrap()
        .contains("loopback: EPERM"));
    loopback.set_nonblocking(true).unwrap();
    assert_eq!(
        loopback.recv(&mut [0; 32]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );

    let rejected_launcher = fixture.directory.path().join("non-executable-launcher");
    fs::copy(&launcher.executable, &rejected_launcher).unwrap();
    fs::set_permissions(&rejected_launcher, fs::Permissions::from_mode(0o600)).unwrap();
    let unstartable = Fixture::new(Launcher {
        executable: rejected_launcher,
        node: launcher.node,
    });
    unstartable
        .database
        .set_agent_sandbox_enabled(true)
        .unwrap();
    let pending = unstartable
        .prepare(
            "launch-failure",
            "printf started > unconfined",
            5_000,
            false,
        )
        .unwrap();
    let error = unstartable
        .dispatch(&pending, unstartable.approve(&pending))
        .unwrap_err();
    assert!(
        error.contains("Failed to start local direct command: Permission denied"),
        "{error}"
    );
    assert!(!unstartable.workspace.join("unconfined").exists());

    const SLEEP_COMMAND: &str = "sleep 30 & printf '%s' \"$!\" > child.pid; wait";
    let result = fixture.run("cancel", SLEEP_COMMAND, 12_000, true);
    let handle = result.data.as_ref().unwrap()["processHandle"]
        .as_str()
        .unwrap();
    let process = fixture.engine.processes.get(handle).unwrap();
    let pid = started_child(&fixture.workspace.join("child.pid"));
    fixture
        .engine
        .cancel_task("task-cancel", &fixture.sessions)
        .unwrap();
    let snapshot = process.wait(Duration::from_secs(3)).unwrap();
    assert_eq!(snapshot.state, ProcessLifecycleNative::Cancelled);
    assert!(snapshot.termination_confirmed);
    assert!(!child_running(pid));
    assert!(fixture.engine.processes.get(handle).is_err());

    fs::remove_file(fixture.workspace.join("child.pid")).unwrap();
    let timeout = fixture.run("timeout", SLEEP_COMMAND, 1_500, false);
    assert_eq!(timeout.status, AgentToolResultStatusNative::TimedOut);
    assert_eq!(timeout.data.unwrap()["terminationConfirmed"], true);
    let pid: i32 = fs::read_to_string(fixture.workspace.join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!child_running(pid));

    let pending = fixture
        .prepare("root-changed", "printf blocked > moved", 5_000, false)
        .unwrap();
    let authorized = fixture.approve(&pending);
    fs::rename(
        &fixture.workspace,
        fixture.directory.path().join("original"),
    )
    .unwrap();
    fs::create_dir(&fixture.workspace).unwrap();
    let error = fixture.dispatch(&pending, authorized).unwrap_err();
    assert!(
        error.contains("Native capability verification failed"),
        "{error}"
    );
    assert!(!fixture.workspace.join("moved").exists());
}
