use super::*;
use crate::models::{
    ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, StatusEvent,
};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};

// A real authenticated SSH shell holds the source terminal open. The test does
// not mark a fabricated transport Connected or emulate remote execution.
fn connect_source(
    sessions: &SessionManager,
    connection: &crate::models::RemoteConnectionRequest,
    known_hosts: &Path,
) -> (std::thread::JoinHandle<()>, Arc<AtomicUsize>) {
    let ssh = crate::execution::open_ssh_execution_session(connection, known_hosts).unwrap();
    let mut channel = ssh.target.channel_session().unwrap();
    channel.shell().unwrap();
    let (sender, receiver) = mpsc::channel();
    sessions
        .insert(
            "phase4-source".into(),
            ManagedSession {
                sender: SessionCommandSender::Standard(sender),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: "phase4-source".into(),
                    status: SessionStatus::Connected,
                    message: None,
                },
                output_ready: Arc::new(AtomicBool::new(true)),
                output_paused: Arc::new(AtomicBool::new(false)),
                terminal_kind: SessionTerminalKind::Remote,
                identity: SessionIdentity {
                    title: "Phase 4 SSH fixture".into(),
                    host: connection.host.clone(),
                    port: connection.port,
                    username: connection.username.clone(),
                },
            },
        )
        .unwrap();
    let writes = Arc::new(AtomicUsize::new(0));
    let observed = writes.clone();
    let worker = std::thread::spawn(move || {
        while let Ok(command) = receiver.recv() {
            match command {
                SessionCommand::Write(input) => {
                    observed.fetch_add(1, Ordering::SeqCst);
                    channel.write_all(input.as_bytes()).unwrap();
                }
                SessionCommand::WriteBytes(bytes) => {
                    observed.fetch_add(1, Ordering::SeqCst);
                    channel.write_all(&bytes).unwrap();
                }
                SessionCommand::Close => break,
                SessionCommand::Resize { .. } => {}
            }
        }
        let _ = channel.send_eof();
        let _ = channel.close();
        drop(ssh);
    });
    (worker, writes)
}

