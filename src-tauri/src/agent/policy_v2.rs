use super::protocol_v2::AgentPolicyModeV2;
use serde::{Deserialize, Serialize};

pub(crate) const AGENT_EFFECTIVE_POLICY_VERSION_V2: &str = "p2-effective-policy-v1";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentEffectivePolicySourcesV2 {
    pub(crate) application: Option<AgentPolicyModeV2>,
    pub(crate) profile: Option<AgentPolicyModeV2>,
    pub(crate) requested: AgentPolicyModeV2,
    pub(crate) tool_minimum: AgentPolicyModeV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentEffectivePolicyV2 {
    pub(crate) mode: AgentPolicyModeV2,
    pub(crate) policy_version: String,
    pub(crate) read_only_requires_approval: bool,
    pub(crate) mutation_requires_approval: bool,
    pub(crate) high_impact_requires_double_confirmation: bool,
}

/// Resolves the strictest policy once, for storage in the immutable run
/// snapshot. Steering and UI settings do not participate in this function.
pub(crate) fn resolve_effective_policy_v2(
    sources: AgentEffectivePolicySourcesV2,
) -> AgentEffectivePolicyV2 {
    let mode = [
        sources.application,
        sources.profile,
        Some(sources.requested),
        Some(sources.tool_minimum),
    ]
    .into_iter()
    .flatten()
    .fold(AgentPolicyModeV2::Balanced, strictest_mode_v2);

    AgentEffectivePolicyV2 {
        mode,
        policy_version: AGENT_EFFECTIVE_POLICY_VERSION_V2.to_string(),
        read_only_requires_approval: mode == AgentPolicyModeV2::Strict,
        mutation_requires_approval: true,
        high_impact_requires_double_confirmation: true,
    }
}

fn strictest_mode_v2(
    current: AgentPolicyModeV2,
    candidate: AgentPolicyModeV2,
) -> AgentPolicyModeV2 {
    if current == AgentPolicyModeV2::Strict || candidate == AgentPolicyModeV2::Strict {
        AgentPolicyModeV2::Strict
    } else {
        AgentPolicyModeV2::Balanced
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_source_can_tighten_but_no_source_can_weaken_strict() {
        let balanced = resolve_effective_policy_v2(AgentEffectivePolicySourcesV2 {
            application: None,
            profile: None,
            requested: AgentPolicyModeV2::Balanced,
            tool_minimum: AgentPolicyModeV2::Balanced,
        });
        assert_eq!(balanced.mode, AgentPolicyModeV2::Balanced);
        assert!(!balanced.read_only_requires_approval);
        assert!(balanced.mutation_requires_approval);
        assert!(balanced.high_impact_requires_double_confirmation);

        for sources in [
            AgentEffectivePolicySourcesV2 {
                application: Some(AgentPolicyModeV2::Strict),
                profile: Some(AgentPolicyModeV2::Balanced),
                requested: AgentPolicyModeV2::Balanced,
                tool_minimum: AgentPolicyModeV2::Balanced,
            },
            AgentEffectivePolicySourcesV2 {
                application: Some(AgentPolicyModeV2::Balanced),
                profile: Some(AgentPolicyModeV2::Strict),
                requested: AgentPolicyModeV2::Balanced,
                tool_minimum: AgentPolicyModeV2::Balanced,
            },
            AgentEffectivePolicySourcesV2 {
                application: None,
                profile: None,
                requested: AgentPolicyModeV2::Strict,
                tool_minimum: AgentPolicyModeV2::Balanced,
            },
            AgentEffectivePolicySourcesV2 {
                application: None,
                profile: None,
                requested: AgentPolicyModeV2::Balanced,
                tool_minimum: AgentPolicyModeV2::Strict,
            },
        ] {
            let effective = resolve_effective_policy_v2(sources);
            assert_eq!(effective.mode, AgentPolicyModeV2::Strict);
            assert!(effective.read_only_requires_approval);
            assert!(effective.mutation_requires_approval);
        }
    }
}
