//! Agent Contract v3 wire types, native policy boundary, rollout policy, and
//! v2 adapters.
//!
//! The M1 registry, capability signer, task/process store, and execution
//! drivers live in `agent_runtime_v3`; this module remains the contract layer.

mod compat;
mod policy;
mod rollout;
mod types;

pub use compat::*;
pub use policy::*;
pub use rollout::{AgentV3RolloutPolicy, AgentV3RolloutStage};
pub use types::*;

pub const AGENT_CONTRACT_V3_SCHEMA: &str =
    include_str!("../../../protocol/agent/v3/agent-contract.schema.json");
pub const AGENT_TOOL_CONTRACT_V3_SCHEMA: &str =
    include_str!("../../../protocol/agent/v3/tool-contract.schema.json");
pub const AGENT_TOOL_MANIFEST_V3_SCHEMA: &str =
    include_str!("../../../protocol/agent/v3/tool-manifest.schema.json");
pub const AGENT_TOOL_MANIFEST_V3: &str =
    include_str!("../../../protocol/agent/v3/built-in-tools.json");

#[tauri::command]
pub(crate) fn agent_v3_rollout_policy() -> AgentV3RolloutPolicy {
    rollout::current_agent_v3_rollout_policy()
}

#[cfg(test)]
mod tests;
