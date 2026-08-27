use super::events::AGENT_EVENT_NAME_V1;
use super::manager::{AgentManager, AgentManagerOutcome};
use super::protocol::{
    AgentActionRequestV1, AgentActionResultV1, AgentCommandErrorV1, AgentGetSnapshotRequestV1,
    AgentRunSnapshotV1, AgentSendMessageRequestV1, AgentStartRequestV1, AgentStartResultV1,
};
use log::warn;
use tauri::{AppHandle, Emitter, Manager, State};

fn emit_events<T>(app: &AppHandle, outcome: AgentManagerOutcome<T>) -> T {
    for event in outcome.events {
        if let Err(error) = app.emit(AGENT_EVENT_NAME_V1, event) {
            // The journal and snapshot remain authoritative when a panel has no
            // listener or an individual delivery fails.
            warn!("Failed to emit Agent event; the panel must resync from snapshot: {error}");
        }
    }
    outcome.value
}

#[tauri::command]
pub(crate) fn agent_start(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    request: AgentStartRequestV1,
) -> Result<AgentStartResultV1, AgentCommandErrorV1> {
    manager
        .start(request)
        .map(|outcome| emit_events(&app, outcome))
}

#[tauri::command]
pub(crate) fn agent_get_snapshot(
    manager: State<'_, AgentManager>,
    request: AgentGetSnapshotRequestV1,
) -> Result<AgentRunSnapshotV1, AgentCommandErrorV1> {
    manager.get_snapshot(request)
}

#[tauri::command]
pub(crate) fn agent_pause(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    request: AgentActionRequestV1,
) -> Result<AgentActionResultV1, AgentCommandErrorV1> {
    manager
        .pause(request)
        .map(|outcome| emit_events(&app, outcome))
}

#[tauri::command]
pub(crate) fn agent_resume(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    request: AgentActionRequestV1,
) -> Result<AgentActionResultV1, AgentCommandErrorV1> {
    manager
        .resume(request)
        .map(|outcome| emit_events(&app, outcome))
}

#[tauri::command]
pub(crate) fn agent_stop(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    request: AgentActionRequestV1,
) -> Result<AgentActionResultV1, AgentCommandErrorV1> {
    manager
        .stop(request)
        .map(|outcome| emit_events(&app, outcome))
}

#[tauri::command]
pub(crate) fn agent_send_message(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    request: AgentSendMessageRequestV1,
) -> Result<AgentActionResultV1, AgentCommandErrorV1> {
    manager
        .send_message(request)
        .map(|outcome| emit_events(&app, outcome))
}

pub(crate) fn cancel_active_for_app_exit(app: &AppHandle) {
    let Some(manager) = app.try_state::<AgentManager>() else {
        return;
    };
    match manager.cancel_active_for_app_exit() {
        Ok(outcome) => {
            let _ = emit_events(app, outcome);
        }
        Err(error) => warn!(
            "Failed to cancel the active Agent run before application exit: {}",
            error.message
        ),
    }
}
