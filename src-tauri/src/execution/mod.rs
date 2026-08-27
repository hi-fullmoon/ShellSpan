//! Crate-private contracts and pure helpers for reviewed SSH execution.
//!
//! Step 1 intentionally defines these boundaries before the existing Runbook
//! SSH implementation is moved or adapted. The staged items become production
//! callers in steps 2 and 3.

#![allow(dead_code, unused_imports)]

mod output;
mod redaction;
mod request;
mod result;

pub(crate) use output::{
    BoundedOutputCollector, CapturedOutputStream, CollectedExecutionOutput, OutputLimitExceeded,
};
pub(crate) use redaction::redact_known_secrets;
pub(crate) use request::{
    ExecutionOutputPolicy, ExecutionValidationError, FrozenJumpHostIdentity, FrozenTargetIdentity,
    ReviewedSshCommand, ReviewedSshExecutionRequest,
};
pub(crate) use result::{ExecutionErrorCategory, ExecutionStatus, ReviewedSshExecutionResult};
