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
    db.set_agent_sandbox_enabled(true).unwrap();
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
fn agent_sandbox_is_opt_in_and_rechecks_before_ssh_dispatch() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db");
    let db = Database::open(&path).unwrap();
    let profile = profile(2222);
    db.insert_profile(&profile).unwrap();
    let target = AgentToolTargetNative::Remote {
        target_id: "remote".into(),
        session_id: "terminal".into(),
        profile_id: Some(profile.id.clone()),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        root_path: Some(WORKSPACE.into()),
        local_root: None,
    };
    let known_hosts = temp.path().join("known_hosts");
    let unsandboxed = binding_for_target(&target, &db, &known_hosts)
        .unwrap()
        .unwrap();
    let args = json!({"command":"pwd"});
    assert!(!db.agent_sandbox_enabled().unwrap());
    guard_tool(&db, Some(&unsandboxed), "exec_command", &args).unwrap();
    guard_tool(&db, None, "exec_command", &args).unwrap();
    validate_session_requirement(Some(&unsandboxed), Some(false)).unwrap();
    unsandboxed.write(&db, &known_hosts, || ()).unwrap();

    set_policy(&db, &profile, Mode::WorkspaceWrite);
    assert_eq!(
        unsandboxed
            .write::<()>(&db, &known_hosts, || panic!(
                "ordinary command dispatched after policy change"
            ))
            .unwrap_err(),
        "SANDBOX_POLICY_CHANGED",
    );
    let binding = binding_for_target(&target, &db, &known_hosts)
        .unwrap()
        .unwrap();
    assert!(guard_tool(&db, Some(&binding), "exec_command", &args)
        .unwrap_err()
        .starts_with("AGENT_SANDBOX_DISABLED:"));
    assert!(binding
        .check(&db, &known_hosts)
        .unwrap_err()
        .starts_with("AGENT_SANDBOX_DISABLED:"));

    db.set_agent_sandbox_enabled(true).unwrap();
    let db = Database::open(&path).unwrap();
    guard_tool(&db, Some(&binding), "exec_command", &args).unwrap();
    binding.check(&db, &known_hosts).unwrap();

    db.set_agent_sandbox_enabled(false).unwrap();
    assert!(binding
        .write::<()>(&db, &known_hosts, || panic!("disabled sandbox dispatched"))
        .unwrap_err()
        .starts_with("AGENT_SANDBOX_DISABLED:"));
    assert_eq!(
        db.profile_sandbox(&profile.id).unwrap().policy,
        binding.state.policy
    );
}

#[test]
fn visible_ssh_dispatch_checks_saved_and_unsaved_targets_after_policy_change() {
    let temp = tempfile::tempdir().unwrap();
    let database = Database::open(&temp.path().join("db")).unwrap();
    let profile = profile(2222);
    database.insert_profile(&profile).unwrap();
    let target = AgentToolTargetNative::Remote {
        target_id: "remote".into(),
        session_id: "terminal".into(),
        profile_id: Some(profile.id.clone()),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        root_path: None,
        local_root: None,
    };
    let mut unsaved = target.clone();
    if let AgentToolTargetNative::Remote { profile_id, .. } = &mut unsaved {
        *profile_id = None;
    }
    let known_hosts = temp.path().join("known_hosts");
    let binding = binding_for_target(&target, &database, &known_hosts)
        .unwrap()
        .unwrap();
    assert!(binding_for_target(&unsaved, &database, &known_hosts)
        .unwrap()
        .is_none());
    let saved_dispatch = VisibleTerminalDispatch {
        target: &target,
        binding: Some(&binding),
        database: &database,
        known_hosts: &known_hosts,
    };
    let unsaved_dispatch = VisibleTerminalDispatch {
        target: &unsaved,
        binding: None,
        database: &database,
        known_hosts: &known_hosts,
    };
    assert!(saved_dispatch.write(|| Ok(())).is_ok());
    assert!(unsaved_dispatch.write(|| Ok(())).is_ok());

    set_policy(&database, &profile, Mode::ReadOnly);
    assert_eq!(
        saved_dispatch
            .write::<()>(|| panic!("stale SSH input was admitted"))
            .unwrap_err(),
        "SANDBOX_POLICY_CHANGED"
    );
    assert_eq!(
        unsaved_dispatch
            .write::<()>(|| panic!("unbound SSH input was admitted"))
            .unwrap_err(),
        "SANDBOX_PROFILE_REQUIRED"
    );
}

