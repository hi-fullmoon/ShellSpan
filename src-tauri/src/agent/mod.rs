//! Versioned dynamic Agent protocol primitives.
//!
//! P1-0 provides pure contracts, state transitions, and budget accounting.
//! P1-A adds the in-memory authority, monotonic journal, snapshot, and narrow
//! lifecycle IPC. P1-B adds provider-neutral strict decision adapters, bounded
//! context construction, and a testable single-decision orchestrator. P1-C adds
//! the compile-time tool registry, local read-only policy, POSIX renderer,
//! generic observation redaction, and run/target-bound evidence validation.
//! The production manager boundary remains an explicit no-op that blocks
//! starts: none of these pieces are registered as a production execution path,
//! and there is still no SSH adapter, raw SSH path, or PTY/write-session path.
//!
//! P2-0 adds fail-closed admission checks plus version 2 contracts and state
//! machines. P2-A adds backend-authoritative resource normalization,
//! structured evidence/freshness/precondition validation, effective policy
//! resolution, and local risk assessment. These remain pure logic: no
//! executor, approval IPC/registry, mutation adapter, verification executor,
//! audit writer, or other production side-effect path is registered here.

pub(crate) mod admission_v2;
pub(crate) mod budgets;
pub(crate) mod context;
#[cfg(test)]
mod eval;
pub(crate) mod events;
pub(crate) mod evidence;
pub(crate) mod evidence_v2;
pub(crate) mod ipc;
pub(crate) mod manager;
pub(crate) mod model;
pub(crate) mod orchestrator;
pub(crate) mod policy;
pub(crate) mod policy_v2;
pub(crate) mod protocol;
pub(crate) mod protocol_v2;
pub(crate) mod redaction;
pub(crate) mod resource_v2;
pub(crate) mod risk_v2;
#[cfg(test)]
mod safety_fixture_v2;
pub(crate) mod state;
pub(crate) mod state_v2;
#[allow(dead_code)]
pub(crate) mod terminal_audit;
#[allow(dead_code)]
pub(crate) mod terminal_coordinator;
#[allow(dead_code)]
pub(crate) mod terminal_driver;
pub(crate) mod terminal_ipc;
#[allow(dead_code)]
pub(crate) mod terminal_observation;
#[allow(dead_code)]
pub(crate) mod terminal_policy;
#[allow(dead_code)]
pub(crate) mod terminal_protocol;
pub(crate) mod tools;
