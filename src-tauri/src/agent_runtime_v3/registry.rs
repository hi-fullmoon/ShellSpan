use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::agent_contract_v3::{
    find_builtin_tool_v3, AgentEffectKindV3, AgentTargetKindV3, AgentToolEffectModeV3,
    AGENT_CONTRACT_V3_VERSION, AGENT_TOOL_MANIFEST_V3,
};

const IMPLEMENTED_M2_TOOLS: [&str; 10] = [
    "exec_command",
    "write_stdin",
    "wait_process",
    "kill_process",
    "read_file",
    "list_directory",
    "search_text",
    "apply_patch",
    "transfer_file",
    "update_plan",
];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolEffectModeV3 {
    Fixed,
    NativeClassifier,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolIdempotencyV3 {
    #[serde(rename = "yes")]
    Yes,
    #[serde(rename = "no")]
    No,
    Conditional,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolRetryPolicyV3 {
    Never,
    IdempotentOnly,
    ReconcileFirst,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolManifestDescriptorV3 {
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) target_kinds: Vec<AgentTargetKindV3>,
    pub(crate) effect_mode: ToolEffectModeV3,
    pub(crate) allowed_effects: Vec<AgentEffectKindV3>,
    pub(crate) idempotency: ToolIdempotencyV3,
    pub(crate) cancellable: bool,
    pub(crate) retry_policy: ToolRetryPolicyV3,
    pub(crate) default_timeout_ms: u64,
    pub(crate) max_output_bytes: u64,
    pub(crate) max_concurrency: u16,
    pub(crate) required_capabilities: Vec<String>,
    pub(crate) untrusted_result_fields: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolManifestV3 {
    contract_version: u8,
    tools: Vec<ToolManifestDescriptorV3>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolImplementationStateV3 {
    Implemented,
    KnownUnavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisteredToolV3 {
    #[serde(flatten)]
    pub(crate) descriptor: ToolManifestDescriptorV3,
    pub(crate) implementation_state: ToolImplementationStateV3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolRegistryErrorV3 {
    InvalidManifest,
    ContractVersionMismatch,
    DuplicateTool,
    DescriptorMismatch,
    UnregisteredTool,
    ToolUnavailable,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolRegistryV3 {
    tools: HashMap<String, RegisteredToolV3>,
    ordered_names: Vec<String>,
}

impl ToolRegistryV3 {
    pub(crate) fn from_builtin_manifest() -> Result<Self, ToolRegistryErrorV3> {
        let manifest: ToolManifestV3 = serde_json::from_str(AGENT_TOOL_MANIFEST_V3)
            .map_err(|_| ToolRegistryErrorV3::InvalidManifest)?;
        if manifest.contract_version != AGENT_CONTRACT_V3_VERSION || manifest.tools.len() != 12 {
            return Err(ToolRegistryErrorV3::ContractVersionMismatch);
        }

        let mut tools = HashMap::new();
        let mut ordered_names = Vec::with_capacity(manifest.tools.len());
        for descriptor in manifest.tools {
            Self::validate_descriptor(&descriptor)?;
            let implementation_state = if IMPLEMENTED_M2_TOOLS.contains(&descriptor.name.as_str()) {
                ToolImplementationStateV3::Implemented
            } else {
                ToolImplementationStateV3::KnownUnavailable
            };
            let name = descriptor.name.clone();
            if tools
                .insert(
                    name.clone(),
                    RegisteredToolV3 {
                        descriptor,
                        implementation_state,
                    },
                )
                .is_some()
            {
                return Err(ToolRegistryErrorV3::DuplicateTool);
            }
            ordered_names.push(name);
        }
        Ok(Self {
            tools,
            ordered_names,
        })
    }

    fn validate_descriptor(
        descriptor: &ToolManifestDescriptorV3,
    ) -> Result<(), ToolRegistryErrorV3> {
        let Some(contract) = find_builtin_tool_v3(&descriptor.name) else {
            return Err(ToolRegistryErrorV3::DescriptorMismatch);
        };
        let expected_mode = match contract.effect_mode {
            AgentToolEffectModeV3::Fixed => ToolEffectModeV3::Fixed,
            AgentToolEffectModeV3::NativeClassifier => ToolEffectModeV3::NativeClassifier,
        };
        if descriptor.version != "1.0.0"
            || descriptor.target_kinds.as_slice() != contract.target_kinds
            || descriptor.effect_mode != expected_mode
            || descriptor.allowed_effects.as_slice() != contract.allowed_effects
            || descriptor.default_timeout_ms == 0
            || descriptor.max_concurrency == 0
            || descriptor.required_capabilities.is_empty()
            || descriptor
                .required_capabilities
                .iter()
                .any(|value| value.trim().is_empty())
        {
            return Err(ToolRegistryErrorV3::DescriptorMismatch);
        }
        let unique_capabilities = descriptor
            .required_capabilities
            .iter()
            .collect::<HashSet<_>>();
        let unique_untrusted = descriptor
            .untrusted_result_fields
            .iter()
            .collect::<HashSet<_>>();
        if unique_capabilities.len() != descriptor.required_capabilities.len()
            || unique_untrusted.len() != descriptor.untrusted_result_fields.len()
        {
            return Err(ToolRegistryErrorV3::DescriptorMismatch);
        }
        Ok(())
    }

    pub(crate) fn get(&self, name: &str) -> Result<&RegisteredToolV3, ToolRegistryErrorV3> {
        self.tools
            .get(name)
            .ok_or(ToolRegistryErrorV3::UnregisteredTool)
    }

    pub(crate) fn executable(&self, name: &str) -> Result<&RegisteredToolV3, ToolRegistryErrorV3> {
        let tool = self.get(name)?;
        if tool.implementation_state != ToolImplementationStateV3::Implemented {
            return Err(ToolRegistryErrorV3::ToolUnavailable);
        }
        Ok(tool)
    }

    pub(crate) fn list(&self) -> Vec<RegisteredToolV3> {
        self.ordered_names
            .iter()
            .filter_map(|name| self.tools.get(name).cloned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_registry_keeps_all_twelve_tools_and_only_implements_m2_surface() {
        let registry = ToolRegistryV3::from_builtin_manifest().unwrap();
        let tools = registry.list();
        assert_eq!(tools.len(), 12);
        assert_eq!(
            tools
                .iter()
                .filter(|tool| tool.implementation_state == ToolImplementationStateV3::Implemented)
                .map(|tool| tool.descriptor.name.as_str())
                .collect::<Vec<_>>(),
            IMPLEMENTED_M2_TOOLS
        );
        assert_eq!(
            registry.executable("host_snapshot"),
            Err(ToolRegistryErrorV3::ToolUnavailable)
        );
        assert_eq!(
            registry.executable("future_tool"),
            Err(ToolRegistryErrorV3::UnregisteredTool)
        );
    }
}
