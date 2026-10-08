//! Real Wry shutdown acceptance, before any model configuration or credential read.
use super::*;
use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub(super) fn run(root: &Path, undrained: bool, exit_active: bool) -> Result<(), String> {
    let reopen =
        std::env::var("SHELLSPAN_NATIVE_SHUTDOWN_CHECK").as_deref() == Ok("local-crash-reopen");
    if !root.is_absolute()
        || !root.is_dir()
        || (!reopen
            && std::fs::read_dir(root)
                .map_err(|_| "Shutdown fixture directory unavailable")?
                .next()
                .is_some())
    {
        return Err("Shutdown check requires a new empty absolute directory".into());
    }
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.shellspan.native-shutdown-check".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.join("state")),
    );
    let saved_root = root.to_path_buf();
    let check_root = saved_root.clone();
    let events_root = saved_root.clone();
    let mut events = Vec::new();
    let app = tauri::Builder::default()
        .manage(ContainerResourceSupervisor::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let outcome = tauri::async_runtime::block_on(async {
                    let outcome = std::panic::AssertUnwindSafe(async {
                        if reopen { check_local_reopen(&handle, &check_root).await }
                        else { check(&handle,&check_root,undrained,exit_active).await }
                    })
                        .catch_unwind().await.unwrap_or_else(|_| Err("Shutdown acceptance panicked before completion".into()));
                    if outcome.as_ref().map_or(true, |report| report["passed"] != true) {
                        if let (Some(runtime),Some(sessions)) = (handle.try_state::<AgentRuntime>(),handle.try_state::<SessionManager>()) {
                            let _ = runtime.shutdown(&sessions).await;
                        }
                    }
                    outcome
                });
                let report = match &outcome {
                    Ok(report) => report.clone(),
                    Err(error) => json!({"passed":false,"mode":if exit_active {"exit-active"} else if undrained {"undrained"} else {"normal"},"error":crate::redaction::redact_sensitive_text(error)}),
                };
                let saved = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())
                    .and_then(|bytes| {
                        let pending = check_root.join("shutdown-check.pending.json");
                        std::fs::write(&pending,bytes).and_then(|_| std::fs::rename(pending,check_root.join("shutdown-check.json"))).map_err(|error| error.to_string())
                    });
                handle.exit(if report["passed"] == true && saved.is_ok() {0} else {1});
            });
            Ok(())
        }).build(context).map_err(|_| "Shutdown Wry application could not start")?;
    let exit_code = app.run_return(move |app,event| {
        if matches!(&event,tauri::RunEvent::ExitRequested {..}|tauri::RunEvent::Exit) {
            events.push(json!({"event":if matches!(&event,tauri::RunEvent::Exit) {"exit"} else {"exitRequested"},"pid":std::process::id()}));
            let _ = std::fs::write(events_root.join("app-exit-events.json"),serde_json::to_vec(&events).unwrap_or_default());
        }
        crate::app_exit::handle_event(app,event);
    });
    let waiting = Instant::now();
    while !saved_root.join("shutdown-check.json").is_file() {
        if waiting.elapsed() > Duration::from_secs(5) {
            return Err("Shutdown report writer did not finish after actual App Exit".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let report: Value = serde_json::from_slice(
        &std::fs::read(saved_root.join("shutdown-check.json"))
            .map_err(|_| "Shutdown report missing")?,
    )
    .map_err(|_| "Shutdown report invalid")?;
    if report["passed"] != true {
        return Err("Real Wry shutdown acceptance failed; inspect its isolated report".into());
    }
    if exit_code != 0 {
        return Err("Real Wry app returned a nonzero exit code".into());
    }
    Ok(())
}

pub(super) fn request(
    header: &AgentSessionHeader,
    id: &str,
    command: &str,
    background: bool,
    services: Value,
) -> Result<NativeToolRequest, String> {
    let target = header
        .target
        .as_ref()
        .ok_or("Shutdown target missing")?
        .clone();
    let contract = AgentSandboxContract::freeze(
        header.sandbox_policy,
        &target,
        header.execution_surface,
        super::super::driver::current_unix_ms()?,
    )?
    .bind_to_session(header);
    Ok(NativeToolRequest {
        sandbox_contract: contract,
        session_id: header.session_id.clone(),
        task_id: header.task_id.clone(),
        goal: header.goal.clone(),
        success_criteria: header.success_criteria.clone(),
        turn_id: "shutdown-turn".into(),
        step_id: id.into(),
        request_id: id.into(),
        model_call: ModelToolCall {
            call_id: id.into(),
            provider_call_id: None,
            name: "run_terminal_command".into(),
            arguments: json!({"command":command,"explanation":"Real owned shutdown acceptance operation","background":background,"timeoutMs":45000,"localServices":services}),
        },
        target,
        permission_mode: header
            .permission_mode
            .ok_or("Shutdown permission mode missing")?,
        execution_surface: header.execution_surface,
    })
}

fn rejected_by_gate<T>(result: &Result<T, String>) -> bool {
    result
        .as_ref()
        .err()
        .is_some_and(|error| error.contains("agentRuntimeShuttingDown"))
}

async fn check_local_reopen(app: &tauri::AppHandle, root: &Path) -> Result<Value, String> {
    let ready: Value = serde_json::from_slice(
        &std::fs::read(root.join("local-ready.json")).map_err(|_| "Local ready missing")?,
    )
    .map_err(|_| "Local ready invalid")?;
    if ready["ready"] != true
        || ready["fixtureRoot"] != root.to_string_lossy().as_ref()
        || ready["identifier"] != "com.shellspan.native-shutdown-check"
    {
        return Err("Local fixture identity changed".into());
    }
    let original = ready["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or("Original App identity missing")?;
    let system = sysinfo::System::new_all();
    if system
        .process(sysinfo::Pid::from_u32(original))
        .is_some_and(|process| Some(process.start_time()) == ready["startTime"].as_u64())
    {
        return Err("Original App is still alive".into());
    }
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(
        app.path()
            .app_data_dir()
            .map_err(|_| "Local state missing")?,
    )?;
    let database = Database::open(&root.join("state/shutdown.db"))?;
    let credentials = CredentialManager::isolated_native_for_checks();
    let sessions = SessionManager::default();
    let source = super::source(&sessions, &root.join("project"))?;
    app.manage(database);
    app.manage(credentials);
    app.manage(sessions.clone());
    app.manage(runtime.clone());
    runtime.configure_native(app.clone())?;
    let blocked = runtime.probe_native_sandbox().is_err();
    let recovered = super::super::commands::agent_runtime_reconcile_direct_resources(
        app.clone(),
        app.state::<AgentRuntime>(),
    )
    .await?;
    let again = super::super::commands::agent_runtime_reconcile_direct_resources(
        app.clone(),
        app.state::<AgentRuntime>(),
    )
    .await?;
    let directories_absent = ready["directories"]
        .as_array()
        .ok_or("Owned directories missing")?
        .iter()
        .all(|value| {
            value
                .as_str()
                .is_some_and(|path| !std::path::Path::new(path).exists())
        });
    let children_absent = ready["children"]
        .as_array()
        .ok_or("Owned children missing")?
        .iter()
        .all(|value| {
            value["pid"]
                .as_u64()
                .and_then(|pid| u32::try_from(pid).ok())
                .is_some_and(|pid| {
                    system
                        .process(sysinfo::Pid::from_u32(pid))
                        .is_none_or(|process| {
                            Some(process.start_time()) != value["startTime"].as_u64()
                        })
                })
        });
    let port = ready["port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .ok_or("Owned port missing")?;
    let port_closed = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    )
    .is_err();
    let effect = std::fs::read_to_string(root.join("project/shutdown-marker"))
        .map_err(|_| "Actual effect missing")?;
    let gate_reopened = runtime.probe_native_sandbox().is_ok();
    let shutdown = runtime.prepare_for_shutdown(&sessions).is_ok();
    let checks = json!({"originalAppGone":true,"blockedBeforeReceipt":blocked,"signedRecovery":recovered.resolved==2&&recovered.uncertain==0,
        "idempotentRecovery":again.resolved==0&&again.uncertain==0,"ownedDirectoriesAbsent":directories_absent,"ownedChildrenAbsent":children_absent,
        "ownedPortClosed":port_closed,"singlePartialEffect":effect=="started","admissionReopened":gate_reopened,"confirmedShutdown":shutdown,
        "actualStdinClosedWithoutCancelling":ready["actualStdinClosedWithoutCancelling"]==true,
        "sourcePtyUntouched":source.writes.load(Ordering::SeqCst)==0});
    Ok(
        json!({"passed":checks.as_object().is_some_and(|checks|checks.values().all(|value|value==true)),"checks":checks,
        "resolved":recovered.resolved,"uncertain":recovered.uncertain,"scope":"real Wry SIGKILL, ordinary group and Node service/proxy/temp, exact signed receipts; historical PIDs only observed, never signalled"}),
    )
}

async fn check(
    app: &tauri::AppHandle,
    root: &Path,
    undrained: bool,
    exit_active: bool,
) -> Result<Value, String> {
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(
        app.path()
            .app_data_dir()
            .map_err(|_| "Shutdown app data directory unavailable")?,
    )?;
    let database = Database::open(&root.join("state/shutdown.db"))?;
    let credentials = CredentialManager::isolated_native_for_checks();
    let sessions = SessionManager::default();
    let workspace = root.join("project");
    std::fs::create_dir(&workspace).map_err(|_| "Shutdown project unavailable")?;
    let source = super::source(&sessions, &workspace)?;
    app.manage(database.clone());
    app.manage(credentials.clone());
    app.manage(sessions.clone());
    app.manage(runtime.clone());
    runtime.configure_native(app.clone())?;
    let shared_engine = runtime.acceptance_native_engine();
    let adapter = Arc::new(NativeToolAdapter::new(app.clone(), shared_engine.clone()));
    let create_input = |id: &str| -> Result<CreateAgentSessionRequest, String> {
        serde_json::from_value(json!({"sessionId":id,"taskId":id,"goal":"Verify production global shutdown",
            "target":{"kind":"local","targetId":"shutdown-local","sessionId":"acceptance-source","cwd":workspace},
            "sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"requestApproval",
            "successCriteria":["No dispatch after shutdown and normal resources are cleaned"]})).map_err(|error| error.to_string())
    };
    let first = runtime
        .create_session(create_input("shutdown-first")?)?
        .header;
    let second = runtime
        .create_session(create_input("shutdown-second")?)?
        .header;
    let crash_seed =
        std::env::var("SHELLSPAN_NATIVE_SHUTDOWN_CHECK").as_deref() == Ok("local-crash-seed");
    let shell_command = if crash_seed {
        "read -r value; [ \"$value\" = guardian-input ] || exit 2; echo $$ > owned-shell.pid; printf started > shutdown-marker; sleep 30; printf finished >> shutdown-marker"
    } else {
        "echo $$ > owned-shell.pid; printf started > shutdown-marker; sleep 30; printf finished >> shutdown-marker"
    };
    let background = adapter.prepare(request(
        &first,
        "background",
        shell_command,
        true,
        json!([]),
    )?)?;
    let result = adapter.execute(&background.token, true, CancellationToken::new())?;
    let data = result.data.ok_or("Shutdown background data missing")?;
    let process_a = runtime.acceptance_process(
        data["processHandle"]
            .as_str()
            .ok_or("Shutdown background handle missing")?,
    )?;
    if crash_seed {
        let input = "guardian-input\n";
        if process_a.write_stdin(input.into(), true)? != input.len() {
            return Err("Actual controller stdin was not accepted".into());
        }
    }
    let marker = workspace.join("shutdown-marker");
    let waiting = Instant::now();
    while std::fs::read_to_string(&marker).ok().as_deref() != Some("started") {
        if waiting.elapsed() > Duration::from_secs(10) {
            return Err("Real shutdown background did not start".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "Owned port unavailable")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Owned port unavailable")?
        .port();
    drop(listener);
    std::fs::write(workspace.join("published.txt"), "real-wry-shutdown-service")
        .map_err(|_| "Owned service file unavailable")?;
    // Keep this real Node project self-contained when the fixture lives below
    // a repository whose parent package configuration is outside its grant.
    std::fs::write(
        workspace.join("package.json"),
        serde_json::to_vec(&json!({
            "name":"shellspan-owned-shutdown-fixture", "private":true, "type":"commonjs"
        }))
        .map_err(|_| "Owned Node project configuration invalid")?,
    )
    .map_err(|_| "Owned Node project configuration unavailable")?;
    std::fs::write(workspace.join("service.cjs"),format!("require('node:fs').writeFileSync('owned-node.pid',String(process.pid));require('node:http').createServer((request,response)=>response.end(require('node:fs').readFileSync('published.txt'))).listen({port},'127.0.0.1');\n")).map_err(|_| "Owned Node service unavailable")?;
    let service = adapter.prepare(request(
        &second,
        "service",
        "node service.cjs",
        true,
        json!([{"port":port}]),
    )?)?;
    let service_result = adapter.execute_scoped(
        &service.token,
        true,
        CancellationToken::new(),
        sandbox_authorization::ResourceAuthorizationScope::Session,
    )?;
    let data = service_result.data.ok_or("Shutdown service data missing")?;
    let process_b = runtime.acceptance_process(
        data["processHandle"]
            .as_str()
            .ok_or("Shutdown service handle missing")?,
    )?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|_| "Shutdown HTTP client unavailable")?;
    let waiting = Instant::now();
    loop {
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{port}/published.txt"))
            .send()
            .await
        {
            if let Ok(body) = response.text().await {
                if body != "real-wry-shutdown-service" {
                    return Err("Actual service body differs from file".into());
                }
                break;
            }
        }
        if waiting.elapsed() > Duration::from_secs(10) {
            let snapshot = process_b.snapshot()?;
            return Err(format!("Actual Wry service did not start: state={:?}, exitCode={:?}, controllerError={:?}, stderr={}", snapshot.state, snapshot.exit_code, snapshot.error, snapshot.stderr));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if crash_seed {
        let directories = [
            process_a
                .guardian_temp()
                .ok_or("Owned shell temp unavailable")?,
            process_b
                .guardian_temp()
                .ok_or("Owned service temp unavailable")?,
        ];
        let system = sysinfo::System::new_all();
        let children = ["owned-shell.pid", "owned-node.pid"]
            .into_iter()
            .map(|name| -> Result<Value, String> {
                let pid: u32 = std::fs::read_to_string(workspace.join(name))
                    .map_err(|_| "Owned PID receipt missing")?
                    .trim()
                    .parse()
                    .map_err(|_| "Owned PID receipt invalid")?;
                let process = system
                    .process(sysinfo::Pid::from_u32(pid))
                    .ok_or("Owned command is not running")?;
                Ok(json!({"pid":pid,"startTime":process.start_time()}))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let pid = std::process::id();
        let ready = json!({"ready":true,"pid":pid,"startTime":system.process(sysinfo::Pid::from_u32(pid)).ok_or("Owned App identity unavailable")?.start_time(),
            "fixtureRoot":root,"identifier":"com.shellspan.native-shutdown-check","directories":directories,"children":children,"port":port,"actualStdinClosedWithoutCancelling":true,"sourcePtyWrites":source.writes.load(Ordering::SeqCst)});
        std::fs::write(
            root.join("local-ready.json"),
            serde_json::to_vec_pretty(&ready).map_err(|_| "Owned readiness invalid")?,
        )
        .map_err(|_| "Owned readiness unavailable")?;
        tokio::time::sleep(Duration::from_secs(120)).await;
        return Err("Local crash seed was not interrupted within its bounded window".into());
    }
    let pending_request = request(
        &second,
        "pending",
        "printf forbidden > pending-marker",
        false,
        json!([]),
    )?;
    let pending = adapter.prepare(pending_request.clone())?;
    let native_target = AgentToolTargetNative::Local {
        target_id: pending_request.target.target_id.clone(),
        session_id: pending_request.target.session_id.clone(),
        cwd: pending_request.target.cwd.clone(),
    };
    let native_context = NativeExecutionContext {
        sandbox_contract: Some(pending_request.sandbox_contract.clone()),
        request: AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: "signed-before-shutdown".into(),
            user_session_id: second.session_id.clone(),
            task_id: second.task_id.clone(),
            goal: second.goal.clone(),
            success_criteria: second.success_criteria.clone(),
            targets: vec![native_target.clone()],
            permission_mode: AgentPermissionModeNative::RequestApproval,
        },
        turn_id: "shutdown-turn".into(),
        step_id: "signed-before-shutdown".into(),
    };
    let prepared = shared_engine.prepare_authorization(native_context.clone(),AgentAuthorizeCallRequestNative {
        request_id:"signed-before-shutdown".into(),call_id:"signed-before-shutdown".into(),tool_name:"exec_command".into(),target:native_target,ttl_ms:Some(60000),
        arguments:json!({"command":"printf forbidden > signed-marker","explanation":"Signed owned marker must not execute after shutdown","cwd":pending_request.target.cwd,"channel":"direct"}),
    },&sessions,&database,&credentials,&root.join("known_hosts"))?;
    let grant = shared_engine.issue_prepared_authorization(&prepared, true)?;
    let mut signed_context = prepared.context;
    signed_context.sandbox_contract = grant.sandbox_contract;
    let mut signed_call = prepared.call;
    signed_call.capability_id = grant.capability_id;
    signed_call.arguments = grant.effective_arguments;
    let raced_header = runtime
        .create_session(create_input("shutdown-raced")?)?
        .header;
    let raced_preparation = adapter.prepare(request(
        &raced_header,
        "raced-launch",
        "printf race-started > race-marker; sleep 30; printf race-finished >> race-marker",
        true,
        json!([]),
    )?)?;
    let lease = shared_engine.admit_operation()?;
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let dispatch_barrier = barrier.clone();
    let raced_adapter = adapter.clone();
    let raced_dispatch = tauri::async_runtime::spawn_blocking(move || {
        dispatch_barrier.wait();
        raced_adapter.execute(&raced_preparation.token, true, CancellationToken::new())
    });
    barrier.wait();
    let resources_running_before_exit =
        !process_a.snapshot()?.state.is_terminal() && !process_b.snapshot()?.state.is_terminal();
    let app_exit_started_cleanup = if exit_active {
        if !resources_running_before_exit {
            return Err("Actual resources ended before AppExit initiation".into());
        }
        app.exit(0);
        let waiting = Instant::now();
        loop {
            if runtime.ensure_shutdown_admission().is_err()
                && process_a.snapshot()?.state.is_terminal()
                && process_b.snapshot()?.state.is_terminal()
            {
                break;
            }
            if waiting.elapsed() > Duration::from_secs(10) {
                return Err(
                    "Actual AppExit did not close admission and start resource cleanup".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        true
    } else {
        runtime.begin_shutdown_admission();
        false
    };
    let shutdown_runtime = runtime.clone();
    let shutdown_sessions = sessions.clone();
    let shutdown =
        tauri::async_runtime::spawn(
            async move { shutdown_runtime.shutdown(&shutdown_sessions).await },
        );
    let mut checks = serde_json::Map::new();
    if exit_active {
        checks.insert(
            "appExitInitiatedWithRunningResources".into(),
            json!(resources_running_before_exit),
        );
        checks.insert(
            "appExitStartedCleanupBeforeManualShutdownJoin".into(),
            json!(app_exit_started_cleanup),
        );
    }
    checks.insert(
        "newSessionRejected".into(),
        json!(rejected_by_gate(
            &runtime.create_session(create_input("shutdown-after-close")?)
        )),
    );
    let provider = crate::llm::config::AiProviderConfig {
        model_definition: None,
        retry_policy: None,
        profile: "minimax".into(),
        id: "shutdown-no-request".into(),
        kind: crate::llm::config::AiProviderKind::OpenAiCompatible,
        base_url: "https://api.minimax.io/v1".into(),
        model: "MiniMax-M3".into(),
        reasoning_effort: None,
        requires_api_key: true,
        api_key: None,
    };
    checks.insert(
        "existingSessionStartRejected".into(),
        json!(rejected_by_gate(&runtime.start(
            &first.session_id,
            provider,
            None
        ))),
    );
    checks.insert(
        "newPreparationRejected".into(),
        json!(rejected_by_gate(&adapter.prepare(request(
            &first,
            "after-close",
            "printf forbidden > new-marker",
            false,
            json!([])
        )?))),
    );
    checks.insert(
        "pendingAdapterTokenRejected".into(),
        json!(rejected_by_gate(&adapter.execute(
            &pending.token,
            true,
            CancellationToken::new()
        ))),
    );
    checks.insert(
        "signedLaunchRejected".into(),
        json!(rejected_by_gate(&shared_engine.execute_tool(
            &signed_context,
            signed_call,
            &sessions,
            &database,
            &credentials,
            &root.join("known_hosts"),
            &CancellationToken::new()
        ))),
    );
    let approval = AgentToolDecisionInput {
        session_id: second.session_id.clone(),
        turn_id: "shutdown-turn".into(),
        step_id: "pending".into(),
        request_id: "pending".into(),
        call_id: "pending".into(),
        approval_id: "shutdown-no-model-approval".into(),
    };
    let approval_result = runtime.approve_tool(approval).await;
    let approval_entry_error = approval_result
        .as_ref()
        .err()
        .map(|error| crate::redaction::redact_sensitive_text(error));
    checks.insert(
        "approvalEntryRejected".into(),
        json!(rejected_by_gate(&approval_result)),
    );
    let initial = if undrained {
        let result = shutdown.await.map_err(|_| "Shutdown worker did not join")?;
        drop(lease);
        result
    } else {
        drop(lease);
        shutdown.await.map_err(|_| "Shutdown worker did not join")?
    };
    let repeated = runtime.shutdown(&sessions).await;
    let raced_result = raced_dispatch
        .await
        .map_err(|_| "Actual raced dispatch did not join")?;
    let race_marker = workspace.join("race-marker");
    let (raced_outcome, raced_contained) = match &raced_result {
        Err(error) if error.contains("agentRuntimeShuttingDown") => {
            ("gateRejected", !race_marker.exists())
        }
        Ok(result) => {
            if let Some(handle) = result
                .data
                .as_ref()
                .and_then(|data| data["processHandle"].as_str())
            {
                let ended = runtime.acceptance_process(handle)?.snapshot()?;
                (
                    "nativeStarted",
                    ended.state.is_terminal()
                        && ended.termination_confirmed
                        && std::fs::read_to_string(&race_marker)
                            .ok()
                            .is_none_or(|content| !content.contains("race-finished")),
                )
            } else {
                ("unexpectedResult", false)
            }
        }
        Err(_) => ("unexpectedFailure", false),
    };
    checks.insert(
        "racedNativeLaunchContained".into(),
        json!(raced_contained && !shared_engine.has_task_processes(&raced_header.task_id)?),
    );
    checks.insert("repeatedOutcomeSame".into(), json!(initial == repeated));
    checks.insert(
        "gateStillClosed".into(),
        json!(runtime.ensure_shutdown_admission().is_err()),
    );
    checks.insert(
        "expectedOutcome".into(),
        json!(if undrained {
            initial
                .as_ref()
                .err()
                .is_some_and(|error| error.contains("unconfirmed"))
        } else {
            initial.as_ref().ok().is_some_and(|count| *count >= 2)
        }),
    );
    let ended_a = process_a.snapshot()?;
    let ended_b = process_b.snapshot()?;
    checks.insert(
        "resourcesTerminated".into(),
        json!(
            ended_a.state.is_terminal()
                && ended_b.state.is_terminal()
                && ended_a.termination_confirmed
                && ended_b.termination_confirmed
        ),
    );
    checks.insert(
        "proxyClosed".into(),
        json!(ended_b.network_proxy.is_some_and(|proxy| proxy.closed)),
    );
    let released = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port));
    checks.insert("ownedPortReleased".into(), json!(released.is_ok()));
    drop(released);
    checks.insert(
        "noMarkerReplay".into(),
        json!(
            std::fs::read_to_string(&marker).ok().as_deref() == Some("started")
                && ["pending-marker", "signed-marker", "new-marker"]
                    .iter()
                    .all(|name| !workspace.join(name).exists())
        ),
    );
    checks.insert(
        "sourcePtyUntouched".into(),
        json!(source.writes.load(Ordering::SeqCst) == 0),
    );
    checks.insert(
        "policiesRemainWorkspace".into(),
        json!([&first.session_id, &second.session_id]
            .iter()
            .all(|id| runtime
                .session(id)
                .is_ok_and(|snapshot| snapshot.header.sandbox_policy
                    == Some(AgentSandboxPolicy::Workspace)))),
    );
    let model_requests = [&first.session_id, &second.session_id]
        .iter()
        .map(|id| {
            runtime
                .events(AgentSessionEventsRequest {
                    session_id: (*id).clone(),
                    cursor: None,
                    limit: 1000,
                })
                .map(|page| {
                    page.events
                        .iter()
                        .filter(|event| {
                            matches!(event.payload, AgentSessionEventPayload::RequestStart { .. })
                        })
                        .count()
                })
        })
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .sum::<usize>();
    checks.insert("noModelRequests".into(), json!(model_requests == 0));
    let passed = checks.values().all(|value| value == true);
    Ok(
        json!({"passed":passed,"mode":if exit_active {"exit-active"} else if undrained {"undrained"} else {"normal"},"shutdownInitiator":if exit_active {"productionAppExit"} else {"explicitRuntime"},"checks":checks,"modelRequests":model_requests,"sourcePtyWrites":source.writes.load(Ordering::SeqCst),"racedDispatchOutcome":raced_outcome,"approvalEntryError":approval_entry_error,"approvalEntryScope":"public API without a model-registered approval; valid pending adapter token and signed capability checked separately","shutdownOutcome":match initial {Ok(count)=>json!({"confirmed":true,"cleaned":count}),Err(error)=>json!({"confirmed":false,"error":crate::redaction::redact_sensitive_text(&error)})}}),
    )
}
