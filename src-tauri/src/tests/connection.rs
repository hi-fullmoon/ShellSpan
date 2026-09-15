    use super::*;
    use crate::models::SessionCreateRequest;
    use ssh2::{KnownHostFileKind, KnownHostKeyFormat};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::thread;

    #[test]
    fn session_request_summary_redacts_secret_values() {
        let request = SessionCreateRequest {
            operation_id: Some("ssh-connect-test".to_string()),
            name: "demo".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("super-secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: Some("keep-me-out-of-logs".to_string()),
            terminal_cols: 120,
            terminal_rows: 32,
            jump_host: None,
            replaces_session_id: None,
        };

        let summary = summarize_session_request(&request);

        assert!(summary.contains("host=example.com"));
        assert!(summary.contains("operation_id=ssh-connect-test"));
        assert!(summary.contains("username=alice"));
        assert!(summary.contains("auth_method=password"));
        assert!(summary.contains("has_password=true"));
        assert!(summary.contains("has_passphrase=true"));
        assert!(!summary.contains("super-secret"));
        assert!(!summary.contains("keep-me-out-of-logs"));
    }

    #[test]
    fn connect_sftp_returns_shared_connection() {
        use crate::sftp_pool::SftpPool;
        fn expect_shared(
            _result: Result<
                std::sync::Arc<std::sync::Mutex<crate::models::ConnectedSftp>>,
                crate::models::RemoteFsError,
            >,
        ) {
        }
        fn dummy_call(request: &crate::models::RemoteConnectionRequest, pool: &SftpPool) {
            expect_shared(connect_sftp(request, Some(pool), None));
        }
        let _ = dummy_call;
    }

    #[test]
    fn leader_recheck_reuses_a_connection_that_won_the_initial_miss_race() {
        let connect_calls = std::cell::Cell::new(0);

        let result = reuse_raced_pool_entry_or_connect(Some("pooled"), || {
            connect_calls.set(connect_calls.get() + 1);
            Ok::<_, ()>("new")
        });

        assert_eq!(result, Ok("pooled"));
        assert_eq!(
            connect_calls.get(),
            0,
            "race winner triggered another handshake"
        );
    }

    #[test]
    fn leader_recheck_connects_once_when_the_pool_is_still_empty() {
        let connect_calls = std::cell::Cell::new(0);

        let result = reuse_raced_pool_entry_or_connect(None, || {
            connect_calls.set(connect_calls.get() + 1);
            Ok::<_, ()>("new")
        });

        assert_eq!(result, Ok("new"));
        assert_eq!(connect_calls.get(), 1);
    }

    #[test]
    fn transfer_timeout_guard_restores_the_normal_session_timeout() {
        let session = Session::new().expect("session should initialize");
        session.set_timeout(SSH_SESSION_IO_TIMEOUT_MS);

        {
            let _guard = TransferTimeoutGuard::new(&session);
            assert_eq!(session.timeout(), SSH_TRANSFER_IO_TIMEOUT_MS);
        }

        assert_eq!(session.timeout(), SSH_SESSION_IO_TIMEOUT_MS);
    }

    #[test]
    fn validate_connection_fields_blocks_metadata_endpoint() {
        assert!(validate_connection_fields("169.254.169.254", "alice").is_err());
        assert!(validate_connection_fields("metadata.google.internal", "alice").is_err());
        assert!(validate_connection_fields("0.0.0.0", "alice").is_err());
        assert!(validate_connection_fields("::", "alice").is_err());
        assert!(validate_connection_fields("fd00:ec2::254", "alice").is_err());
        assert!(validate_connection_fields("[::]:22", "alice").is_err());
        assert!(validate_connection_fields("169.254.169.254:22", "alice").is_err());
    }

    #[test]
    fn validate_connection_fields_allows_normal_hosts() {
        assert!(validate_connection_fields("example.com", "alice").is_ok());
        assert!(validate_connection_fields("192.168.1.1", "alice").is_ok());
    }

    #[test]
    fn is_blocked_host_covers_blocked_ip_ranges() {
        // Link-local ranges beyond the well-known metadata literal.
        assert!(is_blocked_host("169.254.0.1"));
        assert!(is_blocked_host("fe80::1"));
        // Unspecified addresses.
        assert!(is_blocked_host("0.0.0.0"));
        assert!(is_blocked_host("::"));
        // IPv4-mapped IPv6 spellings must not bypass the range checks.
        assert!(is_blocked_host("::ffff:169.254.169.254"));
        // Blocked ranges still match when a port is attached.
        assert!(is_blocked_host("[fe80::1]:22"));
    }

    #[test]
    fn is_blocked_host_allows_loopback() {
        // SSH to localhost is a legitimate use case (VMs, tunnels, dev).
        assert!(!is_blocked_host("127.0.0.1"));
        assert!(!is_blocked_host("::1"));
        assert!(!is_blocked_host("127.0.0.1:2222"));
        assert!(!is_blocked_host("::ffff:127.0.0.1"));
    }

    #[test]
    fn is_blocked_host_allows_public_and_private_addresses() {
        assert!(!is_blocked_host("8.8.8.8"));
        assert!(!is_blocked_host("192.168.1.1"));
        assert!(!is_blocked_host("10.0.0.5"));
        assert!(!is_blocked_host("2606:4700:4700::1111"));
        assert!(!is_blocked_host("example.com"));
    }

    #[test]
    fn format_host_for_socket_address_brackets_ipv6_literals() {
        assert_eq!(format_host_for_socket_address("::1"), "[::1]");
        assert_eq!(format_host_for_socket_address("127.0.0.1"), "127.0.0.1");
        assert_eq!(format_host_for_socket_address("example.com"), "example.com");
    }

    #[test]
    fn connect_tcp_stream_blocks_resolved_metadata_addresses() {
        let error = connect_tcp_stream("169.254.169.254", 22)
            .expect_err("metadata endpoint should be blocked before connecting");

        assert!(error.contains("blocked"));
    }

    #[test]
    fn connect_tcp_stream_enables_nodelay() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("should bind a loopback listener for the test");
        let address = listener
            .local_addr()
            .expect("listener should expose a loopback address");

        let accept_thread = thread::spawn(move || {
            let _ = listener.accept();
        });

        let stream = connect_tcp_stream("127.0.0.1", address.port())
            .expect("connect_tcp_stream should connect to the local listener");

        assert!(
            stream.nodelay().expect("querying nodelay should succeed"),
            "interactive SSH sockets should disable Nagle's algorithm",
        );

        accept_thread
            .join()
            .expect("accept thread should finish cleanly");
    }

    #[test]
    fn cancelled_preflight_marks_every_unstarted_step_blocked() {
        let request = RemoteConnectionRequest {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("unused".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let cancelled = AtomicBool::new(true);
        let result = preflight_connection(
            request,
            "connection-preflight-cancelled".to_string(),
            Path::new("unused-known-hosts"),
            &cancelled,
        );

        assert_eq!(result.status, ConnectionPreflightStatus::Cancelled);
        assert_eq!(result.steps.len(), 4);
        assert!(result
            .steps
            .iter()
            .all(|step| step.status == ConnectionPreflightStepStatus::Blocked));
    }

    #[test]
    fn preflight_recorder_never_omits_expected_steps() {
        let mut recorder = PreflightRecorder::new("connection-preflight-test".to_string(), true);
        recorder.push(
            ConnectionPreflightStepId::Dns,
            ConnectionPreflightStepStatus::Passed,
            "resolved",
            Some(("jump.example.com", 22)),
            None,
            false,
        );

        let result = recorder.finish(ConnectionPreflightStatus::Failed, "not reached");

        assert_eq!(result.steps.len(), 7);
        assert_eq!(
            result.steps[0].status,
            ConnectionPreflightStepStatus::Passed
        );
        assert!(result.steps[1..]
            .iter()
            .all(|step| step.status == ConnectionPreflightStepStatus::Blocked));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end() {
        let host =
            std::env::var("SHELLSPAN_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("SHELLSPAN_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username =
            std::env::var("SHELLSPAN_E2E_SSH_USERNAME").unwrap_or_else(|_| "shellspan".to_string());
        let password = std::env::var("SHELLSPAN_E2E_SSH_PASSWORD")
            .unwrap_or_else(|_| "shellspan-e2e".to_string());
        let temp = tempfile::tempdir().expect("create isolated known-hosts directory");
        let known_hosts_path = temp.path().join("known_hosts");
        let request = || RemoteConnectionRequest {
            host: host.clone(),
            port,
            username: username.clone(),
            auth_method: AuthMethod::Password,
            password: Some(password.clone()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };

        let unknown_preflight = preflight_connection(
            request(),
            "connection-preflight-unknown".to_string(),
            &known_hosts_path,
            &AtomicBool::new(false),
        );
        assert_eq!(
            unknown_preflight.status,
            ConnectionPreflightStatus::Attention
        );
        assert!(unknown_preflight.steps.iter().any(|step| {
            step.id == ConnectionPreflightStepId::HostKey
                && step.status == ConnectionPreflightStepStatus::Warning
                && step.trustable
        }));
        assert!(unknown_preflight.steps.iter().any(|step| {
            step.id == ConnectionPreflightStepId::Authentication
                && step.status == ConnectionPreflightStepStatus::Blocked
        }));

        let unknown = open_authenticated_session(
            connect_tcp_stream(&host, port).expect("connect to isolated SSH service"),
            &username,
            AuthMethod::Password,
            Some(&password),
            None,
            None,
            &host,
            port,
            Some(&known_hosts_path),
        );
        match unknown {
            Err(ConnectionError::HostKeyUnknown { .. }) => {}
            Err(error) => panic!("expected an unknown host key, got {error:?}"),
            Ok(_) => panic!("an untrusted host key was accepted"),
        }

        let handshake = open_session_for_host_key(&host, port).expect("read isolated host key");
        let (key, key_type) = handshake.host_key().expect("server exposes a host key");
        let key_format = match key_type {
            ssh2::HostKeyType::Rsa => KnownHostKeyFormat::SshRsa,
            ssh2::HostKeyType::Dss => KnownHostKeyFormat::SshDss,
            ssh2::HostKeyType::Ecdsa256 => KnownHostKeyFormat::Ecdsa256,
            ssh2::HostKeyType::Ecdsa384 => KnownHostKeyFormat::Ecdsa384,
            ssh2::HostKeyType::Ecdsa521 => KnownHostKeyFormat::Ecdsa521,
            ssh2::HostKeyType::Ed25519 => KnownHostKeyFormat::Ed25519,
            ssh2::HostKeyType::Unknown => KnownHostKeyFormat::Unknown,
        };
        let host_with_port = if port == 22 {
            host.clone()
        } else {
            format!("[{host}]:{port}")
        };
        let mut known_hosts = handshake.known_hosts().expect("initialize known hosts");
        known_hosts
            .add(&host_with_port, key, &host_with_port, key_format)
            .expect("trust isolated host key");
        known_hosts
            .write_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
            .expect("persist isolated known host");

        let trusted_preflight = preflight_connection(
            request(),
            "connection-preflight-trusted".to_string(),
            &known_hosts_path,
            &AtomicBool::new(false),
        );
        assert_eq!(trusted_preflight.status, ConnectionPreflightStatus::Passed);
        assert!(trusted_preflight.steps.iter().all(|step| !step.trustable));

        let session = open_authenticated_session(
            connect_tcp_stream(&host, port).expect("reconnect to isolated SSH service"),
            &username,
            AuthMethod::Password,
            Some(&password),
            None,
            None,
            &host,
            port,
            Some(&known_hosts_path),
        )
        .expect("authenticate after trusting host key");

        let mismatch_path = temp.path().join("mismatched-known-hosts");
        let mut mismatched_key = key.to_vec();
        let last = mismatched_key
            .last_mut()
            .expect("isolated SSH host key is not empty");
        *last ^= 0x01;
        let mut mismatched_hosts = handshake
            .known_hosts()
            .expect("initialize mismatched known hosts");
        mismatched_hosts
            .add(
                &host_with_port,
                &mismatched_key,
                &host_with_port,
                key_format,
            )
            .expect("record a changed host key fixture");
        mismatched_hosts
            .write_file(&mismatch_path, KnownHostFileKind::OpenSSH)
            .expect("persist changed host key fixture");
        let mismatch = open_authenticated_session(
            connect_tcp_stream(&host, port).expect("reconnect for changed host-key check"),
            &username,
            AuthMethod::Password,
            Some(&password),
            None,
            None,
            &host,
            port,
            Some(&mismatch_path),
        );
        match mismatch {
            Err(ConnectionError::HostKeyMismatch { .. }) => {}
            Err(error) => panic!("expected a changed host key, got {error:?}"),
            Ok(_) => panic!("a changed host key was accepted"),
        }

        let mut channel = session.channel_session().expect("open terminal channel");
        channel
            .request_pty("xterm", None, None)
            .expect("request terminal PTY");
        channel.shell().expect("start remote shell");
        channel
            .write_all(b"printf 'shellspan-terminal-ok\\n'\nexit\n")
            .expect("write terminal input");
        let mut terminal_output = String::new();
        channel
            .read_to_string(&mut terminal_output)
            .expect("read terminal output");
        channel.wait_close().expect("close terminal channel");
        assert!(terminal_output.contains("shellspan-terminal-ok"));

        let sftp = session.sftp().expect("open SFTP subsystem");
        let remote_path = Path::new("/home/shellspan/upload/shellspan-e2e.txt");
        let mut remote = sftp.create(remote_path).expect("create remote upload");
        remote
            .write_all(b"shellspan-sftp-ok")
            .expect("upload remote content");
        drop(remote);
        let mut downloaded = String::new();
        sftp.open(remote_path)
            .expect("open uploaded file")
            .read_to_string(&mut downloaded)
            .expect("download uploaded file");
        assert_eq!(downloaded, "shellspan-sftp-ok");
        sftp.unlink(remote_path).expect("clean up remote fixture");
    }
