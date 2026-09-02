use serde::de::DeserializeOwned;

use super::types::{
    AgentEffectKindNative, AgentObservedEffectNative, AgentRequestNative, AgentTargetKindNative,
    AgentToolCallNative, AgentToolTargetNative, ApplyPatchArgumentsNative,
    ExecCommandArgumentsNative, KillProcessArgumentsNative, ListDirectoryArgumentsNative,
    ReadFileArgumentsNative, SearchTextArgumentsNative, TransferFileArgumentsNative,
    WaitProcessArgumentsNative, WriteStdinArgumentsNative, NATIVE_TOOL_CONTRACT_VERSION,
};

pub enum AgentToolEffectModeNative {
    Fixed,
    NativeClassifier,
}

pub struct AgentToolDescriptorNative {
    pub name: &'static str,
    pub target_kinds: &'static [AgentTargetKindNative],
    pub effect_mode: AgentToolEffectModeNative,
    pub allowed_effects: &'static [AgentEffectKindNative],
}

const LOCAL_REMOTE: &[AgentTargetKindNative] =
    &[AgentTargetKindNative::Local, AgentTargetKindNative::Remote];
const PROCESS: &[AgentTargetKindNative] = &[AgentTargetKindNative::Process];
const READ_ONLY: &[AgentEffectKindNative] = &[AgentEffectKindNative::ReadOnly];
const SENSITIVE_READ: &[AgentEffectKindNative] = &[AgentEffectKindNative::SensitiveRead];
const STATE_CHANGE: &[AgentEffectKindNative] = &[AgentEffectKindNative::StateChange];
const PATCH_EFFECTS: &[AgentEffectKindNative] = &[
    AgentEffectKindNative::StateChange,
    AgentEffectKindNative::Destructive,
];
const TRANSFER_EFFECTS: &[AgentEffectKindNative] = &[
    AgentEffectKindNative::SensitiveRead,
    AgentEffectKindNative::StateChange,
    AgentEffectKindNative::ExternalSideEffect,
];
const EXEC_EFFECTS: &[AgentEffectKindNative] = &[
    AgentEffectKindNative::ReadOnly,
    AgentEffectKindNative::SensitiveRead,
    AgentEffectKindNative::StateChange,
    AgentEffectKindNative::Destructive,
    AgentEffectKindNative::ExternalSideEffect,
];

pub const BUILTIN_TOOL_DESCRIPTORS: [AgentToolDescriptorNative; 9] = [
    AgentToolDescriptorNative {
        name: "exec_command",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeNative::NativeClassifier,
        allowed_effects: EXEC_EFFECTS,
    },
    AgentToolDescriptorNative {
        name: "write_stdin",
        target_kinds: PROCESS,
        effect_mode: AgentToolEffectModeNative::Fixed,
        allowed_effects: STATE_CHANGE,
    },
    AgentToolDescriptorNative {
        name: "wait_process",
        target_kinds: PROCESS,
        effect_mode: AgentToolEffectModeNative::Fixed,
        allowed_effects: READ_ONLY,
    },
    AgentToolDescriptorNative {
        name: "kill_process",
        target_kinds: PROCESS,
        effect_mode: AgentToolEffectModeNative::Fixed,
        allowed_effects: STATE_CHANGE,
    },
    AgentToolDescriptorNative {
        name: "read_file",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeNative::Fixed,
        allowed_effects: SENSITIVE_READ,
    },
    AgentToolDescriptorNative {
        name: "list_directory",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeNative::Fixed,
        allowed_effects: READ_ONLY,
    },
    AgentToolDescriptorNative {
        name: "search_text",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeNative::Fixed,
        allowed_effects: SENSITIVE_READ,
    },
    AgentToolDescriptorNative {
        name: "apply_patch",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeNative::NativeClassifier,
        allowed_effects: PATCH_EFFECTS,
    },
    AgentToolDescriptorNative {
        name: "transfer_file",
        target_kinds: LOCAL_REMOTE,
        effect_mode: AgentToolEffectModeNative::NativeClassifier,
        allowed_effects: TRANSFER_EFFECTS,
    },
];

