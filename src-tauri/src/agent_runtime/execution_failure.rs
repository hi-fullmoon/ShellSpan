use serde::{Deserialize, Serialize};

/// Trusted controller facts only. Never inferred from command stderr or errno text.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentExecutionFailureKind {
    PolicyRejected,
    BackendUnavailable,
    InfrastructureFailure,
    CommandFailed,
    Cancelled,
    TimedOut,
    TerminationUnconfirmed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentExecutionAdmission {
    NotStarted,
    Started,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentExecutionFailure {
    pub(crate) kind: AgentExecutionFailureKind,
    pub(crate) code: String,
    pub(crate) admission: AgentExecutionAdmission,
}

impl AgentExecutionFailure {
    pub(crate) fn new(
        kind: AgentExecutionFailureKind,
        code: &str,
        admission: AgentExecutionAdmission,
    ) -> Self {
        Self {
            kind,
            code: code.into(),
            admission,
        }
    }
}
