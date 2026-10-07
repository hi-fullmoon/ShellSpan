use super::super::super::{
    AgentAuthorizeCallRequestNative, AgentPermissionModeNative, AgentRequestNative,
    AgentToolCallNative, NativeExecutionContext, NativeToolEngine, NATIVE_TOOL_CONTRACT_VERSION,
};
use super::*;

fn context(fixture: &Fixture) -> NativeExecutionContext {
    NativeExecutionContext {
        sandbox_contract: Some(fixture.contract()),
        request: AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: "remote-engine-request".into(),
            user_session_id: fixture.header.session_id.clone(),
            task_id: fixture.header.task_id.clone(),
            goal: "Verify production signed remote native tools".into(),
            success_criteria: vec!["Real SSH operation under frozen remote policy".into()],
            targets: vec![super::super::super::remote_backend::validate_probe_target(
                &fixture.header,
                &fixture.sessions,
            )
            .unwrap()],
            permission_mode: AgentPermissionModeNative::RequestApproval,
        },
        turn_id: "turn".into(),
        step_id: "step".into(),
    }
}

#[test]
#[ignore = "explicit ordinary-account self-owned Mac SSH signed NativeToolEngine acceptance"]
fn remote_native_engine_signed_approval_and_reverification_never_revive_old_grants() {
    let fixture = Fixture::new();
    verify_header(
        &fixture.header,
        &fixture.sessions,
        &fixture.database,
        &fixture.credentials,
        &fixture.known_hosts,
        Some(fixture.admission.clone()),
    )
    .unwrap();
    let ctx = context(&fixture);
    let engine = NativeToolEngine::default();
    let prepare = |id: &str, command: &str| {
        engine.prepare_authorization(ctx.clone(),AgentAuthorizeCallRequestNative {
        request_id:ctx.request.request_id.clone(),call_id:id.into(),tool_name:"exec_command".into(),target:ctx.request.targets[0].clone(),ttl_ms:None,
        arguments:json!({"command":command,"explanation":"Real signed remote fixture request","channel":"direct","timeoutMs":8000}),
    },&fixture.sessions,&fixture.database,&fixture.credentials,&fixture.known_hosts).unwrap()
    };
    let first = prepare(
        "signed-call",
        "printf signed-result > signed-result; cat signed-result",
    );
    assert!(engine.issue_prepared_authorization(&first, false).is_err());
    let grant = engine.issue_prepared_authorization(&first, true).unwrap();
    let mut call = first.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    let result = engine
        .execute_tool(
            &ctx,
            call,
            &fixture.sessions,
            &fixture.database,
            &fixture.credentials,
            &fixture.known_hosts,
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    let data = result.data.unwrap();
    assert_eq!(data["stdout"], "signed-result");
    assert_eq!(data["sandboxBackend"], "remote-macos-seatbelt");
    assert_eq!(data["sandboxCapability"]["status"], "partial");
    assert_eq!(data["terminationConfirmed"], true);
    for tool in ["read_file", "write_file", "transfer_file", "probe_http"] {
        let error = engine
            .prepare_authorization(
                ctx.clone(),
                AgentAuthorizeCallRequestNative {
                    request_id: ctx.request.request_id.clone(),
                    call_id: "unsupported".into(),
                    tool_name: tool.into(),
                    target: ctx.request.targets[0].clone(),
                    ttl_ms: None,
                    arguments: json!({}),
                },
                &fixture.sessions,
                &fixture.database,
                &fixture.credentials,
                &fixture.known_hosts,
            )
            .unwrap_err();
        assert!(
            error.starts_with("sandboxToolUnsupported:"),
            "{tool}: {error}"
        );
    }
    let stale = prepare("stale-call", "printf forbidden > must-not-exist");
    let grant = engine.issue_prepared_authorization(&stale, true).unwrap();
    let mut stale_call: AgentToolCallNative = stale.call.clone();
    stale_call.capability_id = grant.capability_id;
    stale_call.arguments = grant.effective_arguments;
    let mut profile = fixture
        .database
        .get_profile("mac-profile")
        .unwrap()
        .unwrap();
    let original = profile.clone();
    profile.auth_method = ProfileAuthMethod::Password;
    fixture
        .database
        .update_profile(&profile.id, &profile)
        .unwrap();
    fixture
        .database
        .update_profile(&original.id, &original)
        .unwrap();
    assert!(capability(&fixture.header).is_none());
    assert!(engine.issue_prepared_authorization(&stale, true).is_err());
    verify_header(
        &fixture.header,
        &fixture.sessions,
        &fixture.database,
        &fixture.credentials,
        &fixture.known_hosts,
        Some(fixture.admission.clone()),
    )
    .unwrap();
    let error = engine
        .execute_tool(
            &ctx,
            stale_call,
            &fixture.sessions,
            &fixture.database,
            &fixture.credentials,
            &fixture.known_hosts,
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap_err();
    assert!(error.starts_with("sandboxAuthorizationInvalid:"),"old signed capability must stay invalid after original profile+timestamp are restored: {error}");
    let ssh = open_ssh_execution_session(&fixture.connection, &fixture.known_hosts).unwrap();
    let sftp = ssh.target.sftp().unwrap();
    assert!(sftp
        .stat(&fixture.directory.path().join("project/must-not-exist"))
        .is_err());
    let mut changed = ctx.clone();
    changed.request.targets[0] = AgentToolTargetNative::Remote {
        target_id: "different-target".into(),
        session_id: "mac-source".into(),
        profile_id: Some("mac-profile".into()),
        host: fixture.connection.host.clone(),
        port: fixture.connection.port,
        username: fixture.connection.username.clone(),
        root_path: fixture.header.target.as_ref().unwrap().root_path.clone(),
        local_root: None,
    };
    assert!(engine.prepare_authorization(changed,AgentAuthorizeCallRequestNative {request_id:ctx.request.request_id.clone(),call_id:"mismatch".into(),tool_name:"exec_command".into(),target:ctx.request.targets[0].clone(),ttl_ms:None,arguments:json!({"command":"true","explanation":"Reject mismatched frozen target","channel":"direct"})},&fixture.sessions,&fixture.database,&fixture.credentials,&fixture.known_hosts).unwrap_err().starts_with("sandboxAuthorizationInvalid:"));
    assert_eq!(fixture.writes.load(Ordering::SeqCst), 0);
}
