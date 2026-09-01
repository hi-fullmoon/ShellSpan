use serde::de::DeserializeOwned;

use super::types::{
    AgentEffectKindV3, AgentObservedEffectV3, AgentRequestV3, AgentTargetKindV3, AgentToolCallV3,
    AgentToolResultV3, AgentToolTargetV3, ApplyPatchArgumentsV3, AskUserArgumentsV3,
    ExecCommandArgumentsV3, HostSnapshotArgumentsV3, KillProcessArgumentsV3,
    ListDirectoryArgumentsV3, ReadFileArgumentsV3, SearchTextArgumentsV3, TransferFileArgumentsV3,
    UpdatePlanArgumentsV3, WaitProcessArgumentsV3, WriteStdinArgumentsV3,
    AGENT_CONTRACT_V3_VERSION,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentToolEffectModeV3 {
    Fixed,
    NativeClassifier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentToolDescriptorV3 {
    pub name: &'static str,
    pub target_kinds: &'static [AgentTargetKindV3],
    pub effect_mode: AgentToolEffectModeV3,
    pub allowed_effects: &'static [AgentEffectKindV3],
}

const LOCAL_REMOTE: &[AgentTargetKindV3] = &[AgentTargetKindV3::Local, AgentTargetKindV3::Remote];
const PROCESS: &[AgentTargetKindV3] = &[AgentTargetKindV3::Process];
const UI: &[AgentTargetKindV3] = &[AgentTargetKindV3::Ui];
const TASK: &[AgentTargetKindV3] = &[AgentTargetKindV3::Task];
const NONE: &[AgentEffectKindV3] = &[AgentEffectKindV3::None];
const READ_ONLY: &[AgentEffectKindV3] = &[AgentEffectKindV3::ReadOnly];
const SENSITIVE_READ: &[AgentEffectKindV3] = &[AgentEffectKindV3::SensitiveRead];
const STATE_CHANGE: &[AgentEffectKindV3] = &[AgentEffectKindV3::StateChange];
const PATCH_EFFECTS: &[AgentEffectKindV3] = &[
    AgentEffectKindV3::StateChange,
    AgentEffectKindV3::Destructive,
];
const TRANSFER_EFFECTS: &[AgentEffectKindV3] = &[
    AgentEffectKindV3::SensitiveRead,
    AgentEffectKindV3::StateChange,
    AgentEffectKindV3::ExternalSideEffect,
];
const EXEC_EFFECTS: &[AgentEffectKindV3] = &[
    AgentEffectKindV3::ReadOnly,
    AgentEffectKindV3::SensitiveRead,
    AgentEffectKindV3::StateChange,
    AgentEffectKindV3::Destructive,
    AgentEffectKindV3::ExternalSideEffect,
];

pub const BUILTIN_TOOL_DESCRIPTORS_V3: [AgentToolDescriptorV3; 12] = [
    AgentToolDescriptorV3 {
        name: "exec_command",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeV3::NativeClassifier,
        allowed_effects: EXEC_EFFECTS,
    },
    AgentToolDescriptorV3 {
        name: "write_stdin",
        target_kinds: PROCESS,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: STATE_CHANGE,
    },
    AgentToolDescriptorV3 {
        name: "wait_process",
        target_kinds: PROCESS,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: READ_ONLY,
    },
    AgentToolDescriptorV3 {
        name: "kill_process",
        target_kinds: PROCESS,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: STATE_CHANGE,
    },
    AgentToolDescriptorV3 {
        name: "read_file",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: SENSITIVE_READ,
    },
    AgentToolDescriptorV3 {
        name: "list_directory",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: READ_ONLY,
    },
    AgentToolDescriptorV3 {
        name: "search_text",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: SENSITIVE_READ,
    },
    AgentToolDescriptorV3 {
        name: "apply_patch",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeV3::NativeClassifier,
        allowed_effects: PATCH_EFFECTS,
    },
    AgentToolDescriptorV3 {
        name: "transfer_file",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeV3::NativeClassifier,
        allowed_effects: TRANSFER_EFFECTS,
    },
    AgentToolDescriptorV3 {
        name: "host_snapshot",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: SENSITIVE_READ,
    },
    AgentToolDescriptorV3 {
        name: "ask_user",
        target_kinds: UI,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: NONE,
    },
    AgentToolDescriptorV3 {
        name: "update_plan",
        target_kinds: TASK,
        effect_mode: AgentToolEffectModeV3::Fixed,
        allowed_effects: NONE,
    },
];

pub fn find_builtin_tool_v3(name: &str) -> Option<&'static AgentToolDescriptorV3> {
    BUILTIN_TOOL_DESCRIPTORS_V3
        .iter()
        .find(|descriptor| descriptor.name == name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCapabilityVerificationContextV3<'a> {
    pub request_id: &'a str,
    pub user_session_id: &'a str,
    pub call_id: &'a str,
    pub target_id: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCapabilityVerificationFailureV3 {
    Unknown,
    InvalidProof,
    Revoked,
    Expired,
}

/// Verifies an opaque capability reference inside the Rust trust boundary.
/// Implementations must never deserialize a `VerifiedAgentCapabilityV3` from
/// the WebView or model output.
pub trait AgentCapabilityVerifierV3: Send + Sync {
    fn verify(
        &self,
        capability_id: &str,
        context: AgentCapabilityVerificationContextV3<'_>,
        now_unix_ms: u64,
    ) -> Result<VerifiedAgentCapabilityV3, AgentCapabilityVerificationFailureV3>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAgentCapabilityV3 {
    capability_id: String,
    request_id: String,
    user_session_id: String,
    allowed_tools: Vec<String>,
    allowed_effects: Vec<AgentEffectKindV3>,
    target_ids: Vec<String>,
    not_before_unix_ms: u64,
    expires_at_unix_ms: u64,
    revoked: bool,
}

impl VerifiedAgentCapabilityV3 {
    /// Construction is crate-private so a future native verifier can create
    /// this proof, while Tauri wire input cannot fabricate it.
    #[allow(dead_code)] // M0 hand-off point; the M1 verifier will call it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_verified_claims(
        capability_id: String,
        request_id: String,
        user_session_id: String,
        allowed_tools: Vec<String>,
        allowed_effects: Vec<AgentEffectKindV3>,
        target_ids: Vec<String>,
        not_before_unix_ms: u64,
        expires_at_unix_ms: u64,
        revoked: bool,
    ) -> Self {
        Self {
            capability_id,
            request_id,
            user_session_id,
            allowed_tools,
            allowed_effects,
            target_ids,
            not_before_unix_ms,
            expires_at_unix_ms,
            revoked,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPolicyOutcomeV3 {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPolicyReasonV3 {
    Authorized,
    InvalidRequest,
    RequestMismatch,
    UnregisteredTool,
    InvalidArguments,
    InvalidTarget,
    UnclassifiedEffect,
    EffectTargetMismatch,
    ToolEffectMismatch,
    MissingCapability,
    CapabilityIdMismatch,
    CapabilityRequestMismatch,
    CapabilityUserSessionMismatch,
    CapabilityNotYetValid,
    CapabilityExpired,
    CapabilityRevoked,
    CapabilityToolDenied,
    CapabilityEffectDenied,
    CapabilityTargetDenied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentPolicyDecisionV3 {
    pub outcome: AgentPolicyOutcomeV3,
    pub reason: AgentPolicyReasonV3,
}

impl AgentPolicyDecisionV3 {
    fn allow() -> Self {
        Self {
            outcome: AgentPolicyOutcomeV3::Allow,
            reason: AgentPolicyReasonV3::Authorized,
        }
    }

    fn deny(reason: AgentPolicyReasonV3) -> Self {
        Self {
            outcome: AgentPolicyOutcomeV3::Deny,
            reason,
        }
    }
}

pub struct AgentPolicyEvaluationV3<'a> {
    pub request: &'a AgentRequestV3,
    pub call: &'a AgentToolCallV3,
    pub assessed_effect: Option<&'a AgentObservedEffectV3>,
    pub capability: Option<&'a VerifiedAgentCapabilityV3>,
    pub now_unix_ms: u64,
}

/// Native policy boundary consumed by the M1 runtime. M0 provides the strict,
/// fail-closed reference evaluator but does not execute tools.
pub trait AgentPolicyEngineV3: Send + Sync {
    fn evaluate(&self, input: AgentPolicyEvaluationV3<'_>) -> AgentPolicyDecisionV3;
}

#[derive(Debug, Default)]
pub struct M0ContractPolicyEngineV3;

impl AgentPolicyEngineV3 for M0ContractPolicyEngineV3 {
    fn evaluate(&self, input: AgentPolicyEvaluationV3<'_>) -> AgentPolicyDecisionV3 {
        let request = input.request;
        let call = input.call;
        if validate_agent_request_v3(request).is_err() {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::InvalidRequest);
        }
        if call.request_id != request.request_id
            || !valid_identifier(&call.call_id)
            || !valid_identifier(&call.capability_id)
        {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::RequestMismatch);
        }

        let Some(descriptor) = find_builtin_tool_v3(&call.tool_name) else {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::UnregisteredTool);
        };
        if !target_shape_is_valid(&call.target)
            || !request.targets.iter().any(|target| target == &call.target)
            || !process_owner_is_registered(request, &call.target)
            || !descriptor.target_kinds.contains(&call.target.kind())
        {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::InvalidTarget);
        }
        if validate_tool_arguments_v3(&call.tool_name, &call.arguments).is_err() {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::InvalidArguments);
        }

        let Some(effect) = input.assessed_effect else {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::UnclassifiedEffect);
        };
        if effect.target_id != call.target.target_id() {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::EffectTargetMismatch);
        }
        if !descriptor.allowed_effects.contains(&effect.kind) {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::ToolEffectMismatch);
        }
        if effect.summary.trim().is_empty()
            || effect.summary.len() > 2_048
            || effect.paths.len() > 128
            || effect.paths.iter().any(|path| validate_path(path).is_err())
        {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::ToolEffectMismatch);
        }

        let Some(capability) = input.capability else {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::MissingCapability);
        };
        if capability.capability_id != call.capability_id {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityIdMismatch);
        }
        if capability.request_id != request.request_id {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityRequestMismatch);
        }
        if capability.user_session_id != request.user_session_id {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityUserSessionMismatch);
        }
        if capability.revoked {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityRevoked);
        }
        if input.now_unix_ms < capability.not_before_unix_ms {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityNotYetValid);
        }
        if input.now_unix_ms >= capability.expires_at_unix_ms {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityExpired);
        }
        if !capability
            .allowed_tools
            .iter()
            .any(|name| name == &call.tool_name)
        {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityToolDenied);
        }
        if !capability.allowed_effects.contains(&effect.kind) {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityEffectDenied);
        }
        if !capability
            .target_ids
            .iter()
            .any(|target_id| target_id == call.target.target_id())
        {
            return AgentPolicyDecisionV3::deny(AgentPolicyReasonV3::CapabilityTargetDenied);
        }
        AgentPolicyDecisionV3::allow()
    }
}

