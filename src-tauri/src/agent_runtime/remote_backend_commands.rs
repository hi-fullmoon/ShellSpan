use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use super::remote_backend::{
    probe_operation_id, probe_remote_backend, validate_probe_target, RemoteSandboxBackendProbe,
};
use super::AgentRuntime;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSandboxProbeInput {
    session_id: String,
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSandboxVerificationInput {
    target: super::AgentSessionTarget,
    policy: super::AgentSandboxPolicy,
    request_id: String,
}

/// Explicit target-only verification supports the first remote session. It
/// never changes policy or persists a session/grant; normal start rechecks its
/// own actual header and the native source binding.
#[tauri::command]
pub(crate) async fn agent_runtime_verify_remote_sandbox_target(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: RemoteSandboxVerificationInput,
) -> Result<super::remote_seatbelt::RemoteSandboxVerification, String> {
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || {
        super::commands::configure_runtime(&app, &runtime)?;
        runtime.verify_remote_sandbox_target(input.target, input.policy, &input.request_id)
    })
    .await
    .map_err(|_| "Remote target verification worker failed".to_string())?
}

/// Explicit infrastructure inspection, never installation or admission.
#[tauri::command]
pub(crate) async fn agent_runtime_probe_remote_sandbox_backend(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: RemoteSandboxProbeInput,
) -> Result<RemoteSandboxBackendProbe, String> {
    let operation = probe_operation_id(&input.session_id, &input.request_id)?;
    // Register before queuing blocking connection work, so cancellation can
    // stop a probe waiting for a worker slot before any SSH command starts.
    let cancellation = app
        .state::<crate::execution::ExecutionCancellationRegistry>()
        .register(operation)
        .map_err(|error| error.to_string())?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || {
        super::commands::configure_runtime(&app, &runtime)?;
        let snapshot = runtime.session(&input.session_id)?;
        if snapshot.ended || snapshot.archived {
            return Err("sandboxAuthorizationInvalid: session closed".into());
        }
        let sessions = app.state::<crate::models::SessionManager>();
        let target = validate_probe_target(&snapshot.header, &sessions)?;
        let database = app.state::<crate::db::Database>();
        let binding =
            super::remote_binding::RemoteExecutionBinding::capture(&target, &sessions, &database)?
                .ok_or("Remote sandbox probe requires a remote execution binding")?;
        let credentials = app.state::<crate::keychain::CredentialManager>();
        let known_hosts = crate::known_hosts::known_hosts_path(&app)?;
        let result = probe_remote_backend(
            &snapshot.header,
            &target,
            &database,
            &credentials,
            cancellation,
            &known_hosts,
            &input.request_id,
        )?;
        let latest = runtime.session(&input.session_id)?;
        if latest.ended || latest.archived || latest.header != snapshot.header {
            return Err("sandboxAuthorizationInvalid: session changed during remote probe".into());
        }
        validate_probe_target(&latest.header, &sessions)?;
        binding.validate(&target, &sessions, &database)?;
        // Recheck the stored profile too; the result is discarded if an account
        // or connection was edited while the SSH worker was active.
        super::connection_for_remote_target(&target, &database, &credentials)?;
        Ok(result)
    })
    .await
    .map_err(|_| "Remote sandbox probe worker failed".to_string())?
}

#[tauri::command]
pub(crate) fn agent_runtime_cancel_remote_sandbox_probe(
    cancellations: State<'_, crate::execution::ExecutionCancellationRegistry>,
    input: RemoteSandboxProbeInput,
) -> Result<(), String> {
    let operation = probe_operation_id(&input.session_id, &input.request_id)?;
    cancellations
        .cancel(&operation)
        .map_err(|error| error.to_string())
}
