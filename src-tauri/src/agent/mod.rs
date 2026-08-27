//! Version 1 dynamic Agent protocol primitives.
//!
//! P1-0 provides pure contracts, state transitions, and budget accounting.
//! P1-A adds the in-memory authority, monotonic journal, snapshot, and narrow
//! lifecycle IPC. P1-B adds provider-neutral strict decision adapters, bounded
//! context construction, and a testable single-decision orchestrator. The
//! production manager boundary remains an explicit no-op that blocks starts:
//! none of the P1-B pieces are registered as a production execution path, and
//! there is still no real tool registry, policy/evidence/redaction layer, SSH
//! adapter, raw SSH path, or PTY/write-session path here.

pub(crate) mod budgets;
pub(crate) mod context;
pub(crate) mod events;
pub(crate) mod ipc;
pub(crate) mod manager;
pub(crate) mod model;
pub(crate) mod orchestrator;
pub(crate) mod protocol;
pub(crate) mod state;
