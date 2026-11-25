use super::*;
use crate::agent_runtime::{
    AgentActiveScope, AgentRecoveryCheckpointKind, AgentRecoveryStatus, AgentToolApprovalStatus,
    AgentToolExecutionStatus, AgentToolResultStatus, ModelToolCall, NativeToolServices,
    ToolPipelineSettlement,
};
use crate::models::{
    AuthMethod, ManagedSession, ProfileAuthMethod, ProfileRow, RemoteConnectionRequest,
    SessionCommandSender, SessionIdentity, SessionManager, SessionStatus, SessionTerminalKind,
    StatusEvent,
};
use serde_json::json;
use std::sync::atomic::AtomicBool;

const WORKSPACE: &str = "/srv/shellspan-workspaces/project";
const SESSION: &str = "sandbox-disconnect";
const TERMINAL: &str = "sandbox-disconnect-terminal";
const CALL: &str = "severed-command";

#[tokio::test]
#[ignore = "requires the disposable Linux SSH fixture and a loopback fault-injection proxy"]
async fn linux_bubblewrap_disconnect_reaches_session_recovery() {
    let port = std::env::var("SHELLSPAN_SANDBOX_DISCONNECT_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let output = std::env::var_os("SHELLSPAN_SANDBOX_DISCONNECT_RECORDING").unwrap();
    let root = tempfile::tempdir().unwrap();
    let (_keys, known_hosts_path) =
        crate::connection::trusted_known_hosts_fixture("127.0.0.1", port);
    let database = crate::db::Database::open(&root.path().join("profiles.db")).unwrap();
    let credentials = crate::keychain::CredentialManager::in_memory_for_tests();
    let profile = ProfileRow {
        id: SESSION.into(),
        name: "SSH disconnect fixture".into(),
        host: "127.0.0.1".into(),
        port,
        username: "sandbox".into(),
        auth_method: ProfileAuthMethod::Password,
        keychain_key_id: None,
        jump_host_config: None,
        organization_json: None,
        created_at: 1,
        updated_at: 1,
    };
    database.insert_profile(&profile).unwrap();
    database.set_agent_sandbox_enabled(true).unwrap();
    let saved = database.profile_sandbox(SESSION).unwrap();
    database
        .save_profile_sandbox(
            SESSION,
            &saved.binding,
            Some(crate::remote_sandbox::Policy {
                mode: crate::remote_sandbox::Mode::WorkspaceWrite,
                workspace: WORKSPACE.into(),
            }),
        )
        .unwrap();
    credentials
        .store_profile_password(SESSION, "shellspan-sandbox-e2e")
        .unwrap();

    // Keep the selected terminal on the real SSH server through a separate,
    // uncut transport. A terminal fallback would appear on its input queue.
    let direct_port = std::env::var("SHELLSPAN_SANDBOX_FIXTURE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let (_direct_keys, direct_known_hosts) =
        crate::connection::trusted_known_hosts_fixture("127.0.0.1", direct_port);
    let manual = crate::execution::open_ssh_execution_session(
        &RemoteConnectionRequest {
            host: profile.host.clone(),
            port: direct_port,
            username: profile.username.clone(),
            auth_method: AuthMethod::Password,
            password: credentials.retrieve_profile_password(SESSION).unwrap(),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        },
        &direct_known_hosts,
    )
    .unwrap();
    let mut shell = manual.target.channel_session().unwrap();
    shell.request_pty("xterm", None, None).unwrap();
    shell.shell().unwrap();
    let sessions = SessionManager::default();
    let (sender, input) = crossbeam_channel::unbounded();
    sessions
        .insert(
            TERMINAL.into(),
            ManagedSession {
                sender: SessionCommandSender::Event(sender),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: TERMINAL.into(),
                    status: SessionStatus::Connected,
                    message: None,
                },
                output_ready: Arc::new(AtomicBool::new(true)),
                output_paused: Arc::new(AtomicBool::new(false)),
                terminal_kind: SessionTerminalKind::Remote,
                identity: SessionIdentity {
                    title: profile.name,
                    host: profile.host,
                    port,
                    username: profile.username,
                },
            },
        )
        .unwrap();
    let engine = Arc::new(NativeToolEngine::default());
    let native = Arc::new(
        NativeToolAdapter::from_services(
            NativeToolServices {
                sessions,
                database,
                credentials,
                known_hosts_path,
                data_root: root.path().to_path_buf(),
            },
            engine.clone(),
        )
        .unwrap(),
    );
    let mut builder = AgentRuntimeBuilder::new().native_tool_runtime(native);
    builder.native_engine = engine;
    let runtime = builder.build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    runtime.set_event_publisher(Arc::new(|_| {})).unwrap();
    runtime.create_session(serde_json::from_value(json!({
        "sessionId": SESSION, "taskId": SESSION, "goal": "Verify a remote sandbox command interrupted by SSH disconnect",
        "permissionMode": "requestApproval", "executionSurface": "direct",
        "target": {"kind":"remote", "targetId":TERMINAL, "sessionId":TERMINAL,
            "profileId":SESSION, "host":"127.0.0.1", "port":port, "username":"sandbox", "rootPath":WORKSPACE},
    })).unwrap()).unwrap();
    // Use the real scheduler starting at its model-call boundary. The fixed
    // test command needs neither a model request nor a simulated model response.
    let provider: AiProviderConfig = serde_json::from_value(json!({
        "id":"sandbox-disconnect", "kind":"ollama", "profile":"ollama",
        "baseUrl":"http://127.0.0.1:1", "model":"qwen3:8b", "requiresApiKey":false,
    }))
    .unwrap();
    let adapter = runtime.models.resolve(provider.clone(), None).unwrap();
    let handle = runtime
        .agents
        .attach(runtime.sessions.clone(), SESSION.into(), provider, adapter)
        .unwrap();
    let entry = handle.entry();
    runtime
        .sessions
        .enqueue(
            SESSION,
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                message_id: "disconnect-input".into(),
                client_submission_id: None,
                content: "Run the isolated SSH disconnect witness".into(),
                source: AgentMessageSource::user(),
                images: Vec::new(),
                terminal_context: None,
            },
        )
        .unwrap();
    runtime
        .sessions
        .begin_turn_step(SESSION, "disconnect-turn".into(), "disconnect-step".into())
        .unwrap()
        .unwrap();
    entry
        .set_scope(Some(AgentActiveScope {
            turn_id: "disconnect-turn".into(),
            step_id: Some("disconnect-step".into()),
        }))
        .unwrap();
    entry.set_phase(AgentLifecyclePhase::Running).unwrap();
    let run = |request, call, command: &str| {
        runtime.tools.process_model_calls(
        &entry, "disconnect-turn", "disconnect-step", request, vec![ModelToolCall {
            call_id: call, provider_call_id: None, name: "run_terminal_command".into(),
            arguments: json!({"command":command,"explanation":"Observe the SSH disconnect boundary","timeoutMs":45000}),
        }])
    };
    let command = "printf '%s %s\\n' \"$$\" \"$(readlink /proc/self/ns/pid)\" >> disconnect-started; while [ ! -e disconnect-release ]; do sleep 0.2; done; printf '%s\\n' completed > disconnect-completed";
    assert_eq!(
        run("disconnect-request", CALL.into(), command)
            .await
            .unwrap(),
        ToolPipelineSettlement::Waiting
    );
    let approval = runtime
        .sessions
        .read_events(SESSION, |events| {
            events.iter().find_map(|event| {
                if let AgentSessionEventPayload::ToolApproval {
                    request_id,
                    call_id,
                    approval_id: Some(approval_id),
                    status: AgentToolApprovalStatus::Requested,
                    ..
                } = &event.payload
                {
                    Some(AgentToolDecisionInput {
                        session_id: SESSION.into(),
                        turn_id: event.turn_id.clone().unwrap(),
                        step_id: event.step_id.clone().unwrap(),
                        request_id: request_id.clone(),
                        call_id: call_id.clone(),
                        approval_id: approval_id.clone(),
                        reason: None,
                    })
                } else {
                    None
                }
            })
        })
        .unwrap()
        .unwrap();
    runtime
        .tools
        .decide(&entry, approval, AgentToolDecision::Approve)
        .await
        .unwrap();
    let snapshot = runtime.session(SESSION).unwrap();
    assert!(snapshot.uncertain_native_effects);
    assert_eq!(
        snapshot.recovery.kind,
        AgentRecoveryCheckpointKind::ExecutionInFlight
    );
    assert_eq!(snapshot.recovery.status, AgentRecoveryStatus::Required);
    assert_eq!(snapshot.recovery.call_id.as_deref(), Some(CALL));
    assert!(runtime.resume_recovery(SESSION).await.is_err());
    assert!(!runtime.tools.recover_waiting(&entry).unwrap());
    assert!(runtime
        .sessions
        .execution_observation_only(SESSION)
        .unwrap());
    run("replacement-request", "replacement-command".into(), command)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    let snapshot = runtime.session(SESSION).unwrap();
    let events = runtime.sessions.all_events(SESSION).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                &event.payload,
                AgentSessionEventPayload::ToolExecution {
                    status: AgentToolExecutionStatus::Dispatched,
                    ..
                }
            ))
            .count(),
        1
    );
    assert!(events.iter().any(
        |event| matches!(&event.payload, AgentSessionEventPayload::ToolResult {
        call_id, status: AgentToolResultStatus::Uncertain, summary, data: Some(data), ..
    } if call_id == CALL && summary.contains("SANDBOX_TERMINATION_UNCONFIRMED")
        && data["terminationConfirmed"] == false && data["doNotRetry"] == true)
    ));
    assert!(events.iter().any(
        |event| matches!(&event.payload, AgentSessionEventPayload::ToolResult {
        call_id, status: AgentToolResultStatus::Rejected, ..
    } if call_id == "replacement-command")
    ));
    assert!(
        input.try_recv().is_err(),
        "unexpected fallback to the terminal input queue"
    );
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        reopened.snapshot(SESSION).unwrap().recovery.status,
        AgentRecoveryStatus::Required
    );
    std::fs::write(
        output,
        serde_json::to_vec_pretty(&json!({ "snapshot": snapshot, "events": events })).unwrap(),
    )
    .unwrap();
}