pub fn validate_agent_request_v3(request: &AgentRequestV3) -> Result<(), AgentPolicyReasonV3> {
    if request.contract_version != AGENT_CONTRACT_V3_VERSION
        || !valid_identifier(&request.request_id)
        || !valid_identifier(&request.user_session_id)
        || !valid_identifier(&request.task_id)
        || request.goal.trim().is_empty()
        || request.goal.len() > 16_384
        || request.success_criteria.is_empty()
        || request.success_criteria.len() > 64
        || request
            .success_criteria
            .iter()
            .any(|criterion| criterion.trim().is_empty() || criterion.len() > 2_048)
        || !targets_are_valid_and_unique(&request.targets)
        || !request_targets_are_coherent(request)
    {
        Err(AgentPolicyReasonV3::InvalidRequest)
    } else {
        Ok(())
    }
}

fn decode_arguments<T: DeserializeOwned>(value: &serde_json::Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
}

pub fn validate_tool_arguments_v3(
    tool_name: &str,
    arguments: &serde_json::Value,
) -> Result<(), String> {
    match tool_name {
        "exec_command" => {
            let value = decode_arguments::<ExecCommandArgumentsV3>(arguments)?;
            if value.command.is_empty()
                || value.command.len() > 8192
                || value.command.chars().any(char::is_control)
                || value.explanation.trim().is_empty()
                || value.explanation.len() > 2_048
                || value
                    .timeout_ms
                    .map(|timeout| timeout == 0 || timeout > 3_600_000)
                    .unwrap_or(false)
            {
                return Err("invalid exec_command arguments".into());
            }
            if let Some(cwd) = value.cwd {
                validate_path(&cwd)?;
            }
        }
        "write_stdin" => {
            let value = decode_arguments::<WriteStdinArgumentsV3>(arguments)?;
            if value.input.len() > 65536 {
                return Err("write_stdin input exceeds the contract limit".into());
            }
        }
        "wait_process" => {
            let value = decode_arguments::<WaitProcessArgumentsV3>(arguments)?;
            if value
                .timeout_ms
                .map(|timeout| timeout > 3_600_000)
                .unwrap_or(false)
                || value
                    .max_output_bytes
                    .map(|limit| limit == 0 || limit > 1_048_576)
                    .unwrap_or(false)
            {
                return Err("invalid wait_process bounds".into());
            }
        }
        "kill_process" => {
            let value = decode_arguments::<KillProcessArgumentsV3>(arguments)?;
            if value
                .timeout_ms
                .map(|timeout| timeout == 0 || timeout > 60_000)
                .unwrap_or(false)
            {
                return Err("invalid kill_process timeout".into());
            }
        }
        "read_file" => {
            let value = decode_arguments::<ReadFileArgumentsV3>(arguments)?;
            validate_path(&value.path)?;
            if value
                .max_bytes
                .map(|limit| limit == 0 || limit > 1_048_576)
                .unwrap_or(false)
            {
                return Err("invalid read_file byte limit".into());
            }
            if let Some(digest) = value.expected_sha256 {
                validate_sha256(&digest)?;
            }
        }
        "list_directory" => {
            let value = decode_arguments::<ListDirectoryArgumentsV3>(arguments)?;
            validate_path(&value.path)?;
            if value
                .page_size
                .map(|size| size == 0 || size > 1_000)
                .unwrap_or(false)
                || value
                    .cursor
                    .as_deref()
                    .map(|cursor| cursor.is_empty() || cursor.len() > 1_024)
                    .unwrap_or(false)
            {
                return Err("invalid list_directory pagination".into());
            }
        }
        "search_text" => {
            let value = decode_arguments::<SearchTextArgumentsV3>(arguments)?;
            validate_path(&value.path)?;
            if value.query.is_empty()
                || value.query.len() > 4_096
                || value.globs.len() > 64
                || value
                    .globs
                    .iter()
                    .any(|glob| glob.is_empty() || glob.len() > 512)
                || value
                    .globs
                    .iter()
                    .enumerate()
                    .any(|(index, glob)| value.globs[..index].iter().any(|seen| seen == glob))
                || value
                    .max_results
                    .map(|limit| limit == 0 || limit > 1_000)
                    .unwrap_or(false)
                || value
                    .cursor
                    .as_deref()
                    .map(|cursor| cursor.is_empty() || cursor.len() > 1_024)
                    .unwrap_or(false)
            {
                return Err("invalid search_text arguments".into());
            }
        }
        "apply_patch" => {
            let value = decode_arguments::<ApplyPatchArgumentsV3>(arguments)?;
            if value.patch.is_empty()
                || value.patch.len() > 1_048_576
                || value.preconditions.is_empty()
                || value.preconditions.len() > 128
            {
                return Err("apply_patch requires a patch and preconditions".into());
            }
            for precondition in value.preconditions {
                validate_path(&precondition.path)?;
                validate_sha256(&precondition.sha256)?;
            }
        }
        "transfer_file" => {
            let value = decode_arguments::<TransferFileArgumentsV3>(arguments)?;
            validate_path(&value.source_path)?;
            validate_path(&value.destination_path)?;
            if let Some(digest) = value.expected_sha256 {
                validate_sha256(&digest)?;
            }
            if let Some(digest) = value.destination_sha256 {
                validate_sha256(&digest)?;
            }
            if value
                .max_bytes
                .map(|limit| limit == 0 || limit > 268_435_456)
                .unwrap_or(false)
            {
                return Err("invalid transfer_file byte limit".into());
            }
        }
        "host_snapshot" => {
            let value = decode_arguments::<HostSnapshotArgumentsV3>(arguments)?;
            if value.sections.is_empty()
                || value.sections.len() > 4
                || value.sections.iter().enumerate().any(|(index, section)| {
                    value.sections[..index].iter().any(|seen| seen == section)
                })
            {
                return Err("host_snapshot sections are empty".into());
            }
        }
        "ask_user" => {
            let value = decode_arguments::<AskUserArgumentsV3>(arguments)?;
            let choices_were_supplied = arguments.get("choices").is_some();
            if value.prompt.trim().is_empty()
                || value.prompt.len() > 4_096
                || value.choices.len() > 20
                || (choices_were_supplied && value.choices.is_empty())
                || (!value.allow_free_text && value.choices.is_empty())
                || value.choices.iter().any(|choice| {
                    !valid_identifier(&choice.id)
                        || choice.label.trim().is_empty()
                        || choice.label.len() > 256
                        || choice
                            .description
                            .as_deref()
                            .map(|description| description.is_empty() || description.len() > 1_024)
                            .unwrap_or(false)
                })
                || value
                    .timeout_ms
                    .map(|timeout| timeout == 0 || timeout > 86_400_000)
                    .unwrap_or(false)
            {
                return Err("ask_user has no response path".into());
            }
        }
        "update_plan" => {
            let value = decode_arguments::<UpdatePlanArgumentsV3>(arguments)?;
            if value.steps.is_empty()
                || value.steps.len() > 100
                || value
                    .explanation
                    .as_deref()
                    .map(|explanation| explanation.is_empty() || explanation.len() > 4_096)
                    .unwrap_or(false)
                || value.steps.iter().any(|step| {
                    !valid_identifier(&step.id)
                        || step.description.trim().is_empty()
                        || step.description.len() > 2_048
                        || step.dependencies.len() > 100
                        || step
                            .dependencies
                            .iter()
                            .any(|dependency| !valid_identifier(dependency))
                        || step.target_ids.is_empty()
                        || step.target_ids.len() > 16
                        || step
                            .target_ids
                            .iter()
                            .any(|target| !valid_identifier(target))
                        || step.required_tools.is_empty()
                        || step.required_tools.len() > 12
                        || step
                            .required_tools
                            .iter()
                            .any(|tool| find_builtin_tool_v3(tool).is_none())
                        || step.rollback_or_compensation.trim().is_empty()
                        || step.rollback_or_compensation.len() > 4_096
                        || step.evidence_refs.len() > 64
                        || step
                            .evidence_refs
                            .iter()
                            .any(|evidence| !valid_identifier(evidence))
                        || has_duplicates(&step.dependencies)
                        || has_duplicates(&step.target_ids)
                        || has_duplicates(&step.required_tools)
                        || has_duplicates(&step.evidence_refs)
                        || step.success_criteria.is_empty()
                        || step.success_criteria.len() > 20
                        || step
                            .success_criteria
                            .iter()
                            .any(|criterion| criterion.is_empty() || criterion.len() > 1_024)
                })
            {
                return Err("update_plan steps are empty".into());
            }
        }
        _ => return Err("unregistered tool".into()),
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 128
        && first.is_ascii_alphanumeric()
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn validate_path(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        Err("invalid path".into())
    } else {
        Ok(())
    }
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("invalid sha256".into())
    }
}

