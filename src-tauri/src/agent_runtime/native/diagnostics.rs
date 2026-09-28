//! Fixed collector dispatch through the existing bounded, cancellable process transport.
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::{
    validate_diagnostic_arguments, AgentObservedEffectNative, AgentRequestNative,
    AgentToolCallNative, AgentToolResultNative, AgentToolResultStatusNative, AgentToolTargetNative,
    ProcessSignalNative,
};
use crate::models::RemoteConnectionRequest;

use super::{
    spawn_fixed_local_process_native, spawn_remote_diagnostic_process_native,
    ProcessLifecycleNative, ProcessRegistryNative, RemoteProcessStartNative,
};

const COLLECTOR: &str = include_str!("diagnostic_collector.py");

fn collector_arguments(call: &AgentToolCallNative) -> Result<[String; 6], String> {
    validate_diagnostic_arguments(&call.tool_name, &call.arguments)?;
    let mut arguments = call.arguments.clone();
    arguments["_targetId"] = json!(call.target.target_id());
    arguments["_networkDenyList"] = json!(crate::connection::network_destination_deny_list());
    let payload =
        STANDARD.encode(serde_json::to_vec(&arguments).map_err(|_| "invalid collector input")?);
    // Only application-owned code is executable; the entire user payload remains JSON data.
    let loader = format!(
        "import base64;exec(compile(base64.b64decode('{}'),'<shellspan-diagnostics>','exec'))",
        STANDARD.encode(COLLECTOR)
    );
    Ok([
        "python3".into(),
        "-I".into(),
        "-c".into(),
        loader,
        call.tool_name.clone(),
        payload,
    ])
}

