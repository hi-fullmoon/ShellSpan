use super::protocol::{
    AgentFindingConfidenceV1, AgentPlanItemStatusV1, AgentPlanItemV1, AgentPlanUpdateV1,
    HostInspectArgsV1, ShellExecReadOnlyArgsV1,
};
use super::state_v2::{
    AgentApprovalStateV2, AgentRunStateV2, AgentToolCallStateV2, AgentVerificationStateV2,
};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashSet;
use std::fmt;

pub(crate) const AGENT_PROTOCOL_SCHEMA_VERSION_V2: u8 = 2;
pub(crate) const MAX_AGENT_DECISION_BYTES_V2: usize = 64 * 1024;
pub(crate) const AGENT_DECISION_SCHEMA_V2: &str =
    include_str!("../../../protocol/agent/v2/agent-decision.schema.json");
pub(crate) const AGENT_EVENT_SCHEMA_V2: &str =
    include_str!("../../../protocol/agent/v2/agent-events.schema.json");
pub(crate) const AGENT_SNAPSHOT_SCHEMA_V2: &str =
    include_str!("../../../protocol/agent/v2/agent-snapshot.schema.json");

const MAX_ID_CHARACTERS: usize = 64;
const MAX_GOAL_CHARACTERS: usize = 8 * 1024;
const MAX_TERMINAL_CONTEXT_CHARACTERS: usize = 64 * 1024;
const MAX_LABEL_CHARACTERS: usize = 200;
const MAX_RATIONALE_CHARACTERS: usize = 1_000;
const MAX_TOOL_TEXT_CHARACTERS: usize = 1_000;
const MAX_QUESTION_CHARACTERS: usize = 4_000;
const MAX_REPORT_TEXT_CHARACTERS: usize = 4_000;
const MAX_REPORT_ITEM_TEXT_CHARACTERS: usize = 2_000;
const MAX_PLAN_ITEMS: usize = 8;
const MAX_FINDINGS: usize = 16;
const MAX_CHANGES: usize = 8;
const MAX_EVIDENCE_IDS: usize = 32;
const MAX_TOOL_CALLS: usize = 15;
const MAX_RISK_ASSESSMENTS: usize = 15;
const MAX_VERIFICATION_OBLIGATIONS: usize = 8;
const MAX_SERVICE_UNIT_BYTES: usize = 128;
const MAX_EXPECTED_LISTENER_PORTS: usize = 8;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub(crate) struct AgentSchemaVersionV2;

impl Serialize for AgentSchemaVersionV2 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(AGENT_PROTOCOL_SCHEMA_VERSION_V2)
    }
}

impl<'de> Deserialize<'de> for AgentSchemaVersionV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = u8::deserialize(deserializer)?;
        if version == AGENT_PROTOCOL_SCHEMA_VERSION_V2 {
            Ok(Self)
        } else {
            Err(de::Error::custom("Agent schemaVersion must be 2"))
        }
    }
}

fn deserialize_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| de::Error::custom("optional Agent v2 protocol fields cannot be null"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentProtocolDecodeErrorKindV2 {
    TooLarge,
    InvalidJson,
    InvalidContract,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentProtocolDecodeErrorV2 {
    pub(crate) kind: AgentProtocolDecodeErrorKindV2,
    pub(crate) message: String,
}

impl fmt::Display for AgentProtocolDecodeErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn invalid_contract(message: impl Into<String>) -> AgentProtocolDecodeErrorV2 {
    AgentProtocolDecodeErrorV2 {
        kind: AgentProtocolDecodeErrorKindV2::InvalidContract,
        message: message.into(),
    }
}

fn bounded_text(value: &str, max_characters: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max_characters && !value.contains('\0')
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_CHARACTERS
        && value.is_ascii()
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0 && matches!(character, '.' | '_' | ':' | '-'))
        })
}

fn validate_plan(plan: &AgentPlanUpdateV1) -> Result<(), AgentProtocolDecodeErrorV2> {
    if plan.items.len() > MAX_PLAN_ITEMS {
        return Err(invalid_contract("Agent v2 plan contains too many items"));
    }
    let mut ids = HashSet::new();
    let mut active_count = 0;
    for item in &plan.items {
        if !valid_identifier(&item.id)
            || !bounded_text(&item.title, MAX_LABEL_CHARACTERS)
            || !ids.insert(item.id.as_str())
        {
            return Err(invalid_contract(
                "Agent v2 plan item is invalid or duplicated",
            ));
        }
        if item.status == AgentPlanItemStatusV1::Active {
            active_count += 1;
        }
    }
    if active_count > 1 {
        return Err(invalid_contract(
            "Agent v2 plan may contain at most one active item",
        ));
    }
    Ok(())
}

