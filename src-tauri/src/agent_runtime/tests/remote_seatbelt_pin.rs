use super::*;
use std::os::unix::process::CommandExt;

#[test]
#[ignore = "explicit own Mac SSH host-key rotation; verifies refusal before authentication"]
fn changed_trusted_host_key_is_rejected_before_authentication_and_host_baseline_remains() {
    let mut fixture = Fixture::new();
    let previous = open_ssh_execution_session(&fixture.connection, &fixture.known_hosts).unwrap();
    let expected = fingerprint(&previous.target).unwrap();
    drop(previous);
    fixture.disconnect_source().unwrap();
    unsafe {
        libc::kill(-(fixture.server.id() as i32), libc::SIGTERM);
    }
    fixture.server.wait().unwrap();
    let root = fixture.directory.path().canonicalize().unwrap();
    assert!(Command::new("/usr/bin/ssh-keygen")
        .args(["-q", "-t", "rsa", "-b", "3072", "-m", "PEM", "-N", "", "-f"])
        .arg(root.join("replacement-host"))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .status()
        .unwrap()
        .success());
    std::fs::rename(root.join("replacement-host"), root.join("host")).unwrap();
    std::fs::rename(root.join("replacement-host.pub"), root.join("host.pub")).unwrap();
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
    loop {
        if std::net::TcpStream::connect(("127.0.0.1", fixture.connection.port)).is_ok() {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let public =
        ssh_key::PublicKey::from_openssh(&std::fs::read_to_string(root.join("host.pub")).unwrap())
            .unwrap()
            .to_bytes()
            .unwrap();
    let handshake = crate::connection::open_session_for_host_key(
        &fixture.connection.host,
        fixture.connection.port,
    )
    .unwrap();
    assert_eq!(handshake.host_key().unwrap().0, public.as_slice());
    let mut trust = handshake.known_hosts().unwrap();
    trust
        .add(
            &format!("[127.0.0.1]:{}", fixture.connection.port),
            &public,
            "Own rotated fixture key",
            ssh2::KnownHostKeyFormat::SshRsa,
        )
        .unwrap();
    trust
        .write_file(&fixture.known_hosts, ssh2::KnownHostFileKind::OpenSSH)
        .unwrap();
    let count = || {
        std::fs::read_to_string(root.join("server.log"))
            .unwrap()
            .matches("Accepted publickey")
            .count()
    };
    let before = count();
    let error = match open_ssh_execution_session_pinned(
        &fixture.connection,
        &fixture.known_hosts,
        &expected,
    ) {
        Ok(_) => panic!("changed key reached authentication"),
        Err(error) => error,
    };
    assert!(error.message.contains("before authentication"));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        count(),
        before,
        "no credential authentication can precede the frozen-key rejection"
    );
    // Host keeps the normal known_hosts contract and can authenticate to the
    // fixture's newly trusted key with its own genuine generated credential.
    open_ssh_execution_session(&fixture.connection, &fixture.known_hosts).unwrap();
    assert!(count() > before);
}
