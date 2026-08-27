//! Crate-private reviewed SSH execution boundary.
//!
//! This module owns operation cancellation, target revalidation, SSH session
//! and channel execution, bounded output, and known-secret redaction. It is not
//! registered as a Tauri command; the Runbook adapter remains the only current
//! production caller and is migrated to the generic request/result in step 3.

#![allow(dead_code, unused_imports)]

mod cancellation;
mod output;
mod redaction;
mod request;
mod result;
mod ssh;
mod target;

pub(crate) use cancellation::{
    CancellationHandle, ExecutionCancellationError, ExecutionCancellationErrorKind,
    ExecutionCancellationRegistry, ExecutionTerminalState,
};
pub(crate) use output::{
    BoundedOutputCollector, CapturedOutputStream, CollectedExecutionOutput, OutputLimitExceeded,
};
pub(crate) use redaction::redact_known_secrets;
pub(crate) use request::{
    known_connection_secret_values, ExecutionOutputPolicy, ExecutionValidationError,
    FrozenJumpHostIdentity, FrozenTargetIdentity, ReviewedSshCommand, ReviewedSshExecutionRequest,
    DEFAULT_STDERR_CAPTURE_BYTES, DEFAULT_STDOUT_CAPTURE_BYTES,
    DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
};
pub(crate) use result::{ExecutionErrorCategory, ExecutionStatus, ReviewedSshExecutionResult};
pub(crate) use ssh::{
    await_ssh_execution_worker, execute_reviewed_ssh_command, execute_ssh_channel,
    open_ssh_execution_session, spawn_ssh_execution_worker, SshChannelExecutionOutcome,
    SshExecutionFailure, SshExecutionSession, SSH_EXECUTION_POLL_INTERVAL,
};
