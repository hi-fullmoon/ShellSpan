//! Version 1 dynamic Agent protocol primitives.
//!
//! P1-0 intentionally contains only pure contracts, state transitions, and
//! budget accounting. It does not expose a Tauri command, start a model
//! request, or call the reviewed SSH execution boundary.

pub(crate) mod budgets;
pub(crate) mod protocol;
pub(crate) mod state;
