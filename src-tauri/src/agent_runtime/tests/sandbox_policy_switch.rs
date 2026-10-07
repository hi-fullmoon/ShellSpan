use super::*;

#[test]
fn policy_switch_serializes_unregistered_session_with_real_background_launch() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let sessions = SessionManager::default();
    let source = source(&sessions, "policy-source", workspace.path());
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let before = runtime.create_session(serde_json::from_value(json!({
        "sessionId":"policy-switch", "taskId":"policy-switch", "goal":"Run ordinary owned process",
        "target":{"kind":"local","targetId":"local","sessionId":"policy-source","cwd":workspace.path()},
        "sandboxPolicy":"host","executionSurface":"direct","permissionMode":"operator","successCriteria":["Owned process stops before read-only policy can apply"],
    })).unwrap()).unwrap();
    let engine = runtime.policy_test_engine();
    engine
        .configure_checkpoint_root(storage.path().to_path_buf())
        .unwrap();
    let database = Database::open(&storage.path().join("native.db")).unwrap();
    let credentials = CredentialManager::isolated_native_for_tests();
    let target = before.header.target.as_ref().unwrap();
    let contract = AgentSandboxContract::freeze(
        before.header.sandbox_policy,
        target,
        before.header.execution_surface,
        current_unix_ms(),
    )
    .unwrap()
    .bind_to_session(&before.header);
    let native_target = AgentToolTargetNative::Local {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        cwd: target.cwd.clone(),
    };
    let transition = runtime.policy_transition("policy-switch").unwrap();
    let guard = transition.lock().unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let other = runtime.clone();
    let rendezvous = barrier.clone();
    let switch = std::thread::spawn(move || {
        rendezvous.wait();
        other.set_sandbox_policy(
            "policy-switch",
            crate::agent_runtime::AgentSandboxPolicy::ReadOnly,
        )
    });
    barrier.wait();
    assert!(switch
        .join()
        .unwrap()
        .unwrap_err()
        .starts_with("SANDBOX_POLICY_BUSY:"));
    let provider = crate::ai::AiProviderConfig {
        id: "policy-admission-ollama".into(),
        profile: "ollama".into(),
        kind: crate::ai::AiProviderKind::Ollama,
        base_url: "http://127.0.0.1:11434".into(),
        model: "llama3.2:3b".into(),
        model_definition: None,
        retry_policy: None,
        reasoning_effort: None,
        requires_api_key: false,
        api_key: None,
    };
    let other = runtime.clone();
    let start = std::thread::spawn(move || other.start("policy-switch", provider, None));
    assert!(start
        .join()
        .unwrap()
        .unwrap_err()
        .starts_with("SANDBOX_POLICY_BUSY:"));
    assert_eq!(runtime.session("policy-switch").unwrap(),before,"A rejected start cannot register or append Agent state while policy transition owns the gate");
    let prepared = engine.prepare_authorization(NativeExecutionContext {
        sandbox_contract:Some(contract.clone()),request:AgentRequestNative {contract_version:NATIVE_TOOL_CONTRACT_VERSION,request_id:"request".into(),user_session_id:before.header.session_id.clone(),task_id:before.header.task_id.clone(),goal:before.header.goal.clone(),success_criteria:before.header.success_criteria.clone(),targets:vec![native_target.clone()],permission_mode:AgentPermissionModeNative::Operator},turn_id:"turn".into(),step_id:"step".into(),
    }, AgentAuthorizeCallRequestNative {request_id:"request".into(),call_id:"background".into(),tool_name:"exec_command".into(),target:native_target,ttl_ms:None,arguments:json!({"command":"sleep 30","explanation":"Ordinary owned background process","cwd":target.cwd,"channel":"direct","background":true,"timeoutMs":40000})}, &sessions,&database,&credentials,&storage.path().join("known_hosts")).unwrap();
    let grant = engine
        .issue_prepared_authorization(&prepared, false)
        .unwrap();
    let mut context = prepared.context.clone();
    context.sandbox_contract = grant.sandbox_contract;
    let mut call = prepared.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    let data = engine
        .execute_tool(
            &context,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap()
        .data
        .unwrap();
    let process = engine
        .acceptance_process(data["processHandle"].as_str().unwrap())
        .unwrap();
    drop(guard);
    assert!(runtime
        .set_sandbox_policy(
            "policy-switch",
            crate::agent_runtime::AgentSandboxPolicy::ReadOnly
        )
        .unwrap_err()
        .starts_with("SANDBOX_POLICY_BUSY:"));
    assert_eq!(
        runtime
            .session("policy-switch")
            .unwrap()
            .header
            .sandbox_policy,
        Some(crate::agent_runtime::AgentSandboxPolicy::Host)
    );
    assert_eq!(
        process.snapshot().unwrap().state,
        ProcessLifecycleNative::Running
    );
    engine
        .cancel_task(&before.header.task_id, &sessions)
        .unwrap();
    assert!(process.snapshot().unwrap().termination_confirmed);
    let after = runtime
        .set_sandbox_policy(
            "policy-switch",
            crate::agent_runtime::AgentSandboxPolicy::ReadOnly,
        )
        .unwrap();
    assert_eq!(after.header.permission_mode, before.header.permission_mode);
    assert!(after.header.sandbox_binding_revision > before.header.sandbox_binding_revision);
    assert!(contract
        .validate_session(&after.header, current_unix_ms())
        .is_err());
    assert_eq!(
        after.sandbox_capability.status,
        crate::agent_runtime::AgentSandboxCapabilityStatus::Partial
    );
    assert_eq!(source.writes.load(Ordering::SeqCst), 0);
}
