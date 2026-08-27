//! Version 1 dynamic Agent protocol primitives.
//!
//! P1-0 provides pure contracts, state transitions, and budget accounting.
//! P1-A adds the in-memory authority, monotonic journal, snapshot, and narrow
//! lifecycle IPC. The production orchestration boundary remains an explicit
//! no-op that blocks starts: there is still no model request, tool registry,
//! execution adapter, raw SSH path, or PTY/write-session path here.

pub(crate) mod budgets;
pub(crate) mod events;
pub(crate) mod ipc;
pub(crate) mod manager;
pub(crate) mod protocol;
pub(crate) mod state;
