use super::*;

#[test]
fn external_ordinary_file_requires_read_approval_without_sibling_or_write_access() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let file = external.path().join("ordinary.txt");
    let sibling = external.path().join("other.txt");
    std::fs::write(&file, "external ordinary content\n").unwrap();
    std::fs::write(&sibling, "unapproved sibling\n").unwrap();
    let sessions = SessionManager::default();
    let source = source(&sessions, "external-read-source", workspace.path());
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let header = runtime.create_session(serde_json::from_value(json!({
        "sessionId":"external-read", "taskId":"external-read", "goal":"Read an explicitly approved ordinary file",
        "target":{"kind":"local","targetId":"local","sessionId":"external-read-source","cwd":workspace.path()},
        "sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"operator","successCriteria":["Only the approved file is readable"],
    })).unwrap()).unwrap().header;
    let target = header.target.as_ref().unwrap();
    let contract = AgentSandboxContract::freeze(
        header.sandbox_policy,
        target,
        AgentExecutionSurface::Direct,
        current_unix_ms(),
    )
    .unwrap()
    .bind_to_session(&header);
    let native_target = AgentToolTargetNative::Local {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        cwd: target.cwd.clone(),
    };
    let engine = NativeToolEngine::default();
    engine
        .configure_checkpoint_root(storage.path().to_path_buf())
        .unwrap();
    let database = Database::open(&storage.path().join("native.db")).unwrap();
    let credentials = CredentialManager::isolated_native_for_tests();
    let prepare = |command: String, paths: Vec<String>| {
        engine.prepare_authorization(NativeExecutionContext {
        sandbox_contract:Some(contract.clone()),
        request:AgentRequestNative {contract_version:NATIVE_TOOL_CONTRACT_VERSION,request_id:"request".into(),user_session_id:header.session_id.clone(),task_id:header.task_id.clone(),goal:header.goal.clone(),success_criteria:header.success_criteria.clone(),targets:vec![native_target.clone()],permission_mode:AgentPermissionModeNative::Operator},turn_id:"turn".into(),step_id:"step".into(),
    },AgentAuthorizeCallRequestNative {request_id:"request".into(),call_id:uuid::Uuid::new_v4().to_string(),tool_name:"exec_command".into(),target:native_target.clone(),ttl_ms:Some(5000),arguments:json!({"command":command,"explanation":"Read an approved ordinary file","channel":"direct","cwd":target.cwd,"readPaths":paths})},&sessions,&database,&credentials,&storage.path().join("known_hosts"))
    };
    let execute = |prepared: &PreparedAuthorizationNative, grant: AgentCapabilityGrantNative| {
        let mut context = prepared.context.clone();
        context.sandbox_contract = grant.sandbox_contract;
        let mut call = prepared.call.clone();
        call.capability_id = grant.capability_id;
        call.arguments = grant.effective_arguments;
        engine.execute_tool(
            &context,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
    };
    let unapproved = prepare(format!("cat {}", file.display()), vec![]).unwrap();
    assert_ne!(
        execute(
            &unapproved,
            engine
                .issue_prepared_authorization(&unapproved, false)
                .unwrap()
        )
        .unwrap()
        .data
        .unwrap()["exitCode"],
        0
    );
    let path = file.canonicalize().unwrap().to_string_lossy().into_owned();
    let approved = prepare(format!("cat {}", file.display()), vec![path.clone()]).unwrap();
    assert!(approved.requires_native_confirmation);
    assert!(engine
        .issue_prepared_authorization(&approved, false)
        .is_err());
    let result = execute(
        &approved,
        engine
            .issue_prepared_authorization(&approved, true)
            .unwrap(),
    )
    .unwrap()
    .data
    .unwrap();
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(result["stdout"], "external ordinary content\n");
    let read_sibling = prepare(format!("cat {}", sibling.display()), vec![path.clone()]).unwrap();
    assert_ne!(
        execute(
            &read_sibling,
            engine
                .issue_prepared_authorization(&read_sibling, true)
                .unwrap()
        )
        .unwrap()
        .data
        .unwrap()["exitCode"],
        0
    );
    let write = prepare(
        format!("printf changed > {}", file.display()),
        vec![path.clone()],
    )
    .unwrap();
    assert_ne!(
        execute(
            &write,
            engine.issue_prepared_authorization(&write, true).unwrap()
        )
        .unwrap()
        .data
        .unwrap()["exitCode"],
        0
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "external ordinary content\n"
    );
    assert!(prepare(
        "pwd".into(),
        vec![external.path().to_string_lossy().into_owned()]
    )
    .is_err());
    assert!(prepare(
        "pwd".into(),
        vec![storage
            .path()
            .join("native.db")
            .to_string_lossy()
            .into_owned()]
    )
    .is_err());
    let sensitive = external.path().join(".env.private");
    std::fs::write(&sensitive, "ordinary owned test value").unwrap();
    assert!(prepare("pwd".into(), vec![sensitive.to_string_lossy().into_owned()]).is_err());
    let private = external.path().join("ordinary-private.key");
    std::fs::write(&private, "owned non-credential test content").unwrap();
    assert!(prepare("pwd".into(), vec![private.to_string_lossy().into_owned()]).is_err());
    assert!(prepare(
        "pwd".into(),
        vec![std::env::home_dir().unwrap().to_string_lossy().into_owned()]
    )
    .is_err());
    let link = external.path().join("ordinary-link.txt");
    std::os::unix::fs::symlink(&file, &link).unwrap();
    assert!(prepare("pwd".into(), vec![link.to_string_lossy().into_owned()]).is_err());
    assert_eq!(
        engine
            .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
            .unwrap()
            .state,
        "none",
        "Once approval must not create session authorization"
    );
    let session = prepare(format!("cat {}", file.display()), vec![path.clone()]).unwrap();
    assert!(session.requires_native_confirmation);
    let grant = engine
        .issue_prepared_authorization_scoped(
            &session,
            true,
            crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session,
        )
        .unwrap();
    assert_eq!(
        execute(&session, grant).unwrap().data.unwrap()["exitCode"],
        0
    );
    let repeated = prepare(format!("cat {}", file.display()), vec![path.clone()]).unwrap();
    assert!(!repeated.requires_native_confirmation);
    let previous = engine
        .issue_prepared_authorization(&repeated, false)
        .unwrap();
    let status = engine
        .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
        .unwrap();
    assert_eq!(status.read_paths, vec![path.clone()]);
    assert!(status.expires_at_unix_ms.unwrap() > status.checked_at_unix_ms);
    let unrelated = prepare(
        format!("cat {}", sibling.display()),
        vec![sibling
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()],
    )
    .unwrap();
    assert!(
        unrelated.requires_native_confirmation,
        "Session approval does not cover a sibling file"
    );
    assert!(engine
        .issue_prepared_authorization(&unrelated, false)
        .is_err());
    engine.cancel_task(&header.task_id, &sessions).unwrap();
    assert!(
        execute(&repeated, previous).is_err(),
        "Revocation invalidates already-issued session reuse tokens"
    );
    assert_eq!(
        engine
            .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
            .unwrap()
            .state,
        "none"
    );
    assert!(
        prepare(format!("cat {}", file.display()), vec![path])
            .unwrap()
            .requires_native_confirmation
    );
    assert_eq!(source.writes.load(Ordering::SeqCst), 0);
    engine.cancel_task(&header.task_id, &sessions).unwrap();
}
