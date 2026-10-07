use super::*;
use crate::models::{
    AuthMethod, ManagedSession, ProfileAuthMethod, ProfileRow, SessionCommand,
    SessionCommandSender, SessionIdentity, SessionStatus, SessionTerminalKind, StatusEvent,
};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;

pub(crate) struct Fixture {
    directory: tempfile::TempDir,
    server: Child,
    source: Option<std::thread::JoinHandle<()>>,
    sessions: SessionManager,
    database: Database,
    credentials: CredentialManager,
    connection: RemoteConnectionRequest,
    known_hosts: PathBuf,
    writes: Arc<AtomicUsize>,
    header: AgentSessionHeader,
    #[cfg(test)]
    admission: super::super::shutdown_admission::ShutdownAdmission,
    key_id: String,
}

impl Fixture {
    #[cfg(debug_assertions)]
    pub(crate) fn install(&self, app: &tauri::AppHandle) -> Result<(), String> {
        use tauri::Manager;
        app.manage(self.database.clone());
        app.manage(self.credentials.clone());
        app.manage(self.sessions.clone());
        let path = crate::known_hosts::known_hosts_path(app)?;
        std::fs::create_dir_all(path.parent().ok_or("Fixture known-hosts parent missing")?)
            .map_err(|_| "Fixture known-hosts directory unavailable")?;
        std::fs::copy(&self.known_hosts, path).map_err(|_| "Fixture known-hosts copy failed")?;
        Ok(())
    }
    #[cfg(debug_assertions)]
    pub(crate) fn target(&self) -> AgentSessionTarget {
        self.header.target.clone().expect("fixture target")
    }
    #[cfg(debug_assertions)]
    pub(crate) fn source_writes(&self) -> usize {
        self.writes.load(Ordering::SeqCst)
    }
    #[cfg(debug_assertions)]
    pub(crate) fn read_project(&self, name: &str) -> Result<String, String> {
        let ssh = open_ssh_execution_session(&self.connection, &self.known_hosts)
            .map_err(|_| "Fixture SSH reopen failed")?;
        let sftp = ssh.target.sftp().map_err(|_| "Fixture SFTP unavailable")?;
        let mut value = String::new();
        sftp.open(&self.directory.path().join("project").join(name))
            .map_err(|_| "Fixture project output unavailable")?
            .read_to_string(&mut value)
            .map_err(|_| "Fixture project read failed")?;
        Ok(value)
    }
    #[cfg(debug_assertions)]
    pub(crate) fn disconnect_source(&mut self) -> Result<(), String> {
        self.sessions.close("mac-source")?;
        if let Some(worker) = self.source.take() {
            worker.join().map_err(|_| "Fixture source worker failed")?;
        }
        Ok(())
    }
    #[cfg(debug_assertions)]
    pub(crate) fn reconnect_source(&mut self) -> Result<(), String> {
        if self.source.is_some() {
            return Err("Fixture source is still connected".into());
        }
        let ssh = open_ssh_execution_session(&self.connection, &self.known_hosts)
            .map_err(|_| "Fixture SSH reconnect failed")?;
        let mut channel = ssh
            .target
            .channel_session()
            .map_err(|_| "Fixture source channel unavailable")?;
        channel
            .request_pty("xterm", None, Some((80, 24, 0, 0)))
            .map_err(|_| "Fixture SSH PTY unavailable")?;
        let home = self.directory.path().join("source-home");
        let command = shlex::try_join([
            "/usr/bin/env",
            "-i",
            &format!("HOME={}", home.display()),
            "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
            "/bin/sh",
            "-i",
        ])
        .map_err(|_| "Fixture source argument encoding failed")?;
        crate::execution::start_ssh_exec_channel(&mut channel, &command)
            .map_err(|_| "Fixture source shell failed")?;
        ssh.target.set_blocking(false);
        let (sender, receiver) = mpsc::channel();
        self.sessions.insert(
            "mac-source".into(),
            ManagedSession {
                sender: SessionCommandSender::Standard(sender),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: "mac-source".into(),
                    status: SessionStatus::Connected,
                    message: None,
                },
                output_ready: Arc::new(AtomicBool::new(true)),
                output_paused: Arc::new(AtomicBool::new(false)),
                terminal_kind: SessionTerminalKind::Remote,
                identity: SessionIdentity {
                    title: "Own Mac SSH reconnect".into(),
                    host: self.connection.host.clone(),
                    port: self.connection.port,
                    username: self.connection.username.clone(),
                },
            },
        )?;
        let observed = self.writes.clone();
        let sessions = self.sessions.clone();
        self.source = Some(std::thread::spawn(move || {
            let mut bytes = [0_u8; 4096];
            loop {
                match receiver.try_recv() {
                    Ok(SessionCommand::Close) | Err(mpsc::TryRecvError::Disconnected) => break,
                    Ok(SessionCommand::Write(input)) => {
                        observed.fetch_add(1, Ordering::SeqCst);
                        let _ = channel.write_all(input.as_bytes());
                    }
                    Ok(SessionCommand::WriteBytes(input)) => {
                        observed.fetch_add(1, Ordering::SeqCst);
                        let _ = channel.write_all(&input);
                    }
                    _ => {}
                }
                match channel.read(&mut bytes) {
                    Ok(0) if channel.eof() => break,
                    Err(error) if error.kind() != std::io::ErrorKind::WouldBlock => break,
                    _ => {}
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = channel.send_eof();
            let _ = channel.close();
            let _ = sessions.set_status(
                "mac-source",
                StatusEvent {
                    session_id: "mac-source".into(),
                    status: SessionStatus::Disconnected,
                    message: None,
                },
            );
        }));
        Ok(())
    }
    pub(crate) fn new() -> Self {
        use std::os::unix::process::CommandExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        for name in ["host", "client"] {
            assert!(Command::new("/usr/bin/ssh-keygen")
                .args(["-q", "-t", "rsa", "-b", "3072", "-m", "PEM", "-N", "", "-f"])
                .arg(root.join(name))
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .status()
                .unwrap()
                .success());
        }
        std::fs::copy(root.join("client.pub"), root.join("authorized_keys")).unwrap();
        let username = String::from_utf8(
            Command::new("/usr/bin/id")
                .arg("-un")
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        std::fs::write(root.join("sshd_config"),format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes yes\nSubsystem sftp internal-sftp\nAllowUsers {username}\nLogLevel INFO\n",root.join("host").display(),root.join("pid").display(),root.join("authorized_keys").display())).unwrap();
        let log = std::fs::File::create(root.join("server.log")).unwrap();
        let mut server = Command::new("/usr/sbin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(root.join("sshd_config"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .process_group(0)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(
                server.try_wait().unwrap().is_none(),
                "ordinary-account fixture sshd failed"
            );
            assert!(
                Instant::now() < deadline,
                "ordinary-account fixture sshd did not listen"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let connection = RemoteConnectionRequest {
            host: "127.0.0.1".into(),
            port,
            username: username.clone(),
            auth_method: AuthMethod::Key,
            password: None,
            keychain_key_id: None,
            private_key_data: Some(std::fs::read_to_string(root.join("client")).unwrap()),
            passphrase: None,
            jump_host: None,
        };
        let known_hosts = root.join("known_hosts");
        let expected = ssh_key::PublicKey::from_openssh(
            &std::fs::read_to_string(root.join("host.pub")).unwrap(),
        )
        .unwrap()
        .to_bytes()
        .unwrap();
        let handshake =
            crate::connection::open_session_for_host_key(&connection.host, port).unwrap();
        assert_eq!(
            handshake.host_key().unwrap().0,
            expected.as_slice(),
            "fixture host key must match its own generated key"
        );
        let mut trust = handshake.known_hosts().unwrap();
        trust
            .add(
                &format!("[127.0.0.1]:{port}"),
                &expected,
                "Own phase4 fixture",
                ssh2::KnownHostKeyFormat::SshRsa,
            )
            .unwrap();
        trust
            .write_file(&known_hosts, ssh2::KnownHostFileKind::OpenSSH)
            .unwrap();
        let sessions = SessionManager::default();
        let ssh = open_ssh_execution_session(&connection, &known_hosts).unwrap();
        let mut channel = ssh.target.channel_session().unwrap();
        channel
            .request_pty("xterm", None, Some((80, 24, 0, 0)))
            .unwrap();
        let source_home = root.join("source-home");
        std::fs::create_dir(&source_home).unwrap();
        let source_command = shlex::try_join([
            "/usr/bin/env",
            "-i",
            &format!("HOME={}", source_home.display()),
            "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
            "/bin/sh",
            "-i",
        ])
        .unwrap();
        crate::execution::start_ssh_exec_channel(&mut channel, &source_command).unwrap();
        ssh.target.set_blocking(false);
        let (sender, receiver) = mpsc::channel();
        sessions
            .insert(
                "mac-source".into(),
                ManagedSession {
                    sender: SessionCommandSender::Standard(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: "mac-source".into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Remote,
                    identity: SessionIdentity {
                        title: "Own ordinary-account Mac SSH fixture".into(),
                        host: connection.host.clone(),
                        port,
                        username: username.clone(),
                    },
                },
            )
            .unwrap();
        let writes = Arc::new(AtomicUsize::new(0));
        let observed = writes.clone();
        let source_sessions = sessions.clone();
        let source = std::thread::spawn(move || {
            let mut bytes = [0_u8; 4096];
            loop {
                match receiver.try_recv() {
                    Ok(SessionCommand::Close) | Err(mpsc::TryRecvError::Disconnected) => break,
                    Ok(SessionCommand::Write(input)) => {
                        observed.fetch_add(1, Ordering::SeqCst);
                        let _ = channel.write_all(input.as_bytes());
                    }
                    Ok(SessionCommand::WriteBytes(input)) => {
                        observed.fetch_add(1, Ordering::SeqCst);
                        let _ = channel.write_all(&input);
                    }
                    _ => {}
                }
                match channel.read(&mut bytes) {
                    Ok(0) if channel.eof() => break,
                    Err(error) if error.kind() != std::io::ErrorKind::WouldBlock => break,
                    _ => {}
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = channel.send_eof();
            let _ = channel.close();
            let _ = source_sessions.set_status(
                "mac-source",
                StatusEvent {
                    session_id: "mac-source".into(),
                    status: SessionStatus::Disconnected,
                    message: None,
                },
            );
        });
        let database = Database::open(&root.join("fixture.db")).unwrap();
        #[cfg(test)]
        let credentials = CredentialManager::in_memory_for_tests();
        #[cfg(not(test))]
        let credentials = CredentialManager::isolated_native_for_checks();
        let key_id = format!("phase4-mac-ssh-{}", Uuid::new_v4());
        credentials
            .store_key_credential(
                &key_id,
                &json!({"privateKey":connection.private_key_data}).to_string(),
            )
            .unwrap();
        database
            .insert_profile(&ProfileRow {
                id: "mac-profile".into(),
                name: "Own Mac SSH fixture".into(),
                host: connection.host.clone(),
                port,
                username,
                auth_method: ProfileAuthMethod::Key,
                keychain_key_id: Some(key_id.clone()),
                jump_host_config: None,
                organization_json: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        let project = root.join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("input"), "remote-input").unwrap();
        std::fs::write(project.join(".env"), "ordinary-protected-marker").unwrap();
        std::os::unix::fs::symlink(&project, root.join("project-alias")).unwrap();
        let header=serde_json::from_value(json!({"sessionId":"mac-agent","taskId":"mac-task","goal":"Verify real remote native execution","executionSurface":"direct",
            "sandboxPolicy":"workspace","createdAtUnixMs":1,"target":{"kind":"remote","targetId":"mac-target","sessionId":"mac-source","profileId":"mac-profile",
                "host":connection.host,"port":port,"username":connection.username,"rootPath":root.join("project-alias")}})).unwrap();
        Self {
            directory,
            server,
            source: Some(source),
            sessions,
            database,
            credentials,
            connection,
            known_hosts,
            writes,
            header,
            #[cfg(test)]
            admission: Default::default(),
            key_id,
        }
    }

    #[cfg(test)]
    fn contract(&self) -> AgentSandboxContract {
        let target = self.header.target.as_ref().unwrap();
        let mut contract = AgentSandboxContract::freeze(
            Some(AgentSandboxPolicy::Host),
            target,
            AgentExecutionSurface::Direct,
            0,
        )
        .unwrap()
        .bind_to_session(&self.header);
        contract.policy = AgentSandboxPolicy::Workspace;
        contract.network = AgentSandboxNetworkPolicy::Deny;
        contract.root = Some(root_for(target).unwrap());
        contract.read_allow = contract.root.iter().cloned().collect();
        contract.write_allow = contract.read_allow.clone();
        contract.deny = deny_for(target).unwrap();
        contract
    }

    #[cfg(test)]
    fn process(
        &self,
        command: &str,
        timeout: Duration,
    ) -> (Arc<super::super::ManagedProcessNative>, PathBuf) {
        let job = RemoteSeatbeltJob::new(
            &self.contract(),
            command,
            timeout,
            &self.connection,
            &self.known_hosts,
        )
        .unwrap();
        assert!(
            !job.launch_command().unwrap().contains(&job.secret()),
            "control token must not enter argv"
        );
        let directory = job.owned_directory();
        let process =
            super::super::spawn_remote_process_native(super::super::RemoteProcessStartNative {
                remote_sandbox: Some(job),
                admission: Some(self.admission.clone()),
                task_id: "mac-task".into(),
                request_id: Uuid::new_v4().to_string(),
                owner_target_id: "mac-target".into(),
                command: command.into(),
                connection: self.connection.clone(),
                known_hosts_path: self.known_hosts.clone(),
                timeout,
            })
            .unwrap();
        (process, directory)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.sessions.close("mac-source");
        if let Some(worker) = self.source.take() {
            let _ = worker.join();
        }
        unsafe {
            libc::kill(-(self.server.id() as i32), libc::SIGTERM);
        }
        let _ = self.server.wait();
        let _ = self.credentials.delete_key_credential(&self.key_id);
    }
}

#[test]
#[ignore = "explicit ordinary-account self-owned Mac OpenSSH/Seatbelt native lower-layer acceptance"]
fn remote_native_lower_layer_freezes_sftp_root_transports_stdin_denies_and_cleans() {
    let fixture = Fixture::new();
    verify_header(
        &fixture.header,
        &fixture.sessions,
        &fixture.database,
        &fixture.credentials,
        &fixture.known_hosts,
        Some(fixture.admission.clone()),
    )
    .unwrap();
    assert_eq!(
        root_for(fixture.header.target.as_ref().unwrap()).unwrap(),
        fixture
            .directory
            .path()
            .join("project")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(
        capability(&fixture.header).unwrap().status,
        AgentSandboxCapabilityStatus::Partial
    );
    let (process, directory) = fixture.process(
        "read value; printf '%s' \"$value\"; printf updated > output",
        Duration::from_secs(8),
    );
    process.write_stdin("early-input\n".into(), false).unwrap();
    let result = process.wait(Duration::from_secs(12)).unwrap();
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.stdout, "early-input");
    assert!(result.termination_confirmed);
    let ssh = open_ssh_execution_session(&fixture.connection, &fixture.known_hosts).unwrap();
    let sftp = ssh.target.sftp().unwrap();
    assert!(
        sftp.lstat(&directory).is_err(),
        "confirmed own controller directory must be removed"
    );
    let mut bytes = String::new();
    sftp.open(&fixture.directory.path().join("project/output"))
        .unwrap()
        .read_to_string(&mut bytes)
        .unwrap();
    assert_eq!(bytes, "updated");
    let (denied, _) = fixture.process("cat .env", Duration::from_secs(8));
    let result = denied.wait(Duration::from_secs(12)).unwrap();
    assert_eq!(result.exit_code, Some(1));
    assert_eq!(result.stdout, "");
    assert!(result.termination_confirmed);
    let (cancelled, _) = fixture.process("printf running; exec sleep 30", Duration::from_secs(10));
    let deadline = Instant::now() + Duration::from_secs(5);
    while cancelled.snapshot().unwrap().stdout != "running" {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let result = cancelled
        .kill(
            super::super::ProcessSignalNative::Kill,
            Duration::from_secs(8),
        )
        .unwrap();
    assert_eq!(
        result.state,
        super::super::native::ProcessLifecycleNative::Cancelled
    );
    assert!(result.termination_confirmed);
    let (timed, _) = fixture.process("exec sleep 30", Duration::from_secs(2));
    let result = timed.wait(Duration::from_secs(10)).unwrap();
    assert_eq!(
        result.state,
        super::super::native::ProcessLifecycleNative::TimedOut
    );
    assert!(result.termination_confirmed);
    fixture.admission.close();
    let (blocked, _) = fixture.process("printf must-not-run", Duration::from_secs(3));
    let result = blocked.wait(Duration::from_secs(5)).unwrap();
    assert_eq!(
        result.state,
        super::super::native::ProcessLifecycleNative::Failed
    );
    assert_eq!(result.stdout, "");
    assert!(result.termination_confirmed);
    assert_eq!(
        fixture.writes.load(Ordering::SeqCst),
        0,
        "actual source SSH PTY must receive no Direct input"
    );
}

#[cfg(test)]
#[path = "remote_seatbelt_engine.rs"]
mod engine_tests;
#[cfg(test)]
#[path = "remote_seatbelt_pin.rs"]
mod pin_tests;
