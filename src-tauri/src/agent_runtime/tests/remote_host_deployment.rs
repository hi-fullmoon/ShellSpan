use super::super::super::{
    AgentAuthorizeCallRequestNative, AgentPermissionModeNative, AgentRequestNative,
    NativeExecutionContext, NativeToolEngine, NATIVE_TOOL_CONTRACT_VERSION,
};
use super::*;

#[test]
#[ignore = "explicit own Mac SSH Host artifact deployment using real SFTP and HTTP application"]
fn host_deployment_real_sftp_hash_start_http_update_and_owned_shutdown() {
    let fixture = Fixture::new();
    let artifacts = tempfile::tempdir().unwrap();
    let checkpoints = tempfile::tempdir().unwrap();
    let application =
        include_str!("../../../../tests/agent-shell-sandbox-phase-4/deployment_app.py");
    std::fs::write(artifacts.path().join("application.py"), application).unwrap();
    let mut target = super::super::super::remote_backend::validate_probe_target(
        &fixture.header,
        &fixture.sessions,
    )
    .unwrap();
    let mut session_target = fixture.header.target.clone().unwrap();
    session_target.local_root = Some(artifacts.path().to_str().unwrap().into());
    if let AgentToolTargetNative::Remote { local_root, .. } = &mut target {
        *local_root = session_target.local_root.clone();
    }
    let contract = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        &session_target,
        AgentExecutionSurface::Direct,
        0,
    )
    .unwrap();
    let context = NativeExecutionContext {
        sandbox_contract: Some(contract),
        request: AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: "host-deploy-request".into(),
            user_session_id: "host-deploy-session".into(),
            task_id: "host-deploy-task".into(),
            goal: "Deploy own genuine HTTP application over SSH".into(),
            success_criteria: vec![
                "Artifact hashes and version responses match actual deployed bytes".into(),
            ],
            targets: vec![target.clone()],
            permission_mode: AgentPermissionModeNative::RequestApproval,
        },
        turn_id: "turn".into(),
        step_id: "step".into(),
    };
    let engine = NativeToolEngine::default();
    engine
        .configure_checkpoint_root(checkpoints.path().to_owned())
        .unwrap();
    let call = |id: &str, name: &str, args: Value| {
        let prepared = engine
            .prepare_authorization(
                context.clone(),
                AgentAuthorizeCallRequestNative {
                    request_id: context.request.request_id.clone(),
                    call_id: id.into(),
                    tool_name: name.into(),
                    arguments: args,
                    target: target.clone(),
                    ttl_ms: None,
                },
                &fixture.sessions,
                &fixture.database,
                &fixture.credentials,
                &fixture.known_hosts,
            )
            .unwrap();
        let grant = engine
            .issue_prepared_authorization(&prepared, true)
            .unwrap();
        let mut call = prepared.call.clone();
        call.arguments = grant.effective_arguments;
        call.capability_id = grant.capability_id;
        engine
            .execute_tool(
                &context,
                call,
                &fixture.sessions,
                &fixture.database,
                &fixture.credentials,
                &fixture.known_hosts,
                &tokio_util::sync::CancellationToken::new(),
            )
            .unwrap()
    };
    let app_hash = hex::encode(Sha256::digest(application.as_bytes()));
    let uploaded = call(
        "upload-app",
        "transfer_file",
        json!({"direction":"upload","sourcePath":"application.py","destinationPath":"application.py","overwrite":false,"expectedSha256":app_hash,"maxBytes":65536}),
    );
    assert_eq!(
        uploaded.status,
        super::super::super::AgentToolResultStatusNative::Completed
    );
    let mut old_hash: Option<String> = None;
    for version in ["v1", "v2"] {
        let bytes = serde_json::to_vec(&json!({"version":version})).unwrap();
        std::fs::write(artifacts.path().join("release.json"), &bytes).unwrap();
        let hash = hex::encode(Sha256::digest(&bytes));
        let uploaded = call(
            &format!("upload-{version}"),
            "transfer_file",
            json!({"direction":"upload","sourcePath":"release.json","destinationPath":"release.json","overwrite":old_hash.is_some(),"expectedSha256":hash,"destinationSha256":old_hash,"maxBytes":65536}),
        );
        assert_eq!(
            uploaded.status,
            super::super::super::AgentToolResultStatusNative::Completed
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let root = fixture
            .directory
            .path()
            .join("project")
            .canonicalize()
            .unwrap();
        let command = shlex::try_join([
            "/Library/Developer/CommandLineTools/usr/bin/python3",
            "application.py",
            &port.to_string(),
        ])
        .unwrap();
        let command = format!(
            "cd {} && exec {command}",
            shlex::try_quote(root.to_str().unwrap()).unwrap()
        );
        let started = call(
            &format!("start-{version}"),
            "exec_command",
            json!({"command":command,"explanation":"Start the own uploaded versioned application","channel":"direct","background":true,"timeoutMs":15000}),
        );
        let data = started.data.unwrap();
        assert_eq!(data["sandboxBackend"], "host-account");
        assert_eq!(data["sandboxCapability"]["files"], false);
        let process = engine
            .acceptance_process(data["processHandle"].as_str().unwrap())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !process
            .snapshot()
            .unwrap()
            .stdout
            .contains("deployment-ready")
        {
            assert!(
                Instant::now() < deadline,
                "actual application did not start"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let observed = call(
            &format!("observe-{version}"),
            "probe_http",
            json!({"method":"get","port":port,"path":"/version","timeoutMs":5000}),
        );
        let data = observed.data.unwrap();
        assert_eq!(data["status"], 200);
        let response: Value = serde_json::from_str(data["body"].as_str().unwrap()).unwrap();
        assert_eq!(response["version"], version);
        assert_eq!(response["artifactSha256"], hash);
        let stopped = call(
            &format!("stop-{version}"),
            "probe_http",
            json!({"method":"post","port":port,"path":"/shutdown","timeoutMs":5000}),
        );
        assert_eq!(stopped.data.unwrap()["status"], 200);
        let done = process.wait(Duration::from_secs(5)).unwrap();
        assert_eq!(done.exit_code, Some(0));
        assert!(done.termination_confirmed);
        old_hash = Some(hash);
    }
    let ssh = open_ssh_execution_session(&fixture.connection, &fixture.known_hosts).unwrap();
    let sftp = ssh.target.sftp().unwrap();
    for name in ["application.py", "release.json"] {
        sftp.unlink(&fixture.directory.path().join("project").join(name))
            .unwrap();
    }
    assert_eq!(fixture.writes.load(Ordering::SeqCst), 0);
}
