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
        let database = Database::open(&directory.path().join("shellspan.db")).unwrap();
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
