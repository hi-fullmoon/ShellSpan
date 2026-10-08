//! Current, explicitly selected MiniMax-M3 driver waiting-approval recovery.
//! Reads only the development route document and its selected credential reference.
use super::*;
use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const SESSION: &str = "model-waiting-recovery";
const COMMAND: &str = "printf 'real-model-waiting' > model-waiting-marker";
const UNKNOWN_COMMAND: &str =
    "printf started >> unknown-marker; sleep 6; printf ended >> unknown-marker";

async fn check_unknown_debt_reopen(
    app: &tauri::AppHandle,
    runtime: &AgentRuntime,
    project: &Path,
    root: &Path,
    sessions: &SessionManager,
    writes: &AtomicUsize,
) -> Result<Value, String> {
    let before = runtime.session(SESSION)?;
    let events = runtime.events(AgentSessionEventsRequest {
        session_id: SESSION.into(),
        cursor: None,
        limit: 1000,
    })?;
    let requests = events
        .events
        .iter()
        .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
        .count();
    let approval = events
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
        .ok_or("Actual old unknown approval identity missing")?;
    let old_rejected = runtime.approve_tool(approval).await.is_err();
    let resume_rejected = runtime.resume_recovery(SESSION).await.is_err();
    let effect = std::fs::read_to_string(project.join("unknown-marker"))
        .map_err(|_| "Actual bounded effect missing")?;
    if effect != "started" {
        return Err("Actual old effect is not the single bounded sequence".into());
    }
    let blocked_before = runtime.probe_native_sandbox().is_err();
    let recovered = super::super::commands::agent_runtime_reconcile_direct_resources(
        app.clone(),
        app.state::<AgentRuntime>(),
    )
    .await?;
    let repeated = super::super::commands::agent_runtime_reconcile_direct_resources(
        app.clone(),
        app.state::<AgentRuntime>(),
    )
    .await?;
    runtime.reconcile_recovery(AgentRecoveryReconcileInput{session_id:SESSION.into(),outcome:AgentRecoveryReconcileOutcome::ConfirmedApplied,evidence:"The exact owned command wrote started once; App SIGKILL closed the private pipe and its independent controller stopped the command before ended. Resource cleanup is independently confirmed by authenticated custody and its signed terminal receipt; no command is replayed.".into()})?;
    let admission_reopened = runtime.probe_native_sandbox().is_ok();
    let after = runtime.events(AgentSessionEventsRequest {
        session_id: SESSION.into(),
        cursor: None,
        limit: 1000,
    })?;
    let current_requests = after
        .events
        .iter()
        .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
        .count();
    let db = rusqlite::Connection::open(root.join("state/agent-direct-ownership.sqlite3"))
        .map_err(|_| "Actual debt journal missing")?;
    let debt: i64 = db
        .query_row("SELECT count(*) FROM dispatch_debt", [], |row| row.get(0))
        .map_err(|_| "Actual debt count unavailable")?;
    let shutdown_confirmed = runtime.prepare_for_shutdown(sessions).is_ok();
    let checks = json!({"actualGeneratedUnknownBoundary":before.recovery.kind==AgentRecoveryCheckpointKind::ExecutionInFlight&&requests>0,
        "oldApprovalRejected":old_rejected,"resumeRejected":resume_rejected,"singleOldEffectObserved":effect=="started",
        "resourceGateClosedBeforeReceipt":blocked_before,"signedResourceCleanup":recovered.resolved==1&&recovered.uncertain==0&&debt==0,
        "cleanupIdempotent":repeated.resolved==0&&repeated.uncertain==0,"admissionReopenedWithoutOldGrant":admission_reopened,"noNewGeneratedRequest":current_requests==requests,
        "shutdownConfirmed":shutdown_confirmed,"sourcePtyUntouched":writes.load(Ordering::SeqCst)==0});
    Ok(
        json!({"passed":checks.as_object().is_some_and(|checks|checks.values().all(|value|value==true)),"checks":checks,"modelId":"MiniMax-M3","modelRequests":requests,
        "resourceState":"confirmed","remainingResourceDebt":debt,"scope":"real generated pipeline hard crash; independent controller stops actual owned group/proxy/temp; authenticated signed cleanup permits admission without restoring old grants or model continuation"}),
    )
}

