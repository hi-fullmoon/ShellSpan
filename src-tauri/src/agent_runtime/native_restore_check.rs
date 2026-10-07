//! Two independent real Wry processes recover the same production data, without a model.
use super::*;
use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const WORKSPACE: &str = "restore-workspace";
const READONLY: &str = "restore-readonly";
const CONTENT: &str = "ordinary-owned-restoration-resource\n";

pub(super) fn run(root: &Path, reopen: bool) -> Result<(), String> {
    if !root.is_absolute() || !root.is_dir() {
        return Err("Restore requires an absolute fixture directory".into());
    }
    if reopen {
        let seed: Value = serde_json::from_slice(
            &std::fs::read(root.join("restore-seed.json"))
                .map_err(|_| "Seed report unavailable")?,
        )
        .map_err(|_| "Seed report invalid")?;
        if seed["passed"] != true {
            return Err("Restore seed did not pass".into());
        }
        let pid = seed["pid"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or("Seed PID missing")?;
        if sysinfo::System::new_all()
            .process(sysinfo::Pid::from_u32(pid))
            .is_some()
        {
            return Err("Original seed process is still alive; do not reopen".into());
        }
    } else if std::fs::read_dir(root)
        .map_err(|_| "Restore root unavailable")?
        .next()
        .is_some()
    {
        return Err("Restore seed requires a new empty fixture directory".into());
    }
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.shellspan.native-restore-check".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.join("state")),
    );
    let check_root = root.to_owned();
    let saved_root = root.to_owned();
    let event_root = root.to_owned();
    let name = if reopen {
        "restore-reopen"
    } else {
        "restore-seed"
    };
    let mut events = Vec::new();
    let app=tauri::Builder::default().manage(ContainerResourceSupervisor::default()).setup(move |app| {
        let handle=app.handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let outcome=tauri::async_runtime::block_on(async {
                let result=std::panic::AssertUnwindSafe(check(&handle,&check_root,reopen)).catch_unwind().await
                    .unwrap_or_else(|_|Err("Restore acceptance panicked before completion".into()));
                if result.as_ref().map_or(true,|report|report["passed"]!=true) {
                    if let (Some(runtime),Some(sessions))=(handle.try_state::<AgentRuntime>(),handle.try_state::<SessionManager>()) {let _=runtime.shutdown(&sessions).await;}
                }
                result
            });
            let report=match outcome {Ok(report)=>report,Err(error)=>json!({"passed":false,"mode":name,"pid":std::process::id(),"error":crate::redaction::redact_sensitive_text(&error)})};
            let pending=check_root.join(format!("{name}.pending.json"));
            let saved=serde_json::to_vec_pretty(&report).map_err(|error|error.to_string()).and_then(|data|std::fs::write(&pending,data).and_then(|_|std::fs::rename(&pending,check_root.join(format!("{name}.json")))).map_err(|error|error.to_string()));
            handle.exit(if report["passed"]==true && saved.is_ok() {0}else{1});
        });Ok(())
    }).build(context).map_err(|_|"Restore Wry app unavailable")?;
    let code=app.run_return(move |app,event| {
        if matches!(&event,tauri::RunEvent::ExitRequested {..}|tauri::RunEvent::Exit) {
            events.push(json!({"event":if matches!(&event,tauri::RunEvent::Exit){"exit"}else{"exitRequested"},"pid":std::process::id()}));
            let _=std::fs::write(event_root.join(format!("{name}-events.json")),serde_json::to_vec(&events).unwrap_or_default());
        }
        crate::app_exit::handle_event(app,event);
    });
    let started = Instant::now();
    let path = saved_root.join(format!("{name}.json"));
    while !path.is_file() {
        if started.elapsed() > Duration::from_secs(5) {
            return Err("Restore report writer did not finish after real App Exit".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let report: Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "Restore report unavailable")?)
            .map_err(|_| "Restore report invalid")?;
    if code != 0 || report["passed"] != true {
        return Err("Real Wry restore acceptance failed; inspect isolated report".into());
    }
    Ok(())
}

