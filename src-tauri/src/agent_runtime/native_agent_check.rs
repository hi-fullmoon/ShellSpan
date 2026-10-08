//! Debug acceptance with a real Wry app, configured model and native adapter.
//! It never changes the source database or writes model credentials.
use super::*;
use crate::{
    db::Database,
    keychain::CredentialManager,
    llm::routes::{RouteAuth, RouteSnapshot, RouteStore, ROUTES_KEY},
    models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
        SessionStatus, SessionTerminalKind, StatusEvent,
    },
};
use std::{
    collections::HashMap,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const NORMAL_COMMAND: &str =
    "printf 'native-model-accepted\\n' > model-result.txt && cat model-result.txt";

#[path = "native_shutdown_check.rs"]
mod shutdown_check;

#[path = "native_restore_check.rs"]
mod restore_check;

#[path = "native_pipeline_recovery_check.rs"]
mod pipeline_recovery_check;

#[path = "native_model_recovery_check.rs"]
mod model_recovery_check;

pub(super) struct SourcePty {
    sender: mpsc::Sender<SessionCommand>,
    worker: Option<std::thread::JoinHandle<()>>,
    writes: Arc<AtomicUsize>,
}
impl SourcePty {
    pub(super) fn source_writes(&self) -> usize {
        self.writes.load(Ordering::SeqCst)
    }
}
impl Drop for SourcePty {
    fn drop(&mut self) {
        let _ = self.sender.send(SessionCommand::Close);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(super) fn source(sessions: &SessionManager, root: &Path) -> Result<SourcePty, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| "Acceptance PTY unavailable")?;
    let mut command = CommandBuilder::new("/bin/sh");
    command.cwd(root);
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|_| "Acceptance source shell unavailable")?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|_| "Acceptance PTY writer unavailable")?;
    let (sender, receiver) = mpsc::channel();
    let writes = Arc::new(AtomicUsize::new(0));
    let count = writes.clone();
    let worker = std::thread::spawn(move || {
        while let Ok(command) = receiver.recv() {
            match command {
                SessionCommand::Write(input) => {
                    count.fetch_add(1, Ordering::SeqCst);
                    if writer
                        .write_all(input.as_bytes())
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
                SessionCommand::WriteBytes(input) => {
                    count.fetch_add(1, Ordering::SeqCst);
                    if writer
                        .write_all(&input)
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
                SessionCommand::Resize { cols, rows } => {
                    let _ = pair.master.resize(PtySize {
                        cols: cols as u16,
                        rows: rows as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                SessionCommand::Close => break,
            }
        }
        drop(writer);
        drop(pair);
        let _ = child.kill();
        let _ = child.wait();
    });
    sessions.insert(
        "acceptance-source".into(),
        ManagedSession {
            sender: SessionCommandSender::Standard(sender.clone()),
            waker: None,
            output_state_sender: None,
            status: StatusEvent {
                session_id: "acceptance-source".into(),
                status: SessionStatus::Connected,
                message: None,
            },
            output_ready: Arc::new(AtomicBool::new(true)),
            output_paused: Arc::new(AtomicBool::new(false)),
            terminal_kind: SessionTerminalKind::Local,
            identity: SessionIdentity {
                title: "Isolated native acceptance".into(),
                host: "local".into(),
                port: 0,
                username: std::env::var("USER").unwrap_or_default(),
            },
        },
    )?;
    Ok(SourcePty {
        sender,
        worker: Some(worker),
        writes,
    })
}

pub(crate) fn run(
    root: &Path,
    cancel: bool,
    session_reads: bool,
    network: bool,
    cache_writes: bool,
) -> Result<(), String> {
    if let Some(mode) = std::env::var_os("SHELLSPAN_NATIVE_SHUTDOWN_CHECK") {
        return match mode.to_str() {
            Some("normal") => shutdown_check::run(root, false, false),
            Some("undrained") => shutdown_check::run(root, true, false),
            Some("exit-active") => shutdown_check::run(root, false, true),
            Some("local-crash-seed") | Some("local-crash-reopen") => {
                shutdown_check::run(root, false, false)
            }
            Some("restore-seed") => restore_check::run(root, false),
            Some("restore-reopen") => restore_check::run(root, true),
            Some("pipeline-waiting-seed") => pipeline_recovery_check::run(root, false, false),
            Some("pipeline-waiting-reopen") => pipeline_recovery_check::run(root, true, false),
            Some("pipeline-unknown-seed") => pipeline_recovery_check::run(root, false, true),
            Some("pipeline-unknown-reopen") => pipeline_recovery_check::run(root, true, true),
            Some("model-waiting-seed") => model_recovery_check::run(root, false, false),
            Some("model-waiting-reopen") => model_recovery_check::run(root, true, false),
            Some("model-unknown-seed") => model_recovery_check::run(root, false, true),
            Some("model-unknown-reopen") => model_recovery_check::run(root, true, true),
            _ => Err("Unknown native shutdown check mode".into()),
        };
    }
    if !root.is_absolute()
        || !root.is_dir()
        || std::fs::read_dir(root)
            .map_err(|_| "Acceptance directory unavailable")?
            .next()
            .is_some()
    {
        return Err("Acceptance requires a new empty absolute directory".into());
    }
    let root = root.to_path_buf();
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    if std::env::var_os("SHELLSPAN_NATIVE_READ_GUI").is_some_and(|value| value == "1") {
        context.config_mut().build.frontend_dist = Some(tauri::utils::config::FrontendDist::Url(
            "http://localhost:1420"
                .parse()
                .map_err(|_| "Acceptance frontend URL invalid")?,
        ));
    }
    context.config_mut().identifier = "com.shellspan.native-agent-check".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.clone()),
    );
    let failure_root = root.clone();
    let app = tauri::Builder::default()
        .manage(ContainerResourceSupervisor::default())
        .manage(crate::petdex::PetdexAdapter::new(root.clone()))
        .invoke_handler(tauri::generate_handler![
            super::commands::agent_runtime_get_session,
            super::commands::agent_runtime_revoke_sandbox_reads,
            super::commands::agent_runtime_get_sandbox_authorizations,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                match initialize(&handle, &root) {
                    Ok((runtime, llm, selection, workspace, source)) => {
                        tauri::async_runtime::spawn(async move {
                            let outcome = check(runtime.clone(), llm, selection, workspace, source, cancel, session_reads, network, cache_writes, handle.clone()).await;
                            if outcome.is_err() { let _ = runtime.prepare_for_shutdown(handle.state::<SessionManager>().inner()); }
                            let report = match &outcome { Ok(report) => report.clone(), Err(error) => serde_json::json!({"passed":false,"error":crate::redaction::redact_sensitive_text(error)}) };
                            let saved = std::fs::write(root.join("model-check.json"), serde_json::to_vec_pretty(&report).unwrap_or_default());
                            handle.exit(if outcome.is_ok() && saved.is_ok() {0} else {1});
                        });
                    }
                    Err(error) => {
                        let report = serde_json::json!({"passed":false,"error":crate::redaction::redact_sensitive_text(&error)});
                        let _ = std::fs::write(root.join("model-check.json"), report.to_string());
                        handle.exit(1);
                    }
                }
            });
            Ok(())
        }).build(context).map_err(|_| "Native acceptance setup failed; inspect system credential access and default model")?;
    app.run(crate::app_exit::handle_event);
    if !failure_root.join("model-check.json").exists() {
        return Err("Native acceptance did not produce a report".into());
    }
    let report: serde_json::Value = serde_json::from_slice(
        &std::fs::read(failure_root.join("model-check.json"))
            .map_err(|_| "Acceptance report unavailable")?,
    )
    .map_err(|_| "Acceptance report invalid")?;
    if report["passed"] != true {
        return Err("Real model acceptance failed; inspect its private report".into());
    }
    Ok(())
}