fn target_shape_is_valid(target: &AgentToolTargetV3) -> bool {
    if !valid_identifier(target.target_id()) {
        return false;
    }
    match target {
        AgentToolTargetV3::Local {
            session_id, cwd, ..
        } => {
            valid_identifier(session_id)
                && cwd
                    .as_deref()
                    .map(|path| validate_path(path).is_ok())
                    .unwrap_or(true)
        }
        AgentToolTargetV3::Remote {
            session_id,
            profile_id,
            host,
            port,
            username,
            root_path,
            local_root,
            ..
        } => {
            valid_identifier(session_id)
                && profile_id.as_deref().map(valid_identifier).unwrap_or(true)
                && !host.trim().is_empty()
                && host.len() <= 255
                && *port > 0
                && !username.trim().is_empty()
                && username.len() <= 255
                && root_path
                    .as_deref()
                    .map(|path| validate_path(path).is_ok())
                    .unwrap_or(true)
                && local_root
                    .as_deref()
                    .map(|path| validate_path(path).is_ok())
                    .unwrap_or(true)
        }
        AgentToolTargetV3::Process {
            owner_target_id,
            process_handle,
            ..
        } => valid_identifier(owner_target_id) && valid_identifier(process_handle),
        AgentToolTargetV3::Ui { surface_id, .. } => valid_identifier(surface_id),
        AgentToolTargetV3::Task { task_id, .. } => valid_identifier(task_id),
    }
}