pub fn find_builtin_tool_native(name: &str) -> Option<&'static AgentToolDescriptorNative> {
    BUILTIN_TOOL_DESCRIPTORS
        .iter()
        .find(|descriptor| descriptor.name == name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCapabilityVerificationContextNative<'a> {
    pub request_id: &'a str,
    pub user_session_id: &'a str,
    pub call_id: &'a str,
    pub target_id: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCapabilityVerificationFailureNative {
    Unknown,
    InvalidProof,
    Revoked,
    Expired,
}

/// Verifies an opaque capability reference inside the Rust trust boundary.
/// Implementations must never deserialize a `VerifiedAgentCapabilityNative` from
/// the WebView or model output.
pub trait AgentCapabilityVerifierNative: Send + Sync {
    fn verify(
        &self,
        capability_id: &str,
        context: AgentCapabilityVerificationContextNative<'_>,
        now_unix_ms: u64,
    ) -> Result<VerifiedAgentCapabilityNative, AgentCapabilityVerificationFailureNative>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAgentCapabilityNative {
    capability_id: String,
    request_id: String,
    user_session_id: String,
    allowed_tools: Vec<String>,
    allowed_effects: Vec<AgentEffectKindNative>,
    target_ids: Vec<String>,
    not_before_unix_ms: u64,
    expires_at_unix_ms: u64,
    revoked: bool,
}

impl VerifiedAgentCapabilityNative {
    /// Construction is crate-private so a future native verifier can create
    /// this proof, while Tauri wire input cannot fabricate it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_verified_claims(
        capability_id: String,
        request_id: String,
        user_session_id: String,
        allowed_tools: Vec<String>,
        allowed_effects: Vec<AgentEffectKindNative>,
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
pub enum AgentPolicyOutcomeNative {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPolicyReasonNative {
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
pub struct AgentPolicyDecisionNative {
    pub outcome: AgentPolicyOutcomeNative,
    pub reason: AgentPolicyReasonNative,
}

impl AgentPolicyDecisionNative {
    fn allow() -> Self {
        Self {
            outcome: AgentPolicyOutcomeNative::Allow,
            reason: AgentPolicyReasonNative::Authorized,
        }
    }

    fn deny(reason: AgentPolicyReasonNative) -> Self {
        Self {
            outcome: AgentPolicyOutcomeNative::Deny,
            reason,
        }
    }
}

pub struct AgentPolicyEvaluationNative<'a> {
    pub request: &'a AgentRequestNative,
    pub call: &'a AgentToolCallNative,
    pub assessed_effect: Option<&'a AgentObservedEffectNative>,
    pub capability: Option<&'a VerifiedAgentCapabilityNative>,
    pub now_unix_ms: u64,
}

/// Native policy boundary consumed by the Native runtime. Native provides the strict,
/// fail-closed reference evaluator but does not execute tools.
pub trait AgentPolicyEngineNative: Send + Sync {
    fn evaluate(&self, input: AgentPolicyEvaluationNative<'_>) -> AgentPolicyDecisionNative;
}

#[derive(Debug, Default)]
pub struct NativeContractPolicyEngine;

impl AgentPolicyEngineNative for NativeContractPolicyEngine {
    fn evaluate(&self, input: AgentPolicyEvaluationNative<'_>) -> AgentPolicyDecisionNative {
        let request = input.request;
        let call = input.call;
        if validate_agent_request_native(request).is_err() {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::InvalidRequest);
        }
        if call.request_id != request.request_id
            || !valid_identifier(&call.call_id)
            || !valid_identifier(&call.capability_id)
        {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::RequestMismatch);
        }

        let Some(descriptor) = find_builtin_tool_native(&call.tool_name) else {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::UnregisteredTool);
        };
        if !target_shape_is_valid(&call.target)
            || !request.targets.iter().any(|target| target == &call.target)
            || !process_owner_is_registered(request, &call.target)
            || !descriptor.target_kinds.contains(&call.target.kind())
        {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::InvalidTarget);
        }
        if validate_tool_arguments_native(&call.tool_name, &call.arguments).is_err() {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::InvalidArguments);
        }

        let Some(effect) = input.assessed_effect else {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::UnclassifiedEffect);
        };
        if effect.target_id != call.target.target_id() {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::EffectTargetMismatch);
        }
        if !descriptor.allowed_effects.contains(&effect.kind) {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::ToolEffectMismatch);
        }
        if effect.summary.trim().is_empty()
            || effect.summary.len() > 2_048
            || effect.paths.len() > 128
            || effect.paths.iter().any(|path| validate_path(path).is_err())
        {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::ToolEffectMismatch);
        }

        let Some(capability) = input.capability else {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::MissingCapability);
        };
        if capability.capability_id != call.capability_id {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::CapabilityIdMismatch);
        }
        if capability.request_id != request.request_id {
            return AgentPolicyDecisionNative::deny(
                AgentPolicyReasonNative::CapabilityRequestMismatch,
            );
        }
        if capability.user_session_id != request.user_session_id {
            return AgentPolicyDecisionNative::deny(
                AgentPolicyReasonNative::CapabilityUserSessionMismatch,
            );
        }
        if capability.revoked {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::CapabilityRevoked);
        }
        if input.now_unix_ms < capability.not_before_unix_ms {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::CapabilityNotYetValid);
        }
        if input.now_unix_ms >= capability.expires_at_unix_ms {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::CapabilityExpired);
        }
        if !capability
            .allowed_tools
            .iter()
            .any(|name| name == &call.tool_name)
        {
            return AgentPolicyDecisionNative::deny(AgentPolicyReasonNative::CapabilityToolDenied);
        }
        if !capability.allowed_effects.contains(&effect.kind) {
            return AgentPolicyDecisionNative::deny(
                AgentPolicyReasonNative::CapabilityEffectDenied,
            );
        }
        if !capability
            .target_ids
            .iter()
            .any(|target_id| target_id == call.target.target_id())
        {
            return AgentPolicyDecisionNative::deny(
                AgentPolicyReasonNative::CapabilityTargetDenied,
            );
        }
        AgentPolicyDecisionNative::allow()
    }
}

