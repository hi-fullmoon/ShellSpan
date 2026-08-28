//! Narrow user control plane for an already-registered Agent terminal run.
//!
//! There is intentionally no proposal, execute, launch, generic session-input,
//! or raw Agent-terminal command here. Model proposals enter the crate-private
//! coordinator seam. The only raw string accepted by IPC is the user's first
//! input on the atomic takeover-and-write operation.

use super::terminal_audit::DatabaseTerminalAuditWriterV1;
use super::terminal_coordinator::{
    AgentTerminalCoordinatorV1, AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1,
    TerminalResolveApprovalRequestV1, TerminalRunControlRequestV1,
    TerminalTakeoverAndWriteRequestV1,
};
use crate::db::{current_timestamp_ms, Database};
use crate::models::SessionManager;
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalSnapshotRequestV1 {
    schema_version: u8,
    run_id: String,
}

fn now_ms_v1() -> u64 {
    current_timestamp_ms().max(0) as u64
}

#[tauri::command]
pub(crate) fn agent_terminal_get_snapshot(
    coordinator: State<'_, AgentTerminalCoordinatorV1>,
    request: TerminalSnapshotRequestV1,
) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
    if request.schema_version != 1 {
        return Err(TerminalCoordinatorErrorV1::invalid_contract(
            "terminal snapshot schemaVersion must be 1",
        ));
    }
    coordinator.snapshot(&request.run_id)
}

#[tauri::command]
pub(crate) fn agent_terminal_resolve_approval(
    coordinator: State<'_, AgentTerminalCoordinatorV1>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    request: TerminalResolveApprovalRequestV1,
) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
    let audit = DatabaseTerminalAuditWriterV1::new(database.inner());
    coordinator.resolve_approval(request, now_ms_v1(), sessions.inner(), &audit)
}

#[tauri::command]
pub(crate) fn agent_terminal_takeover_and_write(
    coordinator: State<'_, AgentTerminalCoordinatorV1>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    request: TerminalTakeoverAndWriteRequestV1,
) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
    let audit = DatabaseTerminalAuditWriterV1::new(database.inner());
    coordinator.takeover_and_write(request, now_ms_v1(), sessions.inner(), &audit)
}

#[tauri::command]
pub(crate) fn agent_terminal_return_control(
    coordinator: State<'_, AgentTerminalCoordinatorV1>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    request: TerminalRunControlRequestV1,
) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
    let audit = DatabaseTerminalAuditWriterV1::new(database.inner());
    coordinator.return_control(request, now_ms_v1(), sessions.inner(), &audit)
}

#[tauri::command]
pub(crate) fn agent_terminal_pause(
    coordinator: State<'_, AgentTerminalCoordinatorV1>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    request: TerminalRunControlRequestV1,
) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
    let audit = DatabaseTerminalAuditWriterV1::new(database.inner());
    coordinator.pause(request, now_ms_v1(), sessions.inner(), &audit)
}

#[tauri::command]
pub(crate) fn agent_terminal_stop(
    coordinator: State<'_, AgentTerminalCoordinatorV1>,
    sessions: State<'_, SessionManager>,
    database: State<'_, Database>,
    request: TerminalRunControlRequestV1,
) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
    let audit = DatabaseTerminalAuditWriterV1::new(database.inner());
    coordinator.stop(request, now_ms_v1(), sessions.inner(), &audit)
}

#[cfg(test)]
mod tests {
    #[test]
    fn control_plane_has_no_generic_execute_or_agent_write_command() {
        let source = include_str!("terminal_ipc.rs");
        let generic_session_input = ["write", "session"].join("_");
        for suffix in ["execute", &generic_session_input, "write"] {
            let forbidden = format!("fn agent_terminal_{suffix}(");
            assert!(!source.contains(&forbidden));
        }
        let raw_field_access = ["request", ".data"].concat();
        assert!(!source.contains(&raw_field_access));
    }
}
