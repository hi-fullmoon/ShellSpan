//! Shared LLM protocol boundary. Stage A preserves the Event v4 and legacy provider wire contracts.
pub(crate) mod adapter;
mod adapters;
pub(crate) mod config;
pub(crate) mod discovery;
pub(crate) mod errors;
pub(crate) mod registry;
pub(crate) mod replay;
#[cfg(test)]
mod tests;
pub(crate) mod transport;
pub(crate) mod types;
pub(crate) mod usage;

pub(crate) mod catalog;
pub(crate) mod migration;
pub(crate) mod routes;
pub(crate) mod runtime;

#[cfg(test)]
mod catalog_tests;
