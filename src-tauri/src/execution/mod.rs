#![allow(dead_code)]

//! Crate-private SSH execution boundary.
//!
//! The reviewed API owns operation cancellation, target revalidation, SSH
//! session/channel execution, bounded output, and known-secret redaction. It
//! is not registered as a Tauri command. Existing fixed-purpose Remote FS and
//! Remote Health probes share only the raw channel-start primitive so the
//! production crate has one auditable `Channel::exec` call site; that primitive
//! is not an authorization boundary and must stay behind fixed-purpose probes.
//!
//! A reviewed timeout is observed by the caller across the whole operation,
//! but blocking DNS, TCP, SSH handshake, and authentication calls retain their
//! connection-layer timeouts. A timed-out worker can therefore finish teardown
//! after the caller returns, although it rechecks cancellation before starting
//! a command. Cancellation closes the channel but cannot guarantee termination
//! of a daemonized/background remote process. All registry state is in memory,
//! so an application crash neither resumes an operation nor proves that a
//! detached remote process stopped.

mod cancellation;
#[cfg(test)]
pub(crate) mod fixture;
mod output;
mod redaction;
mod request;
mod result;
mod ssh;
mod target;

#[cfg(test)]
pub(crate) use cancellation::ExecutionCancellationErrorKind;
pub(crate) use cancellation::ExecutionCancellationRegistry;
#[cfg(test)]
pub(crate) use request::DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES;
#[cfg(test)]
pub(crate) use request::{
    ExecutionOutputPolicy, FrozenTargetIdentity, ReviewedSshCommand, ReviewedSshExecutionRequest,
};
#[cfg(test)]
pub(crate) use result::{ExecutionErrorCategory, ExecutionStatus, ReviewedSshExecutionResult};
#[cfg(test)]
pub(crate) use ssh::execute_reviewed_ssh_command;
pub(crate) use ssh::start_ssh_exec_channel;
