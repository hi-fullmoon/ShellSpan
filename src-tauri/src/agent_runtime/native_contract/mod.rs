//! Internal native-tool contract and policy boundary for the unified Agent runtime.

mod policy;
mod types;

pub(crate) use policy::*;
pub(crate) use types::*;

pub(crate) const AGENT_TOOL_MANIFEST: &str =
    include_str!("../../../../protocol/agent/runtime/built-in-tools.json");
