use serde::Serialize;
use std::time::Duration;

pub(super) const SUCCESS_TTL: Duration = Duration::from_millis(1_200);
pub(super) const FAILURE_TTL: Duration = Duration::from_millis(2_500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum PetdexState {
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

#[derive(Clone)]
pub(crate) enum PetdexEvent {
    SshConnecting(String),
    SshConnected(String),
    SshFailed(String),
    SshClosed(String),
    SftpStarted(String),
    SftpSucceeded(String),
    SftpFailed(String),
    SftpCancelled(String),
    AiStarted(String),
    AiSucceeded(String),
    AiFailed(String),
    AiCancelled(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PetdexConnectionStatus {
    NotDetected = 0,
    Connected = 1,
    NotRunning = 2,
    ConnectionError = 3,
}

impl PetdexConnectionStatus {
    pub(super) fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Connected,
            2 => Self::NotRunning,
            3 => Self::ConnectionError,
            _ => Self::NotDetected,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct StateCommand {
    pub(super) state: PetdexState,
    pub(super) duration: Option<Duration>,
}

impl StateCommand {
    #[cfg(test)]
    pub(super) fn full_ttl(state: PetdexState) -> Self {
        Self {
            state,
            duration: state.ttl(),
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
            Self::Disabled | Self::TokenMissing => PetdexConnectionStatus::NotDetected,
            Self::Transport => PetdexConnectionStatus::NotRunning,
            Self::TokenUnreadable | Self::TokenInvalid | Self::Unauthorized | Self::Rejected => {
                PetdexConnectionStatus::ConnectionError
            }
        }
    }

    pub(super) fn diagnostic_category(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Disabled => "disabled",
            Self::TokenMissing => "token-missing",
            Self::TokenUnreadable => "token-unreadable",
            Self::TokenInvalid => "token-invalid",
            Self::Transport => "transport-unavailable",
            Self::Unauthorized => "unauthorized",
            Self::Rejected => "rejected",
        }
    }

    pub(super) fn should_retry(self) -> bool {
        self != Self::Applied && self != Self::Disabled
    }
}
