use super::budgets::{
    resolve_agent_budget_policy_v1, AgentBudgetRequestV1, AgentBudgetSnapshotV1,
    HARD_MAX_PENDING_PLAN_ITEMS, HARD_MAX_TOOL_TIMEOUT_SECONDS,
};
use super::state::{AgentRunStateV1, AgentToolCallStateV1};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashSet;
use std::fmt;

pub(crate) const AGENT_PROTOCOL_SCHEMA_VERSION_V1: u8 = 1;
pub(crate) const MAX_AGENT_DECISION_BYTES_V1: usize = 64 * 1024;
pub(crate) const AGENT_DECISION_SCHEMA_V1: &str =
    include_str!("../../../protocol/agent/v1/agent-decision.schema.json");

const MAX_ID_CHARACTERS: usize = 64;
const MAX_GOAL_CHARACTERS: usize = 8 * 1024;
const MAX_TERMINAL_CONTEXT_CHARACTERS: usize = 64 * 1024;
const MAX_LABEL_CHARACTERS: usize = 200;
const MAX_RATIONALE_CHARACTERS: usize = 1_000;
const MAX_PURPOSE_CHARACTERS: usize = 1_000;
const MAX_SUCCESS_CRITERIA_CHARACTERS: usize = 1_000;
const MAX_QUESTION_CHARACTERS: usize = 4_000;
const MAX_REPORT_TEXT_CHARACTERS: usize = 4_000;
const MAX_REPORT_ITEM_TEXT_CHARACTERS: usize = 2_000;
const MAX_REPORT_FINDINGS: usize = 16;
const MAX_REPORT_WARNINGS: usize = 16;
const MAX_REPORT_NEXT_ACTIONS: usize = 16;
const MAX_EVIDENCE_IDS_PER_FINDING: usize = 32;
const MAX_SHELL_ARGUMENTS: usize = 32;
const MAX_SHELL_ARGUMENT_CHARACTERS: usize = 512;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub(crate) struct AgentSchemaVersionV1;

impl Serialize for AgentSchemaVersionV1 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(AGENT_PROTOCOL_SCHEMA_VERSION_V1)
    }
}

