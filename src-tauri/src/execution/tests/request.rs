    use super::*;
    use crate::models::AuthMethod;

    fn connection() -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: "target.example.test".to_string(),
            port: 22,
            username: "operator".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("target-password".to_string()),
            keychain_key_id: None,
            private_key_data: Some("target-private-key".to_string()),
            passphrase: Some("target-passphrase".to_string()),
            jump_host: Some(JumpHostConfig {
                host: "jump.example.test".to_string(),
                port: 2222,
                username: "jump-operator".to_string(),
                auth_method: AuthMethod::Key,
                password: Some("jump-password".to_string()),
                keychain_key_id: None,
                private_key_data: Some("jump-private-key".to_string()),
                passphrase: Some("jump-passphrase".to_string()),
            }),
        }
    }

    fn valid_request() -> ReviewedSshExecutionRequest {
        let connection = connection();
        ReviewedSshExecutionRequest {
            operation_id: "execution:test-1".to_string(),
            target: FrozenTargetIdentity::from_connection("profile-1".to_string(), &connection)
                .expect("freeze target"),
            connection,
            command: ReviewedSshCommand::new(
                "printf '%s' 'target-password'".to_string(),
                "printf '%s' '<keychain://profile/password>'".to_string(),
                vec!["target-password".to_string()],
            )
            .expect("review command"),
            timeout: Duration::from_secs(30),
            output_policy: ExecutionOutputPolicy::default(),
        }
    }

    #[test]
    fn request_hard_limit_matrix_fails_closed() {
        let mut request = valid_request();
        assert!(request.validate().is_ok());

        for invalid_operation_id in [
            "".to_string(),
            "invalid operation".to_string(),
            "x".repeat(MAX_OPERATION_ID_BYTES + 1),
        ] {
            request.operation_id = invalid_operation_id;
            assert_eq!(
                request
                    .validate()
                    .expect_err("reject operation ID")
                    .category,
                ExecutionErrorCategory::InvalidRequest
            );
        }
        request = valid_request();

        for invalid_command in [
            String::new(),
            " \t".to_string(),
            "printf '\0'".replace("\\0", "\0"),
            "x".repeat(MAX_REVIEWED_COMMAND_BYTES + 1),
        ] {
            request.command.command = invalid_command;
            assert_eq!(
                request.validate().expect_err("reject command").category,
                ExecutionErrorCategory::InvalidRequest
            );
        }
        request = valid_request();

        for invalid_timeout in [
            MIN_EXECUTION_TIMEOUT - Duration::from_millis(1),
            MAX_EXECUTION_TIMEOUT + Duration::from_millis(1),
        ] {
            request.timeout = invalid_timeout;
            assert_eq!(
                request.validate().expect_err("reject timeout").category,
                ExecutionErrorCategory::InvalidRequest
            );
        }
        request = valid_request();

        for invalid_policy in [
            ExecutionOutputPolicy {
                stdout_capture_bytes: MAX_STDOUT_CAPTURE_BYTES + 1,
                ..ExecutionOutputPolicy::default()
            },
            ExecutionOutputPolicy {
                stderr_capture_bytes: MAX_STDERR_CAPTURE_BYTES + 1,
                ..ExecutionOutputPolicy::default()
            },
            ExecutionOutputPolicy {
                total_read_hard_limit_bytes: 0,
                ..ExecutionOutputPolicy::default()
            },
            ExecutionOutputPolicy {
                total_read_hard_limit_bytes: MAX_TOTAL_READ_HARD_LIMIT_BYTES + 1,
                ..ExecutionOutputPolicy::default()
            },
        ] {
            request.output_policy = invalid_policy;
            assert_eq!(
                request
                    .validate()
                    .expect_err("reject output policy")
                    .category,
                ExecutionErrorCategory::InvalidRequest
            );
        }
    }

    #[test]
    fn reviewed_command_constructor_rejects_invalid_commands() {
        for invalid_command in [
            String::new(),
            " \t".to_string(),
            "printf '\0'".replace("\\0", "\0"),
            "x".repeat(MAX_REVIEWED_COMMAND_BYTES + 1),
        ] {
            let error =
                ReviewedSshCommand::new(invalid_command, "safe preview".to_string(), Vec::new())
                    .expect_err("constructor rejects an invalid command");
            assert_eq!(error.category, ExecutionErrorCategory::InvalidRequest);
        }

        let error = ReviewedSshCommand::new(
            "printf target-password".to_string(),
            "printf target-password".to_string(),
            vec!["target-password".to_string()],
        )
        .expect_err("constructor rejects a preview containing a known secret");
        assert_eq!(error.category, ExecutionErrorCategory::InvalidRequest);

        let mut request = valid_request();
        request.command.preview = "printf target-passphrase".to_string();
        let error = request
            .validate()
            .expect_err("request rejects a preview containing a connection secret");
        assert_eq!(error.category, ExecutionErrorCategory::InvalidRequest);
    }

    #[test]
    fn request_hard_limit_boundaries_are_inclusive() {
        let mut request = valid_request();
        request.command.command = "x".repeat(MAX_REVIEWED_COMMAND_BYTES);
        request.command.preview = "x".repeat(MAX_REVIEWED_COMMAND_BYTES);
        request.timeout = MIN_EXECUTION_TIMEOUT;
        request.output_policy = ExecutionOutputPolicy::new(
            MAX_STDOUT_CAPTURE_BYTES,
            MAX_STDERR_CAPTURE_BYTES,
            MAX_TOTAL_READ_HARD_LIMIT_BYTES,
        )
        .expect("backend maxima are accepted");
        assert!(request.validate().is_ok());

        request.timeout = MAX_EXECUTION_TIMEOUT;
        assert!(request.validate().is_ok());
    }

    #[test]
    fn canonical_identity_digest_is_versioned_and_stable() {
        let target = FrozenTargetIdentity::from_connection("profile-1".to_string(), &connection())
            .expect("freeze target identity");

        assert_eq!(
            target.identity_digest,
            "sha256-v1:47f10e34825627682f78a896d68f8c2c8139f6d0d3b757301a9adf3b471c45af"
        );
        assert_eq!(target.identity_digest, target.canonical_digest());

        let mut changed_secrets = connection();
        changed_secrets.password = Some("different-target-password".to_string());
        changed_secrets.private_key_data = Some("different-target-key".to_string());
        changed_secrets.passphrase = Some("different-target-passphrase".to_string());
        changed_secrets.jump_host.as_mut().unwrap().password =
            Some("different-jump-password".to_string());
        changed_secrets.jump_host.as_mut().unwrap().private_key_data =
            Some("different-jump-key".to_string());
        changed_secrets.jump_host.as_mut().unwrap().passphrase =
            Some("different-jump-passphrase".to_string());
        let same_non_secret_identity =
            FrozenTargetIdentity::from_connection("profile-1".to_string(), &changed_secrets)
                .expect("freeze identity with changed secrets");
        assert_eq!(
            target.identity_digest,
            same_non_secret_identity.identity_digest
        );
    }

    #[test]
    fn target_and_jump_identity_drift_change_digest_and_fail_validation() {
        let baseline_connection = connection();
        let baseline =
            FrozenTargetIdentity::from_connection("profile-1".to_string(), &baseline_connection)
                .expect("freeze baseline identity");

        let mut variants = Vec::new();
        let mut changed = baseline_connection.clone();
        changed.host = "changed.example.test".to_string();
        variants.push(("target host", changed));
        let mut changed = baseline_connection.clone();
        changed.port = 2200;
        variants.push(("target port", changed));
        let mut changed = baseline_connection.clone();
        changed.username = "other-operator".to_string();
        variants.push(("target username", changed));
        let mut changed = baseline_connection.clone();
        changed.auth_method = AuthMethod::Key;
        variants.push(("target auth method", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host.as_mut().unwrap().host = "other-jump.example.test".to_string();
        variants.push(("jump host", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host.as_mut().unwrap().port = 2201;
        variants.push(("jump port", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host.as_mut().unwrap().username = "other-jump-user".to_string();
        variants.push(("jump username", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host.as_mut().unwrap().auth_method = AuthMethod::Password;
        variants.push(("jump auth method", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host = None;
        variants.push(("jump removal", changed));

        for (label, changed_connection) in variants {
            let error = baseline
                .validate_connection(&changed_connection)
                .expect_err("identity drift must fail closed");
            assert_eq!(
                error.category,
                ExecutionErrorCategory::TargetMismatch,
                "{label}"
            );

            let changed =
                FrozenTargetIdentity::from_connection("profile-1".to_string(), &changed_connection)
                    .expect("freeze changed identity");
            assert_ne!(baseline.identity_digest, changed.identity_digest, "{label}");
        }

        let changed_profile =
            FrozenTargetIdentity::from_connection("profile-2".to_string(), &baseline_connection)
                .expect("freeze changed profile identity");
        assert_ne!(baseline.identity_digest, changed_profile.identity_digest);
    }

    #[test]
    fn target_digest_tampering_has_stable_mismatch_category() {
        let mut request = valid_request();
        request.target.identity_digest = "sha256-v1:tampered".to_string();
        let error = request.validate().expect_err("reject tampered digest");
        assert_eq!(error.category, ExecutionErrorCategory::TargetMismatch);
        assert_eq!(
            error.message,
            "frozen target identity digest does not match its fields"
        );
    }

    #[test]
    fn known_secret_values_include_target_jump_and_command_secrets() {
        let request = valid_request();
        let secrets = request.known_secret_values();
        for expected in [
            "target-password",
            "target-private-key",
            "target-passphrase",
            "jump-password",
            "jump-private-key",
            "jump-passphrase",
        ] {
            assert!(secrets.iter().any(|secret| secret == expected));
        }
    }

    #[test]
    fn reviewed_command_debug_never_contains_command_or_secrets() {
        let command = ReviewedSshCommand::new(
            "printf target-password".to_string(),
            "printf <keychain://profile/password>".to_string(),
            vec!["target-password".to_string()],
        )
        .expect("review command");
        let debug = format!("{command:?}");
        assert!(!debug.contains("target-password"));
        assert!(!debug.contains("printf target-password"));
        assert!(debug.contains("redaction_value_count"));
    }
