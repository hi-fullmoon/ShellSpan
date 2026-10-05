use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub(super) const SUCCESS_TTL: Duration = Duration::from_millis(1_200);
pub(super) const FAILURE_TTL: Duration = Duration::from_millis(2_500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PetdexState {
    Idle,
    Waiting,
    Waving,
    Running,
    Jumping,
    Failed,
}

impl PetdexState {
    pub(super) fn ttl(self) -> Option<Duration> {
        match self {
            Self::Waving | Self::Jumping => Some(SUCCESS_TTL),
            Self::Failed => Some(FAILURE_TTL),
            Self::Idle | Self::Waiting | Self::Running => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ActivitySource {
    Ssh,
    Sftp,
    Ai,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PetdexCategories {
    pub ssh: bool,
    pub sftp: bool,
    pub ai: bool,
}

impl Default for PetdexCategories {
    fn default() -> Self {
        Self {
            ssh: true,
            sftp: true,
            ai: false,
        }
    }
}

impl PetdexCategories {
    pub(super) fn includes(self, source: ActivitySource) -> bool {
        match source {
            ActivitySource::Ssh => self.ssh,
            ActivitySource::Sftp => self.sftp,
            ActivitySource::Ai => self.ai,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaitReason {
    Approval,
    Answer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivityPhase {
    Connecting,
    Connected,
    Running,
    Waiting(WaitReason),
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone)]
pub(crate) struct ActivityEvent {
    pub details: super::message_content::SafeDetails,
    pub owner: Option<ActivityOwner>,
    pub kind: ActivityKind,
    pub source: ActivitySource,
    pub run_id: u64,
    pub revision: u64,
    pub phase: ActivityPhase,
    pub occurred_at: std::time::Instant,
}

impl ActivityEvent {
    pub(crate) fn new(
        source: ActivitySource,
        run_id: u64,
        revision: u64,
        phase: ActivityPhase,
        occurred_at: std::time::Instant,
    ) -> Self {
        Self {
            owner: None,
            details: Default::default(),
            kind: match source {
                ActivitySource::Ssh => ActivityKind::Connect,
                ActivitySource::Sftp => ActivityKind::Copy,
                ActivitySource::Ai => ActivityKind::Ai,
            },
            source,
            run_id,
            revision,
            phase,
            occurred_at,
        }
    }
}

// Deliberately neither Debug nor Serialize: business identities never cross
// the presentation/transport boundary or enter diagnostic output.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) enum ActivityOwner {
    Ai(String),
    Connection(std::sync::Arc<uuid::Uuid>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivityKind {
    Connect,
    Upload,
    Download,
    Copy,
    CrossCopy,
    AiPreparing,
    Ai,
    Tool(super::message_content::ToolStage),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewOutcome {
    Requested,
    Overridden,
    Failed,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PetdexHealth {
    Reachable,
    Unavailable,
    Disabled,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetdexCheckResult {
    pub diagnostic: PetdexDiagnostic,
    pub health: PetdexHealth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetdexTestResult {
    pub diagnostic: PetdexDiagnostic,
    pub preview: PreviewOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PetdexConnectionStatus {
    Disabled,
    Checking,
    NotDetected,
    Connected,
    Unreachable,
    Unauthorized,
    Rejected,
    TokenUnreadable,
    TokenInvalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PetdexErrorReason {
    TokenMissing,
    TokenUnreadable,
    TokenInvalid,
    Transport,
    Unauthorized,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetdexDiagnostic {
    pub revision: u64,
    pub status: PetdexConnectionStatus,
    pub error_reason: Option<PetdexErrorReason>,
    pub target_action: Option<PetdexState>,
    pub last_success_at: Option<u64>,
}

impl Default for PetdexDiagnostic {
    fn default() -> Self {
        Self {
            revision: 0,
            status: PetdexConnectionStatus::Disabled,
            error_reason: None,
            target_action: None,
            last_success_at: None,
        }
    }
}

impl PetdexDiagnostic {
    pub(super) fn update(
        &mut self,
        status: PetdexConnectionStatus,
        error_reason: Option<PetdexErrorReason>,
        target_action: Option<PetdexState>,
        success_at: Option<u64>,
    ) -> bool {
        let next = Self {
            revision: self.revision,
            status,
            error_reason,
            target_action,
            last_success_at: success_at
                .map(|time| time.max(self.last_success_at.unwrap_or(0)))
                .or(self.last_success_at),
        };
        if *self == next {
            return false;
        }
        *self = Self {
            revision: self.revision + 1,
            ..next
        };
        true
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct StateCommand {
    pub(super) state: PetdexState,
    pub(super) expires_at: Option<Instant>,
}

impl StateCommand {
    pub(super) fn remaining_duration(
        self,
        now: Instant,
    ) -> Result<Option<Duration>, RequestFailure> {
        match self.expires_at {
            None => Ok(None),
            Some(deadline) => deadline
                .checked_duration_since(now)
                .filter(|remaining| !remaining.is_zero())
                .map(Some)
                .ok_or(RequestFailure::Expired),
        }
    }

    #[cfg(test)]
    pub(super) fn full_ttl(state: PetdexState) -> Self {
        Self {
            state,
            expires_at: state.ttl().map(|ttl| Instant::now() + ttl),
        }
    }
}

#[derive(Serialize)]
pub(super) struct StateRequest {
    pub(super) state: PetdexState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) duration: Option<u64>,
}

pub(super) struct SecretToken(String);

impl SecretToken {
    pub(super) fn new(value: String) -> Self {
        Self(value)
    }

    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

impl PartialEq for SecretToken {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

#[derive(Clone, Copy)]
pub(super) enum RequestFailure {
    Disabled,
    Expired,
    TokenMissing,
    TokenUnreadable,
    TokenInvalid,
    Transport,
    Unauthorized,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RequestResult {
    Applied,
    Disabled,
    Expired,
    TokenMissing,
    TokenUnreadable,
    TokenInvalid,
    Transport,
    Unauthorized,
    Rejected,
}

impl RequestResult {
    pub(super) fn from_result(result: Result<(), RequestFailure>) -> Self {
        match result {
            Ok(()) => Self::Applied,
            Err(RequestFailure::Disabled) => Self::Disabled,
            Err(RequestFailure::Expired) => Self::Expired,
            Err(RequestFailure::TokenMissing) => Self::TokenMissing,
            Err(RequestFailure::TokenUnreadable) => Self::TokenUnreadable,
            Err(RequestFailure::TokenInvalid) => Self::TokenInvalid,
            Err(RequestFailure::Transport) => Self::Transport,
            Err(RequestFailure::Unauthorized) => Self::Unauthorized,
            Err(RequestFailure::Rejected) => Self::Rejected,
        }
    }

    pub(super) fn connection_status(self) -> PetdexConnectionStatus {
        match self {
            Self::Applied => PetdexConnectionStatus::Connected,
            Self::Disabled => PetdexConnectionStatus::Disabled,
            Self::Expired => PetdexConnectionStatus::Checking,
            Self::TokenMissing => PetdexConnectionStatus::NotDetected,
            Self::Transport => PetdexConnectionStatus::Unreachable,
            Self::TokenUnreadable => PetdexConnectionStatus::TokenUnreadable,
            Self::TokenInvalid => PetdexConnectionStatus::TokenInvalid,
            Self::Unauthorized => PetdexConnectionStatus::Unauthorized,
            Self::Rejected => PetdexConnectionStatus::Rejected,
        }
    }

    pub(super) fn error_reason(self) -> Option<PetdexErrorReason> {
        match self {
            Self::Applied | Self::Disabled | Self::Expired => None,
            Self::TokenMissing => Some(PetdexErrorReason::TokenMissing),
            Self::TokenUnreadable => Some(PetdexErrorReason::TokenUnreadable),
            Self::TokenInvalid => Some(PetdexErrorReason::TokenInvalid),
            Self::Transport => Some(PetdexErrorReason::Transport),
            Self::Unauthorized => Some(PetdexErrorReason::Unauthorized),
            Self::Rejected => Some(PetdexErrorReason::Rejected),
        }
    }

    pub(super) fn diagnostic_category(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Disabled => "disabled",
            Self::Expired => "expired",
            Self::TokenMissing => "token-missing",
            Self::TokenUnreadable => "token-unreadable",
            Self::TokenInvalid => "token-invalid",
            Self::Transport => "transport-unavailable",
            Self::Unauthorized => "unauthorized",
            Self::Rejected => "rejected",
        }
    }

    pub(super) fn should_retry(self) -> bool {
        !matches!(self, Self::Applied | Self::Disabled | Self::Expired)
    }
}
