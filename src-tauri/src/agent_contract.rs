//! Frozen M0 contracts and fail-closed policy for the experimental terminal Agent.
//!
//! This module intentionally contains no model loop or terminal executor. Those
//! capabilities belong to later roadmap milestones and must enter through this
//! feature gate and these strict wire types.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};

use crate::ai::AiProviderKind;

pub const AGENT_CONTRACT_VERSION: u8 = 1;
pub const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = AgentPermissionMode::RequestApproval;
const EXPERIMENTAL_AGENT_ENV: &str = "TERMBRIDGE_EXPERIMENTAL_AGENT";

pub const AGENT_CONTRACT_SCHEMA: &str =
    include_str!("../../protocol/agent/v1/agent-contract.schema.json");

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentPermissionMode {
    RequestApproval,
    AutoApproveReadOnly,
    FullAccess,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRisk {
    ReadOnly,
    StateChange,
    Destructive,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum AgentRiskClassification {
    Classified { risk: AgentRisk },
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentApprovalDecisionReason {
    UnclassifiedRisk,
    ModeRequiresApproval,
    ReadOnlyAutoApproved,
    RiskRequiresApproval,
    FullAccess,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentApprovalDecision {
    pub requires_approval: bool,
    pub reason: AgentApprovalDecisionReason,
}

pub fn evaluate_agent_permission(
    mode: AgentPermissionMode,
    classification: AgentRiskClassification,
) -> AgentApprovalDecision {
    let risk = match classification {
        AgentRiskClassification::Classified { risk } => risk,
        AgentRiskClassification::Unknown => {
            return AgentApprovalDecision {
                requires_approval: true,
                reason: AgentApprovalDecisionReason::UnclassifiedRisk,
            };
        }
    };
    match mode {
        AgentPermissionMode::RequestApproval => AgentApprovalDecision {
            requires_approval: true,
            reason: AgentApprovalDecisionReason::ModeRequiresApproval,
        },
        AgentPermissionMode::AutoApproveReadOnly if risk == AgentRisk::ReadOnly => {
            AgentApprovalDecision {
                requires_approval: false,
                reason: AgentApprovalDecisionReason::ReadOnlyAutoApproved,
            }
        }
        AgentPermissionMode::AutoApproveReadOnly => AgentApprovalDecision {
            requires_approval: true,
            reason: AgentApprovalDecisionReason::RiskRequiresApproval,
        },
        AgentPermissionMode::FullAccess => AgentApprovalDecision {
            requires_approval: false,
            reason: AgentApprovalDecisionReason::FullAccess,
        },
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentTargetKind {
    Remote,
    Local,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTargetSnapshot {
    pub kind: AgentTargetKind,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum AgentTaskKind {
    #[serde(rename = "agent")]
    Agent,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequest {
    pub request_id: String,
    pub task: AgentTaskKind,
    pub target: AgentTargetSnapshot,
    pub permission_mode: AgentPermissionMode,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTerminalCommandArguments {
    pub command: String,
    pub explanation: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum AgentToolName {
    #[serde(rename = "run_terminal_command")]
    RunTerminalCommand,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolCall {
    pub request_id: String,
    pub call_id: String,
    pub name: AgentToolName,
    pub command: String,
    pub explanation: String,
    pub target: AgentTargetSnapshot,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentToolResultStatus {
    Completed,
    Rejected,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolResult {
    pub request_id: String,
    pub call_id: String,
    pub status: AgentToolResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub output: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentToolCallingSupport {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentProviderCapabilitySource {
    OpenAiResponses,
    ChatCompletionsProbe,
    OllamaModelMetadata,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProviderCapabilityEvidence {
    pub support: AgentToolCallingSupport,
    pub source: AgentProviderCapabilitySource,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentSafeFallbackReason {
    FeatureDisabled,
    ToolCallingUnsupported,
    ToolCallingUnverified,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum AgentFallbackTask {
    #[serde(rename = "generateCommand")]
    GenerateCommand,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum AgentAssistantTextExecution {
    #[serde(rename = "forbidden")]
    Forbidden,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentAutomaticExecutionDisabled;

impl Serialize for AgentAutomaticExecutionDisabled {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for AgentAutomaticExecutionDisabled {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        if bool::deserialize(deserializer)? {
            Err(de::Error::custom("automaticExecution must be false"))
        } else {
            Ok(Self)
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSafeFallback {
    pub task: AgentFallbackTask,
    pub automatic_execution: AgentAutomaticExecutionDisabled,
    pub assistant_text_execution: AgentAssistantTextExecution,
    pub reason: AgentSafeFallbackReason,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentContractStatus {
    pub contract_version: u8,
    pub feature_enabled: bool,
    pub agent_available: bool,
    pub default_permission_mode: AgentPermissionMode,
    pub provider_capability: AgentProviderCapabilityEvidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<AgentSafeFallback>,
}

fn expected_capability_source(kind: AiProviderKind) -> AgentProviderCapabilitySource {
    match kind {
        AiProviderKind::OpenAi => AgentProviderCapabilitySource::OpenAiResponses,
        AiProviderKind::OpenAiCompatible => AgentProviderCapabilitySource::ChatCompletionsProbe,
        AiProviderKind::Ollama => AgentProviderCapabilitySource::OllamaModelMetadata,
    }
}

pub(crate) fn resolve_agent_provider_capability(
    kind: AiProviderKind,
    evidence: Option<AgentProviderCapabilityEvidence>,
) -> AgentProviderCapabilityEvidence {
    let source = expected_capability_source(kind);
    match evidence {
        Some(evidence) if evidence.source == source => evidence,
        Some(_) => AgentProviderCapabilityEvidence {
            support: AgentToolCallingSupport::Unknown,
            source,
        },
        None => AgentProviderCapabilityEvidence {
            support: if kind == AiProviderKind::OpenAi {
                AgentToolCallingSupport::Supported
            } else {
                AgentToolCallingSupport::Unknown
            },
            source,
        },
    }
}

fn parse_experimental_agent_flag(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true"))
}

fn experimental_agent_enabled() -> bool {
    parse_experimental_agent_flag(std::env::var(EXPERIMENTAL_AGENT_ENV).ok().as_deref())
}

fn resolve_agent_contract_status(
    feature_enabled: bool,
    kind: AiProviderKind,
    evidence: Option<AgentProviderCapabilityEvidence>,
) -> AgentContractStatus {
    let provider_capability = resolve_agent_provider_capability(kind, evidence);
    let agent_available =
        feature_enabled && provider_capability.support == AgentToolCallingSupport::Supported;
    let fallback = (!agent_available).then(|| AgentSafeFallback {
        task: AgentFallbackTask::GenerateCommand,
        automatic_execution: AgentAutomaticExecutionDisabled,
        assistant_text_execution: AgentAssistantTextExecution::Forbidden,
        reason: if !feature_enabled {
            AgentSafeFallbackReason::FeatureDisabled
        } else if provider_capability.support == AgentToolCallingSupport::Unsupported {
            AgentSafeFallbackReason::ToolCallingUnsupported
        } else {
            AgentSafeFallbackReason::ToolCallingUnverified
        },
    });
    AgentContractStatus {
        contract_version: AGENT_CONTRACT_VERSION,
        feature_enabled,
        agent_available,
        default_permission_mode: DEFAULT_AGENT_PERMISSION_MODE,
        provider_capability,
        fallback,
    }
}

#[tauri::command]
pub(crate) fn agent_contract_status(
    provider_kind: AiProviderKind,
    evidence: Option<AgentProviderCapabilityEvidence>,
) -> AgentContractStatus {
    resolve_agent_contract_status(experimental_agent_enabled(), provider_kind, evidence)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = include_str!("../../protocol/agent/v1/agent-contract-fixtures.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ContractFixtures {
        contract_version: u8,
        examples: ContractExamples,
        permission_matrix: Vec<PermissionMatrixCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ContractExamples {
        request: AgentRequest,
        tool_call: AgentToolCall,
        tool_results: Vec<AgentToolResult>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PermissionMatrixCase {
        name: String,
        mode: AgentPermissionMode,
        risk: String,
        expected: AgentApprovalDecision,
    }

    fn classify_fixture_risk(value: &str) -> AgentRiskClassification {
        let risk = match value {
            "readOnly" => Some(AgentRisk::ReadOnly),
            "stateChange" => Some(AgentRisk::StateChange),
            "destructive" => Some(AgentRisk::Destructive),
            _ => None,
        };
        risk.map_or(AgentRiskClassification::Unknown, |risk| {
            AgentRiskClassification::Classified { risk }
        })
    }

    #[test]
    fn shared_examples_decode_strictly_and_round_trip() {
        let fixture: ContractFixtures = serde_json::from_str(FIXTURES).unwrap();
        assert_eq!(fixture.contract_version, AGENT_CONTRACT_VERSION);
        assert_eq!(fixture.examples.request.task, AgentTaskKind::Agent);
        assert_eq!(
            fixture.examples.request.target,
            fixture.examples.tool_call.target
        );
        assert_eq!(fixture.examples.tool_results.len(), 5);
        let statuses = fixture
            .examples
            .tool_results
            .iter()
            .map(|result| result.status)
            .collect::<Vec<_>>();
        assert_eq!(
            statuses,
            vec![
                AgentToolResultStatus::Completed,
                AgentToolResultStatus::Rejected,
                AgentToolResultStatus::Failed,
                AgentToolResultStatus::TimedOut,
                AgentToolResultStatus::Cancelled,
            ]
        );
        assert!(serde_json::to_value(fixture.examples.request).is_ok());
        assert!(serde_json::to_value(fixture.examples.tool_call).is_ok());
    }

    #[test]
    fn shared_permission_matrix_is_fail_closed() {
        let fixture: ContractFixtures = serde_json::from_str(FIXTURES).unwrap();
        assert_eq!(fixture.permission_matrix.len(), 12);
        for case in fixture.permission_matrix {
            assert_eq!(
                evaluate_agent_permission(case.mode, classify_fixture_risk(&case.risk)),
                case.expected,
                "{}",
                case.name
            );
        }
        assert_eq!(
            evaluate_agent_permission(
                AgentPermissionMode::FullAccess,
                classify_fixture_risk("futureRisk")
            ),
            AgentApprovalDecision {
                requires_approval: true,
                reason: AgentApprovalDecisionReason::UnclassifiedRisk,
            }
        );
        assert!(
            serde_json::from_value::<AgentPermissionMode>(serde_json::json!("futureMode")).is_err()
        );
    }

    #[test]
    fn experiment_flag_defaults_off_and_accepts_only_explicit_true_values() {
        assert!(!parse_experimental_agent_flag(None));
        assert!(!parse_experimental_agent_flag(Some("false")));
        assert!(!parse_experimental_agent_flag(Some("TRUE")));
        assert!(!parse_experimental_agent_flag(Some("yes")));
        assert!(parse_experimental_agent_flag(Some("true")));
        assert!(parse_experimental_agent_flag(Some("1")));
    }

    #[test]
    fn provider_detection_requires_protocol_appropriate_evidence() {
        assert_eq!(
            resolve_agent_provider_capability(AiProviderKind::OpenAi, None),
            AgentProviderCapabilityEvidence {
                support: AgentToolCallingSupport::Supported,
                source: AgentProviderCapabilitySource::OpenAiResponses,
            }
        );
        assert_eq!(
            resolve_agent_provider_capability(AiProviderKind::OpenAiCompatible, None).support,
            AgentToolCallingSupport::Unknown
        );
        assert_eq!(
            resolve_agent_provider_capability(
                AiProviderKind::Ollama,
                Some(AgentProviderCapabilityEvidence {
                    support: AgentToolCallingSupport::Supported,
                    source: AgentProviderCapabilitySource::ChatCompletionsProbe,
                }),
            ),
            AgentProviderCapabilityEvidence {
                support: AgentToolCallingSupport::Unknown,
                source: AgentProviderCapabilitySource::OllamaModelMetadata,
            }
        );
    }

    #[test]
    fn disabled_or_unverified_agent_falls_back_without_text_execution() {
        let disabled = resolve_agent_contract_status(false, AiProviderKind::OpenAi, None);
        assert!(!disabled.agent_available);
        assert_eq!(
            disabled.fallback.unwrap(),
            AgentSafeFallback {
                task: AgentFallbackTask::GenerateCommand,
                automatic_execution: AgentAutomaticExecutionDisabled,
                assistant_text_execution: AgentAssistantTextExecution::Forbidden,
                reason: AgentSafeFallbackReason::FeatureDisabled,
            }
        );

        let unverified =
            resolve_agent_contract_status(true, AiProviderKind::OpenAiCompatible, None);
        assert!(!unverified.agent_available);
        assert_eq!(
            unverified.fallback.unwrap().reason,
            AgentSafeFallbackReason::ToolCallingUnverified
        );
    }

    #[test]
    fn fallback_contract_rejects_automatic_execution() {
        let invalid = serde_json::json!({
            "task": "generateCommand",
            "automaticExecution": true,
            "assistantTextExecution": "forbidden",
            "reason": "featureDisabled"
        });
        assert!(serde_json::from_value::<AgentSafeFallback>(invalid).is_err());
    }

    #[test]
    fn rust_wire_enums_match_the_canonical_schema() {
        let schema: serde_json::Value = serde_json::from_str(AGENT_CONTRACT_SCHEMA).unwrap();
        let permission_modes = serde_json::to_value([
            AgentPermissionMode::RequestApproval,
            AgentPermissionMode::AutoApproveReadOnly,
            AgentPermissionMode::FullAccess,
        ])
        .unwrap();
        let risks = serde_json::to_value([
            AgentRisk::ReadOnly,
            AgentRisk::StateChange,
            AgentRisk::Destructive,
        ])
        .unwrap();
        assert_eq!(
            schema.pointer("/$defs/agentPermissionMode/enum"),
            Some(&permission_modes)
        );
        assert_eq!(schema.pointer("/$defs/agentRisk/enum"), Some(&risks));
    }
}