pub fn validate_agent_request_native(
    request: &AgentRequestNative,
) -> Result<(), AgentPolicyReasonNative> {
    if request.contract_version != NATIVE_TOOL_CONTRACT_VERSION
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
        Err(AgentPolicyReasonNative::InvalidRequest)
    } else {
        Ok(())
    }
}

fn decode_arguments<T: DeserializeOwned>(value: &serde_json::Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
}

pub fn validate_tool_arguments_native(
    tool_name: &str,
    arguments: &serde_json::Value,
) -> Result<(), String> {
    match tool_name {
        "exec_command" => {
            let value = decode_arguments::<ExecCommandArgumentsNative>(arguments)?;
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
            let value = decode_arguments::<WriteStdinArgumentsNative>(arguments)?;
            if value.input.len() > 65536 {
                return Err("write_stdin input exceeds the contract limit".into());
            }
        }
        "wait_process" => {
            let value = decode_arguments::<WaitProcessArgumentsNative>(arguments)?;
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
            let value = decode_arguments::<KillProcessArgumentsNative>(arguments)?;
            if value
                .timeout_ms
                .map(|timeout| timeout == 0 || timeout > 60_000)
                .unwrap_or(false)
            {
                return Err("invalid kill_process timeout".into());
            }
        }
        "read_file" => {
            let value = decode_arguments::<ReadFileArgumentsNative>(arguments)?;
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
            let value = decode_arguments::<ListDirectoryArgumentsNative>(arguments)?;
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
            let value = decode_arguments::<SearchTextArgumentsNative>(arguments)?;
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
            let value = decode_arguments::<ApplyPatchArgumentsNative>(arguments)?;
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
            let value = decode_arguments::<TransferFileArgumentsNative>(arguments)?;
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

fn target_shape_is_valid(target: &AgentToolTargetNative) -> bool {
    if !valid_identifier(target.target_id()) {
        return false;
    }
    match target {
        AgentToolTargetNative::Local {
            session_id, cwd, ..
        } => {
            valid_identifier(session_id)
                && cwd
                    .as_deref()
                    .map(|path| validate_path(path).is_ok())
                    .unwrap_or(true)
        }
        AgentToolTargetNative::Remote {
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
        AgentToolTargetNative::Process {
            owner_target_id,
            process_handle,
            ..
        } => valid_identifier(owner_target_id) && valid_identifier(process_handle),
    }
}

fn targets_are_valid_and_unique(targets: &[AgentToolTargetNative]) -> bool {
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

fn process_owner_is_registered(
    request: &AgentRequestNative,
    target: &AgentToolTargetNative,
) -> bool {
    match target {
        AgentToolTargetNative::Process {
            owner_target_id, ..
        } => request.targets.iter().any(|candidate| {
            candidate.target_id() == owner_target_id
                && matches!(
                    candidate,
                    AgentToolTargetNative::Local { .. } | AgentToolTargetNative::Remote { .. }
                )
        }),
        _ => true,
    }
}

fn request_targets_are_coherent(request: &AgentRequestNative) -> bool {
    request.targets.iter().all(|target| match target {
        AgentToolTargetNative::Process { .. } => process_owner_is_registered(request, target),
        _ => true,
    })
}