impl<'de> Deserialize<'de> for AgentSchemaVersionV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = u8::deserialize(deserializer)?;
        if version == AGENT_PROTOCOL_SCHEMA_VERSION_V1 {
            Ok(Self)
        } else {
            Err(de::Error::custom("Agent schemaVersion must be 1"))
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
        .ok_or_else(|| de::Error::custom("optional Agent protocol fields cannot be null"))
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTerminalContextV1 {
    pub(crate) session_id: String,
    pub(crate) captured_at: u64,
    pub(crate) label: String,
    pub(crate) redacted_text: String,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentStartRequestV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) client_request_id: String,
    pub(crate) goal: String,
    pub(crate) profile_id: String,
    pub(crate) provider_id: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) terminal_context: Option<AgentTerminalContextV1>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) requested_budgets: Option<AgentBudgetRequestV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGetSnapshotRequestV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) run_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentActionRequestV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) run_id: String,
    pub(crate) client_action_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSendMessageRequestV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) run_id: String,
    pub(crate) client_action_id: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPlanItemStatusV1 {
    Pending,
    Active,
    Completed,
    Skipped,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPlanItemV1 {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: AgentPlanItemStatusV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPlanUpdateV1 {
    pub(crate) items: Vec<AgentPlanItemV1>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostInspectFieldV1 {
    Os,
    Kernel,
    Architecture,
    Identity,
    Uptime,
    Capabilities,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostInspectArgsV1 {
    pub(crate) include: Vec<HostInspectFieldV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShellExecReadOnlyArgsV1 {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) timeout_seconds: Option<u16>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentReportOutcomeV1 {
    Resolved,
    Diagnosed,
    Inconclusive,
    Blocked,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentFindingConfidenceV1 {
    Verified,
    Likely,
    Uncertain,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFinalReportFindingV1 {
    pub(crate) title: String,
    pub(crate) detail: String,
    pub(crate) confidence: AgentFindingConfidenceV1,
    pub(crate) evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentNextActionV1 {
    pub(crate) title: String,
    pub(crate) requires_change: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFinalReportV1 {
    pub(crate) outcome: AgentReportOutcomeV1,
    pub(crate) summary: String,
    pub(crate) findings: Vec<AgentFinalReportFindingV1>,
    pub(crate) changes: [String; 0],
    pub(crate) warnings: Vec<String>,
    pub(crate) next_actions: Vec<AgentNextActionV1>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ToolCallDecisionKindV1 {
    ToolCall,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AskUserDecisionKindV1 {
    AskUser,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum FinalDecisionKindV1 {
    Final,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
enum HostInspectToolNameV1 {
    #[serde(rename = "host.inspect")]
    HostInspect,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
enum ShellExecReadOnlyToolNameV1 {
    #[serde(rename = "shell.execReadOnly")]
    ShellExecReadOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentHostInspectDecisionV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    kind: ToolCallDecisionKindV1,
    pub(crate) rationale: String,
    pub(crate) plan: AgentPlanUpdateV1,
    tool: HostInspectToolNameV1,
    pub(crate) arguments: HostInspectArgsV1,
    pub(crate) purpose: String,
    pub(crate) success_criteria: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentShellExecReadOnlyDecisionV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    kind: ToolCallDecisionKindV1,
    pub(crate) rationale: String,
    pub(crate) plan: AgentPlanUpdateV1,
    tool: ShellExecReadOnlyToolNameV1,
    pub(crate) arguments: ShellExecReadOnlyArgsV1,
    pub(crate) purpose: String,
    pub(crate) success_criteria: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentAskUserDecisionV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    kind: AskUserDecisionKindV1,
    pub(crate) rationale: String,
    pub(crate) plan: AgentPlanUpdateV1,
    pub(crate) question: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFinalDecisionV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    kind: FinalDecisionKindV1,
    pub(crate) rationale: String,
    pub(crate) plan: AgentPlanUpdateV1,
    pub(crate) report: AgentFinalReportV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub(crate) enum AgentDecisionV1 {
    HostInspect(AgentHostInspectDecisionV1),
    ShellExecReadOnly(AgentShellExecReadOnlyDecisionV1),
    AskUser(AgentAskUserDecisionV1),
    Final(AgentFinalDecisionV1),
}

impl AgentDecisionV1 {
    pub(crate) fn kind_name(&self) -> &'static str {
        match self {
            Self::HostInspect(_) | Self::ShellExecReadOnly(_) => "toolCall",
            Self::AskUser(_) => "askUser",
            Self::Final(_) => "final",
        }
    }

    pub(crate) fn tool_name(&self) -> Option<&'static str> {
        match self {
            Self::HostInspect(_) => Some("host.inspect"),
            Self::ShellExecReadOnly(_) => Some("shell.execReadOnly"),
            Self::AskUser(_) | Self::Final(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentProtocolDecodeErrorKind {
    TooLarge,
    InvalidJson,
    InvalidContract,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentProtocolDecodeError {
    pub(crate) kind: AgentProtocolDecodeErrorKind,
    pub(crate) message: String,
}

impl fmt::Display for AgentProtocolDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) fn decode_agent_decision_v1(
    raw: &str,
) -> Result<AgentDecisionV1, AgentProtocolDecodeError> {
    if raw.len() > MAX_AGENT_DECISION_BYTES_V1 {
        return Err(AgentProtocolDecodeError {
            kind: AgentProtocolDecodeErrorKind::TooLarge,
            message: "Agent decision exceeds 64 KiB".to_string(),
        });
    }
    let decision =
        serde_json::from_str::<AgentDecisionV1>(raw).map_err(|error| AgentProtocolDecodeError {
            kind: if error.is_syntax() || error.is_eof() {
                AgentProtocolDecodeErrorKind::InvalidJson
            } else {
                AgentProtocolDecodeErrorKind::InvalidContract
            },
            message: "Agent decision does not match protocol version 1".to_string(),
        })?;
    validate_agent_decision_v1(&decision)?;
    Ok(decision)
}

pub(crate) fn decode_agent_start_request_v1(
    raw: &str,
) -> Result<AgentStartRequestV1, AgentProtocolDecodeError> {
    let request =
        serde_json::from_str::<AgentStartRequestV1>(raw).map_err(|_| AgentProtocolDecodeError {
            kind: AgentProtocolDecodeErrorKind::InvalidContract,
            message: "Agent start request does not match protocol version 1".to_string(),
        })?;
    validate_agent_start_request_v1(&request)?;
    Ok(request)
}

fn invalid_contract(message: impl Into<String>) -> AgentProtocolDecodeError {
    AgentProtocolDecodeError {
        kind: AgentProtocolDecodeErrorKind::InvalidContract,
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

fn validate_plan(plan: &AgentPlanUpdateV1) -> Result<(), AgentProtocolDecodeError> {
    if plan.items.len() > HARD_MAX_PENDING_PLAN_ITEMS as usize {
        return Err(invalid_contract("Agent plan contains too many items"));
    }
    let mut ids = HashSet::new();
    let mut active_count = 0;
    for item in &plan.items {
        if !valid_identifier(&item.id)
            || !bounded_text(&item.title, MAX_LABEL_CHARACTERS)
            || !ids.insert(item.id.as_str())
        {
            return Err(invalid_contract("Agent plan item is invalid or duplicated"));
        }
        if item.status == AgentPlanItemStatusV1::Active {
            active_count += 1;
        }
    }
    if active_count > 1 {
        return Err(invalid_contract(
            "Agent plan may contain at most one active item",
        ));
    }
    Ok(())
}

fn validate_host_inspect_args(args: &HostInspectArgsV1) -> Result<(), AgentProtocolDecodeError> {
    if args.include.is_empty() || args.include.len() > 6 {
        return Err(invalid_contract("host.inspect include is invalid"));
    }
    let unique = args.include.iter().copied().collect::<HashSet<_>>();
    if unique.len() != args.include.len() {
        return Err(invalid_contract("host.inspect include contains duplicates"));
    }
    Ok(())
}

fn validate_shell_args(args: &ShellExecReadOnlyArgsV1) -> Result<(), AgentProtocolDecodeError> {
    let valid_program = !args.program.is_empty()
        && args.program.len() <= MAX_ID_CHARACTERS
        && args.program.is_ascii()
        && args.program.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric() || (index > 0 && matches!(character, '.' | '_' | '-'))
        });
    if !valid_program || args.args.len() > MAX_SHELL_ARGUMENTS {
        return Err(invalid_contract("shell.execReadOnly arguments are invalid"));
    }
    if args.args.iter().any(|argument| {
        argument.chars().count() > MAX_SHELL_ARGUMENT_CHARACTERS
            || argument.chars().any(char::is_control)
    }) {
        return Err(invalid_contract("shell.execReadOnly argument is invalid"));
    }
    if args
        .timeout_seconds
        .is_some_and(|timeout| timeout == 0 || timeout > HARD_MAX_TOOL_TIMEOUT_SECONDS)
    {
        return Err(invalid_contract("shell.execReadOnly timeout is invalid"));
    }
    Ok(())
}

fn validate_report(report: &AgentFinalReportV1) -> Result<(), AgentProtocolDecodeError> {
    if !bounded_text(&report.summary, MAX_REPORT_TEXT_CHARACTERS)
        || report.findings.len() > MAX_REPORT_FINDINGS
        || report.warnings.len() > MAX_REPORT_WARNINGS
        || report.next_actions.len() > MAX_REPORT_NEXT_ACTIONS
    {
        return Err(invalid_contract(
            "Agent final report exceeds protocol limits",
        ));
    }
    for finding in &report.findings {
        if !bounded_text(&finding.title, MAX_LABEL_CHARACTERS)
            || !bounded_text(&finding.detail, MAX_REPORT_TEXT_CHARACTERS)
            || finding.evidence_ids.len() > MAX_EVIDENCE_IDS_PER_FINDING
            || finding
                .evidence_ids
                .iter()
                .any(|evidence_id| !valid_identifier(evidence_id))
            || (finding.confidence == AgentFindingConfidenceV1::Verified
                && finding.evidence_ids.is_empty())
        {
            return Err(invalid_contract("Agent final report finding is invalid"));
        }
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
        return Err(invalid_contract("Agent final report item is invalid"));
    }
    Ok(())
}

fn validate_agent_decision_v1(decision: &AgentDecisionV1) -> Result<(), AgentProtocolDecodeError> {
    match decision {
        AgentDecisionV1::HostInspect(value) => {
            validate_plan(&value.plan)?;
            validate_host_inspect_args(&value.arguments)?;
            if !bounded_text(&value.rationale, MAX_RATIONALE_CHARACTERS)
                || !bounded_text(&value.purpose, MAX_PURPOSE_CHARACTERS)
                || !bounded_text(&value.success_criteria, MAX_SUCCESS_CRITERIA_CHARACTERS)
            {
                return Err(invalid_contract("Agent tool decision text is invalid"));
            }
        }
        AgentDecisionV1::ShellExecReadOnly(value) => {
            validate_plan(&value.plan)?;
            validate_shell_args(&value.arguments)?;
            if !bounded_text(&value.rationale, MAX_RATIONALE_CHARACTERS)
                || !bounded_text(&value.purpose, MAX_PURPOSE_CHARACTERS)
                || !bounded_text(&value.success_criteria, MAX_SUCCESS_CRITERIA_CHARACTERS)
            {
                return Err(invalid_contract("Agent tool decision text is invalid"));
            }
        }
        AgentDecisionV1::AskUser(value) => {
            validate_plan(&value.plan)?;
            if !bounded_text(&value.rationale, MAX_RATIONALE_CHARACTERS)
                || !bounded_text(&value.question, MAX_QUESTION_CHARACTERS)
            {
                return Err(invalid_contract("Agent askUser decision text is invalid"));
            }
        }
        AgentDecisionV1::Final(value) => {
            validate_plan(&value.plan)?;
            if !bounded_text(&value.rationale, MAX_RATIONALE_CHARACTERS) {
                return Err(invalid_contract(
                    "Agent final decision rationale is invalid",
                ));
            }
            validate_report(&value.report)?;
        }
    }
    Ok(())
}

fn validate_agent_start_request_v1(
    request: &AgentStartRequestV1,
) -> Result<(), AgentProtocolDecodeError> {
    if !valid_identifier(&request.client_request_id)
        || !valid_identifier(&request.profile_id)
        || !valid_identifier(&request.provider_id)
        || !bounded_text(&request.goal, MAX_GOAL_CHARACTERS)
    {
        return Err(invalid_contract("Agent start request metadata is invalid"));
    }
    if let Some(context) = &request.terminal_context {
        if !valid_identifier(&context.session_id)
            || !bounded_text(&context.label, MAX_LABEL_CHARACTERS)
            || context.redacted_text.chars().count() > MAX_TERMINAL_CONTEXT_CHARACTERS
            || context.redacted_text.contains('\0')
        {
            return Err(invalid_contract("Agent terminal context is invalid"));
        }
    }
    resolve_agent_budget_policy_v1(request.requested_budgets.as_ref())
        .map_err(|_| invalid_contract("Agent requested budget is invalid"))?;
    Ok(())
}

pub(crate) fn validate_agent_start_request_contract_v1(
    request: &AgentStartRequestV1,
) -> Result<(), AgentProtocolDecodeError> {
    validate_agent_start_request_v1(request)
}

pub(crate) fn validate_agent_get_snapshot_request_v1(
    request: &AgentGetSnapshotRequestV1,
) -> Result<(), AgentProtocolDecodeError> {
    if request
        .run_id
        .as_deref()
        .is_some_and(|run_id| !valid_identifier(run_id))
    {
        return Err(invalid_contract("Agent snapshot run ID is invalid"));
    }
    Ok(())
}

pub(crate) fn validate_agent_action_request_v1(
    request: &AgentActionRequestV1,
) -> Result<(), AgentProtocolDecodeError> {
    if !valid_identifier(&request.run_id) || !valid_identifier(&request.client_action_id) {
        return Err(invalid_contract("Agent action metadata is invalid"));
    }
    Ok(())
}

pub(crate) fn validate_agent_send_message_request_v1(
    request: &AgentSendMessageRequestV1,
) -> Result<(), AgentProtocolDecodeError> {
    if !valid_identifier(&request.run_id)
        || !valid_identifier(&request.client_action_id)
        || !bounded_text(&request.message, 8 * 1024)
    {
        return Err(invalid_contract("Agent message request is invalid"));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentProviderKindV1 {
    Ollama,
    OpenAi,
    OpenAiCompatible,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentProviderCapabilitiesV1 {
    pub(crate) streaming: bool,
    pub(crate) strict_json_schema: bool,
    pub(crate) native_tool_calling: bool,
    pub(crate) usage_reporting: bool,
    pub(crate) response_continuation: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentProviderBindingV1 {
    pub(crate) provider_id: String,
    pub(crate) kind: AgentProviderKindV1,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) capabilities: AgentProviderCapabilitiesV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentJumpTargetSummaryV1 {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTargetBindingV1 {
    pub(crate) profile_id: String,
    pub(crate) profile_label: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) jump_host: Option<AgentJumpTargetSummaryV1>,
    pub(crate) target_digest: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPolicyModeV1 {
    ReadOnly,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum AgentToolNameV1 {
    #[serde(rename = "host.inspect")]
    HostInspect,
    #[serde(rename = "shell.execReadOnly")]
    ShellExecReadOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPolicySnapshotV1 {
    pub(crate) mode: AgentPolicyModeV1,
    pub(crate) policy_version: String,
    pub(crate) tool_registry_version: String,
    pub(crate) allowed_tools: Vec<AgentToolNameV1>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum AgentEvidenceSourceV1 {
    #[serde(rename = "terminalSnapshot")]
    TerminalSnapshot,
    #[serde(rename = "host.inspect")]
    HostInspect,
    #[serde(rename = "shell.execReadOnly")]
    ShellExecReadOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentEvidenceV1 {
    pub(crate) evidence_id: String,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) source: AgentEvidenceSourceV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tool_call_id: Option<String>,
    pub(crate) observed_at: u64,
    pub(crate) summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) stdout_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) stderr_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i32>,
    pub(crate) truncated: bool,
    pub(crate) observation_digest: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolResultStatusV1 {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
    Denied,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentToolExecutionResultV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) run_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) status: AgentToolResultStatusV1,
    pub(crate) started_at: u64,
    pub(crate) completed_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout_excerpt: String,
    pub(crate) stderr_excerpt: String,
    pub(crate) stdout_bytes_captured: u64,
    pub(crate) stderr_bytes_captured: u64,
    pub(crate) stdout_bytes_read: u64,
    pub(crate) stderr_bytes_read: u64,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<AgentPublicErrorV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentHostInspectToolCallSnapshotV1 {
    pub(crate) tool_call_id: String,
    pub(crate) state: AgentToolCallStateV1,
    tool: HostInspectToolNameV1,
    pub(crate) arguments: HostInspectArgsV1,
    pub(crate) rationale: String,
    pub(crate) purpose: String,
    pub(crate) success_criteria: String,
    pub(crate) proposed_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) command_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<AgentToolExecutionResultV1>,
    #[serde(default)]
    pub(crate) evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentShellExecReadOnlyToolCallSnapshotV1 {
    pub(crate) tool_call_id: String,
    pub(crate) state: AgentToolCallStateV1,
    tool: ShellExecReadOnlyToolNameV1,
    pub(crate) arguments: ShellExecReadOnlyArgsV1,
    pub(crate) rationale: String,
    pub(crate) purpose: String,
    pub(crate) success_criteria: String,
    pub(crate) proposed_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) command_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<AgentToolExecutionResultV1>,
    #[serde(default)]
    pub(crate) evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub(crate) enum AgentToolCallSnapshotV1 {
    HostInspect(AgentHostInspectToolCallSnapshotV1),
    ShellExecReadOnly(AgentShellExecReadOnlyToolCallSnapshotV1),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentQuestionV1 {
    pub(crate) question_id: String,
    pub(crate) question: String,
    pub(crate) asked_at: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPublicErrorCategoryV1 {
    AgentBusy,
    TargetUnavailable,
    ProviderIncompatible,
    ProviderUnavailable,
    ProviderProtocol,
    ToolDenied,
    ToolFailed,
    BudgetExceeded,
    Cancelled,
    Internal,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPublicErrorV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) category: AgentPublicErrorCategoryV1,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) suggestion: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum AgentEventTypeV1 {
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
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentEventV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) run_id: String,
    pub(crate) sequence: u64,
    pub(crate) occurred_at: u64,
    #[serde(rename = "type")]
    pub(crate) event_type: AgentEventTypeV1,
    pub(crate) payload: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunSnapshotV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) run_id: String,
    pub(crate) last_sequence: u64,
    pub(crate) state: AgentRunStateV1,
    pub(crate) target: AgentTargetBindingV1,
    pub(crate) provider: AgentProviderBindingV1,
    pub(crate) policy: AgentPolicySnapshotV1,
    pub(crate) budgets: AgentBudgetSnapshotV1,
    pub(crate) goal: String,
    pub(crate) plan: Vec<AgentPlanItemV1>,
    pub(crate) tool_calls: Vec<AgentToolCallSnapshotV1>,
    pub(crate) evidence: Vec<AgentEvidenceV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending_question: Option<AgentQuestionV1>,
    pub(crate) queued_steering_count: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) report: Option<AgentFinalReportV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<AgentPublicErrorV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentStartResultV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) run_id: String,
    pub(crate) accepted_at: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentActionKindV1 {
    Pause,
    Resume,
    Stop,
    SendMessage,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentActionResultV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) run_id: String,
    pub(crate) client_action_id: String,
    pub(crate) action: AgentActionKindV1,
    pub(crate) accepted_at: u64,
    pub(crate) resulting_sequence: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentActiveRunSummaryV1 {
    pub(crate) run_id: String,
    pub(crate) state: AgentRunStateV1,
    pub(crate) goal: String,
    pub(crate) profile_id: String,
    pub(crate) started_at: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentCommandErrorCategoryV1 {
    InvalidRequest,
    AgentBusy,
    RunNotFound,
    IdempotencyConflict,
    InvalidState,
    P1Blocked,
    Internal,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentCommandErrorV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) category: AgentCommandErrorCategoryV1,
    pub(crate) message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) active_run: Option<AgentActiveRunSummaryV1>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct DecisionFixtureV1 {
        schema_version: u8,
        cases: Vec<DecisionFixtureCaseV1>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct DecisionFixtureCaseV1 {
        name: String,
        valid: bool,
        value: serde_json::Value,
        #[serde(default)]
        expected_kind: Option<String>,
        #[serde(default)]
        expected_tool: Option<String>,
    }

    #[test]
    fn shared_decision_fixtures_parse_and_round_trip() {
        let fixture: DecisionFixtureV1 = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v1/agent-decisions.json"
        ))
        .expect("shared Agent decision fixture must decode");
        assert_eq!(fixture.schema_version, 1);

        for case in fixture.cases {
            let raw = serde_json::to_string(&case.value).expect("serialize fixture value");
            let decoded = decode_agent_decision_v1(&raw);
            assert_eq!(
                decoded.is_ok(),
                case.valid,
                "decision fixture {}",
                case.name
            );
            if let Ok(decision) = decoded {
                assert_eq!(decision.kind_name(), case.expected_kind.as_deref().unwrap());
                assert_eq!(decision.tool_name(), case.expected_tool.as_deref());
                assert_eq!(
                    serde_json::to_value(decision).expect("serialize decoded decision"),
                    case.value,
                    "valid decision fixture {} must round-trip exactly",
                    case.name
                );
            }
        }
    }

    #[test]
    fn decoder_rejects_surrounding_text_oversize_and_trailing_action() {
        let valid = r#"{"schemaVersion":1,"kind":"askUser","rationale":"Need scope.","plan":{"items":[]},"question":"Which service?"}"#;
        assert!(decode_agent_decision_v1(valid).is_ok());
        assert!(decode_agent_decision_v1(&format!("answer: {valid}")).is_err());
        assert!(decode_agent_decision_v1(&format!("{valid}\n{valid}")).is_err());
        assert_eq!(
            decode_agent_decision_v1(&format!(
                "{{\"schemaVersion\":1,\"kind\":\"askUser\",\"rationale\":\"{}\",\"plan\":{{\"items\":[]}},\"question\":\"q\"}}",
                "x".repeat(MAX_AGENT_DECISION_BYTES_V1)
            ))
            .expect_err("oversized decision is denied")
            .kind,
            AgentProtocolDecodeErrorKind::TooLarge
        );
    }

    #[test]
    fn start_request_is_versioned_bounded_and_unknown_field_closed() {
        let valid = serde_json::json!({
            "schemaVersion": 1,
            "clientRequestId": "request-1",
            "goal": "Inspect CPU pressure without changes.",
            "profileId": "profile-1",
            "providerId": "openai",
            "requestedBudgets": { "maxToolCalls": 5 }
        });
        assert!(decode_agent_start_request_v1(&valid.to_string()).is_ok());

        let mut unknown_version = valid.clone();
        unknown_version["schemaVersion"] = serde_json::json!(2);
        assert!(decode_agent_start_request_v1(&unknown_version.to_string()).is_err());

        let mut unknown = valid.clone();
        unknown
            .as_object_mut()
            .expect("object fixture")
            .insert("host".to_string(), serde_json::json!("other.example"));
        assert!(decode_agent_start_request_v1(&unknown.to_string()).is_err());

        let mut nested_unknown = valid;
        nested_unknown["requestedBudgets"]["unlimited"] = serde_json::json!(true);
        assert!(decode_agent_start_request_v1(&nested_unknown.to_string()).is_err());

        let explicit_null = serde_json::json!({
            "schemaVersion": 1,
            "clientRequestId": "request-1",
            "goal": "Inspect CPU pressure without changes.",
            "profileId": "profile-1",
            "providerId": "openai",
            "terminalContext": null
        });
        assert!(decode_agent_start_request_v1(&explicit_null.to_string()).is_err());
    }

    #[test]
    fn lifecycle_ipc_requests_are_versioned_and_unknown_field_closed() {
        let action = serde_json::json!({
            "schemaVersion": 1,
            "runId": "run-1",
            "clientActionId": "action-1"
        });
        let decoded = serde_json::from_value::<AgentActionRequestV1>(action.clone())
            .expect("valid action request");
        assert!(validate_agent_action_request_v1(&decoded).is_ok());

        let mut unknown = action.clone();
        unknown["command"] = serde_json::json!("uptime");
        assert!(serde_json::from_value::<AgentActionRequestV1>(unknown).is_err());

        let mut unknown_version = action;
        unknown_version["schemaVersion"] = serde_json::json!(2);
        assert!(serde_json::from_value::<AgentActionRequestV1>(unknown_version).is_err());

        let active = serde_json::json!({ "schemaVersion": 1 });
        let decoded = serde_json::from_value::<AgentGetSnapshotRequestV1>(active)
            .expect("active snapshot request");
        assert!(validate_agent_get_snapshot_request_v1(&decoded).is_ok());
        assert!(
            serde_json::from_value::<AgentGetSnapshotRequestV1>(serde_json::json!({
                "schemaVersion": 1,
                "runId": null
            }))
            .is_err()
        );

        let message = serde_json::from_value::<AgentSendMessageRequestV1>(serde_json::json!({
            "schemaVersion": 1,
            "runId": "run-1",
            "clientActionId": "action-2",
            "message": "Keep the observation bounded."
        }))
        .expect("valid message request");
        assert!(validate_agent_send_message_request_v1(&message).is_ok());

        let mut empty_message = message;
        empty_message.message.clear();
        assert!(validate_agent_send_message_request_v1(&empty_message).is_err());
    }

    #[test]
    fn public_error_and_event_taxonomies_are_stable_and_unknown_closed() {
        assert_eq!(
            serde_json::to_value([
                AgentPublicErrorCategoryV1::AgentBusy,
                AgentPublicErrorCategoryV1::TargetUnavailable,
                AgentPublicErrorCategoryV1::ProviderIncompatible,
                AgentPublicErrorCategoryV1::ProviderUnavailable,
                AgentPublicErrorCategoryV1::ProviderProtocol,
                AgentPublicErrorCategoryV1::ToolDenied,
                AgentPublicErrorCategoryV1::ToolFailed,
                AgentPublicErrorCategoryV1::BudgetExceeded,
                AgentPublicErrorCategoryV1::Cancelled,
                AgentPublicErrorCategoryV1::Internal,
            ])
            .expect("serialize error taxonomy"),
            serde_json::json!([
                "agentBusy",
                "targetUnavailable",
                "providerIncompatible",
                "providerUnavailable",
                "providerProtocol",
                "toolDenied",
                "toolFailed",
                "budgetExceeded",
                "cancelled",
                "internal"
            ])
        );

        let event = serde_json::json!({
            "schemaVersion": 1,
            "runId": "run-1",
            "sequence": 1,
            "occurredAt": 1000,
            "type": "run.created",
            "payload": {}
        });
        assert!(serde_json::from_value::<AgentEventV1>(event.clone()).is_ok());

        let mut unknown_version = event.clone();
        unknown_version["schemaVersion"] = serde_json::json!(2);
        assert!(serde_json::from_value::<AgentEventV1>(unknown_version).is_err());

        let mut unknown_type = event.clone();
        unknown_type["type"] = serde_json::json!("run.restarted");
        assert!(serde_json::from_value::<AgentEventV1>(unknown_type).is_err());

        let mut unknown_field = event;
        unknown_field["rawOutput"] = serde_json::json!("secret");
        assert!(serde_json::from_value::<AgentEventV1>(unknown_field).is_err());

        let public_error = serde_json::json!({
            "schemaVersion": 1,
            "category": "providerProtocol",
            "message": "The provider returned an invalid decision.",
            "retryable": false
        });
        assert!(serde_json::from_value::<AgentPublicErrorV1>(public_error.clone()).is_ok());
        let mut unknown_category = public_error;
        unknown_category["category"] = serde_json::json!("providerBug");
        assert!(serde_json::from_value::<AgentPublicErrorV1>(unknown_category).is_err());
    }

    #[test]
    fn tool_snapshot_arguments_are_strict_and_correlated_with_the_tool() {
        let valid = serde_json::json!({
            "toolCallId": "tool-1",
            "state": "proposed",
            "tool": "host.inspect",
            "arguments": { "include": ["os"] },
            "rationale": "Inspect the host.",
            "purpose": "Establish host context.",
            "successCriteria": "The operating system is observed.",
            "proposedAt": 1000,
            "evidenceIds": []
        });
        assert!(serde_json::from_value::<AgentToolCallSnapshotV1>(valid.clone()).is_ok());

        let mut unknown_argument = valid.clone();
        unknown_argument["arguments"]["command"] = serde_json::json!("uname -a");
        assert!(serde_json::from_value::<AgentToolCallSnapshotV1>(unknown_argument).is_err());

        let mut mismatched = valid.clone();
        mismatched["arguments"] = serde_json::json!({ "program": "uptime", "args": [] });
        assert!(serde_json::from_value::<AgentToolCallSnapshotV1>(mismatched).is_err());

        let mut unknown_state = valid;
        unknown_state["state"] = serde_json::json!("running");
        assert!(serde_json::from_value::<AgentToolCallSnapshotV1>(unknown_state).is_err());
    }

    #[test]
    fn checked_in_decision_schema_is_versioned_and_closed() {
        let schema: serde_json::Value = serde_json::from_str(AGENT_DECISION_SCHEMA_V1)
            .expect("decision schema must be valid JSON");
        assert_eq!(
            schema["$id"],
            "https://termbridge.app/protocol/agent/v1/agent-decision.schema.json"
        );
        assert_eq!(schema["oneOf"].as_array().map(Vec::len), Some(4));
        for variant in schema["oneOf"].as_array().expect("four variants") {
            assert_eq!(variant["additionalProperties"], false);
            assert_eq!(variant["properties"]["schemaVersion"]["const"], 1);
        }
    }
}
