//! Real Wry + production installed NativeAdapter; no model or user database.
use super::*;
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio_util::sync::CancellationToken;
#[path = "native_remote_recovery_check.rs"]
mod recovery;

pub(crate) fn run(root: &Path) -> Result<(), String> {
    if let Ok(mode) = std::env::var("SHELLSPAN_NATIVE_REMOTE_LIFECYCLE_CHECK") {
        return recovery::run(root, &mode);
    }
    if !root.is_absolute()
        || !root.is_dir()
        || std::fs::read_dir(root)
            .map_err(|_| "Remote acceptance directory unavailable")?
            .next()
            .is_some()
    {
        return Err("Remote acceptance requires a new empty absolute directory".into());
    }
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.shellspan.native-remote-check".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.to_owned()),
    );
    let saved = root.to_owned();
    let check_root = saved.clone();
    let app=tauri::Builder::default().manage(ContainerResourceSupervisor::default()).setup(move |app| {
        let handle=app.handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check(&handle,&check_root)))
                .unwrap_or_else(|_| Err("Remote acceptance panicked; no request/credential dump retained".into()));
            let report=match result {Ok(report)=>report,Err(error)=>json!({"passed":false,"scope":"real Wry NativeAdapter; no LLM turn","error":crate::redaction::redact_sensitive_text(&error)})};
            let written=std::fs::write(check_root.join("remote-check.json"),serde_json::to_vec_pretty(&report).unwrap_or_default());
            handle.exit(if report["passed"]==true && written.is_ok() {0} else {1});
        });Ok(())
    }).build(context).map_err(|_| "Remote Wry acceptance application unavailable")?;
    let code = app.run_return(crate::app_exit::handle_event);
    let report: Value = serde_json::from_slice(
        &std::fs::read(saved.join("remote-check.json"))
            .map_err(|_| "Remote acceptance report missing")?,
    )
    .map_err(|_| "Remote acceptance report invalid")?;
    if code != 0 || report["passed"] != true {
        return Err("Remote NativeAdapter acceptance failed; inspect its isolated report".into());
    }
    Ok(())
}

fn request(
    header: &AgentSessionHeader,
    id: &str,
    name: &str,
    args: Value,
) -> Result<NativeToolRequest, String> {
    let target = header
        .target
        .clone()
        .ok_or("Remote acceptance target missing")?;
    Ok(NativeToolRequest {
        sandbox_contract: AgentSandboxContract::freeze(
            header.sandbox_policy,
            &target,
            header.execution_surface,
            0,
        )?
        .bind_to_session(header),
        session_id: header.session_id.clone(),
        task_id: header.task_id.clone(),
        goal: header.goal.clone(),
        success_criteria: header.success_criteria.clone(),
        turn_id: "turn".into(),
        step_id: "step".into(),
        request_id: id.into(),
        model_call: ModelToolCall {
            call_id: id.into(),
            provider_call_id: None,
            name: name.into(),
            arguments: args,
        },
        target,
        permission_mode: AgentSessionPermissionMode::RequestApproval,
        execution_surface: AgentExecutionSurface::Direct,
    })
}