type PreparedCheck = (
    AgentRuntime,
    crate::llm::runtime::LlmRuntime,
    crate::llm::routes::ModelSelection,
    std::path::PathBuf,
    SourcePty,
);
fn initialize(app: &tauri::AppHandle, root: &Path) -> Result<PreparedCheck, String> {
    let home = std::env::home_dir().ok_or("Acceptance home unavailable")?;
    let database = rusqlite::Connection::open_with_flags(
        home.join(".shellspan-dev/shellspan-v1.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Development model database unavailable")?;
    let document: String = database
        .query_row(
            "SELECT value FROM preferences WHERE key=?1",
            [ROUTES_KEY],
            |row| row.get(0),
        )
        .map_err(|_| "Development model routes unavailable")?;
    let snapshot: RouteSnapshot =
        serde_json::from_str(&document).map_err(|_| "Development model route document invalid")?;
    let selection = snapshot
        .default_selection
        .as_ref()
        .ok_or("Default model is not configured")?
        .clone();
    if selection.model_id != "MiniMax-M3" {
        return Err("Default model changed; acceptance selection must be reviewed".into());
    }
    let route = snapshot.route(&selection.route_id)?.clone();
    let reference = match &route.auth {
        RouteAuth::Keychain { reference } => Some(reference.clone()),
        RouteAuth::None => None,
    };
    let credentials = CredentialManager::readonly_model_check(reference);
    let private_database = Database::open(&root.join("acceptance.db"))?;
    private_database.save_preferences(&[(ROUTES_KEY.into(), document)])?;
    let routes = RouteStore::open(private_database.clone(), credentials.clone())?;
    let llm = crate::llm::runtime::LlmRuntime { routes };
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(
        app.path()
            .app_data_dir()
            .map_err(|_| "Acceptance app directory unavailable")?,
    )?;
    runtime.configure_llm(llm.clone())?;
    runtime.configure_credentials(credentials.clone())?;
    let sessions = SessionManager::default();
    let workspace = root.join("project");
    std::fs::create_dir(&workspace).map_err(|_| "Acceptance project unavailable")?;
    let source = source(&sessions, &workspace)?;
    app.manage(private_database);
    app.manage(credentials);
    app.manage(llm.clone());
    app.manage(sessions);
    app.manage(runtime.clone());
    runtime.configure_native(app.clone())?;
    Ok((runtime, llm, selection, workspace, source))
}

async fn check(
    runtime: AgentRuntime,
    llm: crate::llm::runtime::LlmRuntime,
    selection: crate::llm::routes::ModelSelection,
    workspace: std::path::PathBuf,
    source: SourcePty,
    cancel: bool,
    session_reads: bool,
    network: bool,
    cache_writes: bool,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let session_id = format!("native-model-{}", uuid::Uuid::new_v4());
    let cache = if cache_writes {
        Some(tempfile::tempdir().map_err(|_| "Acceptance cache unavailable")?)
    } else {
        None
    };
    let cache_path = cache
        .as_ref()
        .map(|cache| std::fs::canonicalize(cache.path()))
        .transpose()
        .map_err(|_| "Acceptance cache path unavailable")?;
    let cache_command = if let Some(path) = &cache_path {
        let output = path.join("ordinary.txt");
        let output = crate::terminal_integration::quote_remote_posix(
            output.to_str().ok_or("Acceptance cache path invalid")?,
        );
        format!("printf 'native-session-read-accepted\\n' > {output}; cat {output}")
    } else {
        String::new()
    };
    runtime.create_session(serde_json::from_value(serde_json::json!({
        "sessionId":session_id, "taskId":session_id, "goal":"Execute ordinary command in isolated project",
        "target":{"kind":"local","targetId":"acceptance-local","sessionId":"acceptance-source","cwd":workspace},
        "sandboxPolicy":"workspace", "executionSurface":"direct", "permissionMode":if session_reads {"operator"} else {"requestApproval"}, "successCriteria":["Native command returns the actual file contents"],
    })).map_err(|_| "Acceptance session request invalid")?)?;
    let routes = llm.routes.snapshot()?;
    let route = routes.route(&selection.route_id)?;
    runtime.start(
        &session_id,
        route.provider(&selection)?,
        llm.routes.credential(route)?,
    )?;
    let submission = format!("input-{}", uuid::Uuid::new_v4());
    let read_path = workspace.join(".env.acceptance");
    if session_reads && !cache_writes {
        std::fs::write(&read_path, "native-session-read-accepted\n")
            .map_err(|_| "Acceptance configuration unavailable")?;
    }
    let read_path = if session_reads && !cache_writes {
        std::fs::canonicalize(read_path).map_err(|_| "Acceptance configuration path unavailable")?
    } else {
        read_path
    };
    let command = if cache_writes {
        cache_command.as_str()
    } else if network {
        "pnpm view react version --registry=https://registry.npmjs.org"
    } else if session_reads {
        "cat .env.acceptance"
    } else if cancel {
        "sleep 30"
    } else {
        NORMAL_COMMAND
    };
    let read_instruction = if cache_writes {
        format!(" Include writePaths=[{:?}] and no other resource requests. This exact dedicated account-owned temporary cache directory is explicitly approved for read/write outside the frozen project; do not access any other external path.", cache_path.as_ref().ok_or("Acceptance cache missing")?.to_string_lossy())
    } else if network {
        " Include networkTargets=[{\"host\":\"registry.npmjs.org\",\"port\":443,\"resolver\":\"cloudflare\"}]. The client explicitly approves this public npm destination and sending that public hostname to Cloudflare encrypted DNS.".into()
    } else if session_reads {
        format!(
            " Include readPaths=[{:?}] in the tool arguments.",
            read_path.to_string_lossy()
        )
    } else {
        String::new()
    };
    runtime.receive_submission(&session_id, submission.clone(), submission,
        format!("This is an isolated native execution acceptance. Call run_terminal_command exactly once with command={command:?} and background={cancel}.{read_instruction} Do not access paths outside the frozen project except exact explicitly approved resources, call other tools, change settings or delete files. The client will approve only this exact command and specified resources. After the real tool result, report its actual state briefly. Do not simulate a tool result. Do not wait for or kill the background process; the client is responsible for cancellation."), None, AgentInboxLane::NextTurn, false, None)?;
    let started = Instant::now();
    let mut cursor = None;
    let mut calls = HashMap::new();
    let mut requests = 0;
    let mut completed = 0;
    let mut approvals = 0;
    let mut phase = 0;
    while started.elapsed() < Duration::from_secs(240) {
        let events = runtime.events(AgentSessionEventsRequest {
            session_id: session_id.clone(),
            cursor,
            limit: 1000,
        })?;
        for event in events.events {
            cursor = Some(event.seq.saturating_add(1));
            match event.payload {
                AgentSessionEventPayload::RequestStart { .. } => requests += 1,
                AgentSessionEventPayload::ToolCall { call } => {
                    calls.insert(call.call_id.clone(), call);
                }
                AgentSessionEventPayload::ToolApproval {
                    request_id,
                    call_id,
                    approval_id: Some(approval_id),
                    status: AgentToolApprovalStatus::Requested,
                    ..
                } => {
                    let input = AgentToolDecisionInput {
                        session_id: session_id.clone(),
                        turn_id: event.turn_id.ok_or("Acceptance turn identity missing")?,
                        step_id: event.step_id.ok_or("Acceptance step identity missing")?,
                        request_id,
                        call_id: call_id.clone(),
                        approval_id,
                    };
                    let allowed = calls.get(&call_id).is_some_and(|call: &RecordedToolCall| {
                        call.name == "run_terminal_command"
                            && call.arguments["command"].as_str() == Some(command)
                            && call.arguments["background"].as_bool().unwrap_or(false) == cancel
                            && (!session_reads
                                || cache_writes
                                || call.arguments["readPaths"] == serde_json::json!([read_path]))
                            && (!cache_writes || (call.arguments["writePaths"] == serde_json::json!([cache_path])
                                && call.arguments["readPaths"].as_array().is_none_or(|paths| paths.is_empty())
                                && call.arguments["networkTargets"].as_array().is_none_or(|targets| targets.is_empty())
                                && call.arguments["localServices"].as_array().is_none_or(|services| services.is_empty())))
                            && (!network || call.arguments["networkTargets"] == serde_json::json!([{"host":"registry.npmjs.org","port":443,"resolver":"cloudflare"}]))
                    });
                    if !allowed {
                        runtime.reject_tool(input).await?;
                        return Err(
                            "Model requested an operation outside the approved acceptance scope"
                                .into(),
                        );
                    }
                    approvals += 1;
                    if session_reads {
                        if phase == 1 {
                            runtime.reject_tool(input).await?;
                            return Err(
                                "Remembered resource authorization unexpectedly required approval"
                                    .into(),
                            );
                        }
                        if phase == 2 {
                            runtime.reject_tool(input).await?;
                            if completed != 2
                                || approvals != 2
                                || source.writes.load(Ordering::SeqCst) != 0
                            {
                                return Err("Session revocation evidence incomplete".into());
                            }
                            return Ok(
                                serde_json::json!({"passed":true,"mode":if cache_writes {"cache-writes"} else {"session-reads"},"modelId":selection.model_id,"requests":requests,"nativeResults":completed,"initialApproval":true,"reusedWithoutApproval":true,"approvalRequiredAfterRevocation":true,"sourcePtyWrites":0}),
                            );
                        }
                        runtime
                            .approve_tool_scoped(
                                input,
                                super::sandbox_authorization::ResourceAuthorizationScope::Session,
                            )
                            .await?;
                    } else {
                        runtime.approve_tool(input).await?;
                    }
                }
                AgentSessionEventPayload::ToolResult {
                    status: AgentToolResultStatus::Completed,
                    data: Some(data),
                    ..
                } if cancel
                    && data["sandboxBackend"] == "macos-seatbelt"
                    && data["state"] == "running" =>
                {
                    let handle = data["processHandle"]
                        .as_str()
                        .ok_or("Background result omitted process handle")?;
                    let process = runtime.acceptance_process(handle)?;
                    let stopped = runtime.cancel(&session_id).await?;
                    let result = process.snapshot()?;
                    if requests == 0
                        || source.writes.load(Ordering::SeqCst) != 0
                        || !result.termination_confirmed
                        || result.state != ProcessLifecycleNative::Cancelled
                        || !stopped.ended
                    {
                        return Err("Real model cancellation was not confirmed".into());
                    }
                    return Ok(
                        serde_json::json!({"passed":true,"mode":"cancel","modelId":selection.model_id,"sessionId":session_id,"requests":requests,"sourcePtyWrites":0,"processLifecycle":result.state,"terminationConfirmed":result.termination_confirmed,"sessionEnded":stopped.ended}),
                    );
                }
                AgentSessionEventPayload::ToolResult {
                    status: AgentToolResultStatus::Completed,
                    data: Some(data),
                    ..
                } if data["sandboxBackend"] == "macos-seatbelt" && data["exitCode"] == 0 => {
                    if network
                        && (data["networkProxy"]["closed"] != true
                            || data["networkProxy"]["connectionsStarted"]
                                .as_u64()
                                .unwrap_or(0)
                                == 0
                            || data["stdout"]
                                .as_str()
                                .is_none_or(|text| text.trim().is_empty()))
                    {
                        return Err("Network model turn omitted real proxy evidence".into());
                    }
                    if session_reads && data["stdout"] != "native-session-read-accepted\n" {
                        return Err("Native session read returned unexpected file contents".into());
                    }
                    completed += 1;
                }
                AgentSessionEventPayload::TurnEnd { reason } => {
                    if network {
                        if reason != "completed"
                            || completed != 1
                            || approvals != 1
                            || requests < 2
                            || source.writes.load(Ordering::SeqCst) != 0
                        {
                            return Err("Network model acceptance evidence incomplete".into());
                        }
                        return Ok(
                            serde_json::json!({"passed":true,"mode":"network","modelId":selection.model_id,"requests":requests,"nativeResults":completed,"proxyClosed":true,"sourcePtyWrites":0}),
                        );
                    }
                    if session_reads {
                        if reason != "completed" || completed != phase + 1 || approvals != 1 {
                            return Err("Session read model turn did not complete with expected authorization".into());
                        }
                        phase += 1;
                        if phase == 2 {
                            if std::env::var_os("SHELLSPAN_NATIVE_READ_GUI")
                                .is_some_and(|value| value == "1")
                            {
                                tauri::WebviewWindowBuilder::new(
                                    &app,
                                    "main",
                                    tauri::WebviewUrl::App(format!("src/components/ai/__tests__/sandbox-revoke-native.html?session={session_id}").into()),
                                ).title("ShellSpan native read authorization acceptance").inner_size(620.0, 560.0).build()
                                    .map_err(|_| "Native revocation window unavailable")?;
                                let waiting = Instant::now();
                                while runtime.acceptance_is_active(&session_id)? {
                                    if waiting.elapsed() > Duration::from_secs(120) {
                                        return Err("Native GUI revocation was not received".into());
                                    }
                                    tokio::time::sleep(Duration::from_millis(200)).await;
                                }
                            } else {
                                runtime
                                    .revoke_sandbox_reads(
                                        &session_id,
                                        app.state::<SessionManager>().inner(),
                                    )
                                    .await?;
                            }
                            runtime.start(
                                &session_id,
                                route.provider(&selection)?,
                                llm.routes.credential(route)?,
                            )?;
                        }
                        let submission = format!("input-{}", uuid::Uuid::new_v4());
                        runtime.receive_submission(&session_id, submission.clone(), submission,
                            format!("Perform the same real foreground read again: run_terminal_command command={command:?}, background=false.{read_instruction} Call exactly once and then report the actual result. No other operations."),
                            None, AgentInboxLane::NextTurn, false, None)?;
                        continue;
                    }
                    let contents = std::fs::read_to_string(workspace.join("model-result.txt"))
                        .map_err(|_| "Model turn ended without real project output")?;
                    if reason != "completed"
                        || contents != "native-model-accepted\n"
                        || completed != 1
                        || requests < 2
                        || source.writes.load(Ordering::SeqCst) != 0
                    {
                        return Err("Model acceptance evidence is incomplete".into());
                    }
                    return Ok(
                        serde_json::json!({"passed":true,"mode":"normal","modelId":selection.model_id,"sessionId":session_id,"requests":requests,"nativeResults":completed,"sourcePtyWrites":0,"turnEndReason":reason,"capability":runtime.session(&session_id)?.sandbox_capability}),
                    );
                }
                _ => {}
            }
        }
        if runtime.session(&session_id)?.status == AgentSessionStatus::Failed {
            return Err(
                "Real model session failed; retained private events contain its diagnostics".into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    runtime.cancel(&session_id).await?;
    Err("Real model acceptance timed out; session cancelled without replay".into())
}