#[test]
fn removed_policy_requires_a_new_session_even_after_reopening_database() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db");
    let db = Database::open(&path).unwrap();
    let profile = profile(2222);
    db.insert_profile(&profile).unwrap();
    let target = AgentToolTargetNative::Remote {
        target_id: "remote".into(),
        session_id: "terminal".into(),
        profile_id: Some(profile.id.clone()),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        root_path: Some(WORKSPACE.into()),
        local_root: None,
    };
    let known_hosts = temp.path().join("known_hosts");
    set_policy(&db, &profile, Mode::WorkspaceWrite);
    let configured = binding_for_target(&target, &db, &known_hosts).unwrap();
    validate_session_requirement(configured.as_ref(), Some(true)).unwrap();
    validate_session_requirement(configured.as_ref(), None).unwrap();
    assert!(validate_session_requirement(configured.as_ref(), Some(false)).is_err());

    db.save_profile_sandbox(&profile.id, &configured.unwrap().state.binding, None)
        .unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let removed = binding_for_target(&target, &db, &known_hosts).unwrap();
    for existing in [Some(true), None] {
        assert!(validate_session_requirement(removed.as_ref(), existing)
            .unwrap_err()
            .starts_with("SANDBOX_SESSION_POLICY_CHANGED:"));
    }
    validate_session_requirement(removed.as_ref(), Some(false)).unwrap();
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
    db.set_agent_sandbox_enabled(true).unwrap();
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
        remote_sandbox_required: Some(true),
        local_sandbox_required: None,
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
    let prepare_on = |execution_surface, name: &str, arguments: Value| {
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
            execution_surface,
            model_call: ModelToolCall {
                call_id: format!("fixture-{}", uuid::Uuid::new_v4().simple()),
                provider_call_id: None,
                name: name.into(),
                arguments,
            },
        })
    };
    let prepare =
        |name: &str, arguments: Value| prepare_on(AgentExecutionSurface::Direct, name, arguments);
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
    assert_eq!(
        prepare_on(
            AgentExecutionSurface::BoundTerminal,
            "run_terminal_command",
            json!({"command":"pwd","explanation":"Verify the selected execution surface"}),
        )
        .err()
        .as_deref(),
        Some(DIRECT_REQUIRED),
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
    let pending = cmd("printf blocked > disabled.txt").unwrap();
    db.set_agent_sandbox_enabled(false).unwrap();
    assert!(adapter
        .execute(&pending.token, true, CancellationToken::new())
        .unwrap_err()
        .contains("AGENT_SANDBOX_DISABLED"));
    assert!(ordinary
        .lstat(Path::new(&format!("{WORKSPACE}/disabled.txt")))
        .is_err());
    db.set_agent_sandbox_enabled(true).unwrap();
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

#[test]
fn verify_cache_tracks_digest_expiry_and_invalidation() {
    let mut cache = VerifyCache::default();
    let start = Instant::now();
    let ttl = Duration::from_secs(60);

    assert!(!cache.is_valid("profile-a", "digest-1", start));
    cache.record("profile-a", "digest-1", start, ttl);
    assert!(cache.is_valid("profile-a", "digest-1", start + Duration::from_secs(30)));
    // Digest change misses immediately.
    assert!(!cache.is_valid("profile-a", "digest-2", start + Duration::from_secs(30)));
    // Expiry invalidates the entry.
    assert!(!cache.is_valid("profile-a", "digest-1", start + Duration::from_secs(60)));

    cache.record("profile-a", "digest-2", start, ttl);
    cache.record("profile-b", "digest-b", start, ttl);
    cache.invalidate_profile("profile-a");
    assert!(!cache.is_valid("profile-a", "digest-2", start));
    assert!(cache.is_valid("profile-b", "digest-b", start));
}

#[test]
fn client_read_only_policy_validation_and_tool_guard() {
    let valid = Policy {
        mode: Mode::ClientReadOnly,
        workspace: "/var/log/nginx".into(),
    };
    assert!(valid.validate().is_ok());
    assert!(valid.contains("/var/log/nginx"));
    assert!(valid.contains("/var/log/nginx/access.log"));
    assert!(!valid.contains("/var/log/other"));
    assert!(!valid.contains("/var/log/nginx/../shadow"));

    for invalid in ["", "var/log", "/var/log/", "/var/../etc", "/var/log\\bad"] {
        let bad = Policy {
            mode: Mode::ClientReadOnly,
            workspace: invalid.into(),
        };
        assert!(bad.validate().is_err(), "expected {invalid:?} to fail");
    }

    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("sandbox.sqlite")).unwrap();
    db.save_preferences(&[("ai.agentSandboxEnabled".into(), "true".into())])
        .unwrap();
    let binding = Binding {
        profile_id: "profile-l1".into(),
        state: ProfileSandbox {
            binding: "rev-1".into(),
            policy: Some(valid),
            host: "example.internal".into(),
            port: 22,
            username: "ops".into(),
            was_configured: true,
        },
        digest: "digest-1".into(),
    };
    for allowed in [
        "read_file",
        "list_directory",
        "search_text",
        "inspect_host",
        "inspect_service",
        "query_logs",
        "diagnose_endpoint",
    ] {
        assert!(
            guard_tool(&db, Some(&binding), allowed, &json!({})).is_ok(),
            "expected {allowed} to be allowed in L1 clientReadOnly"
        );
    }
    assert!(guard_tool(
        &db,
        Some(&binding),
        "transfer_file",
        &json!({"direction": "download"})
    )
    .is_ok());
    assert!(guard_tool(
        &db,
        Some(&binding),
        "transfer_file",
        &json!({"direction": "upload"})
    )
    .unwrap_err()
    .contains("SANDBOX_READ_ONLY"));
    for write_tool in ["write_file", "edit_file", "apply_patch"] {
        assert!(guard_tool(&db, Some(&binding), write_tool, &json!({}))
            .unwrap_err()
            .contains("SANDBOX_READ_ONLY"));
    }
    for shell_tool in ["run_terminal_command", "exec_command"] {
        assert!(guard_tool(&db, Some(&binding), shell_tool, &json!({}))
            .unwrap_err()
            .contains("SANDBOX_TOOL_UNAVAILABLE"));
    }
}

#[test]
fn bubblewrap_deployment_script_contains_subsystem_and_workspace() {
    let policy = Policy {
        mode: Mode::WorkspaceWrite,
        workspace: "/srv/shellspan-workspaces/staging".into(),
    };
    let script = deployment_script(&policy, Some("dnf install bubblewrap"));
    assert!(script.contains("dnf install bubblewrap"));
    assert!(script.contains("/srv/shellspan-workspaces/staging"));
    assert!(script.contains("Subsystem shellspan-bwrap-v1 /usr/local/libexec/shellspan-bwrap-v1"));
    assert!(script
        .contains("base64 -d <<'SHELLSPAN_BWRAP_EOF' > /usr/local/libexec/shellspan-bwrap-v1"));
    assert!(script.contains("SHELLSPAN_BWRAP_EOF"));
    assert!(script.contains("/var/lib/shellspan-sandbox/outside-probe"));
    assert!(script.contains("nodev,nosuid"));
}
