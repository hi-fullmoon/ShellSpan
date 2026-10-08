use super::*;
use std::os::unix::process::CommandExt;

#[test]
#[ignore = "explicit own ordinary-account macOS SSH offline/reconnect and exact job cleanup"]
fn offline_reconnect_keeps_cleanup_debt_and_never_reuses_execution_authority() {
    let mut fixture = Fixture::new();
    for cycle in 1..=3 {
        offline_reconnect_cycle(&mut fixture, cycle);
    }
}

fn offline_reconnect_cycle(fixture: &mut Fixture, cycle: usize) {
    let engine = super::super::super::NativeToolEngine::default();
    let state = fixture.directory.path().join("state");
    engine.configure_direct_ownership(&state).unwrap();
    verify_header_owned(
        &fixture.header,
        &fixture.sessions,
        &fixture.database,
        &fixture.credentials,
        &fixture.known_hosts,
        Some(fixture.admission.clone()),
        Some(&engine),
    )
    .unwrap();
    assert_eq!(
        rusqlite::Connection::open(state.join("agent-direct-ownership.sqlite3"))
            .unwrap()
            .query_row("SELECT count(*) FROM dispatch_debt", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0,
        "successful preflight must resolve its own durable resource intent"
    );
    let (first, first_directory) = fixture.process(
        "printf first-running; exec sleep 20",
        Duration::from_secs(25),
    );
    let (second, second_directory) = fixture.process(
        "printf second-running; exec sleep 20",
        Duration::from_secs(25),
    );
    let deadline = Instant::now() + Duration::from_secs(8);
    while first.snapshot().unwrap().stdout != "first-running"
        || second.snapshot().unwrap().stdout != "second-running"
    {
        assert!(
            Instant::now() < deadline,
            "both owned jobs must reach their real running effect"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let stopped = first
        .kill(
            super::super::super::ProcessSignalNative::Kill,
            Duration::from_secs(8),
        )
        .unwrap();
    assert!(stopped.termination_confirmed);
    assert_eq!(
        second.snapshot().unwrap().state,
        super::super::super::native::ProcessLifecycleNative::Running
    );
    let ssh = open_ssh_execution_session(&fixture.connection, &fixture.known_hosts).unwrap();
    let sftp = ssh.target.sftp().unwrap();
    assert!(sftp.lstat(&first_directory).is_err());
    assert!(sftp.lstat(&second_directory).is_ok());
    drop(sftp);
    drop(ssh);
    // Kill only our listening sshd Child. Active per-connection controllers
    // retain their own deadline; no descendant is selected by a historical PID.
    fixture.server.kill().unwrap();
    fixture.server.wait().unwrap();
    fixture.disconnect_source().unwrap();
    let offline_started = Instant::now();
    let result = second.wait(Duration::from_secs(12)).unwrap();
    assert!(
        result.state.is_terminal(),
        "offline execution must publish its unconfirmed terminal state"
    );
    assert!(
        !result.termination_confirmed,
        "channel loss is not termination evidence"
    );
    let offline_termination_confirmed = result.termination_confirmed;
    assert_eq!(
        result.failure.unwrap().kind,
        super::super::super::AgentExecutionFailureKind::TerminationUnconfirmed
    );
    while offline_started.elapsed() < Duration::from_secs(15) {
        assert!(!second.snapshot().unwrap().termination_confirmed);
        std::thread::sleep(Duration::from_millis(50));
    }
    let offline_seconds = offline_started.elapsed().as_secs_f64();
    let root = fixture.directory.path().canonicalize().unwrap();
    let log = std::fs::OpenOptions::new()
        .append(true)
        .open(root.join("server.log"))
        .unwrap();
    fixture.server = Command::new("/usr/sbin/sshd")
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
    while std::net::TcpStream::connect(("127.0.0.1", fixture.connection.port)).is_err() {
        assert!(fixture.server.try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    fixture.reconnect_source().unwrap();
    assert!(
        capability(&fixture.header).is_none(),
        "new source generation cannot revive the old grant"
    );
    let result = second
        .kill(
            super::super::super::ProcessSignalNative::Kill,
            Duration::from_secs(8),
        )
        .unwrap();
    assert!(
        result.termination_confirmed,
        "frozen signed own-job receipt must confirm cleanup after reconnect: {result:?}"
    );
    let ssh = open_ssh_execution_session(&fixture.connection, &fixture.known_hosts).unwrap();
    let sftp = ssh.target.sftp().unwrap();
    assert!(sftp.lstat(&second_directory).is_err());
    assert_eq!(
        result.stdout, "second-running",
        "old command must not be replayed"
    );
    assert_eq!(fixture.writes.load(Ordering::SeqCst), 0);
    if let Some(root) = std::env::var_os("SHELLSPAN_STAGE1_EVIDENCE_DIR") {
        let root = PathBuf::from(root);
        assert!(root.is_absolute() && root.is_dir());
        std::fs::write(root.join(format!("ssh-offline-reconnect-cycle-{cycle}.json")), serde_json::to_vec_pretty(&json!({
            "cycle":cycle,
            "offlineObservationSeconds":offline_seconds,
            "offlineTerminationConfirmed":offline_termination_confirmed,
            "reconnectedTerminationConfirmed":result.termination_confirmed,
            "firstOwnedDirectoryAbsent":sftp.lstat(&first_directory).is_err(),
            "secondOwnedDirectoryAbsent":sftp.lstat(&second_directory).is_err(),
            "oldCapabilityUnavailable":capability(&fixture.header).is_none(),
            "sourcePtyWrites":fixture.writes.load(Ordering::SeqCst),
            "effect":result.stdout,
            "scope":"self-owned loopback ordinary-account SSH listener unavailable for a measured finite window; no external network or indefinite recovery claim"
        })).unwrap()).unwrap();
    }
}
