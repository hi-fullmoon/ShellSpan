use super::*;
use crate::agent_runtime::{
    AgentExecutionSurface, AgentSessionPermissionMode, AgentSessionTarget, AgentToolResultStatus,
    ModelToolCall, NativeToolAdapter, NativeToolEngine, NativeToolRequest, NativeToolRuntime,
    NativeToolServices,
};
use crate::keychain::CredentialManager;
use crate::models::{
    AuthMethod, ManagedSession, ProfileAuthMethod, ProfileRow, SessionCommandSender,
    SessionIdentity, SessionManager, SessionStatus, SessionTerminalKind, StatusEvent,
};

const WORKSPACE: &str = "/srv/shellspan-workspaces/project";

fn profile(port: u16) -> ProfileRow {
    ProfileRow {
        id: "bwrap-e2e".into(),
        name: "Bubblewrap fixture".into(),
        host: "127.0.0.1".into(),
        port,
        username: "sandbox".into(),
        auth_method: ProfileAuthMethod::Password,
        keychain_key_id: None,
        jump_host_config: None,
        organization_json: None,
        created_at: 1,
        updated_at: 1,
    }
}

fn set_policy(db: &Database, profile: &ProfileRow, mode: Mode) {
    let prior = db.profile_sandbox(&profile.id).unwrap();
    let policy = Policy {
        mode,
        workspace: WORKSPACE.into(),
    };
    db.save_profile_sandbox(&profile.id, &prior.binding, Some(policy))
        .unwrap();
}

#[test]
fn connection_policy_rejects_paths_outside_the_administrator_workspace_tree() {
    for invalid in [
        "/",
        "/srv/shellspan-workspaces/../etc",
        "/srv/shellspan-workspaces/project/",
        "/srv/shellspan-workspaces/project/child",
    ] {
        assert!(Policy {
            workspace: invalid.into(),
            mode: Mode::ReadOnly
        }
        .validate()
        .is_err());
    }
    let policy = Policy {
        workspace: WORKSPACE.into(),
        mode: Mode::ReadOnly,
    };
    assert!(policy.contains(&format!("{WORKSPACE}/src")));
    assert!(!policy.contains(&format!("{WORKSPACE}/../another")));
    assert!(!policy.contains(&format!("{WORKSPACE}another")));
    assert_eq!(install_command("unknown-distro"), None);
}

#[test]
fn profile_identity_roundtrip_and_policy_roundtrip_invalidate_old_approval() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let profile = profile(2222);
    db.insert_profile(&profile).unwrap();
    set_policy(&db, &profile, Mode::WorkspaceWrite);
    let saved = db.profile_sandbox(&profile.id).unwrap();
    let mut changed = profile.clone();
    changed.jump_host_config = Some(
        r#"{"host":"jump.example","port":22,"username":"sandbox","authMethod":"password"}"#.into(),
    );
    db.update_profile(&profile.id, &changed).unwrap();
    db.update_profile(&profile.id, &profile).unwrap();
    assert_ne!(
        saved.binding,
        db.profile_sandbox(&profile.id).unwrap().binding
    );
    assert!(!db
        .with_sandbox_dispatch(&profile.id, &saved.binding, || panic!("stale dispatch"))
        .is_ok());
    let saved = db.profile_sandbox(&profile.id).unwrap();
    db.save_profile_sandbox(&profile.id, &saved.binding, None)
        .unwrap();
    set_policy(&db, &profile, Mode::WorkspaceWrite);
    assert_ne!(
        saved.binding,
        db.profile_sandbox(&profile.id).unwrap().binding
    );
    assert_eq!(
        db.save_profile_sandbox(&profile.id, &saved.binding, None)
            .unwrap_err(),
        "SANDBOX_POLICY_CHANGED"
    );
}

