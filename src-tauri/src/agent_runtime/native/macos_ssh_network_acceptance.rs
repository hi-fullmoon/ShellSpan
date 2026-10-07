#[test]
fn phase2_default_network_denies_real_ssh_forward_after_successful_baseline() {
    use std::io::{Read, Write};
    use std::process::Stdio;
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().canonicalize().unwrap();
    for name in ["host", "client"] {
        assert!(Command::new("/usr/bin/ssh-keygen")
            .args(["-q", "-t", "rsa", "-b", "3072", "-m", "PEM", "-N", "", "-f"])
            .arg(root.join(name))
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
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let config = root.join("sshd_config");
    std::fs::write(&config, format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes yes\nAllowTcpForwarding yes\nAllowUsers {username}\nLogLevel ERROR\n", root.join("host").display(), root.join("pid").display(), root.join("authorized_keys").display())).unwrap();
    let log = std::fs::File::create(root.join("server.log")).unwrap();
    let mut server = Server(
        Command::new("/usr/sbin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(&config)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap(),
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "Own ordinary-account sshd exited"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "Own sshd did not become reachable"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let known_hosts = root.join("known_hosts");
    std::fs::write(
        &known_hosts,
        format!(
            "[127.0.0.1]:{port} {}",
            std::fs::read_to_string(root.join("host.pub")).unwrap()
        ),
    )
    .unwrap();
    let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let target_address = target.local_addr().unwrap();
    let receiver = target.try_clone().unwrap();
    let worker = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match receiver.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "Baseline SSH did not forward to owned target"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Owned target accept failed: {error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut marker = [0; 18];
        stream.read_exact(&mut marker).unwrap();
        assert_eq!(&marker, b"ssh-forward-marker");
        stream.write_all(&marker).unwrap();
    });
    let arguments = vec![
        "-F".into(),
        "/dev/null".into(),
        "-oBatchMode=yes".into(),
        "-oIdentityAgent=none".into(),
        "-oConnectTimeout=3".into(),
        "-oStrictHostKeyChecking=yes".into(),
        format!("-oUserKnownHostsFile={}", known_hosts.display()),
        "-i".into(),
        root.join("client").display().to_string(),
        "-p".into(),
        port.to_string(),
        "-W".into(),
        target_address.to_string(),
        format!("{username}@127.0.0.1"),
    ];
    let mut baseline = Command::new("/usr/bin/ssh")
        .args(&arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    baseline
        .stdin
        .take()
        .unwrap()
        .write_all(b"ssh-forward-marker")
        .unwrap();
    let output = baseline.wait_with_output().unwrap();
    worker.join().unwrap();
    assert!(
        output.status.success(),
        "Baseline SSH forwarding failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"ssh-forward-marker");
    let input = shlex::try_join(
        std::iter::once("/usr/bin/ssh").chain(arguments.iter().map(String::as_str)),
    )
    .unwrap();
    let (mut restricted, _temp) =
        command(&input, &contract(&root, AgentSandboxPolicy::Workspace)).unwrap();
    let output = restricted.output().unwrap();
    assert!(
        !output.status.success(),
        "Default-deny SSH unexpectedly completed"
    );
    assert!(
        matches!(target.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
        "Restricted SSH reached owned forwarding target"
    );
}
