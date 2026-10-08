//! Actual Wry sessions on a parent-owned ordinary-account SSH fixture. The
//! server's Child handle survives client crashes and is never reconstructed.
use super::*;
use crate::models::{
    AuthMethod, ManagedSession, ProfileAuthMethod, ProfileRow, RemoteConnectionRequest,
    SessionCommand, SessionCommandSender, SessionIdentity, SessionManager, SessionStatus,
    SessionTerminalKind, StatusEvent,
};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureSpec {
    fixture_root: String,
    port: u16,
    username: String,
    parent_pid: u32,
    parent_nonce: String,
}

struct RemoteSource {
    id: String,
    sessions: SessionManager,
    worker: Option<std::thread::JoinHandle<()>>,
    writes: Arc<AtomicUsize>,
}

impl Drop for RemoteSource {
    fn drop(&mut self) {
        let _ = self.sessions.close(&self.id);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn source(
    id: &str,
    connection: &RemoteConnectionRequest,
    known_hosts: &Path,
    sessions: &SessionManager,
    home: &Path,
) -> Result<RemoteSource, String> {
    let ssh = crate::execution::open_ssh_execution_session(connection, known_hosts)
        .map_err(|_| "Owned source authentication failed")?;
    let mut channel = ssh
        .target
        .channel_session()
        .map_err(|_| "Owned source channel failed")?;
    channel
        .request_pty("xterm", None, Some((80, 24, 0, 0)))
        .map_err(|_| "Owned source PTY failed")?;
    std::fs::create_dir_all(home).map_err(|_| "Owned source home unavailable")?;
    let command = shlex::try_join([
        "/usr/bin/env",
        "-i",
        &format!("HOME={}", home.display()),
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
        "/bin/sh",
        "-i",
    ])
    .map_err(|_| "Owned source arguments invalid")?;
    crate::execution::start_ssh_exec_channel(&mut channel, &command)
        .map_err(|_| "Owned source launch failed")?;
    ssh.target.set_blocking(false);
    let (sender, receiver) = mpsc::channel();
    sessions.insert(
        id.into(),
        ManagedSession {
            sender: SessionCommandSender::Standard(sender),
            waker: None,
            output_state_sender: None,
            status: StatusEvent {
                session_id: id.into(),
                status: SessionStatus::Connected,
                message: None,
            },
            output_ready: Arc::new(AtomicBool::new(true)),
            output_paused: Arc::new(AtomicBool::new(false)),
            terminal_kind: SessionTerminalKind::Remote,
            identity: SessionIdentity {
                title: "Owned recovery SSH source".into(),
                host: connection.host.clone(),
                port: connection.port,
                username: connection.username.clone(),
            },
        },
    )?;
    let writes = Arc::new(AtomicUsize::new(0));
    let observed = writes.clone();
    let manager = sessions.clone();
    let source_id = id.to_owned();
    let worker = std::thread::spawn(move || {
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
        let _ = manager.set_status(
            &source_id,
            StatusEvent {
                session_id: source_id.clone(),
                status: SessionStatus::Disconnected,
                message: None,
            },
        );
    });
    Ok(RemoteSource {
        id: id.into(),
        sessions: sessions.clone(),
        worker: Some(worker),
        writes,
    })
}

pub(super) fn run(root: &Path, mode: &str) -> Result<(), String> {
    if !matches!(mode, "multi" | "crash-seed" | "crash-reopen")
        || !root.is_absolute()
        || !root.is_dir()
        || !root
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("shellspan-stage1-ssh-"))
    {
        return Err("Owned remote lifecycle fixture invalid".into());
    }
    let spec: FixtureSpec = serde_json::from_slice(
        &std::fs::read(root.join("fixture.json"))
            .map_err(|_| "Owned fixture specification missing")?,
    )
    .map_err(|_| "Owned fixture specification invalid")?;
    if spec.fixture_root != root.to_string_lossy()
        || spec.port == 22
        || spec.port == 0
        || spec.parent_pid < 2
    {
        return Err("Owned fixture binding invalid".into());
    }
    uuid::Uuid::parse_str(&spec.parent_nonce).map_err(|_| "Owned parent nonce invalid")?;
    let system = sysinfo::System::new_all();
    if system
        .process(sysinfo::Pid::from_u32(spec.parent_pid))
        .is_none()
    {
        return Err("Owned parent fixture is not active".into());
    }
    let actual_user = std::process::Command::new("/usr/bin/id")
        .arg("-un")
        .output()
        .map_err(|_| "Ordinary account identity unavailable")?;
    if String::from_utf8_lossy(&actual_user.stdout).trim() != spec.username {
        return Err("Owned fixture account mismatch".into());
    }
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.shellspan.native-remote-recovery-check".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.join("state")),
    );
    let check_root = root.to_owned();
    let saved = root.to_owned();
    let selected = mode.to_owned();
    let mut events = Vec::new();
    let event_root = root.to_owned();
    let app=tauri::Builder::default().manage(ContainerResourceSupervisor::default()).setup(move|app|{
        let handle=app.handle().clone();tauri::async_runtime::spawn_blocking(move||{
            let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||check(&handle,&check_root,&selected,&spec)))
                .unwrap_or_else(|_|Err("Owned remote lifecycle acceptance panicked".into()));
            let report=match outcome{Ok(value)=>value,Err(error)=>json!({"passed":false,"error":crate::redaction::redact_sensitive_text(&error)})};
            let _=std::fs::write(check_root.join("remote-lifecycle.json"),serde_json::to_vec_pretty(&report).unwrap_or_default());
            handle.exit(if report["passed"]==true{0}else{1});
        });Ok(())
    }).build(context).map_err(|_|"Owned remote Wry unavailable")?;
    let code=app.run_return(move|app,event|{
        if matches!(&event,tauri::RunEvent::ExitRequested{..}|tauri::RunEvent::Exit){events.push(json!({"pid":std::process::id(),"event":if matches!(&event,tauri::RunEvent::Exit){"exit"}else{"exitRequested"}}));let _=std::fs::write(event_root.join("remote-events.json"),serde_json::to_vec(&events).unwrap_or_default());}
        crate::app_exit::handle_event(app,event);
    });
    let report: Value = serde_json::from_slice(
        &std::fs::read(saved.join("remote-lifecycle.json"))
            .map_err(|_| "Remote lifecycle report missing")?,
    )
    .map_err(|_| "Remote lifecycle report invalid")?;
    if code != 0 || report["passed"] != true {
        return Err("Owned remote lifecycle acceptance failed; inspect isolated report".into());
    }
    Ok(())
}

