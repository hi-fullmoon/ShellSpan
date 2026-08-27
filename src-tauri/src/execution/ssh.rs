use super::cancellation::{
    CancellationHandle, ExecutionCancellationErrorKind, ExecutionCancellationRegistry,
    ExecutionTerminalState,
};
use super::output::{BoundedOutputCollector, CollectedExecutionOutput};
use super::redaction::redact_known_secrets;
use super::request::{ExecutionOutputPolicy, ReviewedSshExecutionRequest};
use super::result::{ExecutionErrorCategory, ExecutionStatus, ReviewedSshExecutionResult};
use super::target::revalidate_frozen_target;
use crate::connection::{
    connect_tcp_stream, connect_through_jump_host, open_authenticated_session,
};
use crate::db::Database;
use crate::keychain::CredentialManager;
use crate::models::{ConnectionError, RemoteConnectionRequest};
use libssh2_sys::LIBSSH2_ERROR_EAGAIN;
use ssh2::{ErrorCode, Session};
use std::io::{ErrorKind, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub(crate) const SSH_EXECUTION_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SshExecutionFailure {
    pub(crate) category: ExecutionErrorCategory,
    pub(crate) message: String,
}

pub(crate) struct SshExecutionSession {
    pub(crate) target: Session,
    _jump: Option<Session>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SshChannelExecutionOutcome {
    Completed {
        exit_code: i32,
        output: CollectedExecutionOutput,
    },
    Cancelled,
    TimedOut,
    Failed(SshExecutionFailure),
}

struct SessionBlockingModeGuard<'a> {
    session: &'a Session,
    was_blocking: bool,
}

impl<'a> SessionBlockingModeGuard<'a> {
    fn nonblocking(session: &'a Session) -> Self {
        let was_blocking = session.is_blocking();
        session.set_blocking(false);
        Self {
            session,
            was_blocking,
        }
    }
}

impl Drop for SessionBlockingModeGuard<'_> {
    fn drop(&mut self) {
        self.session.set_blocking(self.was_blocking);
    }
}

pub(crate) fn open_ssh_execution_session(
    request: &RemoteConnectionRequest,
    known_hosts_path: &Path,
) -> Result<SshExecutionSession, SshExecutionFailure> {
    validate_ssh_connection_fields(request)?;
    if let Some(jump) = &request.jump_host {
        let (jump, target) = connect_through_jump_host(
            jump,
            &request.host,
            request.port,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_data.as_deref(),
            request.passphrase.as_deref(),
            Some(known_hosts_path),
        )
        .map_err(classify_connection_error)?;
        return Ok(SshExecutionSession {
            target,
            _jump: Some(jump),
        });
    }

    let tcp =
        connect_tcp_stream(&request.host, request.port).map_err(|message| SshExecutionFailure {
            category: ExecutionErrorCategory::ConnectionFailed,
            message,
        })?;
    let target = open_authenticated_session(
        tcp,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_data.as_deref(),
        request.passphrase.as_deref(),
        &request.host,
        request.port,
        Some(known_hosts_path),
    )
    .map_err(classify_connection_error)?;
    Ok(SshExecutionSession {
        target,
        _jump: None,
    })
}

fn validate_ssh_connection_fields(
    request: &RemoteConnectionRequest,
) -> Result<(), SshExecutionFailure> {
    crate::validate_connection_fields(&request.host, &request.username).map_err(|message| {
        SshExecutionFailure {
            category: ExecutionErrorCategory::InvalidRequest,
            message,
        }
    })?;
    if let Some(jump) = &request.jump_host {
        crate::validate_connection_fields(&jump.host, &jump.username).map_err(|message| {
            SshExecutionFailure {
                category: ExecutionErrorCategory::InvalidRequest,
                message,
            }
        })?;
    }
    Ok(())
}

fn classify_connection_error(error: ConnectionError) -> SshExecutionFailure {
    let category = match error {
        ConnectionError::HostKeyUnknown { .. } | ConnectionError::HostKeyMismatch { .. } => {
            ExecutionErrorCategory::HostKeyRejected
        }
        ConnectionError::Other { .. } => ExecutionErrorCategory::ConnectionFailed,
    };
    SshExecutionFailure {
        category,
        message: error.message(),
    }
}

