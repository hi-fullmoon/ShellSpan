use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub(crate) enum DeploymentPortType {
    #[serde(rename = "source.snapshot")]
    SourceSnapshot,
    #[serde(rename = "artifact.bundle")]
    ArtifactBundle,
    #[serde(rename = "target.snapshot")]
    TargetSnapshot,
    #[serde(rename = "release.candidate")]
    ReleaseCandidate,
    #[serde(rename = "transfer.receipt")]
    TransferReceipt,
    #[serde(rename = "release.receipt")]
    ReleaseReceipt,
    #[serde(rename = "activation.receipt")]
    ActivationReceipt,
    #[serde(rename = "verification.evidence")]
    VerificationEvidence,
    #[serde(rename = "control.approval")]
    ControlApproval,
    #[serde(rename = "scalar.string")]
    ScalarString,
    #[serde(rename = "scalar.boolean")]
    ScalarBoolean,
    #[serde(rename = "scalar.integer")]
    ScalarInteger,
}

impl DeploymentPortType {
    pub(crate) fn is_scalar(self) -> bool {
        matches!(
            self,
            Self::ScalarString | Self::ScalarBoolean | Self::ScalarInteger
        )
    }
}