async fn check_unknown_reopen(
    runtime: &AgentRuntime,
    llm: &crate::llm::runtime::LlmRuntime,
    selection: &crate::llm::routes::ModelSelection,
    route: &crate::llm::routes::ProviderRoute,
    project: &Path,
    root: &Path,
    writes: &AtomicUsize,
    sessions: &SessionManager,
) -> Result<Value, String> {
    let before = runtime.session(SESSION)?;
    let ready: Value = serde_json::from_slice(
        &std::fs::read(root.join("pipeline-ready.json"))
            .map_err(|_| "Actual model unknown ready missing")?,
    )
    .map_err(|_| "Ready invalid")?;
    let initial_requests = runtime
        .events(AgentSessionEventsRequest {
            session_id: SESSION.into(),
            cursor: None,
            limit: 1000,
        })?
        .events
        .iter()
        .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
        .count();
    runtime.start(
        SESSION,
        route.provider(selection)?,
        llm.routes.credential(route)?,
    )?;
    let old = runtime.events(AgentSessionEventsRequest {
        session_id: SESSION.into(),
        cursor: None,
        limit: 1000,
    })?;
    let requests_before_reconcile = old
        .events
        .iter()
        .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
        .count();
    let approval = old
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
        .ok_or("Actual old model approval absent")?;
    let mut checks = serde_json::Map::new();
    checks.insert(
        "noGeneratedRequestBeforeReconciliation".into(),
        json!(requests_before_reconcile == initial_requests),
    );
    checks.insert(
        "actualGeneratedUnknownBoundary".into(),
        json!(
            before.recovery.kind == AgentRecoveryCheckpointKind::ExecutionInFlight
                && ready["actualDriverAssistantCall"] == true
                && ready["modelRequests"].as_u64().unwrap_or(0) > 0
        ),
    );
    checks.insert(
        "residentDriverRestoredWithoutReplay".into(),
        json!(
            runtime.acceptance_is_active(SESSION)?
                && runtime.session(SESSION)?.uncertain_native_effects
                && std::fs::read_to_string(project.join("unknown-marker"))
                    .ok()
                    .as_deref()
                    == Some("startedended")
        ),
    );
    checks.insert(
        "oldApprovalRejected".into(),
        json!(runtime.approve_tool(approval).await.is_err()),
    );
    checks.insert(
        "resumeRequiresHumanReconciliation".into(),
        json!(runtime.resume_recovery(SESSION).await.is_err()),
    );
    let cursor = old.events.last().map(|event| event.seq.saturating_add(1));
    runtime.reconcile_recovery(AgentRecoveryReconcileInput{session_id:SESSION.into(),outcome:AgentRecoveryReconcileOutcome::ConfirmedApplied,evidence:"Own App identity/start time checked before interruption; recorded bounded descendants all ended; owned unknown-marker contains exactly one startedended sequence before reopening".into()})?;
    let started = Instant::now();
    let mut completed = false;
    let mut extra_tool = false;
    loop {
        let page = runtime.events(AgentSessionEventsRequest {
            session_id: SESSION.into(),
            cursor,
            limit: 1000,
        })?;
        for event in page.events {
            match event.payload {
                AgentSessionEventPayload::ToolCall { .. } => extra_tool = true,
                AgentSessionEventPayload::ToolApproval {
                    request_id,
                    call_id,
                    approval_id: Some(approval_id),
                    status: AgentToolApprovalStatus::Requested,
                    ..
                } => {
                    extra_tool = true;
                    runtime
                        .reject_tool(AgentToolDecisionInput {
                            session_id: SESSION.into(),
                            turn_id: event.turn_id.ok_or("Extra call turn missing")?,
                            step_id: event.step_id.ok_or("Extra call step missing")?,
                            request_id,
                            call_id,
                            approval_id,
                        })
                        .await?;
                }
                AgentSessionEventPayload::TurnEnd { reason } if reason == "completed" => {
                    completed = true
                }
                _ => {}
            }
        }
        if completed || extra_tool || runtime.session(SESSION)?.status == AgentSessionStatus::Failed
        {
            break;
        }
        if started.elapsed() > Duration::from_secs(120) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let requests = runtime
        .events(AgentSessionEventsRequest {
            session_id: SESSION.into(),
            cursor: None,
            limit: 1000,
        })?
        .events
        .iter()
        .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
        .count();
    checks.insert(
        "actualResidentModelContinuation".into(),
        json!(completed && requests > initial_requests),
    );
    checks.insert("noAdditionalToolSideEffects".into(), json!(!extra_tool));
    checks.insert(
        "oldEffectExactlyOnce".into(),
        json!(
            std::fs::read_to_string(project.join("unknown-marker"))
                .ok()
                .as_deref()
                == Some("startedended")
        ),
    );
    checks.insert(
        "uncertaintyClearedByEvidenceOnly".into(),
        json!(!runtime.session(SESSION)?.uncertain_native_effects),
    );
    checks.insert(
        "workspacePreserved".into(),
        json!(
            runtime.session(SESSION)?.header.sandbox_policy == Some(AgentSandboxPolicy::Workspace)
        ),
    );
    checks.insert(
        "sourcePtyUntouched".into(),
        json!(writes.load(Ordering::SeqCst) == 0),
    );
    runtime.shutdown(sessions).await?;
    Ok(
        json!({"passed":checks.values().all(|value|value==true),"checks":checks,"pid":std::process::id(),"modelId":"MiniMax-M3","seedModelRequests":ready["modelRequests"],"totalModelRequests":requests,"sourcePtyWrites":writes.load(Ordering::SeqCst),"scope":"new generated MiniMax-M3 unknown dispatch; real Runtime.start restores resident driver, public human evidence reconciliation wakes a real subsequent model request; no replay or extra tool approval"}),
    )
}

pub(super) fn run(root: &Path, reopen: bool, unknown: bool) -> Result<(), String> {
    if !root.is_absolute() || !root.is_dir() {
        return Err("Model recovery requires an owned absolute directory".into());
    }
    if !reopen
        && std::fs::read_dir(root)
            .map_err(|_| "Owned directory unavailable")?
            .next()
            .is_some()
    {
        return Err("Model recovery seed requires a fresh empty root".into());
    }
    if reopen {
        let ready: Value = serde_json::from_slice(
            &std::fs::read(root.join("pipeline-ready.json"))
                .map_err(|_| "Real model ready record missing")?,
        )
        .map_err(|_| "Ready record invalid")?;
        if ready["ready"] != true || ready["modelRequests"].as_u64().unwrap_or(0) == 0 {
            return Err("No new real model request reached waiting approval".into());
        }
        let system = sysinfo::System::new_all();
        for fact in std::iter::once(json!({"pid":ready["pid"],"startTime":ready["startTime"]}))
            .chain(
                ready["descendants"]
                    .as_array()
                    .ok_or("Owned process facts missing")?
                    .iter()
                    .cloned(),
            )
        {
            let pid = fact["pid"]
                .as_u64()
                .and_then(|id| u32::try_from(id).ok())
                .ok_or("Actual pid missing")?;
            if system
                .process(sysinfo::Pid::from_u32(pid))
                .is_some_and(|process| {
                    process.start_time() == fact["startTime"].as_u64().unwrap_or(0)
                })
            {
                return Err("Original model fixture process has not ended".into());
            }
        }
    }
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.shellspan.native-pipeline-recovery-check".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.join("state")),
    );
    let check_root = root.to_owned();
    let saved_root = root.to_owned();
    let event_root = root.to_owned();
    let mut events = Vec::new();
    let app=tauri::Builder::default().manage(ContainerResourceSupervisor::default()).setup(move |app|{
        let handle=app.handle().clone();tauri::async_runtime::spawn_blocking(move ||{
            let outcome=tauri::async_runtime::block_on(async {
                let value=std::panic::AssertUnwindSafe(check(&handle,&check_root,reopen,unknown)).catch_unwind().await.unwrap_or_else(|_|Err("Actual model recovery acceptance panicked".into()));
                if value.as_ref().map_or(true,|report|report["passed"]!=true){if let(Some(runtime),Some(sessions))=(handle.try_state::<AgentRuntime>(),handle.try_state::<SessionManager>()){let _=runtime.shutdown(&sessions).await;}}
                value
            });
            let report=match outcome{Ok(value)=>value,Err(error)=>json!({"passed":false,"error":crate::redaction::redact_sensitive_text(&error),"pid":std::process::id()})};
            let pending=check_root.join("model-recovery-result.pending.json");let saved=serde_json::to_vec_pretty(&report).map_err(|_|"Report encoding failed").and_then(|data|std::fs::write(&pending,data).and_then(|_|std::fs::rename(pending,check_root.join("model-recovery-result.json"))).map_err(|_|"Report delivery failed"));
            handle.exit(if report["passed"]==true && saved.is_ok(){0}else{1});
        });Ok(())
    }).build(context).map_err(|_|"Actual model recovery Wry app unavailable")?;
    let code=app.run_return(move |app,event|{
        if matches!(&event,tauri::RunEvent::ExitRequested{..}|tauri::RunEvent::Exit){events.push(json!({"event":if matches!(&event,tauri::RunEvent::Exit){"exit"}else{"exitRequested"},"pid":std::process::id()}));let _=std::fs::write(event_root.join("model-recovery-events.json"),serde_json::to_vec(&events).unwrap_or_default());}
        crate::app_exit::handle_event(app,event);
    });
    let started = Instant::now();
    while !saved_root.join("model-recovery-result.json").is_file() {
        if started.elapsed() > Duration::from_secs(5) {
            return Err("Model recovery result writer did not finish".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let report: Value = serde_json::from_slice(
        &std::fs::read(saved_root.join("model-recovery-result.json"))
            .map_err(|_| "Result missing")?,
    )
    .map_err(|_| "Result invalid")?;
    if code != 0 || report["passed"] != true {
        return Err("Real model waiting recovery failed; inspect isolated report".into());
    }
    Ok(())
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
    let home = std::env::home_dir().ok_or("Home unavailable")?;
    let source_db = rusqlite::Connection::open_with_flags(
        home.join(".shellspan-dev/shellspan-v1.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Approved development route database unavailable")?;
    let document: String = source_db
        .query_row(
            "SELECT value FROM preferences WHERE key=?1",
            [ROUTES_KEY],
            |row| row.get(0),
        )
        .map_err(|_| "Approved development route document unavailable")?;
    let snapshot: RouteSnapshot =
        serde_json::from_str(&document).map_err(|_| "Development route schema invalid")?;
    let selection = snapshot
        .default_selection
        .as_ref()
        .ok_or("Actual default model selection missing")?
        .clone();
    if selection.model_id != "MiniMax-M3" {
        return Err("Development default is no longer the explicitly selected MiniMax-M3".into());
    }
    let route = snapshot.route(&selection.route_id)?.clone();
    let reference = match &route.auth {
        RouteAuth::Keychain { reference } => Some(reference.clone()),
        RouteAuth::None => None,
    };
    let credentials = CredentialManager::readonly_model_check(reference);
    let database = Database::open(&root.join("state/model.db"))?;
    database.save_preferences(&[(ROUTES_KEY.into(), document)])?;
    let routes = RouteStore::open(database.clone(), credentials.clone())?;
    let llm = crate::llm::runtime::LlmRuntime { routes };
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(
        app.path()
            .app_data_dir()
            .map_err(|_| "Owned app state unavailable")?,
    )?;
    runtime.configure_llm(llm.clone())?;
    runtime.configure_credentials(credentials.clone())?;
    let sessions = SessionManager::default();
    let source = super::source(&sessions, &project)?;
    app.manage(database);
    app.manage(credentials);
    app.manage(sessions.clone());
    app.manage(runtime.clone());
    app.manage(llm.clone());
    runtime.configure_native(app.clone())?;
    if reopen && unknown && runtime.probe_native_sandbox().is_err() {
        return check_unknown_debt_reopen(app, &runtime, &project, root, &sessions, &source.writes)
            .await;
    }
    super::super::commands::agent_runtime_probe_native_sandbox(
        app.clone(),
        app.state::<AgentRuntime>(),
    )
    .await?;
    let command = if unknown { UNKNOWN_COMMAND } else { COMMAND };
    if !reopen {
        runtime.create_session(serde_json::from_value(json!({"sessionId":SESSION,"taskId":SESSION,"goal":"Reach real current model waiting approval in an owned project",
            "target":{"kind":"local","targetId":"model-waiting-local","sessionId":"acceptance-source","cwd":project},"sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"requestApproval","successCriteria":["Only the specified owned marker command is requested"]})).map_err(|_|"Actual model session schema failed")?)?;
        runtime.start(
            SESSION,
            route.provider(&selection)?,
            llm.routes.credential(&route)?,
        )?;
        let instruction = if unknown {
            "The client will explicitly approve this exact bounded operation once and interrupt the App after it actually starts. When the real operation result is provided after recovery, briefly acknowledge that result and finish without calling any tools or repeating any command."
        } else {
            "The client will leave your real approval request pending for a process-recovery test."
        };
        runtime.receive_submission(SESSION,"real-model-input".into(),"real-model-input".into(),format!("In this isolated owned project, call run_terminal_command exactly once with command={command:?}, background=false, no resource extensions. Do not call any other tools, access outside the project, simulate results or run the command yourself. {instruction}"),None,AgentInboxLane::NextTurn,false,None)?;
        let started = Instant::now();
        let mut approved_once = false;
        loop {
            let page = runtime.events(AgentSessionEventsRequest {
                session_id: SESSION.into(),
                cursor: None,
                limit: 1000,
            })?;
            let requests = page
                .events
                .iter()
                .filter(|event| {
                    matches!(event.payload, AgentSessionEventPayload::RequestStart { .. })
                })
                .count();
            let valid = page.events.iter().any(|event| match &event.payload {
                AgentSessionEventPayload::ToolCall { call } => {
                    call.name == "run_terminal_command"
                        && call.arguments["command"] == command
                        && !call.arguments["background"].as_bool().unwrap_or(false)
                }
                _ => false,
            });
            let assistant = page.events.iter().any(|event| match &event.payload {
                AgentSessionEventPayload::AssistantMessage { content, .. } => {
                    super::super::assistant_tool_calls(content)
                        .iter()
                        .any(|call| {
                            call.name == "run_terminal_command"
                                && call.arguments["command"] == command
                        })
                }
                _ => false,
            });
            let pending = page.events.iter().any(|event| {
                matches!(
                    event.payload,
                    AgentSessionEventPayload::ToolApproval {
                        status: AgentToolApprovalStatus::Requested,
                        ..
                    }
                )
            });
            if pending {
                if requests == 0
                    || !valid
                    || !assistant
                    || project.join("model-waiting-marker").exists()
                {
                    return Err(
                        "Actual model requested an operation outside the fixed waiting scope"
                            .into(),
                    );
                }
                if unknown && !approved_once {
                    let input = page
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
                        .ok_or("Real fixed model approval identity missing")?;
                    approved_once = true;
                    let actual = runtime.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = actual.approve_tool(input).await;
                    });
                }
                if unknown
                    && (!page.events.iter().any(|event| {
                        matches!(
                            event.payload,
                            AgentSessionEventPayload::ToolExecution { .. }
                        )
                    }) || std::fs::read_to_string(project.join("unknown-marker"))
                        .ok()
                        .as_deref()
                        != Some("started"))
                {
                    if started.elapsed() > Duration::from_secs(150) {
                        return Err(
                            "Actual approved model operation never reached bounded started state"
                                .into(),
                        );
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                let mut ready = super::pipeline_recovery_check::own_process_facts(root)?;
                ready["identifier"] = json!(app.config().identifier);
                ready["ready"] = json!(true);
                ready["unknown"] = json!(unknown);
                ready["recoveryKind"] = json!(runtime.session(SESSION)?.recovery.kind);
                ready["modelRequests"] = json!(requests);
                ready["modelId"] = json!("MiniMax-M3");
                ready["actualDriverAssistantCall"] = json!(true);
                ready["sourcePtyWrites"] = json!(source.writes.load(Ordering::SeqCst));
                let pending = root.join("pipeline-ready.pending.json");
                std::fs::write(
                    &pending,
                    serde_json::to_vec_pretty(&ready).map_err(|_| "Ready encoding failed")?,
                )
                .and_then(|_| std::fs::rename(pending, root.join("pipeline-ready.json")))
                .map_err(|_| "Ready delivery failed")?;
                tokio::time::sleep(Duration::from_secs(120)).await;
                return Err(
                    "Actual model waiting fixture was not interrupted in its announced window"
                        .into(),
                );
            }
            if started.elapsed() > Duration::from_secs(150) {
                return Err(format!("Actual MiniMax-M3 did not reach fixed waiting approval; observed request starts={requests}"));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    if unknown {
        return check_unknown_reopen(
            &runtime,
            &llm,
            &selection,
            &route,
            &project,
            root,
            &source.writes,
            &sessions,
        )
        .await;
    }
    let before = runtime.session(SESSION)?;
    let header = before.header.clone();
    let parts = super::super::runtime::native_restore_pipeline_check::actual_parts(&runtime);
    let provider = route.provider(&selection)?;
    let model = parts.models.resolve(provider.clone(), None)?;
    let handle = parts
        .agents
        .attach(parts.sessions.clone(), SESSION.into(), provider, model)?;
    let entry = handle.entry();
    let events = runtime.events(AgentSessionEventsRequest {
        session_id: SESSION.into(),
        cursor: None,
        limit: 1000,
    })?;
    let approval = events
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
        .ok_or("Actual old model approval not found")?;
    parts.tools.recover_waiting(&entry)?;
    let mut checks = serde_json::Map::new();
    checks.insert(
        "actualDriverWaitingRecovered".into(),
        json!(before.recovery.kind == AgentRecoveryCheckpointKind::WaitingApproval),
    );
    checks.insert(
        "oldModelApprovalRejected".into(),
        json!(parts
            .tools
            .decide(&entry, approval, AgentToolDecision::Approve)
            .await
            .is_err()),
    );
    checks.insert(
        "neverExecutedOldModelMarker".into(),
        json!(!project.join("model-waiting-marker").exists()),
    );
    checks.insert("productionCancelsOldRestrictedPending".into(),json!(runtime.events(AgentSessionEventsRequest{session_id:SESSION.into(),cursor:None,limit:1000})?.events.iter().any(|event|matches!(&event.payload,AgentSessionEventPayload::ToolApproval{status:AgentToolApprovalStatus::Cancelled,reason:Some(reason),..}if reason=="sandboxAuthorizationInvalidAfterRestart"))));
    entry.stop_admission()?;
    entry.cancel();
    entry.await_idle().await;
    parts.agents.detach(SESSION)?;
    let native = runtime.acceptance_native_runtime()?;
    native.prepare_sandbox(&header)?;
    let fresh = native.prepare(super::shutdown_check::request(
        &runtime.session(SESSION)?.header,
        "fresh-model-recovery-request",
        "printf fresh > explicit-model-recovery-marker",
        false,
        json!([]),
    )?)?;
    let result = native.execute(&fresh.token, true, CancellationToken::new())?;
    checks.insert(
        "newExplicitRequestOnly".into(),
        json!(
            result.data.as_ref().is_some_and(
                |data| data["exitCode"] == 0 && data["sandboxBackend"] == "macos-seatbelt"
            ) && std::fs::read_to_string(project.join("explicit-model-recovery-marker"))
                .ok()
                .as_deref()
                == Some("fresh")
        ),
    );
    checks.insert(
        "workspaceIntentPreserved".into(),
        json!(
            runtime.session(SESSION)?.header.sandbox_policy == Some(AgentSandboxPolicy::Workspace)
        ),
    );
    checks.insert(
        "sourcePtyUntouched".into(),
        json!(source.writes.load(Ordering::SeqCst) == 0),
    );
    let ready: Value = serde_json::from_slice(
        &std::fs::read(root.join("pipeline-ready.json"))
            .map_err(|_| "Actual model ready missing")?,
    )
    .map_err(|_| "Ready invalid")?;
    let requests = runtime
        .events(AgentSessionEventsRequest {
            session_id: SESSION.into(),
            cursor: None,
            limit: 1000,
        })?
        .events
        .iter()
        .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
        .count();
    checks.insert(
        "noNewModelRequestOnRecovery".into(),
        json!(requests == ready["modelRequests"].as_u64().unwrap_or(0) as usize),
    );
    runtime.shutdown(&sessions).await?;
    Ok(
        json!({"passed":checks.values().all(|value|value==true),"checks":checks,"pid":std::process::id(),"seedModelRequests":ready["modelRequests"],"modelId":"MiniMax-M3","sourcePtyWrites":source.writes.load(Ordering::SeqCst),"scope":"new actual MiniMax-M3 driver journal waiting approval, owned App interruption and production recovery; fresh continuation via explicit NativeAdapter approval, not a second generated model turn"}),
    )
}