fn read_available(
    reader: &mut impl Read,
    collector: &mut BoundedOutputCollector,
    stdout: bool,
) -> Result<(), SshExecutionFailure> {
    let mut buffer = [0_u8; 4_096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => {
                let result = if stdout {
                    collector.push_stdout(&buffer[..count])
                } else {
                    collector.push_stderr(&buffer[..count])
                };
                if let Err(limit) = result {
                    return Err(SshExecutionFailure {
                        category: limit.category,
                        message: format!(
                            "reviewed SSH output exceeded the {} byte hard limit after reading {} bytes",
                            limit.hard_limit_bytes, limit.total_bytes_read
                        ),
                    });
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
            Err(error) => {
                return Err(SshExecutionFailure {
                    category: ExecutionErrorCategory::TransportFailed,
                    message: format!("failed to read reviewed SSH command output: {error}"),
                })
            }
        }
    }
}

fn observed_terminal_or_deadline(
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Option<SshChannelExecutionOutcome> {
    match cancellation.terminal_state() {
        ExecutionTerminalState::Cancelled => Some(SshChannelExecutionOutcome::Cancelled),
        ExecutionTerminalState::TimedOut => Some(SshChannelExecutionOutcome::TimedOut),
        ExecutionTerminalState::Finished => {
            Some(SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                category: ExecutionErrorCategory::WorkerStopped,
                message: "reviewed SSH worker observed an already finished operation".to_string(),
            }))
        }
        ExecutionTerminalState::Running if Instant::now() >= deadline => {
            cancellation.try_timeout();
            observed_terminal_or_deadline(cancellation, deadline)
        }
        ExecutionTerminalState::Running => None,
    }
}

/// Executes one command on one independent SSH exec channel.
///
/// Capture overflow keeps draining; only the combined hard read limit fails.
/// The caller supplies all known secrets so every completed stream is redacted
/// after front/tail reassembly rather than chunk by chunk.
pub(crate) fn execute_ssh_channel(
    session: &Session,
    command: &str,
    output_policy: ExecutionOutputPolicy,
    known_secrets: &[String],
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> SshChannelExecutionOutcome {
    if let Some(outcome) = observed_terminal_or_deadline(cancellation, deadline) {
        return outcome;
    }
    let mut collector = match BoundedOutputCollector::new(output_policy) {
        Ok(collector) => collector,
        Err(error) => {
            return SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                category: error.category,
                message: error.message.to_string(),
            })
        }
    };
    let mut channel = match session.channel_session() {
        Ok(channel) => channel,
        Err(error) => {
            return SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                category: ExecutionErrorCategory::ChannelOpenFailed,
                message: format!("failed to open reviewed SSH command channel: {error}"),
            })
        }
    };
    if let Err(error) = channel.exec(command) {
        return SshChannelExecutionOutcome::Failed(SshExecutionFailure {
            category: ExecutionErrorCategory::CommandStartFailed,
            message: format!("failed to start reviewed SSH command: {error}"),
        });
    }

    // This guard is declared after the channel so blocking mode is restored
    // before Channel::drop asks libssh2 to free the channel on every path.
    let _blocking_mode = SessionBlockingModeGuard::nonblocking(session);
    loop {
        if let Some(outcome) = observed_terminal_or_deadline(cancellation, deadline) {
            let _ = channel.close();
            return outcome;
        }
        if let Err(failure) = read_available(&mut channel, &mut collector, true) {
            let _ = channel.close();
            return SshChannelExecutionOutcome::Failed(failure);
        }
        if let Err(failure) = read_available(&mut channel.stderr(), &mut collector, false) {
            let _ = channel.close();
            return SshChannelExecutionOutcome::Failed(failure);
        }
        if channel.eof() {
            break;
        }
        std::thread::sleep(SSH_EXECUTION_POLL_INTERVAL);
    }

    loop {
        if let Some(outcome) = observed_terminal_or_deadline(cancellation, deadline) {
            let _ = channel.close();
            return outcome;
        }
        match channel.wait_close() {
            Ok(()) => break,
            Err(error) if error.code() == ErrorCode::Session(LIBSSH2_ERROR_EAGAIN) => {
                std::thread::sleep(SSH_EXECUTION_POLL_INTERVAL);
            }
            Err(error) => {
                return SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                    category: ExecutionErrorCategory::TransportFailed,
                    message: format!("failed to close reviewed SSH command channel: {error}"),
                })
            }
        }
    }

    let exit_code = loop {
        if let Some(outcome) = observed_terminal_or_deadline(cancellation, deadline) {
            return outcome;
        }
        match channel.exit_status() {
            Ok(status) => break status,
            Err(error) if error.code() == ErrorCode::Session(LIBSSH2_ERROR_EAGAIN) => {
                std::thread::sleep(SSH_EXECUTION_POLL_INTERVAL);
            }
            Err(error) => {
                return SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                    category: ExecutionErrorCategory::TransportFailed,
                    message: format!("failed to read reviewed SSH command status: {error}"),
                })
            }
        }
    };
    match collector.finish(known_secrets) {
        Ok(output) => SshChannelExecutionOutcome::Completed { exit_code, output },
        Err(limit) => SshChannelExecutionOutcome::Failed(SshExecutionFailure {
            category: limit.category,
            message: format!(
                "reviewed SSH output exceeded the {} byte hard limit after reading {} bytes",
                limit.hard_limit_bytes, limit.total_bytes_read
            ),
        }),
    }
}