fn check(app: &tauri::AppHandle, root: &Path) -> Result<Value, String> {
    let mut fixture = super::remote_seatbelt::tests::Fixture::new();
    fixture.install(app)?;
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(
        app.path()
            .app_data_dir()
            .map_err(|_| "Remote fixture app directory unavailable")?,
    )?;
    app.manage(runtime.clone());
    runtime.configure_native(app.clone())?;
    let snapshot=runtime.create_session(serde_json::from_value(json!({"sessionId":"remote-adapter","taskId":"remote-adapter-task","goal":"Verify actual remote NativeAdapter",
        "target":fixture.target(),"executionSurface":"direct","sandboxPolicy":"workspace","permissionMode":"requestApproval","successCriteria":["Real SSH frozen policy and native signed controls"]})).map_err(|_| "Remote acceptance session schema failed")?)?;
    let header = snapshot.header;
    let native = runtime.acceptance_native_runtime()?;
    native.prepare_sandbox(&header)?;
    let capability = runtime.session(&header.session_id)?.sandbox_capability;
    if capability.status != AgentSandboxCapabilityStatus::Partial {
        return Err("Remote actual snapshot did not report verified partial".into());
    }
    let arguments = |command: &str, background: bool| json!({"command":command,"explanation":"Explicit native remote acceptance request","timeoutMs":12000,"background":background});
    let denied = native.prepare(request(
        &header,
        "unapproved",
        "run_terminal_command",
        arguments("printf forbidden > unapproved", false),
    )?)?;
    if native
        .execute(&denied.token, false, CancellationToken::new())
        .is_ok()
    {
        return Err("Unapproved remote state change was allowed".into());
    }
    let approved = native.prepare(request(
        &header,
        "approved",
        "run_terminal_command",
        arguments(
            "printf remote-adapter-result > adapter-result; cat adapter-result",
            false,
        ),
    )?)?;
    let result = native.execute(&approved.token, true, CancellationToken::new())?;
    let data = result.data.ok_or("Remote result facts missing")?;
    if data["stdout"] != "remote-adapter-result"
        || data["sandboxBackend"] != "remote-macos-seatbelt"
        || data["sandboxCapability"]["status"] != "partial"
        || data["terminationConfirmed"] != true
        || fixture.read_project("adapter-result")? != "remote-adapter-result"
    {
        return Err("Actual remote adapter execution/result persistence mismatch".into());
    }
    for name in [
        "read_file",
        "write_file",
        "transfer_file",
        "probe_http",
        "call_mcp_tool",
    ] {
        let error = native
            .prepare(request(&header, "unsupported", name, json!({}))?)
            .err()
            .ok_or("Unsupported remote native tool prepared")?;
        if !error.starts_with("sandboxToolUnsupported:") {
            return Err("Remote non-Shell capability rejection mismatch".into());
        }
    }
    let started = native.prepare(request(
        &header,
        "background",
        "run_terminal_command",
        arguments("read value; printf '%s' \"$value\"; exec sleep 30", true),
    )?)?;
    let active = native.execute(&started.token, true, CancellationToken::new())?;
    let handle = active
        .data
        .as_ref()
        .and_then(|data| data["processHandle"].as_str())
        .ok_or("Remote background handle missing")?
        .to_owned();
    let input = native.prepare(request(
        &header,
        "input",
        "write_process_input",
        json!({"processHandle":handle,"input":"adapter-input\n","close":false}),
    )?)?;
    native.execute(&input.token, true, CancellationToken::new())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if runtime.acceptance_process(&handle)?.snapshot()?.stdout == "adapter-input" {
            break;
        }
        if Instant::now() >= deadline {
            return Err("Remote adapter stdin did not reach its real process".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let kill = native.prepare(request(
        &header,
        "kill",
        "kill_process",
        json!({"processHandle":handle,"signal":"kill","timeoutMs":8000}),
    )?)?;
    let killed = native.execute(&kill.token, true, CancellationToken::new())?;
    if killed
        .data
        .as_ref()
        .is_none_or(|data| data["terminationConfirmed"] != true)
    {
        return Err("Remote adapter cancellation cleanup unconfirmed".into());
    }
    let stale = native.prepare(request(
        &header,
        "disconnect",
        "run_terminal_command",
        arguments("printf forbidden > disconnected", false),
    )?)?;
    let reconnect_stale = native.prepare(request(
        &header,
        "reconnect-stale",
        "run_terminal_command",
        arguments("printf forbidden > reconnected-stale", false),
    )?)?;
    fixture.disconnect_source()?;
    if native
        .execute(&stale.token, true, CancellationToken::new())
        .is_ok()
    {
        return Err("Disconnected SSH source approval was reused".into());
    }
    fixture.reconnect_source()?;
    native.prepare_sandbox(&header)?;
    if native
        .execute(&reconnect_stale.token, true, CancellationToken::new())
        .is_ok()
    {
        return Err("Same-identity SSH reconnect revived an old prepared approval".into());
    }
    let restored = native.prepare(request(
        &header,
        "reconnected",
        "run_terminal_command",
        arguments("printf reconnected", false),
    )?)?;
    let restored = native.execute(&restored.token, true, CancellationToken::new())?;
    if restored
        .data
        .as_ref()
        .is_none_or(|data| data["stdout"] != "reconnected")
    {
        return Err("New frozen call did not execute after actual source reconnect".into());
    }
    if fixture.source_writes() != 0 {
        return Err("Direct adapter wrote to the actual source SSH PTY".into());
    }
    let source_writes = fixture.source_writes();
    runtime.prepare_for_shutdown(app.state::<crate::models::SessionManager>().inner())?;
    std::fs::write(root.join("scope.txt"),"Real Wry production NativeAdapter and shared NativeToolEngine; no LLM request or UI rendering claimed.\n").map_err(|_| "Remote scope report unavailable")?;
    Ok(
        json!({"passed":true,"scope":"real Wry production NativeAdapter; no LLM turn or UI rendering","targetPlatform":"macos","restrictedDirect":true,"sameIdentityReconnect":true,
        "sftpCanonicalRoot":true,"operationApproval":true,"signedNativeControls":true,"filePersistence":true,"capabilityFacts":"partial",
        "nonShellRejected":true,"stdin":true,"cancelCleanupConfirmed":true,"disconnectedApprovalRejected":true,"sourcePtyWrites":source_writes}),
    )
}