#[test]
#[ignore = "requires explicit project-owned ordinary-permission SSH phase 4 fixture"]
fn remote_binding_real_ssh_reconnect_account_auth_jump_and_disconnect_invalidate_approval() {
    let connection = crate::execution::fixture::isolated_ssh_connection();
    let (_trust, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
    let temp = tempfile::tempdir().unwrap();
    let database = Database::open(&temp.path().join("fixture.db")).unwrap();
    let mut profile = crate::models::ProfileRow {
        id: "phase4-binding".into(),
        name: "Phase 4 fixture".into(),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
        auth_method: crate::models::ProfileAuthMethod::Password,
        keychain_key_id: None,
        jump_host_config: None,
        organization_json: None,
        created_at: 1,
        updated_at: 1,
    };
    database.insert_profile(&profile).unwrap();
    let target = AgentToolTargetNative::Remote {
        target_id: "phase4-target".into(),
        session_id: "phase4-source".into(),
        profile_id: Some(profile.id.clone()),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
        root_path: None,
        local_root: None,
    };
    let sessions = SessionManager::default();
    let (first, writes) = connect_source(&sessions, &connection, &known_hosts);
    let binding = RemoteExecutionBinding::capture(&target, &sessions, &database)
        .unwrap()
        .unwrap();
    binding.validate(&target, &sessions, &database).unwrap();
    // A status notification with the same state does not revoke an approval.
    sessions
        .set_status(
            "phase4-source",
            StatusEvent {
                session_id: "phase4-source".into(),
                status: SessionStatus::Connected,
                message: Some("ready".into()),
            },
        )
        .unwrap();
    binding.validate(&target, &sessions, &database).unwrap();
    sessions.close("phase4-source").unwrap();
    first.join().unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    assert!(binding.validate(&target, &sessions, &database).is_err());
    let (second, writes) = connect_source(&sessions, &connection, &known_hosts);
    assert!(
        binding.validate(&target, &sessions, &database).is_err(),
        "same identity reconnect must not revive approval"
    );
    let current = RemoteExecutionBinding::capture(&target, &sessions, &database)
        .unwrap()
        .unwrap();
    profile.username = "shellspan-sh".into();
    database.update_profile(&profile.id, &profile).unwrap();
    assert!(current.validate(&target, &sessions, &database).is_err());
    profile.username = connection.username.clone();
    database.update_profile(&profile.id, &profile).unwrap();
    assert!(
        current.validate(&target, &sessions, &database).is_err(),
        "restoring the original account and UI timestamp must not revive approval"
    );
    let current = RemoteExecutionBinding::capture(&target, &sessions, &database)
        .unwrap()
        .unwrap();
    profile.auth_method = crate::models::ProfileAuthMethod::Key;
    database.update_profile(&profile.id, &profile).unwrap();
    assert!(current.validate(&target, &sessions, &database).is_err());
    profile.auth_method = crate::models::ProfileAuthMethod::Password;
    database.update_profile(&profile.id, &profile).unwrap();
    assert!(
        current.validate(&target, &sessions, &database).is_err(),
        "restoring original authentication and timestamp must not revive approval"
    );
    let current = RemoteExecutionBinding::capture(&target, &sessions, &database)
        .unwrap()
        .unwrap();
    profile.keychain_key_id = Some("fixture-reference".into());
    database.update_profile(&profile.id, &profile).unwrap();
    assert!(current.validate(&target, &sessions, &database).is_err());
    profile.keychain_key_id = None;
    database.update_profile(&profile.id, &profile).unwrap();
    assert!(
        current.validate(&target, &sessions, &database).is_err(),
        "restoring credential reference must not revive approval"
    );
    let current = RemoteExecutionBinding::capture(&target, &sessions, &database)
        .unwrap()
        .unwrap();
    profile.jump_host_config = Some(serde_json::json!({"host":"127.0.0.1","port":22227,"username":"shellspan","authMethod":"password"}).to_string());
    database.update_profile(&profile.id, &profile).unwrap();
    assert!(current.validate(&target, &sessions, &database).is_err());
    let jump_binding = RemoteExecutionBinding::capture(&target, &sessions, &database)
        .unwrap()
        .unwrap();
    profile.jump_host_config = Some(serde_json::json!({"host":"127.0.0.1","port":22227,"username":"shellspan","authMethod":"password","keychainKeyId":"changed-jump-reference"}).to_string());
    database.update_profile(&profile.id, &profile).unwrap();
    assert!(
        jump_binding
            .validate(&target, &sessions, &database)
            .is_err(),
        "jump credential reference changes invalidate pending approval"
    );
    for field in ["password", "privateKeyData", "passphrase"] {
        let mut config = serde_json::json!({"host":"127.0.0.1","port":22227,"username":"shellspan","authMethod":"password"});
        config[field] = serde_json::Value::String("disposable-test-value".into());
        profile.jump_host_config = Some(config.to_string());
        database.update_profile(&profile.id, &profile).unwrap();
        assert!(
            RemoteExecutionBinding::capture(&target, &sessions, &database)
                .unwrap_err()
                .contains("inline secrets are not accepted")
        );
    }
    profile.jump_host_config = None;
    database.update_profile(&profile.id, &profile).unwrap();
    let before_delete = RemoteExecutionBinding::capture(&target, &sessions, &database)
        .unwrap()
        .unwrap();
    database.delete_profile(&profile.id).unwrap();
    assert!(before_delete
        .validate(&target, &sessions, &database)
        .is_err());
    database.insert_profile(&profile).unwrap();
    assert!(
        before_delete
            .validate(&target, &sessions, &database)
            .is_err(),
        "delete/reinsert of the identical profile must not revive approval"
    );
    let live = RemoteExecutionBinding::capture(&target, &sessions, &database)
        .unwrap()
        .unwrap();
    let reopened = Database::open(&temp.path().join("fixture.db")).unwrap();
    assert!(
        live.validate(&target, &sessions, &reopened).is_err(),
        "new native connection lifecycle must not restore old approval nonce"
    );
    sessions.close("phase4-source").unwrap();
    second.join().unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 0);
}

