use super::*;

#[test]
fn default_configuration_persists_in_real_preferences_without_native_authority() {
    let storage = tempfile::tempdir().unwrap();
    let path = storage.path().join("preferences.db");
    let database = Database::open(&path).unwrap();
    let configuration = json!({"version":1,"defaults":{"project-owned":{"policy":"readOnly","cacheDirectories":[]}}});
    database
        .save_preferences(&[("agent_sandbox_defaults".into(), configuration.to_string())])
        .unwrap();
    drop(database);
    let recovered = Database::open(&path).unwrap();
    let entries = recovered.load_preferences().unwrap();
    let serialized = entries
        .iter()
        .find(|(key, _)| key == "agent_sandbox_defaults")
        .unwrap()
        .1
        .clone();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&serialized).unwrap(),
        configuration
    );
    assert!(
        !serialized.contains("resourceGrants")
            && !serialized.contains("capabilityId")
            && !serialized.contains("authorizationId")
    );
}

#[test]
fn resource_audit_records_actual_once_session_expiry_and_revocation_without_bearers() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let cache = cache.path().canonicalize().unwrap();
    let sessions = SessionManager::default();
    let source = source(&sessions, "audit-source", workspace.path());
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let snapshot = runtime.create_session(serde_json::from_value(json!({
        "sessionId":"resource-audit","taskId":"resource-audit","goal":"Write owned cache after explicit approval","target":{"kind":"local","targetId":"local","sessionId":"audit-source","cwd":workspace.path()},"sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"operator","successCriteria":["Actual cache file exists and audit contains scope and expiry"],
    })).unwrap()).unwrap();
    let header = snapshot.header;
    let target = header.target.as_ref().unwrap();
    let base = AgentSandboxContract::freeze(
        header.sandbox_policy,
        target,
        header.execution_surface,
        current_unix_ms(),
    )
    .unwrap()
    .bind_to_session(&header);
    let engine = runtime.policy_test_engine();
    engine
        .configure_checkpoint_root(storage.path().to_path_buf())
        .unwrap();
    let database = Database::open(&storage.path().join("native.db")).unwrap();
    let credentials = CredentialManager::isolated_native_for_tests();
    for scope in [
        crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Once,
        crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session,
    ] {
        let id = uuid::Uuid::new_v4().to_string();
        let native_target = AgentToolTargetNative::Local {
            target_id: target.target_id.clone(),
            session_id: target.session_id.clone(),
            cwd: target.cwd.clone(),
        };
        let prepared=engine.prepare_authorization(NativeExecutionContext {sandbox_contract:Some(base.clone()),request:AgentRequestNative {contract_version:NATIVE_TOOL_CONTRACT_VERSION,request_id:"request".into(),user_session_id:header.session_id.clone(),task_id:header.task_id.clone(),goal:header.goal.clone(),success_criteria:header.success_criteria.clone(),targets:vec![native_target.clone()],permission_mode:AgentPermissionModeNative::Operator},turn_id:"turn".into(),step_id:"step".into()},AgentAuthorizeCallRequestNative {request_id:"request".into(),call_id:id.clone(),tool_name:"exec_command".into(),arguments:json!({"command":format!("touch {}",cache.join("actual.txt").display()),"explanation":"Actual cache write","channel":"direct","cwd":target.cwd,"writePaths":[cache]}),target:native_target,ttl_ms:None},&sessions,&database,&credentials,&storage.path().join("known_hosts")).unwrap();
        let grant = engine
            .issue_prepared_authorization_scoped(&prepared, true, scope)
            .unwrap();
        let contract = grant.sandbox_contract.as_ref().unwrap();
        let expiry = if scope
            == crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session
        {
            engine
                .sandbox_authorizations(&header.session_id, &header.task_id, &base)
                .unwrap()
                .expires_at_unix_ms
        } else {
            None
        };
        runtime
            .record_sandbox_authorization(
                &header.session_id,
                "turn",
                "step",
                &id,
                contract,
                scope,
                true,
                expiry,
            )
            .unwrap();
        let mut context = prepared.context.clone();
        context.sandbox_contract = grant.sandbox_contract;
        let mut call = prepared.call.clone();
        call.capability_id = grant.capability_id;
        call.arguments = grant.effective_arguments;
        assert_eq!(
            engine
                .execute_tool(
                    &context,
                    call,
                    &sessions,
                    &database,
                    &credentials,
                    &storage.path().join("known_hosts"),
                    &tokio_util::sync::CancellationToken::new()
                )
                .unwrap()
                .data
                .unwrap()["exitCode"],
            0
        );
    }
    assert!(cache.join("actual.txt").exists());
    tauri::async_runtime::block_on(runtime.revoke_sandbox_reads(&header.session_id, &sessions))
        .unwrap();
    let page = runtime
        .events(crate::agent_runtime::AgentSessionEventsRequest {
            session_id: header.session_id.clone(),
            cursor: None,
            limit: 256,
        })
        .unwrap();
    let audits = page
        .events
        .iter()
        .filter_map(|event| {
            if let crate::agent_runtime::AgentSessionEventPayload::SandboxResourceAudit {
                audit,
                ..
            } = &event.payload
            {
                Some(audit)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(audits.len(), 3);
    assert_eq!(
        audits[0].scope,
        Some(crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Once)
    );
    assert_eq!(
        audits[1].scope,
        Some(crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session)
    );
    assert!(
        audits[1].session_expires_at_unix_ms.unwrap() > audits[1].call_expires_at_unix_ms.unwrap()
    );
    assert_eq!(audits[2].cleanup_confirmed, Some(true));
    let bytes = serde_json::to_string(&audits).unwrap();
    assert!(!bytes.contains("capabilityId") && !bytes.contains("authorizationId"));
    assert_eq!(
        engine
            .sandbox_authorizations(&header.session_id, &header.task_id, &base)
            .unwrap()
            .state,
        "none"
    );
    assert_eq!(source.writes.load(Ordering::SeqCst), 0);
    // A real journal write failure must revoke an issued token and stop existing
    // task processes, even before the newly approved command can be dispatched.
    let native_target = AgentToolTargetNative::Local {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        cwd: target.cwd.clone(),
    };
    let prepare = |command: &str, writes: Vec<std::path::PathBuf>, background: bool| {
        engine.prepare_authorization(NativeExecutionContext {
        sandbox_contract:Some(base.clone()),request:AgentRequestNative {contract_version:NATIVE_TOOL_CONTRACT_VERSION,request_id:"audit-failure".into(),user_session_id:header.session_id.clone(),task_id:header.task_id.clone(),goal:header.goal.clone(),success_criteria:header.success_criteria.clone(),targets:vec![native_target.clone()],permission_mode:AgentPermissionModeNative::Operator},turn_id:"turn".into(),step_id:"step".into(),
    },AgentAuthorizeCallRequestNative {request_id:"audit-failure".into(),call_id:uuid::Uuid::new_v4().to_string(),tool_name:"exec_command".into(),target:native_target.clone(),ttl_ms:None,arguments:json!({"command":command,"explanation":"Actual owned process and audit failure cleanup","channel":"direct","cwd":target.cwd,"background":background,"writePaths":writes})},&sessions,&database,&credentials,&storage.path().join("known_hosts"))
    };
    let background = prepare("sleep 30", vec![], true).unwrap();
    let grant = engine
        .issue_prepared_authorization(&background, false)
        .unwrap();
    let mut context = background.context.clone();
    context.sandbox_contract = grant.sandbox_contract;
    let mut call = background.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    engine
        .execute_tool(
            &context,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    assert!(engine.has_task_processes(&header.task_id).unwrap());
    let marker = cache.join("must-not-run.txt");
    let pending = prepare(
        &format!("touch {}", marker.display()),
        vec![cache.clone()],
        false,
    )
    .unwrap();
    let grant = engine
        .issue_prepared_authorization_scoped(
            &pending,
            true,
            crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session,
        )
        .unwrap();
    let log = storage
        .path()
        .join("agent-runtime/sessions-v5/resource-audit.jsonl");
    let original = std::fs::metadata(&log).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&log, readonly).unwrap();
    let failure = runtime
        .record_sandbox_authorization(
            &header.session_id,
            "turn",
            "step",
            &pending.call.call_id,
            grant.sandbox_contract.as_ref().unwrap(),
            crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session,
            true,
            None,
        )
        .unwrap_err();
    let diagnostic = runtime.rollback_sandbox_audit(
        &header.session_id,
        &header.task_id,
        &sessions,
        failure.clone(),
    );
    std::fs::set_permissions(&log, original).unwrap();
    assert!(diagnostic.contains(&failure));
    assert!(!engine.has_task_processes(&header.task_id).unwrap());
    assert_eq!(
        engine
            .sandbox_authorizations(&header.session_id, &header.task_id, &base)
            .unwrap()
            .state,
        "none"
    );
    let mut context = pending.context.clone();
    context.sandbox_contract = grant.sandbox_contract;
    let mut call = pending.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    assert!(engine
        .execute_tool(
            &context,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new()
        )
        .is_err());
    assert!(!marker.exists());
}

#[test]
fn configured_cache_candidates_persist_as_header_data_without_live_authority() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    runtime.create_session(serde_json::from_value(json!({"sessionId":"cache-config","taskId":"cache-config","goal":"Keep explicit project configuration","target":{"kind":"local","targetId":"local","sessionId":"source","cwd":workspace.path()},"sandboxPolicy":"readOnly","executionSurface":"direct","permissionMode":"requestApproval","successCriteria":["Configuration is not authority"]})).unwrap()).unwrap();
    let paths = vec![cache
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned()];
    let snapshot = runtime
        .set_cache_directory_candidates("cache-config", paths.clone())
        .unwrap();
    assert_eq!(snapshot.header.cache_directory_candidates, paths);
    assert!(runtime
        .set_cache_directory_candidates("cache-config", vec!["relative/cache".into()])
        .is_err());
    let restored = AgentRuntimeBuilder::new().build();
    restored.configure(storage.path().to_path_buf()).unwrap();
    let header = restored.session("cache-config").unwrap().header;
    assert_eq!(header.cache_directory_candidates, paths);
    assert_eq!(
        header.sandbox_policy,
        Some(crate::agent_runtime::AgentSandboxPolicy::ReadOnly)
    );
    let contract = AgentSandboxContract::freeze(
        header.sandbox_policy,
        header.target.as_ref().unwrap(),
        header.execution_surface,
        current_unix_ms(),
    )
    .unwrap()
    .bind_to_session(&header);
    assert!(contract.resource_grants.is_empty());
    assert_eq!(
        restored
            .policy_test_engine()
            .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
            .unwrap()
            .state,
        "none"
    );
}
