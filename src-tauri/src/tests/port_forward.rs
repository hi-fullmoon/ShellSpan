    use super::*;

    fn request(operation_id: &str, config_id: &str) -> PortForwardStartRequest {
        PortForwardStartRequest {
            operation_id: operation_id.to_string(),
            profile_id: "profile-1".to_string(),
            mode: PortForwardStartMode::Manual,
            connection: RemoteConnectionRequest {
                host: "example.test".to_string(),
                port: 22,
                username: "operator".to_string(),
                auth_method: AuthMethod::Password,
                password: Some("secret".to_string()),
                keychain_key_id: None,
                private_key_data: None,
                passphrase: None,
                jump_host: None,
            },
            forward: PortForwardConfig {
                id: config_id.to_string(),
                name: "Database".to_string(),
                kind: PortForwardKind::Local,
                local_port: 15432,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 5432,
            },
        }
    }

    #[test]
    fn manager_rejects_duplicate_active_profile_rule_and_cancels_all() {
        let manager = PortForwardManager::default();
        manager.register(&request("op-1", "rule-1")).unwrap();
        let error = manager.register(&request("op-2", "rule-1")).unwrap_err();
        assert!(error.contains("already active"));
        assert_eq!(manager.active_count(), 1);

        let changed = manager.cancel_all().unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].status, PortForwardStatus::Stopping);
    }

    #[test]
    fn local_listener_surfaces_port_conflict_before_worker_start() {
        let first = bind_local_listener(&PortForwardConfig {
            local_port: 0,
            ..request("op-1", "rule-1").forward
        })
        .unwrap();
        let port = first.local_addr().unwrap().port();
        let error = bind_local_listener(&PortForwardConfig {
            local_port: port,
            ..request("op-2", "rule-2").forward
        })
        .unwrap_err();
        assert!(error.contains("already in use or unavailable"));
    }

    #[test]
    fn counted_copy_records_bytes_without_payload_history() {
        let mut input = &b"traffic-content-is-not-retained"[..];
        let mut output = Vec::new();
        let counter = AtomicU64::new(0);
        copy_counted(&mut input, &mut output, &counter).unwrap();
        assert_eq!(output, b"traffic-content-is-not-retained");
        assert_eq!(counter.load(Ordering::Relaxed), output.len() as u64);
    }

    #[test]
    fn remote_forward_rejects_non_loopback_binding() {
        let mut input = request("op-1", "rule-1");
        input.forward.kind = PortForwardKind::Remote;
        input.forward.remote_host = "0.0.0.0".to_string();
        assert!(validate_start_request(&input)
            .unwrap_err()
            .contains("loopback"));
    }

    #[test]
    fn scoped_loopback_pair_is_preconnected_and_bidirectional() {
        let (mut client, mut bridge) =
            connected_loopback_pair(std::time::Instant::now() + Duration::from_secs(1)).unwrap();
        client.write_all(b"request").unwrap();
        let mut request = [0_u8; 7];
        bridge.read_exact(&mut request).unwrap();
        assert_eq!(&request, b"request");
        bridge.write_all(b"response").unwrap();
        let mut response = [0_u8; 8];
        client.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"response");
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_port_forward() {
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
        let connection = RemoteConnectionRequest {
            host,
            port,
            username,
            auth_method: AuthMethod::Password,
            password: Some(password),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let (_known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind forward listener");
        listener
            .set_nonblocking(true)
            .expect("configure forward listener");
        let local_port = listener.local_addr().expect("read listener port").port();
        let cancel = Arc::new(AtomicBool::new(false));
        let sent = Arc::new(AtomicU64::new(0));
        let received = Arc::new(AtomicU64::new(0));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let worker_cancel = cancel.clone();
        let worker_sent = sent.clone();
        let worker_received = received.clone();
        let worker_known_hosts_path = known_hosts_path.clone();
        let worker = thread::spawn(move || {
            local_forward_loop(
                &connection,
                listener,
                "127.0.0.1",
                18080,
                worker_cancel,
                worker_sent,
                worker_received,
                &worker_known_hosts_path,
                || ready_tx.send(()).expect("report ready"),
                || {},
                |_| {},
            )
        });

        ready_rx
            .recv_timeout(Duration::from_secs(15))
            .expect("forward becomes ready");
        let mut client =
            TcpStream::connect(("127.0.0.1", local_port)).expect("connect through local forward");
        client
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("set forward read timeout");
        let mut banner = Vec::new();
        let mut chunk = [0_u8; 32];
        while !banner.contains(&b'\n') && banner.len() < 256 {
            let count = client
                .read(&mut chunk)
                .expect("read SSH banner through forward");
            assert!(
                count > 0,
                "forwarded SSH connection closed before its banner"
            );
            banner.extend_from_slice(&chunk[..count]);
        }
        let banner_text = String::from_utf8_lossy(&banner);
        assert_eq!(banner_text, "shellspan-forward-ok\n");
        let count = banner.len();
        drop(client);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while received.load(Ordering::Relaxed) == 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(received.load(Ordering::Relaxed) >= count as u64);
        assert_eq!(sent.load(Ordering::Relaxed), 0);

        cancel.store(true, Ordering::SeqCst);
        worker
            .join()
            .expect("join local forward worker")
            .expect("stop local forward cleanly");
        TcpListener::bind(("127.0.0.1", local_port))
            .expect("stopped forward releases its listener immediately");
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_remote_port_forward() {
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
        let connection = RemoteConnectionRequest {
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
        let (_known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);

        let local_service = TcpListener::bind("127.0.0.1:0").expect("bind local target service");
        let local_port = local_service
            .local_addr()
            .expect("read local target port")
            .port();
        let service = thread::spawn(move || {
            let (mut stream, _) = local_service.accept().expect("accept forwarded request");
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .expect("set target read timeout");
            let mut request = [0_u8; 128];
            let count = stream.read(&mut request).expect("read forwarded request");
            assert_eq!(&request[..count], b"remote-forward-request");
            stream
                .write_all(b"remote-forward-response")
                .expect("write forwarded response");
        });

        const REMOTE_PORT: u16 = 23000;
        let cancel = Arc::new(AtomicBool::new(false));
        let sent = Arc::new(AtomicU64::new(0));
        let received = Arc::new(AtomicU64::new(0));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let worker_cancel = cancel.clone();
        let worker_sent = sent.clone();
        let worker_received = received.clone();
        let worker_known_hosts_path = known_hosts_path.clone();
        let worker = thread::spawn(move || {
            remote_forward_loop(
                &connection,
                local_port,
                "127.0.0.1",
                REMOTE_PORT,
                worker_cancel,
                worker_sent,
                worker_received,
                &worker_known_hosts_path,
                || ready_tx.send(()).expect("report remote forward ready"),
                || {},
                |_| {},
            )
        });
        if let Err(ready_error) = ready_rx.recv_timeout(Duration::from_secs(15)) {
            let worker_result = worker.join().expect("join failed remote forward worker");
            panic!("remote forward did not become ready ({ready_error:?}): {worker_result:?}");
        }

        let session = open_forward_session(
            &host,
            port,
            &username,
            AuthMethod::Password,
            Some(&password),
            None,
            None,
            None,
            &known_hosts_path,
        )
        .expect("connect test client to isolated SSH service");
        let mut command = session
            .target
            .channel_session()
            .expect("open remote test command");
        crate::execution::start_ssh_exec_channel(
            &mut command,
            &format!("printf 'remote-forward-request' | nc 127.0.0.1 {REMOTE_PORT}"),
        )
        .expect("connect to remote forwarded listener");
        let mut response = String::new();
        command
            .read_to_string(&mut response)
            .expect("read remote forward response");
        command.wait_close().expect("close remote test command");
        assert_eq!(response, "remote-forward-response");
        service.join().expect("join local target service");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while (sent.load(Ordering::Relaxed) == 0 || received.load(Ordering::Relaxed) == 0)
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(sent.load(Ordering::Relaxed) >= b"remote-forward-response".len() as u64);
        assert!(received.load(Ordering::Relaxed) >= b"remote-forward-request".len() as u64);

        cancel.store(true, Ordering::SeqCst);
        worker
            .join()
            .expect("join remote forward worker")
            .expect("stop remote forward cleanly");

        let verification = open_forward_session(
            &host,
            port,
            &username,
            AuthMethod::Password,
            Some(&password),
            None,
            None,
            None,
            &known_hosts_path,
        )
        .expect("open remote listener verification session");
        let listener = verification
            .target
            .channel_forward_listen(REMOTE_PORT, Some("127.0.0.1"), None)
            .expect("stopped remote forward releases its listener immediately");
        drop(listener);
    }
