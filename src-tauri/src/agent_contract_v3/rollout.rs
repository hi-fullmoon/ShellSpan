use serde::{Deserialize, Serialize};

const AGENT_V3_ROLLOUT_ENV: &str = "SHELLSPAN_AGENT_V3_ROLLOUT";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentV3RolloutStage {
    Disabled,
    ContractOnly,
    Runtime,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentV3RolloutPolicy {
    pub stage: AgentV3RolloutStage,
    pub contract_available: bool,
    pub execution_contract_version: u8,
    pub rollback_contract_version: u8,
}

pub(crate) fn parse_agent_v3_rollout_stage(value: Option<&str>) -> AgentV3RolloutStage {
    match value {
        Some("contractOnly") => AgentV3RolloutStage::ContractOnly,
        Some("runtime") => AgentV3RolloutStage::Runtime,
        Some("disabled") | None => AgentV3RolloutStage::Disabled,
        // Unknown rollout values fail closed and preserve the v2 runtime.
        Some(_) => AgentV3RolloutStage::Disabled,
    }
}

pub(crate) fn resolve_agent_v3_rollout_policy(stage: AgentV3RolloutStage) -> AgentV3RolloutPolicy {
    AgentV3RolloutPolicy {
        stage,
        contract_available: stage != AgentV3RolloutStage::Disabled,
        execution_contract_version: if stage == AgentV3RolloutStage::Runtime {
            3
        } else {
            2
        },
        rollback_contract_version: 2,
    }
}

pub(crate) fn current_agent_v3_rollout_policy() -> AgentV3RolloutPolicy {
    let value = std::env::var(AGENT_V3_ROLLOUT_ENV).ok();
    resolve_agent_v3_rollout_policy(parse_agent_v3_rollout_stage(value.as_deref()))
}