#[test]
#[ignore = "requires explicit project-owned ordinary-permission SSH phase 4 fixture"]
fn remote_host_real_native_approval_direct_cancel_and_residue_are_accurate() {
    use crate::agent_runtime::{
        AgentAuthorizeCallRequestNative, AgentExecutionSurface, AgentPermissionModeNative,
        AgentRequestNative, AgentSandboxContract, AgentSandboxPolicy, NativeExecutionContext,
        NativeToolEngine, ProcessSignalNative, NATIVE_TOOL_CONTRACT_VERSION,
    };
    use std::time::{Duration, Instant};
    let connection = crate::execution::fixture::isolated_ssh_connection();
    let (_trust, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
    let temp = tempfile::tempdir().unwrap();
    let database = Database::open(&temp.path().join("fixture.db")).unwrap();
    let credentials = crate::keychain::CredentialManager::in_memory_for_tests();
    credentials
        .store_profile_password("phase4-host", connection.password.as_deref().unwrap())
        .unwrap();
    database
        .insert_profile(&crate::models::ProfileRow {
            id: "phase4-host".into(),
            name: "Phase 4 host fixture".into(),
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            auth_method: crate::models::ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config: None,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();
    let sessions = SessionManager::default();
    let (source, writes) = connect_source(&sessions, &connection, &known_hosts);
    let target = AgentToolTargetNative::Remote {
        target_id: "phase4-target".into(),
        session_id: "phase4-source".into(),
        profile_id: Some("phase4-host".into()),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
        root_path: None,
        local_root: None,
    };
    let session_target = serde_json::from_value(serde_json::json!({"kind":"remote","targetId":"phase4-target","sessionId":"phase4-source",
        "profileId":"phase4-host","host":connection.host,"port":connection.port,"username":connection.username})).unwrap();
    let context = NativeExecutionContext {
        sandbox_contract: Some(
            AgentSandboxContract::freeze(
                Some(AgentSandboxPolicy::Host),
                &session_target,
                AgentExecutionSurface::Direct,
                0,
            )
            .unwrap(),
        ),
        request: AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: "phase4-request".into(),
            user_session_id: "phase4-agent".into(),
            task_id: "phase4-task".into(),
            goal: "Verify Host cancellation".into(),
            success_criteria: vec![
                "Report actual SSH cancellation and residual process facts".into()
            ],
            targets: vec![target.clone()],
            permission_mode: AgentPermissionModeNative::RequestApproval,
        },
        turn_id: "turn".into(),
        step_id: "step".into(),
    };
    let engine = NativeToolEngine::default();
    let prepared = engine.prepare_authorization(context.clone(), AgentAuthorizeCallRequestNative {
        request_id: "phase4-request".into(), call_id: "phase4-call".into(), tool_name: "exec_command".into(),
        arguments: serde_json::json!({"command":"printf '%s\\n' \"$$\"; exec sleep 4","explanation":"Observe a bounded fixture process after channel cancellation","channel":"direct","background":true,"timeoutMs":15000}),
        target, ttl_ms: None,
    }, &sessions, &database, &credentials, &known_hosts).unwrap();
    assert!(engine
        .issue_prepared_authorization(&prepared, false)
        .is_err());
    let grant = engine
        .issue_prepared_authorization(&prepared, true)
        .unwrap();
    let mut call = prepared.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    let result = engine
        .execute_tool(
            &context,
            call,
            &sessions,
            &database,
            &credentials,
            &known_hosts,
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    let data = result.data.unwrap();
    assert_eq!(data["sandboxPolicy"], "host");
    assert_eq!(data["sandboxBackend"], "host-account");
    assert_eq!(data["sandboxCapability"]["files"], false);
    assert_eq!(data["sandboxCapability"]["network"], false);
    let process = engine
        .acceptance_process(data["processHandle"].as_str().unwrap())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let pid = loop {
        let snapshot = process.snapshot().unwrap();
        if let Ok(pid) = snapshot.stdout.trim().parse::<u32>() {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "remote fixture did not produce its own PID"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    let cancelled = process
        .kill(ProcessSignalNative::Kill, Duration::from_secs(2))
        .unwrap();
    assert!(!cancelled.termination_confirmed);
    assert_eq!(
        cancelled.failure.unwrap().kind,
        crate::agent_runtime::AgentExecutionFailureKind::TerminationUnconfirmed
    );
    let ssh = crate::execution::open_ssh_execution_session(&connection, &known_hosts).unwrap();
    let mut channel = ssh.target.channel_session().unwrap();
    crate::execution::start_ssh_exec_channel(&mut channel, &format!("kill -0 {pid} 2>/dev/null"))
        .unwrap();
    channel.read_to_end(&mut Vec::new()).unwrap();
    channel.wait_close().unwrap();
    assert_eq!(
        channel.exit_status().unwrap(),
        0,
        "SSH channel close must not be treated as confirmed process cleanup"
    );
    // This fixture command has its own short natural deadline; no process or
    // server outside the disposable fixture is killed to perform this test.
    std::thread::sleep(Duration::from_secs(5));
    let mut channel = ssh.target.channel_session().unwrap();
    crate::execution::start_ssh_exec_channel(&mut channel, &format!("kill -0 {pid} 2>/dev/null"))
        .unwrap();
    channel.read_to_end(&mut Vec::new()).unwrap();
    channel.wait_close().unwrap();
    assert_ne!(
        channel.exit_status().unwrap(),
        0,
        "bounded fixture process must eventually exit"
    );
    sessions.close("phase4-source").unwrap();
    source.join().unwrap();
    assert_eq!(
        writes.load(Ordering::SeqCst),
        0,
        "Direct must not inject source SSH terminal input"
    );
}