fn has_duplicates<T: PartialEq>(values: &[T]) -> bool {
    values
        .iter()
        .enumerate()
        .any(|(index, value)| values[..index].contains(value))
}

fn targets_are_valid_and_unique(targets: &[AgentToolTargetV3]) -> bool {
    if targets.is_empty() || targets.len() > 128 {
        return false;
    }
    targets.iter().enumerate().all(|(index, target)| {
        target_shape_is_valid(target)
            && targets[..index]
                .iter()
                .all(|seen| seen.target_id() != target.target_id())
    })
}

fn process_owner_is_registered(request: &AgentRequestV3, target: &AgentToolTargetV3) -> bool {
    match target {
        AgentToolTargetV3::Process {
            owner_target_id, ..
        } => request.targets.iter().any(|candidate| {
            candidate.target_id() == owner_target_id
                && matches!(
                    candidate,
                    AgentToolTargetV3::Local { .. } | AgentToolTargetV3::Remote { .. }
                )
        }),
        _ => true,
    }
}

fn request_targets_are_coherent(request: &AgentRequestV3) -> bool {
    request.targets.iter().all(|target| match target {
        AgentToolTargetV3::Process { .. } => process_owner_is_registered(request, target),
        AgentToolTargetV3::Task { task_id, .. } => task_id == &request.task_id,
        _ => true,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentResultCorrelationErrorV3 {
    RequestMismatch,
    CallMismatch,
    ToolMismatch,
    TargetMismatch,
    UnknownEffectTarget,
}

pub fn validate_result_correlation_v3(
    request: &AgentRequestV3,
    call: &AgentToolCallV3,
    result: &AgentToolResultV3,
) -> Result<(), AgentResultCorrelationErrorV3> {
    if request.request_id != call.request_id || call.request_id != result.request_id {
        return Err(AgentResultCorrelationErrorV3::RequestMismatch);
    }
    if call.call_id != result.call_id {
        return Err(AgentResultCorrelationErrorV3::CallMismatch);
    }
    if call.tool_name != result.tool_name {
        return Err(AgentResultCorrelationErrorV3::ToolMismatch);
    }
    if call.target.target_id() != result.target_id
        || !request.targets.iter().any(|target| target == &call.target)
    {
        return Err(AgentResultCorrelationErrorV3::TargetMismatch);
    }
    if result.effects.iter().any(|effect| {
        !request
            .targets
            .iter()
            .any(|target| target.target_id() == effect.target_id)
    }) {
        return Err(AgentResultCorrelationErrorV3::UnknownEffectTarget);
    }
    Ok(())
}