fn check(
    app: &tauri::AppHandle,
    root: &Path,
    mode: &str,
    spec: &FixtureSpec,
) -> Result<Value, String> {
    let database = crate::db::Database::open(&root.join("state/remote.db"))?;
    let credentials = crate::keychain::CredentialManager::isolated_native_for_checks();
    let sessions = SessionManager::default();
    let known_hosts = crate::known_hosts::known_hosts_path(app)?;
    if !known_hosts.starts_with(root.join("state")) {
        return Err("Owned fixture known-hosts escaped the isolated state directory".into());
    }
    std::fs::create_dir_all(
        known_hosts
            .parent()
            .ok_or("Owned known-hosts parent missing")?,
    )
    .map_err(|_| "Owned known-hosts parent unavailable")?;
    let expected = ssh_key::PublicKey::from_openssh(
        &std::fs::read_to_string(root.join("ssh/host.pub"))
            .map_err(|_| "Owned host key missing")?,
    )
    .map_err(|_| "Owned host key invalid")?
    .to_bytes()
    .map_err(|_| "Owned host key encoding invalid")?;
    let handshake = crate::connection::open_session_for_host_key("127.0.0.1", spec.port)
        .map_err(|_| "Owned SSH handshake failed")?;
    if handshake.host_key().map(|pair| pair.0) != Some(expected.as_slice()) {
        return Err("Owned SSH peer key mismatch before authentication".into());
    }
    let mut trust = handshake
        .known_hosts()
        .map_err(|_| "Owned trust store unavailable")?;
    trust
        .add(
            &format!("[127.0.0.1]:{}", spec.port),
            &expected,
            "Owned lifecycle fixture",
            ssh2::KnownHostKeyFormat::SshRsa,
        )
        .map_err(|_| "Owned trust entry unavailable")?;
    trust
        .write_file(&known_hosts, ssh2::KnownHostFileKind::OpenSSH)
        .map_err(|_| "Owned trust persistence failed")?;
    let mut sources = Vec::new();
    for label in ["alpha", "beta"] {
        let profile_id = format!("stage1-{label}-profile");
        if mode != "crash-reopen" {
            let key_id = format!("stage1-owned-{}", uuid::Uuid::new_v4());
            let private_key = std::fs::read_to_string(root.join(format!("ssh/client-{label}")))
                .map_err(|_| "Owned fixture key unavailable")?;
            credentials
                .store_key_credential(&key_id, &json!({"privateKey":private_key}).to_string())?;
            database.insert_profile(&ProfileRow {
                id: profile_id.clone(),
                name: "Owned remote lifecycle".into(),
                host: "127.0.0.1".into(),
                port: spec.port,
                username: spec.username.clone(),
                auth_method: ProfileAuthMethod::Key,
                keychain_key_id: Some(key_id),
                jump_host_config: None,
                organization_json: None,
                created_at: 1,
                updated_at: 1,
            })?;
        }
        let profile = database
            .get_profile(&profile_id)?
            .ok_or("Owned persisted profile missing")?;
        if profile.host != "127.0.0.1"
            || profile.port != spec.port
            || profile.username != spec.username
        {
            return Err("Owned persisted profile changed".into());
        }
        let mut connection = RemoteConnectionRequest {
            host: profile.host,
            port: profile.port,
            username: profile.username,
            auth_method: AuthMethod::Key,
            password: None,
            keychain_key_id: profile.keychain_key_id,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        crate::commands::resolve_keychain_key_for_remote(&credentials, &mut connection)?;
        sources.push(source(
            &format!("stage1-{label}-source"),
            &connection,
            &known_hosts,
            &sessions,
            &root.join(format!("source-{label}")),
        )?);
    }
    app.manage(database.clone());
    app.manage(credentials.clone());
    app.manage(sessions.clone());
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(
        app.path()
            .app_data_dir()
            .map_err(|_| "Owned app directory unavailable")?,
    )?;
    app.manage(runtime.clone());
    runtime.configure_native(app.clone())?;
    let native = runtime.acceptance_native_runtime()?;
    if mode == "crash-reopen" {
        return reopen(
            app,
            root,
            &runtime,
            &native,
            &sessions,
            &sources,
            &database,
            &credentials,
        );
    }
    let mut headers = Vec::new();
    let mut processes = Vec::new();
    let mut directories = Vec::new();
    for label in ["alpha", "beta"] {
        let header=runtime.create_session(serde_json::from_value(json!({"sessionId":format!("stage1-{label}-agent"),"taskId":format!("stage1-{label}-task"),"goal":"Verify real remote session ownership and recovery",
            "target":{"kind":"remote","targetId":format!("stage1-{label}-target"),"sessionId":format!("stage1-{label}-source"),"profileId":format!("stage1-{label}-profile"),"host":"127.0.0.1","port":spec.port,"username":spec.username,"rootPath":root.join(format!("projects/{label}"))},
            "sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"requestApproval"})).map_err(|_|"Owned session schema invalid")?)?.header;
        native.prepare_sandbox(&header)?;
        let args = json!({"command":format!("printf started >> {label}-effect; sleep 30; printf ended >> {label}-effect"),"explanation":"Explicit owned lifecycle operation","background":true,"timeoutMs":45000});
        let pending = native.prepare(super::request(
            &header,
            &format!("{label}-run"),
            "run_terminal_command",
            args,
        )?)?;
        let data = native
            .execute(&pending.token, true, CancellationToken::new())?
            .data
            .ok_or("Owned start result missing")?;
        let handle = data["processHandle"]
            .as_str()
            .ok_or("Owned process handle missing")?;
        let process = runtime.acceptance_process(handle)?;
        directories.push(
            process
                .acceptance_owned_remote_directory()
                .ok_or("Owned remote directory missing")?,
        );
        headers.push(header);
        processes.push(process);
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    while std::fs::read_to_string(root.join("projects/alpha/alpha-effect"))
        .ok()
        .as_deref()
        != Some("started")
        || std::fs::read_to_string(root.join("projects/beta/beta-effect"))
            .ok()
            .as_deref()
            != Some("started")
    {
        if Instant::now() >= deadline {
            return Err("Both real remote sessions did not reach their effects".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if mode == "crash-seed" {
        let system = sysinfo::System::new_all();
        let own = system
            .process(sysinfo::Pid::from_u32(std::process::id()))
            .ok_or("Owned App identity missing")?;
        let ready = json!({"ready":true,"pid":std::process::id(),"startTime":own.start_time(),"fixtureRoot":root,"identifier":app.config().identifier,
            "directories":directories,"effects":["started","started"],"sourcePtyWrites":sources.iter().map(|source|source.writes.load(Ordering::SeqCst)).sum::<usize>()});
        std::fs::write(
            root.join("remote-ready.json"),
            serde_json::to_vec_pretty(&ready).map_err(|_| "Owned ready encoding failed")?,
        )
        .map_err(|_| "Owned ready delivery failed")?;
        std::thread::sleep(Duration::from_secs(120));
        return Err("Owned SSH App was not interrupted in its declared window".into());
    }
    // A second production engine on the same state must not stop this live
    // App's two sessions merely because it observes their durable intents.
    let observer = NativeToolEngine::default();
    observer.configure_direct_ownership(&root.join("state"))?;
    let live_recovery = observer.reconcile_direct_resources(&credentials, &known_hosts)?;
    let live_creator_protected = live_recovery.resolved == 0
        && live_recovery.uncertain == 2
        && processes.iter().all(|process| {
            process
                .snapshot()
                .is_ok_and(|snapshot| !snapshot.state.is_terminal())
        });
    let stale=native.prepare(super::request(&headers[0],"alpha-stale","run_terminal_command",json!({"command":"printf forbidden > stale-marker","explanation":"Old approval must not revive after a policy rebind"}))?)?;
    let engine = runtime.acceptance_native_engine();
    engine.cancel_task(&headers[0].task_id, &sessions)?;
    let beta_remains_running = !processes[1].snapshot()?.state.is_terminal();
    let alpha = runtime.set_sandbox_policy(&headers[0].session_id, AgentSandboxPolicy::ReadOnly)?;
    let old_approval_rejected = native
        .execute(&stale.token, true, CancellationToken::new())
        .is_err();
    let beta=native.prepare(super::request(&headers[1],"beta-stop","kill_process",json!({"processHandle":processes[1].snapshot()?.process_handle,"signal":"kill","timeoutMs":10000}))?)?;
    native.execute(&beta.token, true, CancellationToken::new())?;
    let terminated = processes.iter().all(|process| {
        process
            .snapshot()
            .is_ok_and(|snapshot| snapshot.termination_confirmed)
    });
    let absent = directories.iter().all(|directory| !directory.exists());
    runtime.prepare_for_shutdown(&sessions)?;
    for label in ["alpha", "beta"] {
        if let Some(key) = database
            .get_profile(&format!("stage1-{label}-profile"))?
            .and_then(|profile| profile.keychain_key_id)
        {
            credentials.delete_key_credential(&key)?;
        }
    }
    let writes = sources
        .iter()
        .map(|source| source.writes.load(Ordering::SeqCst))
        .sum::<usize>();
    let checks = json!({"liveCreatorSessionsNotClaimedByAnotherEngine":live_creator_protected,"secondSessionUnaffectedByFirstCancellation":beta_remains_running,"independentTerminationConfirmed":terminated,"exactOwnedDirectoriesRemoved":absent,
        "oldPreparedApprovalRejectedAfterRebind":old_approval_rejected,"policyRebound":alpha.header.sandbox_policy==Some(AgentSandboxPolicy::ReadOnly),"sourcePtyUntouched":writes==0,
        "oldCommandNotReplayed":!root.join("projects/alpha/stale-marker").exists()});
    Ok(
        json!({"passed":checks.as_object().is_some_and(|checks|checks.values().all(|value|value==true)),"checks":checks,"sessions":2,"sourcePtyWrites":writes,
        "scope":"two independent real remote Agent sessions, source SSH PTYs, profiles, keys and projects in one shared production Runtime and installed NativeAdapter; no generated remote model turn or UI claim"}),
    )
}

fn reopen(
    app: &tauri::AppHandle,
    root: &Path,
    runtime: &AgentRuntime,
    native: &Arc<dyn NativeToolRuntime>,
    sessions: &SessionManager,
    sources: &[RemoteSource],
    database: &crate::db::Database,
    credentials: &crate::keychain::CredentialManager,
) -> Result<Value, String> {
    let ready: Value = serde_json::from_slice(
        &std::fs::read(root.join("remote-ready.json"))
            .map_err(|_| "Owned prior readiness missing")?,
    )
    .map_err(|_| "Owned readiness invalid")?;
    if ready["ready"] != true || ready["fixtureRoot"] != root.to_string_lossy().as_ref() {
        return Err("Owned prior readiness binding changed".into());
    }
    let system = sysinfo::System::new_all();
    let pid = ready["pid"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or("Prior owned pid invalid")?;
    if system
        .process(sysinfo::Pid::from_u32(pid))
        .is_some_and(|process| process.start_time() == ready["startTime"].as_u64().unwrap_or(0))
    {
        return Err("Original App has not ended".into());
    }
    let before = runtime.session("stage1-alpha-agent")?;
    let old_binding = before.header.sandbox_binding_revision;
    let blocked=native.prepare(super::request(&before.header,"before-cleanup","run_terminal_command",json!({"command":"printf forbidden > replay-marker","explanation":"Must remain blocked before custody reconciliation"}))?).is_err();
    let first = tauri::async_runtime::block_on(
        super::super::commands::agent_runtime_reconcile_direct_resources(
            app.clone(),
            app.state::<AgentRuntime>(),
        ),
    )?;
    let second = tauri::async_runtime::block_on(
        super::super::commands::agent_runtime_reconcile_direct_resources(
            app.clone(),
            app.state::<AgentRuntime>(),
        ),
    )?;
    let absent = ready["directories"]
        .as_array()
        .ok_or("Owned directory observations missing")?
        .iter()
        .all(|value| {
            value
                .as_str()
                .is_some_and(|directory| !Path::new(directory).exists())
        });
    let effects_unchanged = ["alpha", "beta"].iter().all(|label| {
        std::fs::read_to_string(root.join(format!("projects/{label}/{label}-effect")))
            .ok()
            .as_deref()
            == Some("started")
    });
    let header = runtime.session("stage1-alpha-agent")?.header;
    native.prepare_sandbox(&header)?;
    let fresh=native.prepare(super::request(&header,"fresh-after-cleanup","run_terminal_command",json!({"command":"printf fresh > fresh-marker","explanation":"New explicit request after verified cleanup"}))?)?;
    let denied = native
        .execute(&fresh.token, false, CancellationToken::new())
        .is_err();
    let fresh=native.prepare(super::request(&header,"fresh-approved","run_terminal_command",json!({"command":"printf fresh > fresh-marker","explanation":"New separately approved request after verified cleanup"}))?)?;
    let executed = native
        .execute(&fresh.token, true, CancellationToken::new())?
        .data
        .is_some_and(|data| data["exitCode"] == 0 && data["terminationConfirmed"] == true);
    runtime.prepare_for_shutdown(sessions)?;
    for label in ["alpha", "beta"] {
        if let Some(key) = database
            .get_profile(&format!("stage1-{label}-profile"))?
            .and_then(|profile| profile.keychain_key_id)
        {
            credentials.delete_key_credential(&key)?;
        }
    }
    let writes = sources
        .iter()
        .map(|source| source.writes.load(Ordering::SeqCst))
        .sum::<usize>();
    let checks = json!({"newDispatchBlockedBeforeReconciliation":blocked,"authenticatedOwnCleanupResolved":first.resolved==2&&first.uncertain==0,"reconciliationIdempotent":second.resolved==0&&second.uncertain==0,
        "exactOwnedDirectoriesAbsent":absent,"noOldEffectReplay":effects_unchanged&&!root.join("projects/alpha/replay-marker").exists(),"policyAndBindingPreserved":header.sandbox_policy==Some(AgentSandboxPolicy::Workspace)&&header.sandbox_binding_revision==old_binding,
        "newApprovalStillRequired":denied,"newExplicitApprovedRequestExecuted":executed,"sourcePtyUntouched":writes==0});
    Ok(
        json!({"passed":checks.as_object().is_some_and(|checks|checks.values().all(|value|value==true)),"checks":checks,"recovered":first,"sourcePtyWrites":writes,
        "scope":"actual client App SIGKILL and new Wry process on identical production state; keychain cleanup-only capsules and signed frozen-peer receipts; no old process handle, command or execution grant restored"}),
    )
}