#[test]
#[ignore = "requires the loopback Linux SSH/Bubblewrap acceptance container"]
fn linux_ssh_bubblewrap_acceptance() {
    let scenario = std::env::var("SHELLSPAN_SANDBOX_FIXTURE_SCENARIO").unwrap();
    let profile = profile(
        std::env::var("SHELLSPAN_SANDBOX_FIXTURE_PORT")
            .unwrap()
            .parse()
            .unwrap(),
    );
    let connection = RemoteConnectionRequest {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth_method: AuthMethod::Password,
        password: Some("shellspan-sandbox-e2e".into()),
        keychain_key_id: None,
        private_key_data: None,
        passphrase: None,
        jump_host: None,
    };
    let (_trust, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&profile.host, profile.port);
    let report = |mode| {
        test_executor(
            connection.clone(),
            &Policy {
                mode,
                workspace: WORKSPACE.into(),
            },
            "sandbox-fixture".into(),
            &known_hosts,
            Arc::new(AtomicBool::new(false)),
        )
    };
    let diagnostic = report(Mode::WorkspaceWrite);
    assert_eq!(
        diagnostic.ssh.status,
        crate::models::ConnectionPreflightStatus::Passed
    );
    match scenario.as_str() {
        "missing" => {
            assert!(!diagnostic.passed);
            assert!(diagnostic.package_missing);
            assert_eq!(diagnostic.install_command, Some("apk add bubblewrap"));
        }
        "unavailable" => {
            assert!(!diagnostic.passed);
            assert!(!diagnostic.package_missing);
            assert!(
                diagnostic.steps.contains(&(
                    "sandboxStart",
                    crate::models::ConnectionPreflightStepStatus::Failed
                )),
                "{:?}",
                diagnostic.steps
            );
        }
        "available" => assert!(diagnostic.passed, "{:?}", diagnostic.steps),
        _ => panic!("unrecognized acceptance scenario"),
    }

    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    db.insert_profile(&profile).unwrap();
    set_policy(&db, &profile, Mode::WorkspaceWrite);
    let credentials = CredentialManager::in_memory_for_tests();
    credentials
        .store_profile_password(&profile.id, connection.password.as_deref().unwrap())
        .unwrap();
    let sessions = SessionManager::default();
    // A real authenticated transport establishes the fixture's connected
    // identity. Agent dispatches open independently authenticated channels.
    let manual = crate::execution::open_ssh_execution_session(&connection, &known_hosts).unwrap();
    assert!(manual.target.authenticated());
    if scenario == "available" {
        use crate::models::{ConnectionPreflightStepId as Step, ConnectionPreflightStepStatus};
        use ssh2::{HostKeyType, KnownHostFileKind, KnownHostKeyFormat};
        let (key, kind) = manual.target.host_key().unwrap();
        let format = match kind {
            HostKeyType::Ed25519 => KnownHostKeyFormat::Ed25519,
            HostKeyType::Ecdsa256 => KnownHostKeyFormat::Ecdsa256,
            HostKeyType::Rsa => KnownHostKeyFormat::SshRsa,
            other => panic!("Unexpected fixture host key: {other:?}"),
        };
        let mut keys = manual.target.known_hosts().unwrap();
        keys.read_file(&known_hosts, KnownHostFileKind::OpenSSH)
            .unwrap();
        keys.add(
            "127.0.0.1",
            key,
            "isolated target inside the forwarding fixture",
            format,
        )
        .unwrap();
        keys.write_file(&known_hosts, KnownHostFileKind::OpenSSH)
            .unwrap();
        let mut via_jump = connection.clone();
        via_jump.port = 22;
        via_jump.jump_host = Some(crate::models::JumpHostConfig {
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            auth_method: connection.auth_method,
            password: connection.password.clone(),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
        });
        let jumped = test_executor(
            via_jump,
            &Policy {
                mode: Mode::ReadOnly,
                workspace: WORKSPACE.into(),
            },
            "sandbox-jump-fixture".into(),
            &known_hosts,
            Arc::new(AtomicBool::new(false)),
        );
        assert!(jumped.passed, "{:?}; {:?}", jumped.ssh.steps, jumped.steps);
        for step in [
            Step::JumpHostKey,
            Step::JumpAuthentication,
            Step::JumpTunnel,
            Step::HostKey,
            Step::Authentication,
        ] {
            assert!(jumped
                .ssh
                .steps
                .iter()
                .any(|entry| entry.id == step
                    && entry.status == ConnectionPreflightStepStatus::Passed));
        }
    }
    let (sender, manual_input) = crossbeam_channel::unbounded();
    sessions
        .insert(
            "fixture-terminal".into(),
            ManagedSession {
                sender: SessionCommandSender::Event(sender),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: "fixture-terminal".into(),
                    status: SessionStatus::Connected,
                    message: None,
                },
                output_ready: Arc::new(AtomicBool::new(true)),
                output_paused: Arc::new(AtomicBool::new(false)),
                terminal_kind: SessionTerminalKind::Remote,
                identity: SessionIdentity {
                    title: profile.name.clone(),
                    host: profile.host.clone(),
                    port: profile.port,
                    username: profile.username.clone(),
                },
            },
        )
        .unwrap();
    let target = AgentSessionTarget {
        kind: "remote".into(),
        target_id: "fixture-target".into(),
        session_id: "fixture-terminal".into(),
        profile_id: Some(profile.id.clone()),
        host: Some(profile.host.clone()),
        port: Some(profile.port),
        username: Some(profile.username.clone()),
        label: None,
        cwd: None,
        root_path: Some(WORKSPACE.into()),
        local_root: Some(temp.path().to_str().unwrap().into()),
    };
    let data_root = temp.path().join("runtime");
    std::fs::create_dir(&data_root).unwrap();
    let engine = Arc::new(NativeToolEngine::default());
    engine
        .configure_terminal_submission_root(&data_root)
        .unwrap();
    let adapter = NativeToolAdapter::from_services(
        NativeToolServices {
            sessions,
            database: db.clone(),
            credentials,
            known_hosts_path: known_hosts.clone(),
            data_root,
        },
        engine,
    )
    .unwrap();
    let prepare = |name: &str, arguments: Value| {
        adapter.prepare(NativeToolRequest {
            session_id: "fixture-agent".into(),
            task_id: "fixture-task".into(),
            goal: "Verify the sandbox".into(),
            success_criteria: vec!["Observe SSH and file results".into()],
            turn_id: "fixture-turn".into(),
            step_id: "fixture-step".into(),
            request_id: "fixture-request".into(),
            target: target.clone(),
            scratch_target: target.clone(),
            permission_mode: AgentSessionPermissionMode::RequestApproval,
            execution_surface: AgentExecutionSurface::BoundTerminal,
            model_call: ModelToolCall {
                call_id: format!("fixture-{}", uuid::Uuid::new_v4().simple()),
                provider_call_id: None,
                name: name.into(),
                arguments,
            },
        })
    };
    let cmd = |command: &str| {
        prepare(
            "run_terminal_command",
            json!({"command":command,"explanation":"Verify isolated execution"}),
        )
    };
    let run = |name: &str, arguments: Value| {
        let call = prepare(name, arguments).unwrap();
        assert!(call.requires_approval);
        adapter
            .execute(&call.token, true, CancellationToken::new())
            .unwrap()
    };
    let command = |command: &str| {
        run(
            "run_terminal_command",
            json!({"command":command,"explanation":"Verify isolated execution"}),
        )
    };

    let ordinary = manual.target.sftp().unwrap();
    assert!(
        ordinary.lstat(Path::new(OUTSIDE)).is_ok(),
        "manual SFTP must retain host visibility"
    );
    assert!(adapter
        .execute(
            &cmd("printf unapproved").unwrap().token,
            false,
            CancellationToken::new()
        )
        .is_err());
    if scenario != "available" {
        let failure = command("printf forbidden > forbidden.txt");
        assert_eq!(
            failure.status,
            AgentToolResultStatus::Failed,
            "{}",
            failure.summary
        );
        assert_eq!(failure.data.unwrap()["started"], false);
        assert!(ordinary
            .lstat(Path::new(&format!("{WORKSPACE}/forbidden.txt")))
            .is_err());
        let reading = prepare("read_file", json!({"path":"seed.txt","encoding":"utf8"})).unwrap();
        assert!(adapter
            .execute(&reading.token, true, CancellationToken::new())
            .unwrap_err()
            .contains("SANDBOX_"));
        return;
    }

    let result = command("test ! -e /var/lib/shellspan-sandbox/outside-probe && printf accepted > command.txt && cat command.txt");
    assert_eq!(
        result.status,
        AgentToolResultStatus::Completed,
        "{}",
        result.summary
    );
    let data = result.data.unwrap();
    assert_eq!(data["stdout"], "accepted");
    assert_eq!(data["terminationConfirmed"], true);
    assert_eq!(data["exitCode"], 0);
    assert!(
        manual_input.try_recv().is_err(),
        "Agent must not send text to the PTY"
    );

    let nonce = format!("files-{}.txt", uuid::Uuid::new_v4().simple());
    let written = run(
        "write_file",
        json!({"path":nonce,"content":"through SFTP","precondition":{"mustNotExist":true}}),
    );
    assert_eq!(
        written.status,
        AgentToolResultStatus::Completed,
        "{}",
        written.summary
    );
    let read = run("read_file", json!({"path":nonce,"encoding":"utf8"}));
    assert_eq!(
        read.status,
        AgentToolResultStatus::Completed,
        "{}",
        read.summary
    );
    assert!(read.data.unwrap().to_string().contains("through SFTP"));
    let search = run(
        "search_text",
        json!({"path":".","query":"through SFTP","mode":"content"}),
    );
    assert_eq!(
        search.status,
        AgentToolResultStatus::Completed,
        "{}",
        search.summary
    );
    assert!(search.data.unwrap().to_string().contains(&nonce));
    let before = hex::encode(Sha256::digest(b"through SFTP"));
    let patch = diffy::create_patch("through SFTP", "patched over SFTP\n").to_string();
    let patched = run(
        "apply_patch",
        json!({"patch":patch,"preconditions":[{"path":nonce,"sha256":before}]}),
    );
    assert_eq!(
        patched.status,
        AgentToolResultStatus::Completed,
        "{}",
        patched.summary
    );
    let digest = hex::encode(Sha256::digest(b"patched over SFTP\n"));
    let copy = run(
        "transfer_file",
        json!({"direction":"download","sourcePath":nonce,"destinationPath":"download.txt","overwrite":false,"expectedSha256":digest}),
    );
    assert_eq!(
        copy.status,
        AgentToolResultStatus::Completed,
        "{}",
        copy.summary
    );
    assert_eq!(
        std::fs::read(temp.path().join("download.txt")).unwrap(),
        b"patched over SFTP\n"
    );
    let refs = adapter.list_file_references(
        crate::agent_runtime::file_references::FileReferenceRequest {
            target: target.clone(),
            expected_scope: None,
            query: nonce.clone(),
            cancellation: CancellationToken::new(),
            deadline: Instant::now() + Duration::from_secs(10),
        },
    );
    assert!(
        refs.entries.iter().any(|entry| entry.path == nonce),
        "{refs:?}"
    );
    let skill = command("mkdir -p .agents/skills/fixture && printf '%s\\n' '---' 'name: fixture' 'description: Sandbox verification' '---' 'Inside sandbox' > .agents/skills/fixture/SKILL.md");
    assert_eq!(
        skill.status,
        AgentToolResultStatus::Completed,
        "{}",
        skill.summary
    );
    let skills = adapter.read_skills(crate::agent_runtime::skill_runtime::SkillReadRequest {
        target: target.clone(),
        expected_scope: None,
        cancellation: CancellationToken::new(),
    });
    assert!(
        skills
            .definitions
            .iter()
            .any(|definition| definition.instructions == "Inside sandbox\n"),
        "{skills:?}"
    );
    let absolute = prepare("read_file", json!({"path":OUTSIDE,"encoding":"utf8"}));
    if let Ok(call) = absolute {
        assert!(adapter
            .execute(&call.token, true, CancellationToken::new())
            .is_err());
    }
    for tool in [
        "write_terminal_input",
        "wait_process",
        "call_mcp_tool",
        "inspect_host",
    ] {
        assert!(prepare(tool, json!({}))
            .err()
            .unwrap()
            .contains("SANDBOX_TOOL_UNAVAILABLE"));
    }
    let stale = cmd("printf stale > stale.txt").unwrap();
    set_policy(&db, &profile, Mode::ReadOnly);
    assert!(adapter
        .execute(&stale.token, true, CancellationToken::new())
        .unwrap_err()
        .contains("SANDBOX_POLICY_CHANGED"));
    assert!(ordinary
        .lstat(Path::new(&format!("{WORKSPACE}/stale.txt")))
        .is_err());
    assert!(report(Mode::ReadOnly).passed);
    let read_only = command("cat seed.txt; ! (printf forbidden > blocked.txt)");
    assert_eq!(
        read_only.status,
        AgentToolResultStatus::Completed,
        "{}",
        read_only.summary
    );
    assert_eq!(read_only.data.unwrap()["stdout"], "inside workspace\n");
    assert!(prepare("write_file", json!({"path":"blocked.txt"}))
        .err()
        .unwrap()
        .contains("SANDBOX_READ_ONLY"));
    assert!(ordinary
        .lstat(Path::new(&format!("{WORKSPACE}/blocked.txt")))
        .is_err());

    let forced = cmd("sleep 20").unwrap();
    let cancel = CancellationToken::new();
    std::thread::scope(|scope| {
        let cancel_worker = cancel.clone();
        scope.spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            cancel_worker.cancel();
        });
        let result = adapter.execute(&forced.token, true, cancel).unwrap();
        assert_eq!(
            result.status,
            AgentToolResultStatus::Cancelled,
            "{}",
            result.summary
        );
        assert_eq!(result.data.unwrap()["terminationConfirmed"], true);
    });
}