fn run_worker_safely(
    operation: impl FnOnce() -> SshChannelExecutionOutcome,
) -> SshChannelExecutionOutcome {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(outcome) => outcome,
        Err(_) => SshChannelExecutionOutcome::Failed(SshExecutionFailure {
            category: ExecutionErrorCategory::WorkerStopped,
            // Deliberately discard the panic payload: it is not a reviewed
            // result channel and may contain connection or command material.
            message: "reviewed SSH execution worker panicked".to_string(),
        }),
    }
}

pub(crate) fn spawn_ssh_execution_worker(
    connection: RemoteConnectionRequest,
    known_hosts_path: PathBuf,
    command: String,
    output_policy: ExecutionOutputPolicy,
    known_secrets: Vec<String>,
    cancellation: CancellationHandle,
    deadline: Instant,
) -> mpsc::Receiver<SshChannelExecutionOutcome> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let outcome = run_worker_safely(|| {
            if let Some(outcome) = observed_terminal_or_deadline(&cancellation, deadline) {
                return outcome;
            }
            match open_ssh_execution_session(&connection, &known_hosts_path) {
                Ok(session) => execute_ssh_channel(
                    &session.target,
                    &command,
                    output_policy,
                    &known_secrets,
                    &cancellation,
                    deadline,
                ),
                Err(failure) => SshChannelExecutionOutcome::Failed(failure),
            }
        });
        let _ = sender.send(outcome);
    });
    receiver
}

pub(crate) fn await_ssh_execution_worker(
    receiver: &mpsc::Receiver<SshChannelExecutionOutcome>,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> SshChannelExecutionOutcome {
    loop {
        if let Some(outcome) = observed_terminal_or_deadline(cancellation, deadline) {
            return outcome;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(SSH_EXECUTION_POLL_INTERVAL.min(remaining)) {
            Ok(outcome) => {
                if cancellation.try_finish() {
                    return outcome;
                }
                return observed_terminal_or_deadline(cancellation, deadline).unwrap_or_else(
                    || {
                        SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                            category: ExecutionErrorCategory::WorkerStopped,
                            message: "reviewed SSH execution lost its terminal state".to_string(),
                        })
                    },
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if cancellation.try_finish() {
                    return SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                        category: ExecutionErrorCategory::WorkerStopped,
                        message: "reviewed SSH execution worker stopped unexpectedly".to_string(),
                    });
                }
                return observed_terminal_or_deadline(cancellation, deadline).unwrap_or_else(
                    || {
                        SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                            category: ExecutionErrorCategory::WorkerStopped,
                            message: "reviewed SSH execution lost its terminal state".to_string(),
                        })
                    },
                );
            }
        }
    }
}

