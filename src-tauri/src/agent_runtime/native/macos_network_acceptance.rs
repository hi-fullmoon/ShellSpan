// Real, owned endpoints only. Baseline connectivity is required before denial.
#[test]
fn phase2_network_request_rejects_metadata_and_local_literals_before_dispatch() {
    let workspace = tempfile::tempdir().unwrap();
    let frozen = contract(workspace.path(), AgentSandboxPolicy::Workspace);
    for host in [
        "169.254.169.254",
        "168.63.129.16",
        "127.0.0.1",
        "[::1]",
        "[::ffff:127.0.0.1]",
        "[fd00:ec2::254]",
        "localhost",
    ] {
        let request = crate::agent_runtime::NetworkTargetRequestNative {
            host: host.into(),
            port: 80,
            resolver: crate::agent_runtime::NetworkResolverNative::System,
        };
        let error =
            crate::agent_runtime::sandbox_authorization::network_requests(&frozen, &[request])
                .expect_err("Literal addresses must not reach grant issuance or DNS");
        assert!(
            error.starts_with("sandboxResourceRequestInvalid:"),
            "{host}: {error}"
        );
    }
}

#[test]
fn phase2_default_network_denies_ipv4_ipv6_mapped_and_child_connections() {
    for address in ["127.0.0.1:0", "[::1]:0"] {
        let listener = std::net::TcpListener::bind(address).unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = listener.local_addr().unwrap();
        let hosts = if endpoint.is_ipv4() {
            vec!["127.0.0.1", "::ffff:127.0.0.1"]
        } else {
            vec!["::1"]
        };
        for host in hosts {
            let workspace = tempfile::tempdir().unwrap();
            let script = workspace.path().join("connect.cjs");
            std::fs::write(&script, format!(
                "const net=require('node:net');const s=net.connect({{host:'{host}',port:{}}});s.on('connect',()=>{{s.destroy();process.exit(0)}});s.on('error',()=>process.exit(7));s.setTimeout(1500,()=>{{s.destroy();process.exit(8)}});",
                endpoint.port()
            )).unwrap();
            assert!(
                Command::new("node")
                    .arg(&script)
                    .status()
                    .unwrap()
                    .success(),
                "Host baseline failed for {host}"
            );
            drop(
                listener
                    .accept()
                    .expect("Baseline must reach owned listener"),
            );
            let input = format!("node {}", quoted(&script).unwrap());
            for invocation in [input.clone(), format!("/bin/sh -c '{}'", input)] {
                let (mut child, _temp) = command(
                    &invocation,
                    &contract(workspace.path(), AgentSandboxPolicy::Workspace),
                )
                .unwrap();
                let output = child.output().unwrap();
                assert_eq!(
                    output.status.code(),
                    Some(7),
                    "Expected socket error for {host}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(
                    matches!(listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
                    "Denied command reached {host}"
                );
            }
        }
    }
}

#[test]
fn phase2_default_network_denies_unapproved_unix_socket() {
    let workspace = tempfile::tempdir().unwrap();
    let socket = workspace.path().join("owned.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let script = workspace.path().join("connect.cjs");
    std::fs::write(&script, "const net=require('node:net');const s=net.connect(process.argv[2]);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(7));s.setTimeout(1500,()=>{s.destroy();process.exit(8)});").unwrap();
    assert!(Command::new("node")
        .arg(&script)
        .arg(&socket)
        .status()
        .unwrap()
        .success());
    drop(
        listener
            .accept()
            .expect("Baseline must reach owned Unix listener"),
    );
    let input = format!(
        "node {} {}",
        quoted(&script).unwrap(),
        quoted(&socket).unwrap()
    );
    let (mut child, _temp) = command(
        &input,
        &contract(workspace.path(), AgentSandboxPolicy::Workspace),
    )
    .unwrap();
    let output = child.output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(7),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        matches!(listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
}
