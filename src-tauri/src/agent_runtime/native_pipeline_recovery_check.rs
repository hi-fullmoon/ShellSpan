//! Actual production pipeline recovery; fixed protocol input, never a fake model response.
use super::*;
use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const SESSION: &str = "pipeline-recovery";
const TURN: &str = "pipeline-turn";
const STEP: &str = "pipeline-step";
const CALL: &str = "pipeline-call";

pub(super) fn run(root: &Path, reopen: bool, unknown: bool) -> Result<(), String> {
    if !root.is_absolute() || !root.is_dir() {
        return Err("Pipeline recovery requires an absolute owned directory".into());
    }
    if !reopen
        && std::fs::read_dir(root)
            .map_err(|_| "Owned directory unavailable")?
            .next()
            .is_some()
    {
        return Err("Pipeline seed requires a fresh empty directory".into());
    }
    if reopen {
        verify_original_ended(root)?;
    }
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.shellspan.native-pipeline-recovery-check".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.join("state")),
    );
    let saved_root = root.to_owned();
    let check_root = root.to_owned();
    let event_root = root.to_owned();
    let mut events = Vec::new();
    let app=tauri::Builder::default().manage(ContainerResourceSupervisor::default()).setup(move |app| {
        let handle=app.handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let outcome=tauri::async_runtime::block_on(async {
                let outcome=std::panic::AssertUnwindSafe(check(&handle,&check_root,reopen,unknown)).catch_unwind().await.unwrap_or_else(|_|Err("Pipeline recovery acceptance panicked".into()));
                if outcome.as_ref().map_or(true,|report|report["passed"]!=true) {
                    if let(Some(runtime),Some(sessions))=(handle.try_state::<AgentRuntime>(),handle.try_state::<SessionManager>()){let _=runtime.shutdown(&sessions).await;}
                }
                outcome
            });
            let report=match outcome {Ok(value)=>value,Err(error)=>json!({"passed":false,"error":crate::redaction::redact_sensitive_text(&error),"pid":std::process::id()})};
            let _=write_report(&check_root,"pipeline-result.json",&report);
            handle.exit(if report["passed"]==true{0}else{1});
        });Ok(())
    }).build(context).map_err(|_|"Real pipeline Wry app unavailable")?;
    let code=app.run_return(move |app,event| {
        if matches!(&event,tauri::RunEvent::ExitRequested {..}|tauri::RunEvent::Exit) {
            events.push(json!({"event":if matches!(&event,tauri::RunEvent::Exit){"exit"}else{"exitRequested"},"pid":std::process::id()}));
            let _=write_report(&event_root,if reopen{"pipeline-reopen-events.json"}else{"pipeline-seed-events.json"},&json!(events));
        }
        crate::app_exit::handle_event(app,event);
    });
    let began = Instant::now();
    while !saved_root.join("pipeline-result.json").is_file() {
        if began.elapsed() > Duration::from_secs(5) {
            return Err("Pipeline result not delivered after App Exit".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let result: Value = serde_json::from_slice(
        &std::fs::read(saved_root.join("pipeline-result.json"))
            .map_err(|_| "Pipeline report missing")?,
    )
    .map_err(|_| "Pipeline report invalid")?;
    if code != 0 || result["passed"] != true {
        return Err("Actual pipeline recovery failed; inspect owned report".into());
    }
    Ok(())
}

fn write_report(root: &Path, name: &str, value: &Value) -> Result<(), String> {
    let pending = root.join(format!("{name}.pending"));
    std::fs::write(
        &pending,
        serde_json::to_vec_pretty(value).map_err(|_| "Report encoding failed")?,
    )
    .and_then(|_| std::fs::rename(pending, root.join(name)))
    .map_err(|_| "Report delivery failed".into())
}

fn verify_original_ended(root: &Path) -> Result<(), String> {
    let ready: Value = serde_json::from_slice(
        &std::fs::read(root.join("pipeline-ready.json"))
            .map_err(|_| "Actual seed ready record missing")?,
    )
    .map_err(|_| "Seed ready record invalid")?;
    if ready["ready"] != true {
        return Err("Seed never formed the actual pipeline state".into());
    }
    let system = sysinfo::System::new_all();
    let pid = ready["pid"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or("Seed pid missing")?;
    if system.process(sysinfo::Pid::from_u32(pid)).is_some() {
        return Err("Original owned App is still alive".into());
    }
    for child in ready["descendants"]
        .as_array()
        .ok_or("Actual descendant facts missing")?
    {
        let pid = child["pid"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or("Descendant pid missing")?;
        if system
            .process(sysinfo::Pid::from_u32(pid))
            .is_some_and(|process| process.start_time() == child["startTime"].as_u64().unwrap_or(0))
        {
            return Err(
                "Owned bounded descendant has not ended; wait without signaling unrelated PIDs"
                    .into(),
            );
        }
    }
    Ok(())
}

pub(super) fn own_process_facts(root: &Path) -> Result<Value, String> {
    let system = sysinfo::System::new_all();
    let pid = sysinfo::Pid::from_u32(std::process::id());
    let process = system
        .process(pid)
        .ok_or("Actual App process facts unavailable")?;
    let mut family = std::collections::HashSet::from([pid]);
    loop {
        let before = family.len();
        for (p, child) in system.processes() {
            if child
                .parent()
                .is_some_and(|parent| family.contains(&parent))
            {
                family.insert(*p);
            }
        }
        if family.len() == before {
            break;
        }
    }
    let descendants=family.into_iter().filter(|id|*id!=pid).filter_map(|id|system.process(id).map(|child|json!({"pid":id.as_u32(),"startTime":child.start_time(),"cwd":child.cwd().map(|path|path.to_string_lossy().to_string()),"name":child.name().to_string_lossy()}))).collect::<Vec<_>>();
    Ok(
        json!({"pid":pid.as_u32(),"startTime":process.start_time(),"argv":process.cmd().iter().map(|arg|arg.to_string_lossy().to_string()).collect::<Vec<_>>(),"fixtureRoot":root,"identifier":"com.shellspan.native-pipeline-recovery-check","descendants":descendants}),
    )
}

async fn check(
    app: &tauri::AppHandle,
    root: &Path,
    reopen: bool,
    unknown: bool,
) -> Result<Value, String> {
    let project = root.join("project");
    if !reopen {
        std::fs::create_dir(&project).map_err(|_| "Owned project unavailable")?;
    }
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(
        app.path()
            .app_data_dir()
            .map_err(|_| "App data unavailable")?,
    )?;
    let database = Database::open(&root.join("state/pipeline.db"))?;
    let credentials = CredentialManager::isolated_native_for_checks();
    let sessions = SessionManager::default();
    let source = super::source(&sessions, &project)?;
    app.manage(database.clone());
    app.manage(credentials.clone());
    app.manage(sessions.clone());
    app.manage(runtime.clone());
    runtime.configure_native(app.clone())?;
    super::super::commands::agent_runtime_probe_native_sandbox(
        app.clone(),
        app.state::<AgentRuntime>(),
    )
    .await?;
    if !reopen {
        runtime.create_session(serde_json::from_value(json!({"sessionId":SESSION,"taskId":SESSION,"goal":"Recover actual registered pipeline boundary from fixed protocol input",
        "target":{"kind":"local","targetId":"pipeline-local","sessionId":"acceptance-source","cwd":project},"sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"requestApproval","successCriteria":["No re-execution of a recovered native call"]})).map_err(|_|"Actual session schema failed")?)?;
        runtime.receive_submission(
            SESSION,
            "pipeline-input".into(),
            "pipeline-input".into(),
            "Run the fixed owned protocol operation only after explicit approval".into(),
            None,
            AgentInboxLane::NextTurn,
            false,
            None,
        )?;
    }
    let parts = super::super::runtime::native_restore_pipeline_check::actual_parts(&runtime);
    let mut provider = crate::ai::AiProviderConfig {
        id: "pipeline-ollama".into(),
        profile: "ollama".into(),
        kind: crate::llm::config::AiProviderKind::Ollama,
        base_url: "http://127.0.0.1:11434".into(),
        model: "llama3.2:3b".into(),
        model_definition: None,
        retry_policy: None,
        reasoning_effort: None,
        requires_api_key: false,
        api_key: None,
    };
    let definition = crate::llm::catalog::declaration_template(&provider)?;
    provider.model_definition = Some(definition.clone());
    let route = crate::llm::routes::ProviderRoute {
        id: provider.id.clone(),
        revision: 1,
        display_name: "Actual pipeline adapter, no model request".into(),
        adapter_id: "ollama".into(),
        base_url: provider.base_url.clone(),
        auth: crate::llm::routes::RouteAuth::None,
        replay_domain_id: "pipeline-no-request".into(),
        preset_id: "ollama".into(),
        models: Some(std::collections::BTreeMap::from([(
            provider.model.clone(),
            definition,
        )])),
        model_overrides: None,
        defaults: None,
        retry_policy: RetryPolicy::default(),
        timeouts: Default::default(),
    };
    let snapshot = crate::llm::routes::RouteSnapshot {
        schema_version: 1,
        revision: 1,
        routes: vec![route],
        default_selection: None,
    };
    database.save_preferences(&[(
        crate::llm::routes::ROUTES_KEY.into(),
        serde_json::to_string(&snapshot)
            .map_err(|_| "Actual adapter route metadata encoding failed")?,
    )])?;
    let routes = crate::llm::routes::RouteStore::open(database.clone(), credentials)?;
    runtime.configure_llm(crate::llm::runtime::LlmRuntime { routes })?;
    let model = parts.models.resolve(provider.clone(), None)?;
    let handle = parts
        .agents
        .attach(parts.sessions.clone(), SESSION.into(), provider, model)?;
    let entry = handle.entry().clone();
    let native = runtime.acceptance_native_runtime()?;
    let header = runtime.session(SESSION)?.header;
    native.prepare_sandbox(&header)?;
    if !reopen {
        parts
            .sessions
            .begin_turn_step(SESSION, TURN.into(), STEP.into())?
            .ok_or("Actual user input was not claimed")?;
        entry.set_scope(Some(AgentActiveScope {
            turn_id: TURN.into(),
            step_id: Some(STEP.into()),
        }))?;
        entry.set_phase(AgentLifecyclePhase::Running)?;
        let command = if unknown {
            "printf started >> unknown-marker; sleep 6; printf ended >> unknown-marker"
        } else {
            "printf forbidden > waiting-marker"
        };
        let settled=parts.tools.process_model_calls(&entry,TURN,STEP,"pipeline-request",vec![ModelToolCall{call_id:CALL.into(),provider_call_id:None,name:"run_terminal_command".into(),arguments:json!({"command":command,"explanation":"Fixed real recovery protocol operation","background":false,"timeoutMs":15000})}]).await?;
        if settled != ToolPipelineSettlement::Waiting {
            return Err("Actual pipeline did not register WaitingApproval".into());
        }
        let approval = runtime
            .events(AgentSessionEventsRequest {
                session_id: SESSION.into(),
                cursor: None,
                limit: 1000,
            })?
            .events
            .into_iter()
            .find_map(|event| match event.payload {
                AgentSessionEventPayload::ToolApproval {
                    request_id,
                    call_id,
                    approval_id: Some(approval_id),
                    status: AgentToolApprovalStatus::Requested,
                    ..
                } => Some(AgentToolDecisionInput {
                    session_id: SESSION.into(),
                    turn_id: event.turn_id?,
                    step_id: event.step_id?,
                    request_id,
                    call_id,
                    approval_id,
                }),
                _ => None,
            })
            .ok_or("Real approval event unavailable")?;
        if unknown {
            let pipeline = parts.tools.clone();
            let active = entry.clone();
            tauri::async_runtime::spawn(async move {
                let _ = pipeline
                    .decide(&active, approval, AgentToolDecision::Approve)
                    .await;
            });
            let began = Instant::now();
            loop {
                let events = runtime.events(AgentSessionEventsRequest {
                    session_id: SESSION.into(),
                    cursor: None,
                    limit: 1000,
                })?;
                let dispatched = events.events.iter().any(|event| {
                    matches!(
                        event.payload,
                        AgentSessionEventPayload::ToolExecution { .. }
                    )
                });
                if dispatched
                    && std::fs::read_to_string(project.join("unknown-marker"))
                        .ok()
                        .as_deref()
                        == Some("started")
                {
                    break;
                }
                if began.elapsed() > Duration::from_secs(4) {
                    return Err(
                        "Real foreground dispatch/marker did not form before bounded deadline"
                            .into(),
                    );
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        let mut ready = own_process_facts(root)?;
        ready["identifier"] = json!(app.config().identifier);
        ready["ready"] = json!(true);
        ready["unknown"] = json!(unknown);
        ready["recoveryKind"] = json!(runtime.session(SESSION)?.recovery.kind);
        ready["scope"]=json!("actual production pipeline from fixed protocol call; real HTTP adapter constructed, no model stream/response or bearer export");
        write_report(root, "pipeline-ready.json", &ready)?;
        tokio::time::sleep(Duration::from_secs(120)).await;
        return Err(
            "Owned seed was not interrupted within its announced observation window".into(),
        );
    }
    let before = runtime.session(SESSION)?;
    let events = runtime.events(AgentSessionEventsRequest {
        session_id: SESSION.into(),
        cursor: None,
        limit: 1000,
    })?;
    let old_approval = events
        .events
        .iter()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::ToolApproval {
                request_id,
                call_id,
                approval_id: Some(approval_id),
                status: AgentToolApprovalStatus::Requested,
                ..
            } => Some(AgentToolDecisionInput {
                session_id: SESSION.into(),
                turn_id: event.turn_id.clone()?,
                step_id: event.step_id.clone()?,
                request_id: request_id.clone(),
                call_id: call_id.clone(),
                approval_id: approval_id.clone(),
            }),
            _ => None,
        })
        .ok_or("Original actual approval identity not found")?;
    let mut checks = serde_json::Map::new();
    checks.insert(
        "workspaceIntentPreserved".into(),
        json!(before.header.sandbox_policy == Some(AgentSandboxPolicy::Workspace)),
    );
    checks.insert(
        "actualRecoveredBoundary".into(),
        json!(
            before.recovery.kind
                == if unknown {
                    AgentRecoveryCheckpointKind::ExecutionInFlight
                } else {
                    AgentRecoveryCheckpointKind::WaitingApproval
                }
        ),
    );
    parts.tools.recover_waiting(&entry)?;
    checks.insert(
        "oldApprovalNotExecutable".into(),
        json!(parts
            .tools
            .decide(&entry, old_approval, AgentToolDecision::Approve)
            .await
            .is_err()),
    );
    if unknown {
        checks.insert(
            "uncertainRetained".into(),
            json!(runtime.session(SESSION)?.uncertain_native_effects),
        );
        checks.insert(
            "resumeRequiresReconciliation".into(),
            json!(runtime.resume_recovery(SESSION).await.is_err()),
        );
        let marker = std::fs::read_to_string(project.join("unknown-marker"))
            .map_err(|_| "Actual unknown-effect marker missing")?;
        checks.insert(
            "oneActualEffectNotReplayed".into(),
            json!(marker == "startedended"),
        );
        verify_original_ended(root)?;
        // This protocol-only fixture has no model driver. Release its real idle
        // registry residency before the human reconciliation API can wake it.
        // Do not alter the durable uncertain checkpoint or synthesize a model.
        entry.stop_admission()?;
        entry.cancel();
        entry.await_idle().await;
        parts.agents.detach(SESSION)?;
        runtime.reconcile_recovery(AgentRecoveryReconcileInput{session_id:SESSION.into(),outcome:AgentRecoveryReconcileOutcome::ConfirmedApplied,evidence:"Owned marker contains one startedended sequence; original App and recorded start-time-matching descendants ended naturally before reopening".into()})?;
        checks.insert(
            "realEvidenceReconcilesUncertainty".into(),
            json!(!runtime.session(SESSION)?.uncertain_native_effects),
        );
    } else {
        checks.insert(
            "neverStartedOldOperation".into(),
            json!(!project.join("waiting-marker").exists()),
        );
        checks.insert("oldPendingCancelledByProductionRecovery".into(),json!(runtime.events(AgentSessionEventsRequest{session_id:SESSION.into(),cursor:None,limit:1000})?.events.iter().any(|event|matches!(&event.payload,AgentSessionEventPayload::ToolApproval{status:AgentToolApprovalStatus::Cancelled,reason:Some(reason),..}if reason=="sandboxAuthorizationInvalidAfterRestart"))));
    }
    let header = runtime.session(SESSION)?.header;
    let fresh = native.prepare(super::shutdown_check::request(
        &header,
        "fresh-after-reconcile",
        "printf fresh > fresh-request-marker",
        false,
        json!([]),
    )?)?;
    let result = native.execute(&fresh.token, true, CancellationToken::new())?;
    checks.insert(
        "newExplicitRequestRunsSeatbelt".into(),
        json!(
            result.data.as_ref().is_some_and(
                |data| data["exitCode"] == 0 && data["sandboxBackend"] == "macos-seatbelt"
            ) && std::fs::read_to_string(project.join("fresh-request-marker"))
                .ok()
                .as_deref()
                == Some("fresh")
        ),
    );
    checks.insert(
        "noModelRequests".into(),
        json!(!runtime
            .events(AgentSessionEventsRequest {
                session_id: SESSION.into(),
                cursor: None,
                limit: 1000
            })?
            .events
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))),
    );
    checks.insert(
        "sourcePtyUntouched".into(),
        json!(source.writes.load(Ordering::SeqCst) == 0),
    );
    runtime.shutdown(&sessions).await?;
    Ok(
        json!({"passed":checks.values().all(|value|value==true),"unknown":unknown,"pid":std::process::id(),"checks":checks,"scope":"actual pipeline registration/recovery and NativeAdapter; fixed protocol input, no generated model turn, no bearer transfer"}),
    )
}
