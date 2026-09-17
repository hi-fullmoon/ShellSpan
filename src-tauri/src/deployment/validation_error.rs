use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum WorkflowValidationCode {
    InvalidJson,
    JsonTooLarge,
    UnsupportedSchemaVersion,
    LimitExceeded,
    InvalidIdentifier,
    DuplicateIdentifier,
    InvalidPath,
    InvalidPolicy,
    UnknownNodeType,
    UnsupportedNodeVersion,
    InvalidNodeConfig,
    DangerousConfig,
    InvalidRetry,
    InvalidRunCondition,
    MissingInput,
    UnknownInputPort,
    UnknownOutputPort,
    DanglingBinding,
    PortTypeMismatch,
    ArtifactTypeMismatch,
    InvalidCondition,
    CycleDetected,
    UnreachableNode,
    MissingArtifactProducer,
    MissingApproval,
    ApprovalBypass,
    MissingDeployment,
    MissingVerification,
    VerificationNotCovered,
    UnknownTarget,
    TargetMismatch,
    CapabilityNotCovered,
    CrossTargetEffects,
    CompensationNotCovered,
    InvalidArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowValidationError {
    pub code: WorkflowValidationCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

impl WorkflowValidationError {
    pub(crate) fn new(code: WorkflowValidationCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
            node_id: None,
        }
    }

    pub(crate) fn at_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub(crate) fn for_node(mut self, node_id: impl Into<String>) -> Self {
        self.node_id = Some(node_id.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowValidationErrors {
    pub errors: Vec<WorkflowValidationError>,
}

impl WorkflowValidationErrors {
    pub(crate) fn one(error: WorkflowValidationError) -> Self {
        Self {
            errors: vec![error],
        }
    }

    pub(crate) fn from_vec(errors: Vec<WorkflowValidationError>) -> Result<(), Self> {
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Self { errors })
        }
    }
}

impl Display for WorkflowValidationErrors {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let summary = self
            .errors
            .iter()
            .map(|error| format!("{:?}: {}", error.code, error.message))
            .collect::<Vec<_>>()
            .join("; ");
        formatter.write_str(&summary)
    }
}

impl std::error::Error for WorkflowValidationErrors {}
