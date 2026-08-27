use super::request::FrozenTargetIdentity;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExecutionStatus {
    Completed,
    Cancelled,
    TimedOut,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExecutionErrorCategory {
    InvalidRequest,
    TargetNotFound,
    TargetMismatch,
    CredentialUnavailable,
    HostKeyRejected,
    ConnectionFailed,
    ChannelOpenFailed,
    CommandStartFailed,
    OutputLimitExceeded,
    TransportFailed,
    Cancelled,
    TimedOut,
    WorkerStopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewedSshExecutionResult {
    pub(crate) operation_id: String,
    pub(crate) target: FrozenTargetIdentity,
    pub(crate) status: ExecutionStatus,
    pub(crate) started_at: i64,
    pub(crate) completed_at: i64,
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) stdout_bytes_captured: u64,
    pub(crate) stderr_bytes_captured: u64,
    pub(crate) stdout_bytes_read: u64,
    pub(crate) stderr_bytes_read: u64,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
    pub(crate) error_category: Option<ExecutionErrorCategory>,
    pub(crate) error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::request::FrozenTargetIdentity;

    #[test]
    fn error_category_serialization_is_stable() {
        let categories = [
            ExecutionErrorCategory::InvalidRequest,
            ExecutionErrorCategory::TargetNotFound,
            ExecutionErrorCategory::TargetMismatch,
            ExecutionErrorCategory::CredentialUnavailable,
            ExecutionErrorCategory::HostKeyRejected,
            ExecutionErrorCategory::ConnectionFailed,
            ExecutionErrorCategory::ChannelOpenFailed,
            ExecutionErrorCategory::CommandStartFailed,
            ExecutionErrorCategory::OutputLimitExceeded,
            ExecutionErrorCategory::TransportFailed,
            ExecutionErrorCategory::Cancelled,
            ExecutionErrorCategory::TimedOut,
            ExecutionErrorCategory::WorkerStopped,
        ];

        assert_eq!(
            serde_json::to_value(categories).expect("serialize stable error categories"),
            serde_json::json!([
                "invalidRequest",
                "targetNotFound",
                "targetMismatch",
                "credentialUnavailable",
                "hostKeyRejected",
                "connectionFailed",
                "channelOpenFailed",
                "commandStartFailed",
                "outputLimitExceeded",
                "transportFailed",
                "cancelled",
                "timedOut",
                "workerStopped"
            ])
        );
    }

    #[test]
    fn completed_result_preserves_nonzero_exit_and_output_metadata() {
        let result = ReviewedSshExecutionResult {
            operation_id: "execution:result-contract".to_string(),
            target: FrozenTargetIdentity::new(
                "profile-1".to_string(),
                "target.example.test".to_string(),
                22,
                "operator".to_string(),
                "password".to_string(),
                None,
            )
            .expect("freeze target"),
            status: ExecutionStatus::Completed,
            started_at: 1_000,
            completed_at: 1_250,
            exit_code: Some(7),
            stdout: "front-tail".to_string(),
            stderr: String::new(),
            stdout_bytes_captured: 10,
            stderr_bytes_captured: 0,
            stdout_bytes_read: 100,
            stderr_bytes_read: 0,
            stdout_truncated: true,
            stderr_truncated: false,
            error_category: None,
            error: None,
        };
        let serialized = serde_json::to_value(result).expect("serialize generic result");

        assert_eq!(serialized["status"], "completed");
        assert_eq!(serialized["exitCode"], 7);
        assert_eq!(serialized["stdoutBytesCaptured"], 10);
        assert_eq!(serialized["stdoutBytesRead"], 100);
        assert_eq!(serialized["stdoutTruncated"], true);
    }
}
