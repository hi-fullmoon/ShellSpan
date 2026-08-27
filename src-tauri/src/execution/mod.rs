//! Crate-private reviewed SSH execution boundary.
//!
//! This module owns operation cancellation, target revalidation, SSH session
//! and channel execution, bounded output, and known-secret redaction. It is not
//! registered as a Tauri command; the Runbook adapter is its only current
//! production caller.

mod cancellation;
mod output;
mod redaction;
mod request;
mod result;
mod ssh;
mod target;

pub(crate) use cancellation::{
    ExecutionCancellationError, ExecutionCancellationErrorKind, ExecutionCancellationRegistry,
};
pub(crate) use request::{
    ExecutionOutputPolicy, FrozenTargetIdentity, ReviewedSshCommand, ReviewedSshExecutionRequest,
    DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
};
pub(crate) use result::{ExecutionErrorCategory, ExecutionStatus, ReviewedSshExecutionResult};
pub(crate) use ssh::execute_reviewed_ssh_command;