fn valid_service_unit(unit: &str) -> bool {
    unit.is_ascii()
        && unit.len() <= MAX_SERVICE_UNIT_BYTES
        && unit.ends_with(".service")
        && unit.len() > ".service".len()
        && !unit.contains("..")
        && unit
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn validate_host_inspect_args(args: &HostInspectArgsV1) -> Result<(), AgentProtocolDecodeErrorV2> {
    if args.include.is_empty() || args.include.len() > 6 {
        return Err(invalid_contract("host.inspect include is invalid"));
    }
    let unique = args.include.iter().copied().collect::<HashSet<_>>();
    if unique.len() != args.include.len() {
        return Err(invalid_contract("host.inspect include contains duplicates"));
    }
    Ok(())
}

fn validate_shell_args(args: &ShellExecReadOnlyArgsV1) -> Result<(), AgentProtocolDecodeErrorV2> {
    let valid_program = !args.program.is_empty()
        && args.program.len() <= MAX_ID_CHARACTERS
        && args.program.is_ascii()
        && args.program.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric() || (index > 0 && matches!(character, '.' | '_' | '-'))
        });
    if !valid_program || args.args.len() > 32 {
        return Err(invalid_contract("shell.execReadOnly arguments are invalid"));
    }
    if args
        .args
        .iter()
        .any(|argument| argument.chars().count() > 512 || argument.chars().any(char::is_control))
        || args
            .timeout_seconds
            .is_some_and(|timeout| timeout == 0 || timeout > 60)
    {
        return Err(invalid_contract("shell.execReadOnly argument is invalid"));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTerminalContextV2 {
    pub(crate) session_id: String,
    pub(crate) captured_at: u64,
    pub(crate) label: String,
    pub(crate) redacted_text: String,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetRequestV2 {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_run_seconds: Option<u16>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_model_turns: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_tool_calls: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) tool_timeout_seconds: Option<u16>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_consecutive_invalid_decisions: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_consecutive_tool_failures: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_pending_plan_items: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_steering_queue_items: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_user_message_bytes: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) stdout_capture_bytes: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) stderr_capture_bytes: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) total_read_hard_limit_bytes: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_mutation_proposals: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_approved_mutations: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_verification_attempts_per_change: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_verification_runtime_seconds: Option<u16>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPolicyModeV2 {
    Strict,
    Balanced,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentStartRequestV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    pub(crate) client_request_id: String,
    pub(crate) goal: String,
    pub(crate) profile_id: String,
    pub(crate) provider_id: String,
    pub(crate) requested_policy_mode: AgentPolicyModeV2,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) terminal_context: Option<AgentTerminalContextV2>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) requested_budgets: Option<AgentBudgetRequestV2>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ServiceInspectFieldV2 {
    LoadState,
    ActiveState,
    SubState,
    MainPid,
    Result,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceInspectArgsV2 {
    pub(crate) manager: ServiceManagerV2,
    pub(crate) unit: String,
    pub(crate) include: Vec<ServiceInspectFieldV2>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ServiceValidatorV2 {
    Nginx,
    Apache,
    Sshd,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceValidateConfigArgsV2 {
    pub(crate) validator: ServiceValidatorV2,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ServiceManagerV2 {
    Systemd,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ServiceControlActionV2 {
    Start,
    Reload,
    Restart,
    Stop,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceVerificationHintsV2 {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) expected_listener_ports: Option<Vec<u16>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceControlArgsV2 {
    pub(crate) manager: ServiceManagerV2,
    pub(crate) unit: String,
    pub(crate) action: ServiceControlActionV2,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) timeout_seconds: Option<u16>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) verification_hints: Option<ServiceVerificationHintsV2>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRetrySafetyV2 {
    Never,
    VerifyBeforeRetry,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ToolCallDecisionKindV2 {
    ToolCall,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AskUserDecisionKindV2 {
    AskUser,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum FinalDecisionKindV2 {
    Final,
}

macro_rules! fixed_tool_name {
    ($name:ident, $variant:ident, $wire:literal) => {
        #[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
        enum $name {
            #[serde(rename = $wire)]
            $variant,
        }
    };
}

fixed_tool_name!(HostInspectToolNameV2, HostInspect, "host.inspect");
fixed_tool_name!(
    ShellExecReadOnlyToolNameV2,
    ShellExecReadOnly,
    "shell.execReadOnly"
);
fixed_tool_name!(ServiceInspectToolNameV2, ServiceInspect, "service.inspect");
fixed_tool_name!(
    ServiceValidateConfigToolNameV2,
    ServiceValidateConfig,
    "service.validateConfig"
);
fixed_tool_name!(ServiceControlToolNameV2, ServiceControl, "service.control");

macro_rules! readonly_decision {
    ($name:ident, $tool:ty, $args:ty) => {
        #[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub(crate) struct $name {
            pub(crate) schema_version: AgentSchemaVersionV2,
            kind: ToolCallDecisionKindV2,
            pub(crate) rationale: String,
            pub(crate) plan: AgentPlanUpdateV1,
            tool: $tool,
            pub(crate) arguments: $args,
            pub(crate) purpose: String,
            pub(crate) success_criteria: String,
        }
    };
}

readonly_decision!(
    AgentHostInspectDecisionV2,
    HostInspectToolNameV2,
    HostInspectArgsV1
);
readonly_decision!(
    AgentShellExecReadOnlyDecisionV2,
    ShellExecReadOnlyToolNameV2,
    ShellExecReadOnlyArgsV1
);
readonly_decision!(
    AgentServiceInspectDecisionV2,
    ServiceInspectToolNameV2,
    ServiceInspectArgsV2
);
readonly_decision!(
    AgentServiceValidateConfigDecisionV2,
    ServiceValidateConfigToolNameV2,
    ServiceValidateConfigArgsV2
);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentServiceControlDecisionV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    kind: ToolCallDecisionKindV2,
    pub(crate) rationale: String,
    pub(crate) plan: AgentPlanUpdateV1,
    tool: ServiceControlToolNameV2,
    pub(crate) arguments: ServiceControlArgsV2,
    pub(crate) purpose: String,
    pub(crate) expected_impact: String,
    pub(crate) rollback_guidance: String,
    pub(crate) success_criteria: String,
    pub(crate) precondition_evidence_ids: Vec<String>,
    pub(crate) retry_safety: AgentRetrySafetyV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentAskUserDecisionV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    kind: AskUserDecisionKindV2,
    pub(crate) rationale: String,
    pub(crate) plan: AgentPlanUpdateV1,
    pub(crate) question: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentReportOutcomeV2 {
    Resolved,
    Diagnosed,
    Partial,
    Failed,
    Blocked,
    Inconclusive,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFinalReportFindingV2 {
    pub(crate) title: String,
    pub(crate) detail: String,
    pub(crate) confidence: AgentFindingConfidenceV1,
    pub(crate) evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentResourceRefV2 {
    pub(crate) kind: AgentResourceKindV2,
    pub(crate) identity: String,
    pub(crate) target_digest: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentResourceKindV2 {
    SystemdService,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentChangeStatusV2 {
    Verified,
    Unverified,
    FailedNoEffect,
    ExecutionSucceededVerificationFailed,
    PartialUnexpectedEffect,
    UnknownEffect,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentChangeReportV2 {
    pub(crate) change_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) approval_id: String,
    pub(crate) resource: AgentResourceRefV2,
    pub(crate) action: String,
    pub(crate) status: AgentChangeStatusV2,
    pub(crate) execution_evidence_ids: Vec<String>,
    pub(crate) verification_evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentNextActionV2 {
    pub(crate) title: String,
    pub(crate) requires_change: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFinalReportV2 {
    pub(crate) outcome: AgentReportOutcomeV2,
    pub(crate) summary: String,
    pub(crate) findings: Vec<AgentFinalReportFindingV2>,
    pub(crate) changes: Vec<AgentChangeReportV2>,
    pub(crate) warnings: Vec<String>,
    pub(crate) next_actions: Vec<AgentNextActionV2>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFinalDecisionV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    kind: FinalDecisionKindV2,
    pub(crate) rationale: String,
    pub(crate) plan: AgentPlanUpdateV1,
    pub(crate) report: AgentFinalReportV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub(crate) enum AgentDecisionV2 {
    HostInspect(AgentHostInspectDecisionV2),
    ShellExecReadOnly(AgentShellExecReadOnlyDecisionV2),
    ServiceInspect(AgentServiceInspectDecisionV2),
    ServiceValidateConfig(AgentServiceValidateConfigDecisionV2),
    ServiceControl(AgentServiceControlDecisionV2),
    AskUser(AgentAskUserDecisionV2),
    Final(AgentFinalDecisionV2),
}

impl AgentDecisionV2 {
    pub(crate) fn kind_name(&self) -> &'static str {
        match self {
            Self::HostInspect(_)
            | Self::ShellExecReadOnly(_)
            | Self::ServiceInspect(_)
            | Self::ServiceValidateConfig(_)
            | Self::ServiceControl(_) => "toolCall",
            Self::AskUser(_) => "askUser",
            Self::Final(_) => "final",
        }
    }

    pub(crate) fn tool_name(&self) -> Option<&'static str> {
        match self {
            Self::HostInspect(_) => Some("host.inspect"),
            Self::ShellExecReadOnly(_) => Some("shell.execReadOnly"),
            Self::ServiceInspect(_) => Some("service.inspect"),
            Self::ServiceValidateConfig(_) => Some("service.validateConfig"),
            Self::ServiceControl(_) => Some("service.control"),
            Self::AskUser(_) | Self::Final(_) => None,
        }
    }
}

pub(crate) fn decode_agent_decision_v2(
    raw: &str,
) -> Result<AgentDecisionV2, AgentProtocolDecodeErrorV2> {
    if raw.len() > MAX_AGENT_DECISION_BYTES_V2 {
        return Err(AgentProtocolDecodeErrorV2 {
            kind: AgentProtocolDecodeErrorKindV2::TooLarge,
            message: "Agent v2 decision exceeds 64 KiB".to_string(),
        });
    }
    let decision = serde_json::from_str::<AgentDecisionV2>(raw).map_err(|error| {
        AgentProtocolDecodeErrorV2 {
            kind: if error.is_syntax() || error.is_eof() {
                AgentProtocolDecodeErrorKindV2::InvalidJson
            } else {
                AgentProtocolDecodeErrorKindV2::InvalidContract
            },
            message: "Agent decision does not match protocol version 2".to_string(),
        }
    })?;
    validate_agent_decision_v2(&decision)?;
    Ok(decision)
}

pub(crate) fn decode_agent_start_request_v2(
    raw: &str,
) -> Result<AgentStartRequestV2, AgentProtocolDecodeErrorV2> {
    let request = serde_json::from_str::<AgentStartRequestV2>(raw).map_err(|error| {
        AgentProtocolDecodeErrorV2 {
            kind: if error.is_syntax() || error.is_eof() {
                AgentProtocolDecodeErrorKindV2::InvalidJson
            } else {
                AgentProtocolDecodeErrorKindV2::InvalidContract
            },
            message: "Agent start request does not match protocol version 2".to_string(),
        }
    })?;
    validate_agent_start_request_v2(&request)?;
    Ok(request)
}

fn validate_service_inspect_args(
    args: &ServiceInspectArgsV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_service_unit(&args.unit) || args.include.is_empty() || args.include.len() > 5 {
        return Err(invalid_contract("service.inspect arguments are invalid"));
    }
    if args.include.iter().copied().collect::<HashSet<_>>().len() != args.include.len() {
        return Err(invalid_contract(
            "service.inspect include contains duplicates",
        ));
    }
    Ok(())
}

fn validate_service_control_args(
    args: &ServiceControlArgsV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_service_unit(&args.unit)
        || args
            .timeout_seconds
            .is_some_and(|timeout| timeout == 0 || timeout > 60)
    {
        return Err(invalid_contract("service.control arguments are invalid"));
    }
    if let Some(hints) = &args.verification_hints {
        if let Some(ports) = &hints.expected_listener_ports {
            if ports.is_empty()
                || ports.len() > MAX_EXPECTED_LISTENER_PORTS
                || ports.contains(&0)
                || ports.iter().copied().collect::<HashSet<_>>().len() != ports.len()
                || args.action == ServiceControlActionV2::Stop
            {
                return Err(invalid_contract(
                    "service.control expected listener ports are invalid",
                ));
            }
        }
    }
    Ok(())
}

fn validate_tool_text(
    rationale: &str,
    purpose: &str,
    success_criteria: &str,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if bounded_text(rationale, MAX_RATIONALE_CHARACTERS)
        && bounded_text(purpose, MAX_TOOL_TEXT_CHARACTERS)
        && bounded_text(success_criteria, MAX_TOOL_TEXT_CHARACTERS)
    {
        Ok(())
    } else {
        Err(invalid_contract("Agent v2 tool decision text is invalid"))
    }
}

fn validate_resource(resource: &AgentResourceRefV2) -> Result<(), AgentProtocolDecodeErrorV2> {
    let expected_identity = resource
        .identity
        .strip_prefix("systemd:")
        .is_some_and(valid_service_unit);
    if !expected_identity || !bounded_text(&resource.target_digest, 200) {
        return Err(invalid_contract("Agent v2 resource reference is invalid"));
    }
    Ok(())
}

fn validate_final_report(report: &AgentFinalReportV2) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !bounded_text(&report.summary, MAX_REPORT_TEXT_CHARACTERS)
        || report.findings.len() > MAX_FINDINGS
        || report.changes.len() > MAX_CHANGES
        || report.warnings.len() > 16
        || report.next_actions.len() > 16
    {
        return Err(invalid_contract(
            "Agent v2 final report exceeds protocol limits",
        ));
    }
    for finding in &report.findings {
        if !bounded_text(&finding.title, MAX_LABEL_CHARACTERS)
            || !bounded_text(&finding.detail, MAX_REPORT_TEXT_CHARACTERS)
            || finding.evidence_ids.len() > MAX_EVIDENCE_IDS
            || finding.evidence_ids.iter().any(|id| !valid_identifier(id))
            || (finding.confidence == AgentFindingConfidenceV1::Verified
                && finding.evidence_ids.is_empty())
        {
            return Err(invalid_contract("Agent v2 final report finding is invalid"));
        }
    }
    for change in &report.changes {
        validate_change_report(change)?;
    }
    if report
        .warnings
        .iter()
        .any(|warning| !bounded_text(warning, MAX_REPORT_ITEM_TEXT_CHARACTERS))
        || report
            .next_actions
            .iter()
            .any(|action| !bounded_text(&action.title, MAX_REPORT_ITEM_TEXT_CHARACTERS))
    {
        return Err(invalid_contract("Agent v2 final report item is invalid"));
    }
    Ok(())
}

fn validate_change_report(change: &AgentChangeReportV2) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_identifier(&change.change_id)
        || !valid_identifier(&change.tool_call_id)
        || !valid_identifier(&change.approval_id)
        || !bounded_text(&change.action, 64)
        || change.execution_evidence_ids.is_empty()
        || change.execution_evidence_ids.len() > MAX_EVIDENCE_IDS
        || change
            .execution_evidence_ids
            .iter()
            .any(|id| !valid_identifier(id))
        || change.verification_evidence_ids.len() > MAX_EVIDENCE_IDS
        || change
            .verification_evidence_ids
            .iter()
            .any(|id| !valid_identifier(id))
        || (change.status == AgentChangeStatusV2::Verified
            && change.verification_evidence_ids.is_empty())
    {
        return Err(invalid_contract("Agent v2 change report is invalid"));
    }
    validate_resource(&change.resource)
}

fn validate_agent_decision_v2(
    decision: &AgentDecisionV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    match decision {
        AgentDecisionV2::HostInspect(value) => {
            validate_plan(&value.plan)?;
            validate_host_inspect_args(&value.arguments)?;
            validate_tool_text(&value.rationale, &value.purpose, &value.success_criteria)
        }
        AgentDecisionV2::ShellExecReadOnly(value) => {
            validate_plan(&value.plan)?;
            validate_shell_args(&value.arguments)?;
            validate_tool_text(&value.rationale, &value.purpose, &value.success_criteria)
        }
        AgentDecisionV2::ServiceInspect(value) => {
            validate_plan(&value.plan)?;
            validate_service_inspect_args(&value.arguments)?;
            validate_tool_text(&value.rationale, &value.purpose, &value.success_criteria)
        }
        AgentDecisionV2::ServiceValidateConfig(value) => {
            validate_plan(&value.plan)?;
            validate_tool_text(&value.rationale, &value.purpose, &value.success_criteria)
        }
        AgentDecisionV2::ServiceControl(value) => {
            validate_plan(&value.plan)?;
            validate_service_control_args(&value.arguments)?;
            validate_tool_text(&value.rationale, &value.purpose, &value.success_criteria)?;
            if !bounded_text(&value.expected_impact, MAX_TOOL_TEXT_CHARACTERS)
                || !bounded_text(&value.rollback_guidance, MAX_TOOL_TEXT_CHARACTERS)
                || value.precondition_evidence_ids.is_empty()
                || value.precondition_evidence_ids.len() > MAX_EVIDENCE_IDS
                || value
                    .precondition_evidence_ids
                    .iter()
                    .any(|id| !valid_identifier(id))
            {
                return Err(invalid_contract("service.control decision is invalid"));
            }
            Ok(())
        }
        AgentDecisionV2::AskUser(value) => {
            validate_plan(&value.plan)?;
            if !bounded_text(&value.rationale, MAX_RATIONALE_CHARACTERS)
                || !bounded_text(&value.question, MAX_QUESTION_CHARACTERS)
            {
                return Err(invalid_contract("Agent v2 askUser decision is invalid"));
            }
            Ok(())
        }
        AgentDecisionV2::Final(value) => {
            validate_plan(&value.plan)?;
            if !bounded_text(&value.rationale, MAX_RATIONALE_CHARACTERS) {
                return Err(invalid_contract("Agent v2 final rationale is invalid"));
            }
            validate_final_report(&value.report)
        }
    }
}

fn validate_agent_start_request_v2(
    request: &AgentStartRequestV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_identifier(&request.client_request_id)
        || !valid_identifier(&request.profile_id)
        || !valid_identifier(&request.provider_id)
        || !bounded_text(&request.goal, MAX_GOAL_CHARACTERS)
    {
        return Err(invalid_contract("Agent v2 start metadata is invalid"));
    }
    if let Some(context) = &request.terminal_context {
        if !valid_identifier(&context.session_id)
            || !bounded_text(&context.label, MAX_LABEL_CHARACTERS)
            || context.redacted_text.chars().count() > MAX_TERMINAL_CONTEXT_CHARACTERS
            || context.redacted_text.contains('\0')
        {
            return Err(invalid_contract("Agent v2 terminal context is invalid"));
        }
    }
    if let Some(budgets) = &request.requested_budgets {
        let within = budgets
            .max_run_seconds
            .is_none_or(|value| (1..=900).contains(&value))
            && budgets
                .max_model_turns
                .is_none_or(|value| (1..=20).contains(&value))
            && budgets
                .max_tool_calls
                .is_none_or(|value| (1..=15).contains(&value))
            && budgets
                .tool_timeout_seconds
                .is_none_or(|value| (1..=60).contains(&value))
            && budgets
                .max_consecutive_invalid_decisions
                .is_none_or(|value| (1..=2).contains(&value))
            && budgets
                .max_consecutive_tool_failures
                .is_none_or(|value| (1..=3).contains(&value))
            && budgets
                .max_pending_plan_items
                .is_none_or(|value| (1..=8).contains(&value))
            && budgets
                .max_steering_queue_items
                .is_none_or(|value| (1..=16).contains(&value))
            && budgets
                .max_user_message_bytes
                .is_none_or(|value| (1..=8192).contains(&value))
            && budgets
                .stdout_capture_bytes
                .is_none_or(|value| (1..=262_144).contains(&value))
            && budgets
                .stderr_capture_bytes
                .is_none_or(|value| (1..=65_536).contains(&value))
            && budgets
                .total_read_hard_limit_bytes
                .is_none_or(|value| (1..=16_777_216).contains(&value))
            && budgets
                .max_mutation_proposals
                .is_none_or(|value| (1..=5).contains(&value))
            && budgets
                .max_approved_mutations
                .is_none_or(|value| (1..=3).contains(&value))
            && budgets
                .max_verification_attempts_per_change
                .is_none_or(|value| (1..=3).contains(&value))
            && budgets
                .max_verification_runtime_seconds
                .is_none_or(|value| (1..=120).contains(&value));
        if !within {
            return Err(invalid_contract("Agent v2 requested budget is invalid"));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub(crate) enum AgentToolNameV2 {
    #[serde(rename = "host.inspect")]
    HostInspect,
    #[serde(rename = "shell.execReadOnly")]
    ShellExecReadOnly,
    #[serde(rename = "service.inspect")]
    ServiceInspect,
    #[serde(rename = "service.validateConfig")]
    ServiceValidateConfig,
    #[serde(rename = "service.control")]
    ServiceControl,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetPolicyV2 {
    pub(crate) max_run_seconds: u16,
    pub(crate) max_model_turns: u8,
    pub(crate) max_tool_calls: u8,
    pub(crate) tool_timeout_seconds: u16,
    pub(crate) max_consecutive_invalid_decisions: u8,
    pub(crate) max_consecutive_tool_failures: u8,
    pub(crate) max_pending_plan_items: u8,
    pub(crate) max_steering_queue_items: u8,
    pub(crate) max_user_message_bytes: u32,
    pub(crate) stdout_capture_bytes: u32,
    pub(crate) stderr_capture_bytes: u32,
    pub(crate) total_read_hard_limit_bytes: u32,
    pub(crate) max_mutation_proposals: u8,
    pub(crate) max_approved_mutations: u8,
    pub(crate) max_pending_approvals: u8,
    pub(crate) max_verification_attempts_per_change: u8,
    pub(crate) max_verification_runtime_seconds: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetUsageV2 {
    pub(crate) elapsed_millis: u64,
    pub(crate) model_turns_used: u8,
    pub(crate) tool_calls_used: u8,
    pub(crate) consecutive_invalid_decisions: u8,
    pub(crate) consecutive_tool_failures: u8,
    pub(crate) steering_queue_items: u8,
    pub(crate) mutation_proposals_used: u8,
    pub(crate) approved_mutations_used: u8,
    pub(crate) pending_approvals: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetSnapshotV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    pub(crate) policy: AgentBudgetPolicyV2,
    pub(crate) usage: AgentBudgetUsageV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPolicySnapshotV2 {
    pub(crate) mode: AgentPolicyModeV2,
    pub(crate) policy_version: String,
    pub(crate) tool_registry_version: String,
    pub(crate) allowed_tools: Vec<AgentToolNameV2>,
    pub(crate) controlled_mutation_allowed: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentProviderKindV2 {
    Ollama,
    OpenAi,
    OpenAiCompatible,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentProviderCapabilitiesV2 {
    pub(crate) streaming: bool,
    pub(crate) strict_json_schema: bool,
    pub(crate) native_tool_calling: bool,
    pub(crate) usage_reporting: bool,
    pub(crate) response_continuation: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentProviderBindingV2 {
    pub(crate) provider_id: String,
    pub(crate) kind: AgentProviderKindV2,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) capabilities: AgentProviderCapabilitiesV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentJumpTargetSummaryV2 {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTargetBindingV2 {
    pub(crate) profile_id: String,
    pub(crate) profile_label: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) jump_host: Option<AgentJumpTargetSummaryV2>,
    pub(crate) target_digest: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRiskSeverityV2 {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRiskConfidenceV2 {
    Known,
    Heuristic,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRiskDimensionsV2 {
    pub(crate) read: bool,
    pub(crate) write: bool,
    pub(crate) delete: bool,
    pub(crate) privilege_elevation: bool,
    pub(crate) service_interruption: bool,
    pub(crate) network_change: bool,
    pub(crate) credential_access: bool,
    pub(crate) external_network: bool,
    pub(crate) multi_host: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRiskFindingV2 {
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRiskVerdictV2 {
    AutoReadOnly,
    RequiresApproval,
    RequiresDoubleConfirmation,
    Deny,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRiskAssessmentV2 {
    pub(crate) risk_assessment_id: String,
    pub(crate) severity: AgentRiskSeverityV2,
    pub(crate) confidence: AgentRiskConfidenceV2,
    pub(crate) dimensions: AgentRiskDimensionsV2,
    pub(crate) findings: Vec<AgentRiskFindingV2>,
    pub(crate) affected_resources: Vec<AgentResourceRefV2>,
    pub(crate) verdict: AgentRiskVerdictV2,
    pub(crate) policy_version: String,
    pub(crate) assessment_digest: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPublicErrorCategoryV2 {
    AgentBusy,
    TargetUnavailable,
    ProviderIncompatible,
    ProviderUnavailable,
    ProviderProtocol,
    ToolDenied,
    ToolFailed,
    StaleEvidence,
    PreconditionFailed,
    ApprovalRequired,
    ApprovalExpired,
    VerificationFailed,
    BudgetExceeded,
    Cancelled,
    P2Blocked,
    PolicyUnavailable,
    Internal,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPublicErrorV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    pub(crate) category: AgentPublicErrorCategoryV2,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) suggestion: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolResultStatusV2 {
    Completed,
    Partial,
    Failed,
    TimedOut,
    Cancelled,
    UnknownEffect,
    Denied,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentToolExecutionResultV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    pub(crate) run_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) status: AgentToolResultStatusV2,
    pub(crate) started_at: u64,
    pub(crate) completed_at: u64,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout_excerpt: String,
    pub(crate) stderr_excerpt: String,
    pub(crate) stdout_bytes_captured: u64,
    pub(crate) stderr_bytes_captured: u64,
    pub(crate) stdout_bytes_read: u64,
    pub(crate) stderr_bytes_read: u64,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) error: Option<AgentPublicErrorV2>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum AgentEvidenceSourceV2 {
    #[serde(rename = "terminalSnapshot")]
    TerminalSnapshot,
    #[serde(rename = "host.inspect")]
    HostInspect,
    #[serde(rename = "shell.execReadOnly")]
    ShellExecReadOnly,
    #[serde(rename = "service.inspect")]
    ServiceInspect,
    #[serde(rename = "service.validateConfig")]
    ServiceValidateConfig,
    #[serde(rename = "service.control")]
    ServiceControl,
    #[serde(rename = "service.verify")]
    ServiceVerify,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentEvidenceV2 {
    pub(crate) evidence_id: String,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) source: AgentEvidenceSourceV2,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) tool_call_id: Option<String>,
    pub(crate) observed_at: u64,
    pub(crate) summary: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) stdout_excerpt: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) stderr_excerpt: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) exit_code: Option<i32>,
    pub(crate) truncated: bool,
    pub(crate) observation_digest: String,
}

macro_rules! readonly_tool_snapshot {
    ($name:ident, $tool:ty, $args:ty) => {
        #[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub(crate) struct $name {
            pub(crate) tool_call_id: String,
            pub(crate) state: AgentToolCallStateV2,
            tool: $tool,
            pub(crate) arguments: $args,
            pub(crate) rationale: String,
            pub(crate) purpose: String,
            pub(crate) success_criteria: String,
            pub(crate) proposed_at: u64,
            #[serde(
                default,
                deserialize_with = "deserialize_optional_non_null",
                skip_serializing_if = "Option::is_none"
            )]
            pub(crate) operation_id: Option<String>,
            #[serde(
                default,
                deserialize_with = "deserialize_optional_non_null",
                skip_serializing_if = "Option::is_none"
            )]
            pub(crate) command_preview: Option<String>,
            #[serde(
                default,
                deserialize_with = "deserialize_optional_non_null",
                skip_serializing_if = "Option::is_none"
            )]
            pub(crate) result: Option<AgentToolExecutionResultV2>,
            pub(crate) evidence_ids: Vec<String>,
        }
    };
}

readonly_tool_snapshot!(
    AgentHostInspectToolCallSnapshotV2,
    HostInspectToolNameV2,
    HostInspectArgsV1
);
readonly_tool_snapshot!(
    AgentShellExecReadOnlyToolCallSnapshotV2,
    ShellExecReadOnlyToolNameV2,
    ShellExecReadOnlyArgsV1
);
readonly_tool_snapshot!(
    AgentServiceInspectToolCallSnapshotV2,
    ServiceInspectToolNameV2,
    ServiceInspectArgsV2
);
readonly_tool_snapshot!(
    AgentServiceValidateConfigToolCallSnapshotV2,
    ServiceValidateConfigToolNameV2,
    ServiceValidateConfigArgsV2
);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentServiceControlToolCallSnapshotV2 {
    pub(crate) tool_call_id: String,
    pub(crate) state: AgentToolCallStateV2,
    tool: ServiceControlToolNameV2,
    pub(crate) arguments: ServiceControlArgsV2,
    pub(crate) rationale: String,
    pub(crate) purpose: String,
    pub(crate) expected_impact: String,
    pub(crate) rollback_guidance: String,
    pub(crate) success_criteria: String,
    pub(crate) precondition_evidence_ids: Vec<String>,
    pub(crate) retry_safety: AgentRetrySafetyV2,
    pub(crate) proposed_at: u64,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) operation_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) command_preview: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) result: Option<AgentToolExecutionResultV2>,
    pub(crate) evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub(crate) enum AgentToolCallSnapshotV2 {
    HostInspect(AgentHostInspectToolCallSnapshotV2),
    ShellExecReadOnly(AgentShellExecReadOnlyToolCallSnapshotV2),
    ServiceInspect(AgentServiceInspectToolCallSnapshotV2),
    ServiceValidateConfig(AgentServiceValidateConfigToolCallSnapshotV2),
    ServiceControl(AgentServiceControlToolCallSnapshotV2),
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentApprovalConfirmationModeV2 {
    Single,
    Double,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentApprovalSnapshotV2 {
    pub(crate) approval_id: String,
    pub(crate) run_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) tool_name: AgentToolNameV2,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) resource: Option<AgentResourceRefV2>,
    pub(crate) risk_assessment_id: String,
    pub(crate) command_preview: String,
    pub(crate) precondition_evidence_ids: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) verification_plan_digest: Option<String>,
    pub(crate) timeout_seconds: u16,
    pub(crate) issued_at: u64,
    pub(crate) expires_at: u64,
    pub(crate) confirmation_mode: AgentApprovalConfirmationModeV2,
    pub(crate) state: AgentApprovalStateV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentChangeSnapshotV2 {
    pub(crate) change_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) approval_id: String,
    pub(crate) resource: AgentResourceRefV2,
    pub(crate) action: String,
    pub(crate) status: AgentChangeStatusV2,
    pub(crate) execution_evidence_ids: Vec<String>,
    pub(crate) verification_evidence_ids: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) operation_id: Option<String>,
    pub(crate) recorded_at: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentVerificationSnapshotV2 {
    pub(crate) verification_obligation_id: String,
    pub(crate) change_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) state: AgentVerificationStateV2,
    pub(crate) verification_plan_digest: String,
    pub(crate) evidence_ids: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) started_at: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) completed_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentQuestionV2 {
    pub(crate) question_id: String,
    pub(crate) question: String,
    pub(crate) asked_at: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunSnapshotV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    pub(crate) run_id: String,
    pub(crate) last_sequence: u64,
    pub(crate) state: AgentRunStateV2,
    pub(crate) target: AgentTargetBindingV2,
    pub(crate) provider: AgentProviderBindingV2,
    pub(crate) policy: AgentPolicySnapshotV2,
    pub(crate) budgets: AgentBudgetSnapshotV2,
    pub(crate) goal: String,
    pub(crate) plan: Vec<AgentPlanItemV1>,
    pub(crate) tool_calls: Vec<AgentToolCallSnapshotV2>,
    pub(crate) evidence: Vec<AgentEvidenceV2>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) pending_question: Option<AgentQuestionV2>,
    pub(crate) queued_steering_count: u8,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) report: Option<AgentFinalReportV2>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) error: Option<AgentPublicErrorV2>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) pending_approval: Option<AgentApprovalSnapshotV2>,
    pub(crate) risk_assessments: Vec<AgentRiskAssessmentV2>,
    pub(crate) changes: Vec<AgentChangeSnapshotV2>,
    pub(crate) verification_obligations: Vec<AgentVerificationSnapshotV2>,
}

pub(crate) fn decode_agent_snapshot_v2(
    raw: &str,
) -> Result<AgentRunSnapshotV2, AgentProtocolDecodeErrorV2> {
    let snapshot = serde_json::from_str::<AgentRunSnapshotV2>(raw).map_err(|error| {
        AgentProtocolDecodeErrorV2 {
            kind: if error.is_syntax() || error.is_eof() {
                AgentProtocolDecodeErrorKindV2::InvalidJson
            } else {
                AgentProtocolDecodeErrorKindV2::InvalidContract
            },
            message: "Agent snapshot does not match protocol version 2".to_string(),
        }
    })?;
    validate_agent_snapshot_v2(&snapshot)?;
    Ok(snapshot)
}

fn validate_agent_snapshot_v2(
    snapshot: &AgentRunSnapshotV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_identifier(&snapshot.run_id)
        || !bounded_text(&snapshot.goal, MAX_GOAL_CHARACTERS)
        || snapshot.plan.len() > MAX_PLAN_ITEMS
        || snapshot.tool_calls.len() > MAX_TOOL_CALLS
        || snapshot.evidence.len() > 64
        || snapshot.risk_assessments.len() > MAX_RISK_ASSESSMENTS
        || snapshot.changes.len() > MAX_CHANGES
        || snapshot.verification_obligations.len() > MAX_VERIFICATION_OBLIGATIONS
        || snapshot.queued_steering_count > 16
    {
        return Err(invalid_contract(
            "Agent v2 snapshot exceeds protocol limits",
        ));
    }
    validate_plan(&AgentPlanUpdateV1 {
        items: snapshot.plan.clone(),
    })?;
    validate_budget_snapshot(&snapshot.budgets)?;
    validate_policy_snapshot(&snapshot.policy)?;
    for tool_call in &snapshot.tool_calls {
        validate_tool_call_snapshot(tool_call)?;
    }
    for risk in &snapshot.risk_assessments {
        validate_risk_assessment(risk)?;
    }
    if let Some(approval) = &snapshot.pending_approval {
        validate_approval_snapshot(approval)?;
        if AgentApprovalStateV2::TERMINAL.contains(&approval.state) {
            return Err(invalid_contract(
                "Agent v2 pending approval cannot contain a terminal approval",
            ));
        }
    }
    for change in &snapshot.changes {
        validate_change_snapshot(change)?;
    }
    for verification in &snapshot.verification_obligations {
        validate_verification_snapshot(verification)?;
    }
    if let Some(report) = &snapshot.report {
        validate_final_report(report)?;
    }
    if let Some(question) = &snapshot.pending_question {
        if !valid_identifier(&question.question_id)
            || !bounded_text(&question.question, MAX_QUESTION_CHARACTERS)
        {
            return Err(invalid_contract("Agent v2 pending question is invalid"));
        }
    }
    Ok(())
}

fn validate_budget_snapshot(
    budgets: &AgentBudgetSnapshotV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    let policy = &budgets.policy;
    let usage = &budgets.usage;
    if policy.max_pending_approvals != 1
        || policy.max_mutation_proposals == 0
        || policy.max_mutation_proposals > 5
        || policy.max_approved_mutations == 0
        || policy.max_approved_mutations > 3
        || policy.max_verification_attempts_per_change == 0
        || policy.max_verification_attempts_per_change > 3
        || policy.max_verification_runtime_seconds == 0
        || policy.max_verification_runtime_seconds > 120
        || usage.pending_approvals > 1
        || usage.mutation_proposals_used > policy.max_mutation_proposals
        || usage.approved_mutations_used > policy.max_approved_mutations
    {
        return Err(invalid_contract("Agent v2 budget snapshot is invalid"));
    }
    Ok(())
}

fn validate_policy_snapshot(
    policy: &AgentPolicySnapshotV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_identifier(&policy.policy_version)
        || !valid_identifier(&policy.tool_registry_version)
        || policy.allowed_tools.len() > 5
        || policy
            .allowed_tools
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            != policy.allowed_tools.len()
    {
        return Err(invalid_contract("Agent v2 policy snapshot is invalid"));
    }
    Ok(())
}

fn validate_tool_call_snapshot(
    tool_call: &AgentToolCallSnapshotV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    macro_rules! validate_readonly {
        ($value:expr, $args:expr) => {{
            let value = $value;
            if !valid_identifier(&value.tool_call_id)
                || value.evidence_ids.len() > MAX_EVIDENCE_IDS
                || value.evidence_ids.iter().any(|id| !valid_identifier(id))
            {
                return Err(invalid_contract("Agent v2 tool snapshot is invalid"));
            }
            validate_tool_text(&value.rationale, &value.purpose, &value.success_criteria)?;
            $args
        }};
    }
    match tool_call {
        AgentToolCallSnapshotV2::HostInspect(value) => {
            validate_readonly!(value, validate_host_inspect_args(&value.arguments))
        }
        AgentToolCallSnapshotV2::ShellExecReadOnly(value) => {
            validate_readonly!(value, validate_shell_args(&value.arguments))
        }
        AgentToolCallSnapshotV2::ServiceInspect(value) => {
            validate_readonly!(value, validate_service_inspect_args(&value.arguments))
        }
        AgentToolCallSnapshotV2::ServiceValidateConfig(value) => {
            validate_readonly!(value, Ok(()))
        }
        AgentToolCallSnapshotV2::ServiceControl(value) => {
            if !valid_identifier(&value.tool_call_id)
                || value.precondition_evidence_ids.is_empty()
                || value.precondition_evidence_ids.len() > MAX_EVIDENCE_IDS
                || value
                    .precondition_evidence_ids
                    .iter()
                    .any(|id| !valid_identifier(id))
                || !bounded_text(&value.expected_impact, MAX_TOOL_TEXT_CHARACTERS)
                || !bounded_text(&value.rollback_guidance, MAX_TOOL_TEXT_CHARACTERS)
            {
                return Err(invalid_contract("service.control snapshot is invalid"));
            }
            validate_tool_text(&value.rationale, &value.purpose, &value.success_criteria)?;
            validate_service_control_args(&value.arguments)
        }
    }
}

fn validate_risk_assessment(
    risk: &AgentRiskAssessmentV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_identifier(&risk.risk_assessment_id)
        || !valid_identifier(&risk.policy_version)
        || !bounded_text(&risk.assessment_digest, 200)
        || risk.findings.len() > 32
        || risk.affected_resources.len() > 8
        || risk.findings.iter().any(|finding| {
            !valid_identifier(&finding.code) || !bounded_text(&finding.message, 2_000)
        })
    {
        return Err(invalid_contract("Agent v2 risk assessment is invalid"));
    }
    for resource in &risk.affected_resources {
        validate_resource(resource)?;
    }
    Ok(())
}

fn validate_approval_snapshot(
    approval: &AgentApprovalSnapshotV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_identifier(&approval.approval_id)
        || !valid_identifier(&approval.run_id)
        || !valid_identifier(&approval.tool_call_id)
        || !valid_identifier(&approval.risk_assessment_id)
        || !bounded_text(&approval.command_preview, 8 * 1024)
        || approval.precondition_evidence_ids.len() > MAX_EVIDENCE_IDS
        || approval
            .precondition_evidence_ids
            .iter()
            .any(|id| !valid_identifier(id))
        || approval.timeout_seconds == 0
        || approval.timeout_seconds > 60
        || approval.expires_at <= approval.issued_at
    {
        return Err(invalid_contract("Agent v2 approval snapshot is invalid"));
    }
    if let Some(resource) = &approval.resource {
        validate_resource(resource)?;
    }
    if approval.tool_name == AgentToolNameV2::ServiceControl
        && (approval.resource.is_none()
            || approval.precondition_evidence_ids.is_empty()
            || approval.verification_plan_digest.is_none())
    {
        return Err(invalid_contract(
            "Agent v2 mutation approval is missing an immutable binding",
        ));
    }
    Ok(())
}

fn validate_change_snapshot(
    change: &AgentChangeSnapshotV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    validate_change_report(&AgentChangeReportV2 {
        change_id: change.change_id.clone(),
        tool_call_id: change.tool_call_id.clone(),
        approval_id: change.approval_id.clone(),
        resource: change.resource.clone(),
        action: change.action.clone(),
        status: change.status,
        execution_evidence_ids: change.execution_evidence_ids.clone(),
        verification_evidence_ids: change.verification_evidence_ids.clone(),
    })?;
    if change
        .operation_id
        .as_deref()
        .is_some_and(|id| !valid_identifier(id))
    {
        return Err(invalid_contract("Agent v2 change operation ID is invalid"));
    }
    Ok(())
}

fn validate_verification_snapshot(
    verification: &AgentVerificationSnapshotV2,
) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_identifier(&verification.verification_obligation_id)
        || !valid_identifier(&verification.change_id)
        || !valid_identifier(&verification.tool_call_id)
        || !bounded_text(&verification.verification_plan_digest, 200)
        || verification.evidence_ids.len() > MAX_EVIDENCE_IDS
        || verification
            .evidence_ids
            .iter()
            .any(|id| !valid_identifier(id))
        || verification
            .completed_at
            .zip(verification.started_at)
            .is_some_and(|(completed, started)| completed < started)
    {
        return Err(invalid_contract(
            "Agent v2 verification snapshot is invalid",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum AgentEventTypeV2 {
    #[serde(rename = "run.created")]
    RunCreated,
    #[serde(rename = "run.stateChanged")]
    RunStateChanged,
    #[serde(rename = "plan.updated")]
    PlanUpdated,
    #[serde(rename = "model.started")]
    ModelStarted,
    #[serde(rename = "model.completed")]
    ModelCompleted,
    #[serde(rename = "tool.proposed")]
    ToolProposed,
    #[serde(rename = "tool.stateChanged")]
    ToolStateChanged,
    #[serde(rename = "evidence.created")]
    EvidenceCreated,
    #[serde(rename = "budget.updated")]
    BudgetUpdated,
    #[serde(rename = "user.messageAccepted")]
    UserMessageAccepted,
    #[serde(rename = "run.reportCreated")]
    RunReportCreated,
    #[serde(rename = "run.warning")]
    RunWarning,
    #[serde(rename = "run.terminal")]
    RunTerminal,
    #[serde(rename = "risk.evaluated")]
    RiskEvaluated,
    #[serde(rename = "approval.requested")]
    ApprovalRequested,
    #[serde(rename = "approval.confirmationRequired")]
    ApprovalConfirmationRequired,
    #[serde(rename = "approval.resolved")]
    ApprovalResolved,
    #[serde(rename = "approval.expired")]
    ApprovalExpired,
    #[serde(rename = "approval.revoked")]
    ApprovalRevoked,
    #[serde(rename = "change.executionStarted")]
    ChangeExecutionStarted,
    #[serde(rename = "change.executionCompleted")]
    ChangeExecutionCompleted,
    #[serde(rename = "verification.started")]
    VerificationStarted,
    #[serde(rename = "verification.completed")]
    VerificationCompleted,
    #[serde(rename = "change.recorded")]
    ChangeRecorded,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunCreatedPayloadV2 {
    pub(crate) state: AgentRunStateV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunStateChangedPayloadV2 {
    pub(crate) previous_state: AgentRunStateV2,
    pub(crate) state: AgentRunStateV2,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPlanUpdatedPayloadV2 {
    pub(crate) plan: Vec<AgentPlanItemV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentModelTurnPayloadV2 {
    pub(crate) model_turn: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentToolProposedPayloadV2 {
    pub(crate) tool_call: AgentToolCallSnapshotV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentToolStateChangedPayloadV2 {
    pub(crate) tool_call_id: String,
    pub(crate) previous_state: AgentToolCallStateV2,
    pub(crate) state: AgentToolCallStateV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentEvidenceCreatedPayloadV2 {
    pub(crate) evidence: AgentEvidenceV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetUpdatedPayloadV2 {
    pub(crate) budgets: AgentBudgetSnapshotV2,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentMessageKindV2 {
    Answer,
    Steering,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentUserMessageAcceptedPayloadV2 {
    pub(crate) client_action_id: String,
    pub(crate) message_kind: AgentMessageKindV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentReportCreatedPayloadV2 {
    pub(crate) report: AgentFinalReportV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentWarningPayloadV2 {
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunTerminalPayloadV2 {
    pub(crate) state: AgentRunStateV2,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) error: Option<AgentPublicErrorV2>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRiskEvaluatedPayloadV2 {
    pub(crate) tool_call_id: String,
    pub(crate) risk_assessment: AgentRiskAssessmentV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentApprovalRequestedPayloadV2 {
    pub(crate) approval: AgentApprovalSnapshotV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentApprovalConfirmationRequiredPayloadV2 {
    pub(crate) approval_id: String,
    pub(crate) challenge_id: String,
    pub(crate) expires_at: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentApprovalResolutionStateV2 {
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentApprovalResolvedPayloadV2 {
    pub(crate) approval_id: String,
    pub(crate) state: AgentApprovalResolutionStateV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentApprovalExpiredPayloadV2 {
    pub(crate) approval_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentApprovalRevokedPayloadV2 {
    pub(crate) approval_id: String,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentChangePayloadV2 {
    pub(crate) change: AgentChangeSnapshotV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentVerificationPayloadV2 {
    pub(crate) verification: AgentVerificationSnapshotV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentEventPayloadV2 {
    RunCreated(AgentRunCreatedPayloadV2),
    RunStateChanged(AgentRunStateChangedPayloadV2),
    PlanUpdated(AgentPlanUpdatedPayloadV2),
    ModelStarted(AgentModelTurnPayloadV2),
    ModelCompleted(AgentModelTurnPayloadV2),
    ToolProposed(Box<AgentToolProposedPayloadV2>),
    ToolStateChanged(AgentToolStateChangedPayloadV2),
    EvidenceCreated(AgentEvidenceCreatedPayloadV2),
    BudgetUpdated(AgentBudgetUpdatedPayloadV2),
    UserMessageAccepted(AgentUserMessageAcceptedPayloadV2),
    RunReportCreated(AgentReportCreatedPayloadV2),
    RunWarning(AgentWarningPayloadV2),
    RunTerminal(AgentRunTerminalPayloadV2),
    RiskEvaluated(AgentRiskEvaluatedPayloadV2),
    ApprovalRequested(AgentApprovalRequestedPayloadV2),
    ApprovalConfirmationRequired(AgentApprovalConfirmationRequiredPayloadV2),
    ApprovalResolved(AgentApprovalResolvedPayloadV2),
    ApprovalExpired(AgentApprovalExpiredPayloadV2),
    ApprovalRevoked(AgentApprovalRevokedPayloadV2),
    ChangeExecutionStarted(AgentChangePayloadV2),
    ChangeExecutionCompleted(AgentChangePayloadV2),
    VerificationStarted(AgentVerificationPayloadV2),
    VerificationCompleted(AgentVerificationPayloadV2),
    ChangeRecorded(AgentChangePayloadV2),
}

impl AgentEventPayloadV2 {
    fn event_type(&self) -> AgentEventTypeV2 {
        match self {
            Self::RunCreated(_) => AgentEventTypeV2::RunCreated,
            Self::RunStateChanged(_) => AgentEventTypeV2::RunStateChanged,
            Self::PlanUpdated(_) => AgentEventTypeV2::PlanUpdated,
            Self::ModelStarted(_) => AgentEventTypeV2::ModelStarted,
            Self::ModelCompleted(_) => AgentEventTypeV2::ModelCompleted,
            Self::ToolProposed(_) => AgentEventTypeV2::ToolProposed,
            Self::ToolStateChanged(_) => AgentEventTypeV2::ToolStateChanged,
            Self::EvidenceCreated(_) => AgentEventTypeV2::EvidenceCreated,
            Self::BudgetUpdated(_) => AgentEventTypeV2::BudgetUpdated,
            Self::UserMessageAccepted(_) => AgentEventTypeV2::UserMessageAccepted,
            Self::RunReportCreated(_) => AgentEventTypeV2::RunReportCreated,
            Self::RunWarning(_) => AgentEventTypeV2::RunWarning,
            Self::RunTerminal(_) => AgentEventTypeV2::RunTerminal,
            Self::RiskEvaluated(_) => AgentEventTypeV2::RiskEvaluated,
            Self::ApprovalRequested(_) => AgentEventTypeV2::ApprovalRequested,
            Self::ApprovalConfirmationRequired(_) => AgentEventTypeV2::ApprovalConfirmationRequired,
            Self::ApprovalResolved(_) => AgentEventTypeV2::ApprovalResolved,
            Self::ApprovalExpired(_) => AgentEventTypeV2::ApprovalExpired,
            Self::ApprovalRevoked(_) => AgentEventTypeV2::ApprovalRevoked,
            Self::ChangeExecutionStarted(_) => AgentEventTypeV2::ChangeExecutionStarted,
            Self::ChangeExecutionCompleted(_) => AgentEventTypeV2::ChangeExecutionCompleted,
            Self::VerificationStarted(_) => AgentEventTypeV2::VerificationStarted,
            Self::VerificationCompleted(_) => AgentEventTypeV2::VerificationCompleted,
            Self::ChangeRecorded(_) => AgentEventTypeV2::ChangeRecorded,
        }
    }

    fn to_value(&self) -> Result<serde_json::Value, serde_json::Error> {
        match self {
            Self::RunCreated(value) => serde_json::to_value(value),
            Self::RunStateChanged(value) => serde_json::to_value(value),
            Self::PlanUpdated(value) => serde_json::to_value(value),
            Self::ModelStarted(value) | Self::ModelCompleted(value) => serde_json::to_value(value),
            Self::ToolProposed(value) => serde_json::to_value(value),
            Self::ToolStateChanged(value) => serde_json::to_value(value),
            Self::EvidenceCreated(value) => serde_json::to_value(value),
            Self::BudgetUpdated(value) => serde_json::to_value(value),
            Self::UserMessageAccepted(value) => serde_json::to_value(value),
            Self::RunReportCreated(value) => serde_json::to_value(value),
            Self::RunWarning(value) => serde_json::to_value(value),
            Self::RunTerminal(value) => serde_json::to_value(value),
            Self::RiskEvaluated(value) => serde_json::to_value(value),
            Self::ApprovalRequested(value) => serde_json::to_value(value),
            Self::ApprovalConfirmationRequired(value) => serde_json::to_value(value),
            Self::ApprovalResolved(value) => serde_json::to_value(value),
            Self::ApprovalExpired(value) => serde_json::to_value(value),
            Self::ApprovalRevoked(value) => serde_json::to_value(value),
            Self::ChangeExecutionStarted(value)
            | Self::ChangeExecutionCompleted(value)
            | Self::ChangeRecorded(value) => serde_json::to_value(value),
            Self::VerificationStarted(value) | Self::VerificationCompleted(value) => {
                serde_json::to_value(value)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentEventV2 {
    pub(crate) schema_version: AgentSchemaVersionV2,
    pub(crate) run_id: String,
    pub(crate) sequence: u64,
    pub(crate) occurred_at: u64,
    pub(crate) payload: AgentEventPayloadV2,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentEventWireV2 {
    schema_version: AgentSchemaVersionV2,
    run_id: String,
    sequence: u64,
    occurred_at: u64,
    #[serde(rename = "type")]
    event_type: AgentEventTypeV2,
    payload: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEventWireRefV2<'a> {
    schema_version: AgentSchemaVersionV2,
    run_id: &'a str,
    sequence: u64,
    occurred_at: u64,
    #[serde(rename = "type")]
    event_type: AgentEventTypeV2,
    payload: serde_json::Value,
}

impl<'de> Deserialize<'de> for AgentEventV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = AgentEventWireV2::deserialize(deserializer)?;
        let payload =
            decode_event_payload(wire.event_type, wire.payload).map_err(de::Error::custom)?;
        let event = Self {
            schema_version: wire.schema_version,
            run_id: wire.run_id,
            sequence: wire.sequence,
            occurred_at: wire.occurred_at,
            payload,
        };
        validate_agent_event_v2(&event).map_err(de::Error::custom)?;
        Ok(event)
    }
}

impl Serialize for AgentEventV2 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let payload = self
            .payload
            .to_value()
            .map_err(<S::Error as serde::ser::Error>::custom)?;
        AgentEventWireRefV2 {
            schema_version: self.schema_version,
            run_id: &self.run_id,
            sequence: self.sequence,
            occurred_at: self.occurred_at,
            event_type: self.payload.event_type(),
            payload,
        }
        .serialize(serializer)
    }
}

fn decode_event_payload(
    event_type: AgentEventTypeV2,
    payload: serde_json::Value,
) -> Result<AgentEventPayloadV2, serde_json::Error> {
    macro_rules! decode {
        ($variant:ident, $payload:ty) => {
            serde_json::from_value::<$payload>(payload).map(AgentEventPayloadV2::$variant)
        };
    }
    match event_type {
        AgentEventTypeV2::RunCreated => decode!(RunCreated, AgentRunCreatedPayloadV2),
        AgentEventTypeV2::RunStateChanged => {
            decode!(RunStateChanged, AgentRunStateChangedPayloadV2)
        }
        AgentEventTypeV2::PlanUpdated => decode!(PlanUpdated, AgentPlanUpdatedPayloadV2),
        AgentEventTypeV2::ModelStarted => decode!(ModelStarted, AgentModelTurnPayloadV2),
        AgentEventTypeV2::ModelCompleted => decode!(ModelCompleted, AgentModelTurnPayloadV2),
        AgentEventTypeV2::ToolProposed => {
            serde_json::from_value::<AgentToolProposedPayloadV2>(payload)
                .map(Box::new)
                .map(AgentEventPayloadV2::ToolProposed)
        }
        AgentEventTypeV2::ToolStateChanged => {
            decode!(ToolStateChanged, AgentToolStateChangedPayloadV2)
        }
        AgentEventTypeV2::EvidenceCreated => {
            decode!(EvidenceCreated, AgentEvidenceCreatedPayloadV2)
        }
        AgentEventTypeV2::BudgetUpdated => decode!(BudgetUpdated, AgentBudgetUpdatedPayloadV2),
        AgentEventTypeV2::UserMessageAccepted => {
            decode!(UserMessageAccepted, AgentUserMessageAcceptedPayloadV2)
        }
        AgentEventTypeV2::RunReportCreated => {
            decode!(RunReportCreated, AgentReportCreatedPayloadV2)
        }
        AgentEventTypeV2::RunWarning => decode!(RunWarning, AgentWarningPayloadV2),
        AgentEventTypeV2::RunTerminal => decode!(RunTerminal, AgentRunTerminalPayloadV2),
        AgentEventTypeV2::RiskEvaluated => decode!(RiskEvaluated, AgentRiskEvaluatedPayloadV2),
        AgentEventTypeV2::ApprovalRequested => {
            decode!(ApprovalRequested, AgentApprovalRequestedPayloadV2)
        }
        AgentEventTypeV2::ApprovalConfirmationRequired => decode!(
            ApprovalConfirmationRequired,
            AgentApprovalConfirmationRequiredPayloadV2
        ),
        AgentEventTypeV2::ApprovalResolved => {
            decode!(ApprovalResolved, AgentApprovalResolvedPayloadV2)
        }
        AgentEventTypeV2::ApprovalExpired => {
            decode!(ApprovalExpired, AgentApprovalExpiredPayloadV2)
        }
        AgentEventTypeV2::ApprovalRevoked => {
            decode!(ApprovalRevoked, AgentApprovalRevokedPayloadV2)
        }
        AgentEventTypeV2::ChangeExecutionStarted => {
            decode!(ChangeExecutionStarted, AgentChangePayloadV2)
        }
        AgentEventTypeV2::ChangeExecutionCompleted => {
            decode!(ChangeExecutionCompleted, AgentChangePayloadV2)
        }
        AgentEventTypeV2::VerificationStarted => {
            decode!(VerificationStarted, AgentVerificationPayloadV2)
        }
        AgentEventTypeV2::VerificationCompleted => {
            decode!(VerificationCompleted, AgentVerificationPayloadV2)
        }
        AgentEventTypeV2::ChangeRecorded => decode!(ChangeRecorded, AgentChangePayloadV2),
    }
}

pub(crate) fn decode_agent_event_v2(raw: &str) -> Result<AgentEventV2, AgentProtocolDecodeErrorV2> {
    serde_json::from_str::<AgentEventV2>(raw).map_err(|error| AgentProtocolDecodeErrorV2 {
        kind: if error.is_syntax() || error.is_eof() {
            AgentProtocolDecodeErrorKindV2::InvalidJson
        } else {
            AgentProtocolDecodeErrorKindV2::InvalidContract
        },
        message: "Agent event does not match protocol version 2".to_string(),
    })
}

fn validate_agent_event_v2(event: &AgentEventV2) -> Result<(), AgentProtocolDecodeErrorV2> {
    if !valid_identifier(&event.run_id) || event.sequence == 0 {
        return Err(invalid_contract("Agent v2 event envelope is invalid"));
    }
    match &event.payload {
        AgentEventPayloadV2::RunCreated(payload) => {
            if payload.state != AgentRunStateV2::Created {
                return Err(invalid_contract("run.created must carry created state"));
            }
        }
        AgentEventPayloadV2::RunStateChanged(payload) => {
            payload
                .previous_state
                .transition(payload.state)
                .map_err(|_| invalid_contract("run.stateChanged carries an illegal transition"))?;
            if payload
                .reason
                .as_deref()
                .is_some_and(|reason| !bounded_text(reason, 2_000))
            {
                return Err(invalid_contract("run.stateChanged reason is invalid"));
            }
        }
        AgentEventPayloadV2::PlanUpdated(payload) => validate_plan(&AgentPlanUpdateV1 {
            items: payload.plan.clone(),
        })?,
        AgentEventPayloadV2::ModelStarted(payload)
        | AgentEventPayloadV2::ModelCompleted(payload) => {
            if payload.model_turn == 0 || payload.model_turn > 20 {
                return Err(invalid_contract("Agent v2 model turn is invalid"));
            }
        }
        AgentEventPayloadV2::ToolProposed(payload) => {
            validate_tool_call_snapshot(&payload.tool_call)?;
            let proposed = match &payload.tool_call {
                AgentToolCallSnapshotV2::HostInspect(value) => value.state,
                AgentToolCallSnapshotV2::ShellExecReadOnly(value) => value.state,
                AgentToolCallSnapshotV2::ServiceInspect(value) => value.state,
                AgentToolCallSnapshotV2::ServiceValidateConfig(value) => value.state,
                AgentToolCallSnapshotV2::ServiceControl(value) => value.state,
            };
            if proposed != AgentToolCallStateV2::Proposed {
                return Err(invalid_contract("tool.proposed must carry proposed state"));
            }
        }
        AgentEventPayloadV2::ToolStateChanged(payload) => {
            if !valid_identifier(&payload.tool_call_id) {
                return Err(invalid_contract("Agent v2 tool call ID is invalid"));
            }
            payload
                .previous_state
                .transition(payload.state)
                .map_err(|_| invalid_contract("tool.stateChanged carries an illegal transition"))?;
        }
        AgentEventPayloadV2::EvidenceCreated(payload) => {
            if !valid_identifier(&payload.evidence.evidence_id) {
                return Err(invalid_contract("Agent v2 evidence ID is invalid"));
            }
        }
        AgentEventPayloadV2::BudgetUpdated(payload) => validate_budget_snapshot(&payload.budgets)?,
        AgentEventPayloadV2::UserMessageAccepted(payload) => {
            if !valid_identifier(&payload.client_action_id) {
                return Err(invalid_contract("Agent v2 client action ID is invalid"));
            }
        }
        AgentEventPayloadV2::RunReportCreated(payload) => validate_final_report(&payload.report)?,
        AgentEventPayloadV2::RunWarning(payload) => {
            if !valid_identifier(&payload.code) || !bounded_text(&payload.message, 2_000) {
                return Err(invalid_contract("Agent v2 warning is invalid"));
            }
        }
        AgentEventPayloadV2::RunTerminal(payload) => {
            if !payload.state.is_terminal() {
                return Err(invalid_contract("run.terminal must carry a terminal state"));
            }
        }
        AgentEventPayloadV2::RiskEvaluated(payload) => {
            if !valid_identifier(&payload.tool_call_id) {
                return Err(invalid_contract("Agent v2 risk tool call ID is invalid"));
            }
            validate_risk_assessment(&payload.risk_assessment)?;
        }
        AgentEventPayloadV2::ApprovalRequested(payload) => {
            validate_approval_snapshot(&payload.approval)?;
            if payload.approval.state != AgentApprovalStateV2::Pending {
                return Err(invalid_contract(
                    "approval.requested must carry pending state",
                ));
            }
        }
        AgentEventPayloadV2::ApprovalConfirmationRequired(payload) => {
            if !valid_identifier(&payload.approval_id) || !valid_identifier(&payload.challenge_id) {
                return Err(invalid_contract(
                    "Agent v2 approval confirmation payload is invalid",
                ));
            }
        }
        AgentEventPayloadV2::ApprovalResolved(payload) => {
            if !valid_identifier(&payload.approval_id) {
                return Err(invalid_contract("Agent v2 approval ID is invalid"));
            }
        }
        AgentEventPayloadV2::ApprovalExpired(payload) => {
            if !valid_identifier(&payload.approval_id) {
                return Err(invalid_contract("Agent v2 approval ID is invalid"));
            }
        }
        AgentEventPayloadV2::ApprovalRevoked(payload) => {
            if !valid_identifier(&payload.approval_id) || !bounded_text(&payload.reason, 2_000) {
                return Err(invalid_contract("Agent v2 approval revoke is invalid"));
            }
        }
        AgentEventPayloadV2::ChangeExecutionStarted(payload)
        | AgentEventPayloadV2::ChangeExecutionCompleted(payload)
        | AgentEventPayloadV2::ChangeRecorded(payload) => {
            validate_change_snapshot(&payload.change)?
        }
        AgentEventPayloadV2::VerificationStarted(payload) => {
            validate_verification_snapshot(&payload.verification)?;
            if payload.verification.state != AgentVerificationStateV2::Running {
                return Err(invalid_contract(
                    "verification.started must carry running state",
                ));
            }
        }
        AgentEventPayloadV2::VerificationCompleted(payload) => {
            validate_verification_snapshot(&payload.verification)?;
            if !payload.verification.state.is_terminal() {
                return Err(invalid_contract(
                    "verification.completed must carry terminal state",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::protocol::decode_agent_decision_v1;
    use serde::Deserialize;
    use std::collections::BTreeMap;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ProtocolFixtureV2 {
        schema_version: u8,
        cases: Vec<ProtocolFixtureCaseV2>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ProtocolFixtureCaseV2 {
        name: String,
        valid: bool,
        #[serde(default)]
        value: Option<serde_json::Value>,
        #[serde(default)]
        expected_kind: Option<String>,
        #[serde(default)]
        expected_tool: Option<String>,
        #[serde(default)]
        expected_type: Option<String>,
        #[serde(default)]
        derive_from: Option<usize>,
        #[serde(default)]
        patch: BTreeMap<String, serde_json::Value>,
    }

    fn decision_fixture() -> ProtocolFixtureV2 {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v2/agent-decisions.json"
        ))
        .expect("shared v2 decision fixture must decode")
    }

    fn event_fixture() -> ProtocolFixtureV2 {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v2/agent-events.json"
        ))
        .expect("shared v2 event fixture must decode")
    }

    fn snapshot_fixture() -> ProtocolFixtureV2 {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v2/agent-snapshots.json"
        ))
        .expect("shared v2 snapshot fixture must decode")
    }

    fn materialize_case(
        fixture: &ProtocolFixtureV2,
        case: &ProtocolFixtureCaseV2,
    ) -> serde_json::Value {
        let mut value = if let Some(index) = case.derive_from {
            fixture.cases[index]
                .value
                .clone()
                .expect("derived fixture base must have a value")
        } else {
            case.value.clone().expect("fixture case must have a value")
        };
        for (path, replacement) in &case.patch {
            apply_patch_value(&mut value, path, replacement.clone());
        }
        value
    }

    fn apply_patch_value(root: &mut serde_json::Value, path: &str, replacement: serde_json::Value) {
        let parts = path.split('.').collect::<Vec<_>>();
        let mut current = root;
        for part in &parts[..parts.len() - 1] {
            current = if let Ok(index) = part.parse::<usize>() {
                &mut current
                    .as_array_mut()
                    .expect("fixture patch expects an array")[index]
            } else {
                current
                    .as_object_mut()
                    .expect("fixture patch expects an object")
                    .get_mut(*part)
                    .expect("fixture patch path must exist")
            };
        }
        let last = parts.last().expect("patch path is non-empty");
        if let Ok(index) = last.parse::<usize>() {
            current
                .as_array_mut()
                .expect("fixture patch expects an array")[index] = replacement;
        } else {
            current
                .as_object_mut()
                .expect("fixture patch expects an object")
                .insert((*last).to_string(), replacement);
        }
    }

    #[test]
    fn shared_v2_decision_fixtures_parse_and_round_trip() {
        let fixture = decision_fixture();
        assert_eq!(fixture.schema_version, 2);
        for case in &fixture.cases {
            let value = materialize_case(&fixture, case);
            let decoded = decode_agent_decision_v2(&value.to_string());
            assert_eq!(decoded.is_ok(), case.valid, "decision case {}", case.name);
            if let Ok(decision) = decoded {
                assert_eq!(decision.kind_name(), case.expected_kind.as_deref().unwrap());
                assert_eq!(decision.tool_name(), case.expected_tool.as_deref());
                assert_eq!(
                    serde_json::to_value(decision).unwrap(),
                    value,
                    "{}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn shared_v2_event_fixtures_are_type_correlated_and_strict() {
        let fixture = event_fixture();
        assert_eq!(fixture.schema_version, 2);
        for case in &fixture.cases {
            let value = materialize_case(&fixture, case);
            let decoded = decode_agent_event_v2(&value.to_string());
            assert_eq!(decoded.is_ok(), case.valid, "event case {}", case.name);
            if let Ok(event) = decoded {
                let round_trip = serde_json::to_value(event).expect("serialize v2 event");
                assert_eq!(round_trip, value, "event case {}", case.name);
                assert_eq!(
                    round_trip["type"].as_str(),
                    case.expected_type.as_deref(),
                    "event case {}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn shared_v2_snapshot_fixtures_are_strict_and_tool_correlated() {
        let fixture = snapshot_fixture();
        assert_eq!(fixture.schema_version, 2);
        for case in &fixture.cases {
            let value = materialize_case(&fixture, case);
            let decoded = decode_agent_snapshot_v2(&value.to_string());
            assert_eq!(decoded.is_ok(), case.valid, "snapshot case {}", case.name);
            if let Ok(snapshot) = decoded {
                assert_eq!(
                    serde_json::to_value(snapshot).unwrap(),
                    value,
                    "{}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn v1_and_v2_decoders_preserve_the_explicit_backward_compatibility_boundary() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct BackwardFixture {
            schema_version: u8,
            cases: Vec<BackwardCase>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct BackwardCase {
            name: String,
            accepted_by_v1: bool,
            accepted_by_v2: bool,
            value: serde_json::Value,
        }

        let fixture: BackwardFixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v2/backward-compatibility.json"
        ))
        .expect("backward compatibility fixture must decode");
        assert_eq!(fixture.schema_version, 2);
        for case in fixture.cases {
            let raw = case.value.to_string();
            assert_eq!(
                decode_agent_decision_v1(&raw).is_ok(),
                case.accepted_by_v1,
                "v1 case {}",
                case.name
            );
            assert_eq!(
                decode_agent_decision_v2(&raw).is_ok(),
                case.accepted_by_v2,
                "v2 case {}",
                case.name
            );
        }
    }

    #[test]
    fn v2_start_request_is_strict_and_does_not_admit_an_executor_field() {
        let valid = serde_json::json!({
            "schemaVersion": 2,
            "clientRequestId": "request-2",
            "goal": "Inspect and propose a controlled service action.",
            "profileId": "profile-1",
            "providerId": "openai",
            "requestedPolicyMode": "strict",
            "requestedBudgets": { "maxMutationProposals": 3 }
        });
        assert!(decode_agent_start_request_v2(&valid.to_string()).is_ok());

        let mut unknown_version = valid.clone();
        unknown_version["schemaVersion"] = serde_json::json!(1);
        assert!(decode_agent_start_request_v2(&unknown_version.to_string()).is_err());

        let mut unknown = valid;
        unknown["executor"] = serde_json::json!("ssh");
        assert!(decode_agent_start_request_v2(&unknown.to_string()).is_err());
    }

    #[test]
    fn checked_in_v2_schemas_are_versioned_closed_and_separate() {
        let decision: serde_json::Value = serde_json::from_str(AGENT_DECISION_SCHEMA_V2).unwrap();
        let events: serde_json::Value = serde_json::from_str(AGENT_EVENT_SCHEMA_V2).unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(AGENT_SNAPSHOT_SCHEMA_V2).unwrap();
        assert_eq!(
            decision["$id"],
            "https://termbridge.app/protocol/agent/v2/agent-decision.schema.json"
        );
        assert_eq!(decision["oneOf"].as_array().map(Vec::len), Some(7));
        for variant in decision["oneOf"].as_array().unwrap() {
            assert_eq!(variant["additionalProperties"], false);
            assert_eq!(variant["properties"]["schemaVersion"]["const"], 2);
        }
        assert_eq!(
            events["$id"],
            "https://termbridge.app/protocol/agent/v2/agent-events.schema.json"
        );
        assert_eq!(events["oneOf"].as_array().map(Vec::len), Some(24));
        for variant in events["oneOf"].as_array().unwrap() {
            assert_eq!(variant["additionalProperties"], false);
            assert_eq!(variant["properties"]["schemaVersion"]["const"], 2);
        }
        assert_eq!(
            snapshot["$id"],
            "https://termbridge.app/protocol/agent/v2/agent-snapshot.schema.json"
        );
        assert_eq!(snapshot["additionalProperties"], false);
        assert_eq!(snapshot["properties"]["schemaVersion"]["const"], 2);
    }
}
