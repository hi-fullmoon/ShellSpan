use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::agent_runtime::{
    find_builtin_tool_native, AgentEffectKindNative, AgentTargetKindNative,
    AgentToolEffectModeNative, AGENT_TOOL_MANIFEST, NATIVE_TOOL_CONTRACT_VERSION,
};

const IMPLEMENTED_NATIVE_TOOLS: [&str; 9] = [
    "exec_command",
    "write_stdin",
    "wait_process",
    "kill_process",
    "read_file",
    "list_directory",
    "search_text",
    "apply_patch",
    "transfer_file",
];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolEffectModeNative {
    Fixed,
    NativeClassifier,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolIdempotencyNative {
    #[serde(rename = "yes")]
    Yes,
    #[serde(rename = "no")]
    No,
    Conditional,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolRetryPolicyNative {
    Never,
    IdempotentOnly,
    ReconcileFirst,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolManifestDescriptorNative {
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) target_kinds: Vec<AgentTargetKindNative>,
    pub(crate) effect_mode: ToolEffectModeNative,
    pub(crate) allowed_effects: Vec<AgentEffectKindNative>,
    pub(crate) idempotency: ToolIdempotencyNative,
    pub(crate) parallel: bool,
    pub(crate) cancellable: bool,
    pub(crate) retry_policy: ToolRetryPolicyNative,
    pub(crate) default_timeout_ms: u64,
    pub(crate) max_output_bytes: u64,
    pub(crate) max_concurrency: u16,
    pub(crate) required_capabilities: Vec<String>,
    pub(crate) untrusted_result_fields: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolManifestNative {
    contract_version: u8,
    tools: Vec<ToolManifestDescriptorNative>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolImplementationStateNative {
    Implemented,
    KnownUnavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisteredToolNative {
    #[serde(flatten)]
    pub(crate) descriptor: ToolManifestDescriptorNative,
    pub(crate) implementation_state: ToolImplementationStateNative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolRegistryErrorNative {
    InvalidManifest,
    ContractVersionMismatch,
    DuplicateTool,
    DescriptorMismatch,
    UnregisteredTool,
    ToolUnavailable,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolRegistryNative {
    tools: HashMap<String, RegisteredToolNative>,
}

impl ToolRegistryNative {
    pub(crate) fn from_builtin_manifest() -> Result<Self, ToolRegistryErrorNative> {
        let manifest: ToolManifestNative = serde_json::from_str(AGENT_TOOL_MANIFEST)
            .map_err(|_| ToolRegistryErrorNative::InvalidManifest)?;
        if manifest.contract_version != NATIVE_TOOL_CONTRACT_VERSION || manifest.tools.len() != 9 {
            return Err(ToolRegistryErrorNative::ContractVersionMismatch);
        }

        let mut tools = HashMap::new();
        for descriptor in manifest.tools {
            Self::validate_descriptor(&descriptor)?;
            let implementation_state =
                if IMPLEMENTED_NATIVE_TOOLS.contains(&descriptor.name.as_str()) {
                    ToolImplementationStateNative::Implemented
                } else {
                    ToolImplementationStateNative::KnownUnavailable
                };
            let name = descriptor.name.clone();
            if tools
                .insert(
                    name.clone(),
                    RegisteredToolNative {
                        descriptor,
                        implementation_state,
                    },
                )
                .is_some()
            {
                return Err(ToolRegistryErrorNative::DuplicateTool);
            }
        }
        Ok(Self { tools })
    }

    fn validate_descriptor(
        descriptor: &ToolManifestDescriptorNative,
    ) -> Result<(), ToolRegistryErrorNative> {
        let Some(contract) = find_builtin_tool_native(&descriptor.name) else {
            return Err(ToolRegistryErrorNative::DescriptorMismatch);
        };
        let expected_mode = match contract.effect_mode {
            AgentToolEffectModeNative::Fixed => ToolEffectModeNative::Fixed,
            AgentToolEffectModeNative::NativeClassifier => ToolEffectModeNative::NativeClassifier,
        };
        if descriptor.version != "1.0.0"
            || descriptor.target_kinds.as_slice() != contract.target_kinds
            || descriptor.effect_mode != expected_mode
            || descriptor.allowed_effects.as_slice() != contract.allowed_effects
            || descriptor.default_timeout_ms == 0
            || descriptor.max_concurrency == 0
            || descriptor.parallel
                && (descriptor.idempotency != ToolIdempotencyNative::Yes
                    || descriptor.allowed_effects.as_slice() != [AgentEffectKindNative::ReadOnly])
            || descriptor.required_capabilities.is_empty()
            || descriptor
                .required_capabilities
                .iter()
                .any(|value| value.trim().is_empty())
        {
            return Err(ToolRegistryErrorNative::DescriptorMismatch);
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
            return Err(ToolRegistryErrorNative::DescriptorMismatch);
        }
        Ok(())
    }

    pub(crate) fn get(&self, name: &str) -> Result<&RegisteredToolNative, ToolRegistryErrorNative> {
        self.tools
            .get(name)
            .ok_or(ToolRegistryErrorNative::UnregisteredTool)
    }

    pub(crate) fn executable(
        &self,
        name: &str,
    ) -> Result<&RegisteredToolNative, ToolRegistryErrorNative> {
        let tool = self.get(name)?;
        if tool.implementation_state != ToolImplementationStateNative::Implemented {
            return Err(ToolRegistryErrorNative::ToolUnavailable);
        }
        Ok(tool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_registry_contains_only_the_nine_native_execution_tools() {
        let registry = ToolRegistryNative::from_builtin_manifest().unwrap();
        assert_eq!(registry.tools.len(), 9);
        assert_eq!(
            IMPLEMENTED_NATIVE_TOOLS
                .iter()
                .filter(|name| registry.executable(name).is_ok())
                .copied()
                .collect::<Vec<_>>(),
            IMPLEMENTED_NATIVE_TOOLS
        );
        assert_eq!(registry.tools.len(), IMPLEMENTED_NATIVE_TOOLS.len());
        assert_eq!(
            registry.executable("future_tool"),
            Err(ToolRegistryErrorNative::UnregisteredTool)
        );
        let mut parallel = registry
            .tools
            .values()
            .filter(|tool| tool.descriptor.parallel)
            .map(|tool| tool.descriptor.name.as_str())
            .collect::<Vec<_>>();
        parallel.sort_unstable();
        assert_eq!(parallel, ["list_directory", "wait_process"]);
    }
}