fn settle_outcome_terminal(
    outcome: SshChannelExecutionOutcome,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> SshChannelExecutionOutcome {
    loop {
        match cancellation.terminal_state() {
            ExecutionTerminalState::Cancelled => return SshChannelExecutionOutcome::Cancelled,
            ExecutionTerminalState::TimedOut => return SshChannelExecutionOutcome::TimedOut,
            ExecutionTerminalState::Finished => return outcome,
            ExecutionTerminalState::Running if Instant::now() >= deadline => {
                cancellation.try_timeout();
            }
            ExecutionTerminalState::Running => {
                if cancellation.try_finish() {
                    return outcome;
                }
            }
        }
    }
}

fn empty_result(
    request: &ReviewedSshExecutionRequest,
    started_at: i64,
    status: ExecutionStatus,
    category: ExecutionErrorCategory,
    message: String,
    secrets: &[String],
) -> ReviewedSshExecutionResult {
    ReviewedSshExecutionResult {
        operation_id: request.operation_id.clone(),
        target: request.target.clone(),
        status,
        started_at,
        completed_at: crate::db::current_timestamp_ms(),
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        stdout_bytes_captured: 0,
        stderr_bytes_captured: 0,
        stdout_bytes_read: 0,
        stderr_bytes_read: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        error_category: Some(category),
        error: Some(redact_known_secrets(&message, secrets)),
    }
}

fn generic_result_from_outcome(
    request: &ReviewedSshExecutionRequest,
    started_at: i64,
    outcome: SshChannelExecutionOutcome,
    secrets: &[String],
) -> ReviewedSshExecutionResult {
    match outcome {
        SshChannelExecutionOutcome::Completed { exit_code, output } => ReviewedSshExecutionResult {
            operation_id: request.operation_id.clone(),
            target: request.target.clone(),
            status: ExecutionStatus::Completed,
            started_at,
            completed_at: crate::db::current_timestamp_ms(),
            exit_code: Some(exit_code),
            stdout: output.stdout.text,
            stderr: output.stderr.text,
            stdout_bytes_captured: output.stdout.bytes_captured,
            stderr_bytes_captured: output.stderr.bytes_captured,
            stdout_bytes_read: output.stdout.bytes_read,
            stderr_bytes_read: output.stderr.bytes_read,
            stdout_truncated: output.stdout.truncated,
            stderr_truncated: output.stderr.truncated,
            error_category: None,
            error: None,
        },
        SshChannelExecutionOutcome::Cancelled => empty_result(
            request,
            started_at,
            ExecutionStatus::Cancelled,
            ExecutionErrorCategory::Cancelled,
            "reviewed SSH execution was cancelled".to_string(),
            secrets,
        ),
        SshChannelExecutionOutcome::TimedOut => empty_result(
            request,
            started_at,
            ExecutionStatus::TimedOut,
            ExecutionErrorCategory::TimedOut,
            format!(
                "reviewed SSH execution timed out after {} ms",
                request.timeout.as_millis()
            ),
            secrets,
        ),
        SshChannelExecutionOutcome::Failed(failure) => empty_result(
            request,
            started_at,
            ExecutionStatus::Failed,
            failure.category,
            failure.message,
            secrets,
        ),
    }
}

/// Complete crate-private entry for a reviewed SSH request.
///
/// Step 2 exposes this to Rust callers only. The Runbook request/result adapter
/// is intentionally left for step 3.
pub(crate) fn execute_reviewed_ssh_command(
    database: &Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    mut request: ReviewedSshExecutionRequest,
) -> ReviewedSshExecutionResult {
    let started_at = crate::db::current_timestamp_ms();
    let started = Instant::now();
    let initial_secrets = request.known_secret_values();
    if let Err(error) = request.validate() {
        return empty_result(
            &request,
            started_at,
            ExecutionStatus::Failed,
            error.category,
            error.message.to_string(),
            &initial_secrets,
        );
    }
    let cancellation = match cancellations.register(request.operation_id.clone()) {
        Ok(handle) => handle,
        Err(error) => {
            let category = match error.kind {
                ExecutionCancellationErrorKind::InvalidOperationId
                | ExecutionCancellationErrorKind::DuplicateOperationId => {
                    ExecutionErrorCategory::InvalidRequest
                }
                ExecutionCancellationErrorKind::OperationNotFound
                | ExecutionCancellationErrorKind::RegistryPoisoned => {
                    ExecutionErrorCategory::WorkerStopped
                }
            };
            return empty_result(
                &request,
                started_at,
                ExecutionStatus::Failed,
                category,
                error.to_string(),
                &initial_secrets,
            );
        }
    };
    let deadline = started + request.timeout;

    let outcome = if let Some(outcome) = observed_terminal_or_deadline(&cancellation, deadline) {
        outcome
    } else if let Err(error) = revalidate_frozen_target(database, &request) {
        SshChannelExecutionOutcome::Failed(SshExecutionFailure {
            category: error.category,
            message: error.message,
        })
    } else if let Some(outcome) = observed_terminal_or_deadline(&cancellation, deadline) {
        outcome
    } else if let Err(failure) = validate_ssh_connection_fields(&request.connection) {
        SshChannelExecutionOutcome::Failed(failure)
    } else if let Err(error) =
        crate::commands::resolve_keychain_key_for_remote(credentials, &mut request.connection)
    {
        SshChannelExecutionOutcome::Failed(SshExecutionFailure {
            category: ExecutionErrorCategory::CredentialUnavailable,
            message: error,
        })
    } else if let Err(error) = request.validate() {
        SshChannelExecutionOutcome::Failed(SshExecutionFailure {
            category: error.category,
            message: error.message.to_string(),
        })
    } else if let Some(outcome) = observed_terminal_or_deadline(&cancellation, deadline) {
        outcome
    } else {
        let receiver = spawn_ssh_execution_worker(
            request.connection.clone(),
            known_hosts_path.to_path_buf(),
            request.command.command.clone(),
            request.output_policy,
            request.known_secret_values(),
            cancellation.clone(),
            deadline,
        );
        await_ssh_execution_worker(&receiver, &cancellation, deadline)
    };

    let outcome = settle_outcome_terminal(outcome, &cancellation, deadline);
    let secrets = request.known_secret_values();
    cancellation.remove_registration();
    generic_result_from_outcome(&request, started_at, outcome, &secrets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{
        FrozenTargetIdentity, ReviewedSshCommand, DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
    };
    use crate::models::AuthMethod;

    fn connection() -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "operator".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("kernel-secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        }
    }

    fn request() -> ReviewedSshExecutionRequest {
        let connection = connection();
        ReviewedSshExecutionRequest {
            operation_id: "execution:kernel-test".to_string(),
            target: FrozenTargetIdentity::from_connection("profile-1".to_string(), &connection)
                .unwrap(),
            connection,
            command: ReviewedSshCommand::new(
                "true".to_string(),
                "true".to_string(),
                vec!["kernel-secret".to_string()],
            )
            .unwrap(),
            timeout: Duration::from_secs(5),
            output_policy: ExecutionOutputPolicy::default(),
        }
    }

    fn completed_outcome() -> SshChannelExecutionOutcome {
        let collector = BoundedOutputCollector::new(ExecutionOutputPolicy::default()).unwrap();
        SshChannelExecutionOutcome::Completed {
            exit_code: 7,
            output: collector.finish(&[]).unwrap(),
        }
    }

    #[test]
    fn cancel_timeout_and_late_worker_result_have_one_terminal_state() {
        let registry = ExecutionCancellationRegistry::default();
        let cancelled = registry.register("execution:late-cancel").unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        registry.cancel("execution:late-cancel").unwrap();
        sender.send(completed_outcome()).unwrap();
        assert_eq!(
            await_ssh_execution_worker(
                &receiver,
                &cancelled,
                Instant::now() + Duration::from_secs(1)
            ),
            SshChannelExecutionOutcome::Cancelled
        );
        assert_eq!(
            cancelled.terminal_state(),
            ExecutionTerminalState::Cancelled
        );

        let timed_out = registry.register("execution:late-timeout").unwrap();
        let (_sender, receiver) = mpsc::sync_channel(1);
        assert_eq!(
            await_ssh_execution_worker(&receiver, &timed_out, Instant::now()),
            SshChannelExecutionOutcome::TimedOut
        );
        assert_eq!(timed_out.terminal_state(), ExecutionTerminalState::TimedOut);
    }

    #[test]
    fn cancellation_also_wins_during_pre_worker_failure_finalization() {
        let registry = ExecutionCancellationRegistry::default();
        let cancellation = registry.register("execution:preflight-race").unwrap();
        registry.cancel("execution:preflight-race").unwrap();
        let settled = settle_outcome_terminal(
            SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                category: ExecutionErrorCategory::TargetMismatch,
                message: "stale preflight failure".to_string(),
            }),
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        );
        assert_eq!(settled, SshChannelExecutionOutcome::Cancelled);
        assert!(!cancellation.try_finish());
    }

    #[test]
    fn kernel_reader_drains_after_capture_limit_and_fails_at_combined_hard_limit() {
        let mut drained =
            BoundedOutputCollector::new(ExecutionOutputPolicy::new(4, 4, 64).unwrap()).unwrap();
        read_available(&mut &b"abcdefghijkl"[..], &mut drained, true).unwrap();
        let drained = drained.finish(&[]).unwrap();
        assert_eq!(drained.stdout.bytes_read, 12);
        assert_eq!(drained.stdout.bytes_captured, 4);
        assert!(drained.stdout.truncated);

        let mut limited =
            BoundedOutputCollector::new(ExecutionOutputPolicy::new(4, 4, 8).unwrap()).unwrap();
        read_available(&mut &b"123456"[..], &mut limited, true).unwrap();
        let failure = read_available(&mut &b"789"[..], &mut limited, false)
            .expect_err("combined stdout and stderr hard limit must fail");
        assert_eq!(
            failure.category,
            ExecutionErrorCategory::OutputLimitExceeded
        );
    }

    #[test]
    fn disconnected_session_observes_cancel_and_timeout_before_channel_open() {
        let session = Session::new().unwrap();
        let registry = ExecutionCancellationRegistry::default();
        let cancelled = registry.register("execution:pre-cancel").unwrap();
        registry.cancel("execution:pre-cancel").unwrap();
        assert_eq!(
            execute_ssh_channel(
                &session,
                "true",
                ExecutionOutputPolicy::default(),
                &[],
                &cancelled,
                Instant::now() + Duration::from_secs(1),
            ),
            SshChannelExecutionOutcome::Cancelled
        );

        let timed_out = registry.register("execution:pre-timeout").unwrap();
        assert_eq!(
            execute_ssh_channel(
                &session,
                "true",
                ExecutionOutputPolicy::default(),
                &[],
                &timed_out,
                Instant::now(),
            ),
            SshChannelExecutionOutcome::TimedOut
        );
    }

    #[test]
    fn panic_payload_and_failure_messages_use_the_redaction_boundary() {
        let panic_outcome = run_worker_safely(|| panic!("kernel-secret"));
        assert_eq!(
            panic_outcome,
            SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                category: ExecutionErrorCategory::WorkerStopped,
                message: "reviewed SSH execution worker panicked".to_string(),
            })
        );

        let result = generic_result_from_outcome(
            &request(),
            1,
            SshChannelExecutionOutcome::Failed(SshExecutionFailure {
                category: ExecutionErrorCategory::TransportFailed,
                message: "transport leaked kernel-secret".to_string(),
            }),
            &["kernel-secret".to_string()],
        );
        assert_eq!(result.error.as_deref(), Some("transport leaked [REDACTED]"));
    }

    #[test]
    fn missing_profile_fails_before_network_and_cleans_registration() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("termbridge.db")).unwrap();
        let credentials = CredentialManager::new();
        let cancellations = ExecutionCancellationRegistry::default();
        let known_hosts = directory.path().join("known_hosts");
        let result = execute_reviewed_ssh_command(
            &database,
            &credentials,
            &cancellations,
            &known_hosts,
            request(),
        );
        assert_eq!(result.status, ExecutionStatus::Failed);
        assert_eq!(
            result.error_category,
            Some(ExecutionErrorCategory::TargetNotFound)
        );
        assert_eq!(
            cancellations
                .cancel("execution:kernel-test")
                .expect_err("terminal result cleans registry")
                .kind,
            ExecutionCancellationErrorKind::OperationNotFound
        );
    }

    #[test]
    fn connection_error_classification_preserves_host_key_boundary() {
        let failure = classify_connection_error(ConnectionError::HostKeyMismatch {
            host: "target.example.test".to_string(),
            port: 22,
            fingerprint: Some("SHA256:test".to_string()),
        });
        assert_eq!(failure.category, ExecutionErrorCategory::HostKeyRejected);

        let failure = classify_connection_error(ConnectionError::Other {
            message: "authentication failed".to_string(),
        });
        assert_eq!(failure.category, ExecutionErrorCategory::ConnectionFailed);
    }

    #[test]
    fn kernel_reapplies_connection_field_policy_before_network_access() {
        let mut blocked = connection();
        blocked.host = "169.254.169.254".to_string();
        let failure = validate_ssh_connection_fields(&blocked)
            .expect_err("metadata endpoint must remain blocked");
        assert_eq!(failure.category, ExecutionErrorCategory::InvalidRequest);

        let mut invalid_jump = connection();
        invalid_jump.jump_host = Some(crate::models::JumpHostConfig {
            host: "169.254.169.254".to_string(),
            port: 22,
            username: "jump".to_string(),
            auth_method: AuthMethod::Password,
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
        });
        assert_eq!(
            validate_ssh_connection_fields(&invalid_jump)
                .expect_err("jump metadata endpoint must remain blocked")
                .category,
            ExecutionErrorCategory::InvalidRequest
        );
    }

    #[test]
    fn default_policy_keeps_capture_and_combined_hard_limit_distinct() {
        let policy = ExecutionOutputPolicy::default();
        assert!(policy.total_read_hard_limit_bytes > policy.stdout_capture_bytes);
        assert_eq!(
            policy.total_read_hard_limit_bytes,
            DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES
        );
    }
}
