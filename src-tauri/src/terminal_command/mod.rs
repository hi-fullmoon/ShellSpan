//! Command facts are owned by the Broker's existing operation mutex.
//! This module provides values/reducers and durable fencing, never a PTY writer.
pub(crate) mod artifacts;
pub(crate) mod bash;
pub(crate) mod capture;
pub(crate) mod editors;
pub(crate) mod journal;
#[cfg(unix)]
pub(crate) mod local;
#[cfg(all(test, unix))]
mod local_tests;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "NIP wire contract is frozen in P1; production transport wiring is P2"
    )
)]
pub(crate) mod protocol;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Native artifact registration is exercised by real P1 tests; production loading is P2"
    )
)]
pub(crate) mod registration;
pub(crate) mod state;
#[cfg(test)]
mod tests;
#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
pub(crate) mod windows_conpty;
#[cfg(all(test, unix))]
mod zle_tests;