fn read_request(
    header: &AgentSessionHeader,
    id: &str,
    path: &Path,
) -> Result<NativeToolRequest, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Owned resource file name unavailable")?;
    let mut request =
        super::shutdown_check::request(header, id, &format!("cat {name}"), false, json!([]))?;
    request.model_call.arguments["readPaths"] = json!([path
        .canonicalize()
        .map_err(|_| "Owned resource path unavailable")?]);
    Ok(request)
}

fn read_result(result: NativeToolResult) -> Result<(), String> {
    let data = result.data.ok_or("Actual read result missing")?;
    if data["stdout"] != CONTENT
        || data["exitCode"] != 0
        || data["sandboxBackend"] != "macos-seatbelt"
    {
        return Err("Owned resource read did not match actual file".into());
    }
    Ok(())
}

async fn check(app: &tauri::AppHandle, root: &Path, reopen: bool) -> Result<Value, String> {
    let project = root.join("project");
    if !reopen {
        std::fs::create_dir(&project).map_err(|_| "Restore project unavailable")?;
        for name in [".env.once", ".env.session"] {
            std::fs::write(project.join(name), CONTENT)
                .map_err(|_| "Owned resource unavailable")?;
        }
        std::fs::create_dir(root.join("cache")).map_err(|_| "Owned cache unavailable")?;
    }
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(
        app.path()
            .app_data_dir()
            .map_err(|_| "Restore app data unavailable")?,
    )?;
    let database = Database::open(&root.join("state/restore.db"))?;
    let credentials = CredentialManager::isolated_native_for_checks();
    let sessions = SessionManager::default();
    let source = super::source(&sessions, &project)?;
    app.manage(database.clone());
    app.manage(credentials.clone());
    app.manage(sessions.clone());
    app.manage(runtime.clone());
    runtime.configure_native(app.clone())?;
    let preflight = super::super::commands::agent_runtime_probe_native_sandbox().await?;
    if preflight.status != AgentSandboxCapabilityStatus::Partial
        || !preflight.files
        || !preflight.network
    {
        return Err("Real native sandbox startup probe did not verify the local backend".into());
    }
    let native = runtime.acceptance_native_runtime()?;
    let engine = runtime.acceptance_native_engine();
    if !reopen {
        for (id, policy) in [(WORKSPACE, "workspace"), (READONLY, "readOnly")] {
            runtime.create_session(serde_json::from_value(json!({"sessionId":id,"taskId":id,"goal":"Recover actual policies and authorities after process restart",
                "target":{"kind":"local","targetId":"restore-local","sessionId":"acceptance-source","cwd":project},
                "sandboxPolicy":policy,"executionSurface":"direct","permissionMode":"requestApproval","successCriteria":["No old authority or marker replay"]})).map_err(|_|"Restore seed schema invalid")?)?;
        }
    }
    let workspace = runtime.session(WORKSPACE)?;
    let readonly = runtime.session(READONLY)?;
    native.prepare_sandbox(&workspace.header)?;
    native.prepare_sandbox(&readonly.header)?;
    let preference_scope = format!(
        "project:{}",
        serde_json::to_string(
            &project
                .canonicalize()
                .map_err(|_| "Restore project canonical path unavailable")?
        )
        .map_err(|_| "Restore preference scope unavailable")?
    );
    let mut checks = serde_json::Map::new();
    checks.insert(
        "workspaceIntent".into(),
        json!(workspace.header.sandbox_policy == Some(AgentSandboxPolicy::Workspace)),
    );
    checks.insert(
        "readonlyIntent".into(),
        json!(readonly.header.sandbox_policy == Some(AgentSandboxPolicy::ReadOnly)),
    );
    if reopen {
        let seed: Value = serde_json::from_slice(
            &std::fs::read(root.join("restore-seed.json")).map_err(|_| "Seed baseline missing")?,
        )
        .map_err(|_| "Seed baseline invalid")?;
        checks.insert(
            "sameFrozenSessionIdentity".into(),
            json!(
                workspace.header.created_at_unix_ms
                    == seed["workspaceCreatedAt"].as_u64().unwrap_or(0)
                    && readonly.header.created_at_unix_ms
                        == seed["readonlyCreatedAt"].as_u64().unwrap_or(0)
                    && workspace.header.sandbox_binding_revision
                        == seed["workspaceBinding"].as_u64().unwrap_or(u64::MAX)
                    && readonly.header.sandbox_binding_revision
                        == seed["readonlyBinding"].as_u64().unwrap_or(u64::MAX)
            ),
        );
        checks.insert(
            "queuedInputRestoredPaused".into(),
            json!(
                workspace
                    .inbox
                    .next_turn
                    .iter()
                    .any(|message| message.message_id == "restore-queued-input")
                    && workspace
                        .inbox
                        .paused_ids
                        .contains(&"restore-queued-input".into())
            ),
        );
        let status = runtime.sandbox_authorizations(READONLY)?;
        checks.insert(
            "sessionAuthorityNotRestored".into(),
            json!(
                status.read_paths.is_empty()
                    && status.write_paths.is_empty()
                    && status.network_targets.is_empty()
                    && status.local_services.is_empty()
            ),
        );
        let audit = runtime.events(AgentSessionEventsRequest {
            session_id: READONLY.into(),
            cursor: None,
            limit: 1000,
        })?;
        checks.insert(
            "realAuditJournalRecovered".into(),
            json!(
                audit
                    .events
                    .iter()
                    .filter(|event| matches!(
                        event.payload,
                        AgentSessionEventPayload::SandboxResourceAudit { .. }
                    ))
                    .count()
                    >= 2
            ),
        );
        let preferences = database.load_preferences()?;
        let stored = preferences
            .iter()
            .find(|(key, _)| key == "agent_sandbox_defaults")
            .ok_or("Real saved preference missing")?;
        let defaults: Value =
            serde_json::from_str(&stored.1).map_err(|_| "Saved preference invalid")?;
        let configuration = &defaults["defaults"][&preference_scope];
        checks.insert(
            "realNonAuthorityConfigurationRecovered".into(),
            json!(
                defaults["version"] == 1
                    && configuration["policy"] == "workspace"
                    && configuration["cacheDirectories"]
                        .as_array()
                        .is_some_and(|paths| paths.len() == 1)
                    && configuration.get("resourceGrants").is_none()
                    && configuration.get("capabilityId").is_none()
            ),
        );
        checks.insert(
            "noOriginalMarkerReplay".into(),
            json!(
                std::fs::read_to_string(project.join("restore-background-marker"))
                    .ok()
                    .as_deref()
                    == Some("seed-started")
                    && !project.join("forbidden-old-prepared").exists()
                    && !project.join("forbidden-old-signed").exists()
            ),
        );
        checks.insert(
            "noOldRunningNativeProcess".into(),
            json!(!engine.has_task_processes(WORKSPACE)? && !engine.has_task_processes(READONLY)?),
        );
        for (id, name) in [
            ("new-once-denied", ".env.once"),
            ("new-session-denied", ".env.session"),
        ] {
            let pending =
                native.prepare(read_request(&readonly.header, id, &project.join(name))?)?;
            checks.insert(
                format!("{id}-requiresApproval"),
                json!(pending.requires_approval),
            );
            checks.insert(
                format!("{id}-notAuthorized"),
                json!(native
                    .execute(&pending.token, false, CancellationToken::new())
                    .is_err()),
            );
        }
        let approved = native.prepare(read_request(
            &readonly.header,
            "fresh-explicit-read",
            &project.join(".env.session"),
        )?)?;
        read_result(native.execute_scoped(
            &approved.token,
            true,
            CancellationToken::new(),
            sandbox_authorization::ResourceAuthorizationScope::Once,
        )?)?;
        checks.insert("newExplicitReadSucceeds".into(), json!(true));
        let continued = native.prepare(super::shutdown_check::request(
            &workspace.header,
            "new-explicit-work",
            "printf fresh > explicit-new-request-marker",
            false,
            json!([]),
        )?)?;
        let result = native.execute(&continued.token, true, CancellationToken::new())?;
        checks.insert(
            "newExplicitWorkspaceRequestSucceeds".into(),
            json!(
                result.data.as_ref().is_some_and(
                    |data| data["sandboxBackend"] == "macos-seatbelt" && data["exitCode"] == 0
                ) && std::fs::read_to_string(project.join("explicit-new-request-marker"))
                    .ok()
                    .as_deref()
                    == Some("fresh")
            ),
        );
        let _ = runtime.shutdown(&sessions).await?;
    } else {
        let once = native.prepare(read_request(
            &readonly.header,
            "seed-once",
            &project.join(".env.once"),
        )?)?;
        read_result(native.execute_scoped(
            &once.token,
            true,
            CancellationToken::new(),
            sandbox_authorization::ResourceAuthorizationScope::Once,
        )?)?;
        let session = native.prepare(read_request(
            &readonly.header,
            "seed-session",
            &project.join(".env.session"),
        )?)?;
        read_result(native.execute_scoped(
            &session.token,
            true,
            CancellationToken::new(),
            sandbox_authorization::ResourceAuthorizationScope::Session,
        )?)?;
        checks.insert("actualOnceAndSessionReads".into(), json!(true));
        let expected = project
            .join(".env.session")
            .canonicalize()
            .map_err(|_| "Owned resource unavailable")?
            .to_string_lossy()
            .to_string();
        checks.insert(
            "sessionAuthorityLiveBeforeExit".into(),
            json!(runtime.sandbox_authorizations(READONLY)?.read_paths == vec![expected]),
        );
        let mut defaults = serde_json::Map::new();
        defaults.insert(
            preference_scope.clone(),
            json!({"policy":"workspace","cacheDirectories":[root.join("cache")]}),
        );
        database.save_preferences(&[(
            "agent_sandbox_defaults".into(),
            json!({"version":1,"defaults":defaults}).to_string(),
        )])?;
        let queued = runtime.receive_submission(
            WORKSPACE,
            "restore-queued-input".into(),
            "restore-queued-input".into(),
            "Inspect the owned recovery marker after explicit continuation".into(),
            None,
            AgentInboxLane::NextTurn,
            false,
            None,
        )?;
        checks.insert(
            "realUnpausedInputSeeded".into(),
            json!(
                queued
                    .inbox
                    .next_turn
                    .iter()
                    .any(|message| message.message_id == "restore-queued-input")
                    && !queued
                        .inbox
                        .paused_ids
                        .contains(&"restore-queued-input".into())
            ),
        );
        let background=native.prepare(super::shutdown_check::request(&workspace.header,"seed-background","printf seed-started > restore-background-marker; sleep 30; printf seed-finished >> restore-background-marker",true,json!([]))?)?;
        let result = native.execute(&background.token, true, CancellationToken::new())?;
        let handle = result
            .data
            .as_ref()
            .and_then(|data| data["processHandle"].as_str())
            .ok_or("Actual restore background handle missing")?;
        let process = runtime.acceptance_process(handle)?;
        let began = Instant::now();
        while std::fs::read_to_string(project.join("restore-background-marker"))
            .ok()
            .as_deref()
            != Some("seed-started")
        {
            if began.elapsed() > Duration::from_secs(5) {
                return Err("Real seed background did not start".into());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let old_prepared = native.prepare(super::shutdown_check::request(
            &workspace.header,
            "old-prepared",
            "printf forbidden > forbidden-old-prepared",
            false,
            json!([]),
        )?)?;
        let target = workspace
            .header
            .target
            .as_ref()
            .ok_or("Workspace target missing")?;
        let native_target = AgentToolTargetNative::Local {
            target_id: target.target_id.clone(),
            session_id: target.session_id.clone(),
            cwd: target.cwd.clone(),
        };
        let context = NativeExecutionContext {
            sandbox_contract: Some(
                AgentSandboxContract::freeze(
                    workspace.header.sandbox_policy,
                    target,
                    workspace.header.execution_surface,
                    super::super::driver::current_unix_ms()?,
                )?
                .bind_to_session(&workspace.header),
            ),
            request: AgentRequestNative {
                contract_version: NATIVE_TOOL_CONTRACT_VERSION,
                request_id: "old-signed".into(),
                user_session_id: WORKSPACE.into(),
                task_id: WORKSPACE.into(),
                goal: workspace.header.goal.clone(),
                success_criteria: workspace.header.success_criteria.clone(),
                targets: vec![native_target.clone()],
                permission_mode: AgentPermissionModeNative::RequestApproval,
            },
            turn_id: "restore-turn".into(),
            step_id: "old-signed".into(),
        };
        let prepared=engine.prepare_authorization(context,AgentAuthorizeCallRequestNative{request_id:"old-signed".into(),call_id:"old-signed".into(),tool_name:"exec_command".into(),arguments:json!({"command":"printf forbidden > forbidden-old-signed","explanation":"Keep signed capability in memory until real close rejection","cwd":target.cwd,"channel":"direct"}),target:native_target,ttl_ms:Some(60000)},&sessions,&database,&credentials,&root.join("known_hosts"))?;
        let grant = engine.issue_prepared_authorization(&prepared, true)?;
        let mut context = prepared.context;
        context.sandbox_contract = grant.sandbox_contract;
        let mut call = prepared.call;
        call.capability_id = grant.capability_id;
        call.arguments = grant.effective_arguments;
        let lease = engine.admit_operation()?;
        app.exit(0);
        let closed = Instant::now();
        while runtime.ensure_shutdown_admission().is_ok()
            || !process.snapshot()?.state.is_terminal()
        {
            if closed.elapsed() > Duration::from_secs(10) {
                return Err("Real seed AppExit did not close and clean background".into());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        checks.insert(
            "oldPreparedRejectedBeforeProcessExit".into(),
            json!(native
                .execute(&old_prepared.token, true, CancellationToken::new())
                .is_err()),
        );
        checks.insert(
            "oldSignedRejectedBeforeProcessExit".into(),
            json!(engine
                .execute_tool(
                    &context,
                    call,
                    &sessions,
                    &database,
                    &credentials,
                    &root.join("known_hosts"),
                    &CancellationToken::new()
                )
                .is_err()),
        );
        checks.insert(
            "actualBackgroundCleanupConfirmed".into(),
            json!(process.snapshot()?.termination_confirmed),
        );
        checks.insert(
            "authorityRevokedBeforeExit".into(),
            json!(runtime
                .sandbox_authorizations(READONLY)?
                .read_paths
                .is_empty()),
        );
        drop(lease);
        checks.insert(
            "appExitShutdownConfirmed".into(),
            json!(runtime.shutdown(&sessions).await.is_ok()),
        );
        checks.insert(
            "noOldMarkerSideEffects".into(),
            json!(
                !project.join("forbidden-old-prepared").exists()
                    && !project.join("forbidden-old-signed").exists()
            ),
        );
    }
    checks.insert(
        "sourcePtyUntouched".into(),
        json!(source.writes.load(Ordering::SeqCst) == 0),
    );
    let mut requests = 0;
    for id in [WORKSPACE, READONLY] {
        requests += runtime
            .events(AgentSessionEventsRequest {
                session_id: id.into(),
                cursor: None,
                limit: 1000,
            })?
            .events
            .iter()
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
            .count();
    }
    checks.insert("noModelRequests".into(), json!(requests == 0));
    let passed = checks.values().all(|value| value == true);
    Ok(
        json!({"passed":passed,"mode":if reopen{"restore-reopen"}else{"restore-seed"},"pid":std::process::id(),"checks":checks,"workspaceCreatedAt":workspace.header.created_at_unix_ms,"readonlyCreatedAt":readonly.header.created_at_unix_ms,"workspaceBinding":workspace.header.sandbox_binding_revision,"readonlyBinding":readonly.header.sandbox_binding_revision,"modelRequests":requests,"sourcePtyWrites":source.writes.load(Ordering::SeqCst),"scope":"two real Wry processes and production Runtime/installed NativeAdapter on the same state; no model-registered WaitingApproval or dispatched-unknown recovery is claimed; no bearer persisted or transferred"}),
    )
}