pub(super) fn execute_diagnostic(
    request: &AgentRequestNative,
    call: &AgentToolCallNative,
    effect: &AgentObservedEffectNative,
    remote: Option<RemoteConnectionRequest>,
    known_hosts: &Path,
    processes: &ProcessRegistryNative,
    cancellation: &CancellationToken,
) -> Result<AgentToolResultNative, String> {
    let arguments = collector_arguments(call)?;
    let deadline = Instant::now()
        + Duration::from_millis(call.arguments["timeoutMs"].as_u64().unwrap_or(10_000));
    if cancellation.is_cancelled() {
        return Ok(result(
            request,
            call,
            effect,
            AgentToolResultStatusNative::Cancelled,
            json!({"status":"cancelled","code":"cancelledBeforeDispatch"}),
        ));
    }
    if cfg!(windows) && matches!(call.target, AgentToolTargetNative::Local { .. }) {
        return Ok(result(
            request,
            call,
            effect,
            AgentToolResultStatusNative::Failed,
            json!({"status":"unavailable","code":"unsupported","detail":"local diagnostic collection requires a POSIX host"}),
        ));
    }
    processes.ensure_capacity()?;
    if processes.running_count()? >= 4 {
        return Err("diagnostic process concurrency limit reached".into());
    }
    // Collector has its own deadline, including DNS and subprocesses. Transport gets a
    // short grace period to collect its final structured timeout result and reap it.
    let timeout = Duration::from_millis(call.arguments["timeoutMs"].as_u64().unwrap_or(10_000))
        + Duration::from_secs(2);
    let process = match &call.target {
        AgentToolTargetNative::Local { target_id, .. } => {
            let mut command = std::process::Command::new(&arguments[0]);
            command.args(&arguments[1..]);
            spawn_fixed_local_process_native(
                request.task_id.clone(),
                request.request_id.clone(),
                target_id.clone(),
                command,
                timeout,
            )?
        }
        AgentToolTargetNative::Remote { target_id, .. } => spawn_remote_diagnostic_process_native(
            RemoteProcessStartNative {
                task_id: request.task_id.clone(),
                request_id: request.request_id.clone(),
                owner_target_id: target_id.clone(),
                command: shlex::try_join(arguments.iter().map(String::as_str))
                    .map_err(|_| "could not encode fixed collector command")?,
                connection: remote
                    .ok_or("diagnostics require the authenticated frozen remote connection")?,
                known_hosts_path: known_hosts.to_path_buf(),
                timeout,
            },
            cancellation,
            deadline,
        )?,
        _ => return Err("diagnostics require a frozen host target".into()),
    };
    if let Err(error) = processes.insert(Arc::clone(&process)) {
        let _ = process.kill(ProcessSignalNative::Kill, Duration::from_secs(1));
        return Err(error);
    }
    let snapshot = loop {
        let snapshot = process.wait(Duration::from_millis(50))?;
        if snapshot.state.is_terminal() {
            break snapshot;
        }
        if cancellation.is_cancelled() {
            break process.kill(ProcessSignalNative::Kill, Duration::from_secs(1))?;
        }
    };
    if snapshot.state.is_terminal() {
        processes.remove_terminal(&snapshot.process_handle, snapshot.state)?;
    }
    let (status, mut data) = if cancellation.is_cancelled()
        || snapshot.state == ProcessLifecycleNative::Cancelled
    {
        (
            AgentToolResultStatusNative::Cancelled,
            json!({"status":"cancelled","terminationConfirmed":snapshot.termination_confirmed}),
        )
    } else if snapshot.state == ProcessLifecycleNative::TimedOut {
        (
            AgentToolResultStatusNative::TimedOut,
            json!({"status":"timedOut","code":"transportDeadlineExceeded","terminationConfirmed":snapshot.termination_confirmed}),
        )
    } else if snapshot.exit_code != Some(0) || snapshot.stdout_truncated {
        // Do not include the transport's command or stderr: they can contain shell
        // startup content. Missing Python is a capability gap, never host failure.
        (
            AgentToolResultStatusNative::Failed,
            json!({"status":"unavailable","code":"collectorUnavailable","exitCode":snapshot.exit_code,"detail":"requires Python 3.8+ with standard-library SSL on the target; collection did not complete"}),
        )
    } else {
        let data: Value = serde_json::from_str(&snapshot.stdout)
            .map_err(|_| "diagnostic collector returned invalid or redacted JSON".to_string())?;
        if data["schemaVersion"] != 1 || data["targetId"].as_str() != Some(call.target.target_id())
        {
            return Err("diagnostic collector returned a mismatched envelope".into());
        }
        let status = match data["status"].as_str() {
            Some("ok") => AgentToolResultStatusNative::Completed,
            Some("timedOut") => AgentToolResultStatusNative::TimedOut,
            _ => AgentToolResultStatusNative::Failed,
        };
        (status, data)
    };
    data["targetId"] = json!(call.target.target_id());
    data["evidenceRef"] = json!(call.call_id);
    data["collectionStartedAtUnixMs"] = json!(snapshot.started_at_unix_ms);
    data["collectionCompletedAtUnixMs"] = json!(snapshot.completed_at_unix_ms);
    Ok(result(request, call, effect, status, data))
}

fn result(
    request: &AgentRequestNative,
    call: &AgentToolCallNative,
    effect: &AgentObservedEffectNative,
    mut status: AgentToolResultStatusNative,
    mut data: Value,
) -> AgentToolResultNative {
    data["schemaVersion"] = json!(1);
    data["targetId"] = json!(call.target.target_id());
    data["evidenceRef"] = json!(call.call_id);
    if data.get("collectedAtUnixMs").is_none() {
        data["collectedAtUnixMs"] = json!(super::current_unix_ms());
    }
    let mut data = crate::redaction::redact_json_value(&data);
    if serde_json::to_vec(&data).map_or(true, |bytes| bytes.len() > 256 * 1024) {
        status = AgentToolResultStatusNative::Failed;
        data = json!({"schemaVersion":1,"targetId":call.target.target_id(),
            "evidenceRef":call.call_id,"collectedAtUnixMs":super::current_unix_ms(),
            "status":"unavailable","code":"outputLimit","truncated":true});
    }
    AgentToolResultNative {
        request_id: request.request_id.clone(),
        call_id: call.call_id.clone(),
        tool_name: call.tool_name.clone(),
        target_id: call.target.target_id().into(),
        status,
        summary: format!(
            "{}: {}",
            call.tool_name,
            data["status"].as_str().unwrap_or("unavailable")
        ),
        truncated: Some(data["truncated"].as_bool().unwrap_or(false)),
        data: Some(data),
        artifacts: Vec::new(),
        effects: vec![effect.clone()],
    }
}

#[cfg(test)]
#[path = "__tests__/diagnostics.rs"]
mod tests;
