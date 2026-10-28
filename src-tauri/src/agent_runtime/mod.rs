mod artifact;
mod budget;
mod builtin_skills;
mod child_recovery;
mod commands;
mod compaction;
mod driver;
mod driver_metrics;
mod driver_progress;
mod event;
pub(crate) mod file_references;
mod hooks;
pub(crate) mod images;
mod inbox;
mod model;
mod model_tools;
mod native;
mod native_adapter;
mod native_contract;
mod petdex;
mod projection;
mod prompt;
pub(crate) mod provider;
mod recovery;
mod registry;
mod request_log;
mod retry;
mod runtime;
mod session;
mod session_title;
pub(crate) mod skill_runtime;
pub(crate) mod skills;
mod stream_writer;
mod subagent;
mod surface;
mod tool_output;
mod tool_pipeline;
mod user_questions;

pub(crate) const TERMINAL_TARGET_UNAVAILABLE_PREFIX: &str = "terminalTargetUnavailable:";

pub(crate) fn terminal_target_unavailable(reason: &str) -> String {
    format!(
        "{TERMINAL_TARGET_UNAVAILABLE_PREFIX} {reason}; reconnect the terminal and verify its execution state before continuing"
    )
}

pub(crate) fn normalize_terminal_target_lookup_error(session_id: &str, error: String) -> String {
    if error == format!("session {session_id} not found") {
        terminal_target_unavailable("the bound terminal no longer exists")
    } else {
        error
    }
}

pub(crate) fn is_terminal_target_unavailable(error: &str) -> bool {
    error.starts_with(TERMINAL_TARGET_UNAVAILABLE_PREFIX)
}

pub(crate) fn terminal_execution_needs_user_action(error: &str) -> bool {
    [
        "TERMINAL_INPUT_RECOVERY_REQUIRED",
        "TERMINAL_DIRECT_REQUIRED",
    ]
    .iter()
    .any(|code| {
        error == *code
            || error
                .strip_prefix(code)
                .is_some_and(|tail| tail.starts_with(':'))
    })
}

pub(crate) fn is_terminal_call_blocked(error: &str) -> bool {
    is_terminal_target_unavailable(error) || terminal_execution_needs_user_action(error)
}

pub(crate) use artifact::*;
pub(crate) use budget::*;
pub(crate) use child_recovery::AgentChildFailureRecovery;
pub(crate) use commands::*;
pub(crate) use compaction::*;
pub(crate) use driver::*;
pub(crate) use event::*;
pub(crate) use hooks::*;
pub(crate) use inbox::*;
pub(crate) use model::*;
pub(crate) use native::*;
pub(crate) use native_adapter::*;
pub(crate) use native_contract::*;
pub(crate) use projection::*;
pub(crate) use prompt::*;
pub(crate) use recovery::*;
pub(crate) use registry::*;
pub(crate) use retry::*;
pub(crate) use runtime::*;
pub(crate) use session::*;
pub(crate) use subagent::*;
pub(crate) use surface::*;
pub(crate) use tool_pipeline::*;

#[cfg(test)]
mod target_availability_tests {
    use super::*;

    #[test]
    fn missing_bound_terminal_has_a_stable_terminal_failure() {
        let error = normalize_terminal_target_lookup_error(
            "terminal-1",
            "session terminal-1 not found".into(),
        );

        assert!(is_terminal_target_unavailable(&error));
        assert!(!error.contains("terminal-1"));
        assert!(error.contains("verify its execution state"));
        assert_eq!(
            normalize_terminal_target_lookup_error(
                "terminal-1",
                "session registry poisoned".into(),
            ),
            "session registry poisoned"
        );
    }
}
