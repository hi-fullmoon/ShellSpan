    use super::*;

    #[test]
    fn session_wake_pair_passes_wakeups_and_drains_without_blocking() {
        let (waker, source) = session_wake_pair().expect("wake pair should be creatable");

        source.drain();

        waker.wake();
        waker.wake();
        // Give the loopback byte a moment to arrive, then drain must consume
        // it and return immediately instead of blocking.
        thread::sleep(Duration::from_millis(50));
        source.drain();
    }

    #[test]
    fn ssh_broker_attachment_failure_closes_channel_and_is_visible() {
        let closed = AtomicBool::new(false);
        let result: Result<(), ConnectionError> = with_failure_cleanup(
            &mut (),
            |_| {
                Err(ConnectionError::Other {
                    message: "TERMINAL_BROKER_PREDECESSOR_NOT_FOUND".into(),
                })
            },
            |_| closed.store(true, AtomicOrdering::Relaxed),
        );

        assert!(closed.load(AtomicOrdering::Relaxed));
        assert!(matches!(
            result,
            Err(ConnectionError::Other { message })
                if message == "TERMINAL_BROKER_PREDECESSOR_NOT_FOUND"
        ));
    }

    #[test]
    fn ssh_success_signal_follows_status_and_connection_publication() {
        let events = std::cell::RefCell::new(Vec::new());
        publish_ssh_connection_ready(
            || {
                events.borrow_mut().push("status");
                Ok(())
            },
            || events.borrow_mut().push("connected"),
            || {
                events.borrow_mut().push("signal");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*events.borrow(), ["status", "connected", "signal"]);
    }

    #[test]
    fn ssh_status_publication_failure_suppresses_success_signal() {
        let signalled = AtomicBool::new(false);
        assert_eq!(
            publish_ssh_connection_ready(
                || Err("status publication failed".into()),
                || panic!("connection notification must follow status publication"),
                || {
                    signalled.store(true, AtomicOrdering::Relaxed);
                    Ok(())
                },
            )
            .unwrap_err(),
            "status publication failed"
        );
        assert!(!signalled.load(AtomicOrdering::Relaxed));
    }

    #[test]
    fn normalize_keepalive_delay_clamps_zero_to_one_second() {
        assert_eq!(normalize_keepalive_delay(0), Duration::from_secs(1));
        assert_eq!(normalize_keepalive_delay(7), Duration::from_secs(7));
    }

    #[test]
    fn startup_output_waits_for_the_frontend_before_release() {
        assert!(!should_release_startup_output(
            false,
            Duration::from_secs(1),
            SSH_OUTPUT_FLUSH_THRESHOLD_BYTES,
        ));
        assert!(should_release_startup_output(
            true,
            Duration::from_secs(1),
            SSH_OUTPUT_FLUSH_THRESHOLD_BYTES,
        ));
    }

    #[test]
    fn startup_output_gate_has_timeout_and_memory_safety_valves() {
        assert!(should_release_startup_output(
            false,
            SSH_OUTPUT_READY_TIMEOUT + Duration::from_millis(1),
            0,
        ));
        assert!(should_release_startup_output(
            false,
            Duration::ZERO,
            SSH_STARTUP_OUTPUT_BUFFER_LIMIT_BYTES + 1,
        ));
    }

    #[test]
    fn transport_error_classifies_drain_incoming_flow_as_disconnect() {
        let message = format_transport_error(
            "failed to write remote input",
            "Failure while draining incoming flow",
        );

        assert!(message.contains("ssh transport disconnected"));
    }

    #[test]
    fn closed_reason_marks_transport_disconnect_as_retryable() {
        let (reason_kind, retryable) = classify_closed_reason(
            Some("failed to read remote output: ssh transport disconnected"),
            SessionStatus::Error,
        );

        assert_eq!(reason_kind, ClosedReasonKind::TransportDisconnect);
        assert!(retryable);
    }

    #[test]
    fn closed_reason_keeps_remote_exit_non_retryable() {
        let (reason_kind, retryable) =
            classify_closed_reason(Some("remote shell exited"), SessionStatus::Disconnected);

        assert_eq!(reason_kind, ClosedReasonKind::RemoteExit);
        assert!(!retryable);
    }

    #[test]
    fn coalesce_session_commands_merges_adjacent_write_chunks() {
        let commands = vec![
            SessionCommand::Write("a".to_string()),
            SessionCommand::Write("bc".to_string()),
            SessionCommand::Write("123".to_string()),
        ];

        let merged = coalesce_session_commands(commands);

        assert_eq!(merged.len(), 1);
        match &merged[0] {
            SessionCommand::Write(data) => assert_eq!(data, "abc123"),
            _ => panic!("expected a single merged write command"),
        }
    }

    #[test]
    fn coalesce_session_commands_preserves_binary_write_boundaries() {
        let commands = vec![
            SessionCommand::Write("before".to_string()),
            SessionCommand::WriteBytes(vec![0x1b, 0x80, 0xff]),
            SessionCommand::Write("after".to_string()),
        ];

        let merged = coalesce_session_commands(commands);

        assert_eq!(merged.len(), 3);
        assert!(matches!(&merged[0], SessionCommand::Write(data) if data == "before"));
        assert!(matches!(
            &merged[1],
            SessionCommand::WriteBytes(bytes) if bytes == &[0x1b, 0x80, 0xff]
        ));
        assert!(matches!(&merged[2], SessionCommand::Write(data) if data == "after"));
    }

    #[test]
    fn coalesce_session_commands_keeps_only_the_last_adjacent_resize() {
        let commands = vec![
            SessionCommand::Resize { cols: 80, rows: 24 },
            SessionCommand::Resize {
                cols: 100,
                rows: 30,
            },
            SessionCommand::Resize {
                cols: 120,
                rows: 40,
            },
        ];

        let merged = coalesce_session_commands(commands);

        assert_eq!(merged.len(), 1);
        match &merged[0] {
            SessionCommand::Resize { cols, rows } => {
                assert_eq!((cols, rows), (&120, &40));
            }
            _ => panic!("expected a single merged resize command"),
        }
    }

    #[test]
    fn coalesce_session_commands_preserves_resize_write_resize_boundaries() {
        let commands = vec![
            SessionCommand::Write("ab".to_string()),
            SessionCommand::Resize { cols: 80, rows: 24 },
            SessionCommand::Resize {
                cols: 120,
                rows: 40,
            },
            SessionCommand::Write("cd".to_string()),
            SessionCommand::Close,
            SessionCommand::Write("ef".to_string()),
        ];

        let merged = coalesce_session_commands(commands);

        assert_eq!(merged.len(), 5);
        match &merged[0] {
            SessionCommand::Write(data) => assert_eq!(data, "ab"),
            _ => panic!("first command should stay write"),
        }
        match &merged[1] {
            SessionCommand::Resize { cols, rows } => {
                assert_eq!((cols, rows), (&120, &40));
            }
            _ => panic!("adjacent resizes should merge into the latest size"),
        }
        match &merged[2] {
            SessionCommand::Write(data) => assert_eq!(data, "cd"),
            _ => panic!("third command should stay write"),
        }
        match &merged[3] {
            SessionCommand::Close => {}
            _ => panic!("fourth command should stay close"),
        }
        match &merged[4] {
            SessionCommand::Write(data) => assert_eq!(data, "ef"),
            _ => panic!("fifth command should stay write"),
        }
    }

    #[test]
    fn retryable_channel_error_kind_includes_wouldblock_and_interrupted() {
        assert!(is_retryable_channel_error_kind(ErrorKind::WouldBlock));
        assert!(is_retryable_channel_error_kind(ErrorKind::Interrupted));
    }

    #[test]
    fn retryable_channel_error_kind_rejects_fatal_kinds() {
        assert!(!is_retryable_channel_error_kind(ErrorKind::ConnectionReset));
        assert!(!is_retryable_channel_error_kind(ErrorKind::BrokenPipe));
    }

    #[test]
    fn remote_login_identity_preserves_home_and_shell_from_passwd() {
        let identity = parse_remote_login_shell_identity(
            "root:x:0:0:root:/root:/bin/sh\nfixture:x:1000:1000::/srv/fixture home:/usr/bin/bash\n",
            "fixture",
        )
        .unwrap();

        assert_eq!(identity.shell, TerminalShellKind::Bash);
        assert_eq!(identity.executable, "/usr/bin/bash");
        assert_eq!(identity.home_directory, "/srv/fixture home");
    }

    #[test]
    fn remote_login_identity_rejects_missing_or_incomplete_accounts() {
        for (contents, username) in [
            ("fixture:x:1000:1000::/home/fixture\n", "fixture"),
            ("other:x:1000:1000::/home/other:/bin/bash\n", "fixture"),
        ] {
            assert!(parse_remote_login_shell_identity(contents, username).is_err());
        }
    }

    #[test]
    fn integrated_remote_shell_commands_preserve_login_and_interactive_flags() {
        assert_eq!(
            remote_integrated_shell_command(
                TerminalShellKind::Bash,
                "/bin/bash",
                "/tmp/.shellspan-terminal-integration-fixture",
            )
            .unwrap(),
            "exec env HOME='/tmp/.shellspan-terminal-integration-fixture' '/bin/bash' -il"
        );
        assert_eq!(
            remote_integrated_shell_command(
                TerminalShellKind::Zsh,
                "/bin/zsh",
                "/tmp/.shellspan-terminal-integration-fixture",
            )
            .unwrap(),
            "exec env ZDOTDIR='/tmp/.shellspan-terminal-integration-fixture' '/bin/zsh' -il"
        );
        assert!(remote_integrated_shell_command(
            TerminalShellKind::Unsupported,
            "/bin/sh",
            "/tmp/.shellspan-terminal-integration-fixture",
        )
        .is_err());
    }

    struct RemoteFixtureTerminal {
        _known_hosts: tempfile::TempDir,
        session: Session,
        shell_channel: Channel,
        integration: Option<RemoteSshShellIntegration>,
        broker: crate::terminal_broker::TerminalSessionBroker,
        transport_id: String,
        integration_id: String,
        agent_session_id: String,
        display: Vec<u8>,
    }

    impl RemoteFixtureTerminal {
        fn connect(
            username: &str,
            transport_id: &str,
            predecessor: Option<&str>,
            broker: crate::terminal_broker::TerminalSessionBroker,
        ) -> Self {
            use crate::terminal_broker::TerminalGeometry;

            let mut connection = crate::execution::fixture::isolated_ssh_connection();
            connection.username = username.to_string();
            let (known_hosts, known_hosts_path) =
                crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
            let session = crate::connection::open_authenticated_session(
                crate::connection::connect_tcp_stream(&connection.host, connection.port)
                    .expect("connect to isolated SSH fixture"),
                &connection.username,
                connection.auth_method,
                connection.password.as_deref(),
                connection.private_key_data.as_deref(),
                connection.passphrase.as_deref(),
                &connection.host,
                connection.port,
                Some(&known_hosts_path),
            )
            .expect("authenticate to isolated SSH fixture");
            let integration = RemoteSshShellIntegration::prepare(&session, username)
                .expect("prepare remote integration before interactive-shell startup");
            let integration_id = integration.integration_id.clone();
            let mut shell_channel = session.channel_session().expect("open SSH PTY channel");
            shell_channel
                .request_pty("xterm-256color", None, Some((100, 30, 0, 0)))
                .expect("request SSH PTY");
            shell_channel
                .handle_extended_data(ExtendedData::Merge)
                .expect("merge SSH PTY stderr");
            integration
                .start_shell(&mut shell_channel)
                .expect("start integrated interactive SSH shell");
            broker
                .attach_transport(
                    transport_id,
                    predecessor,
                    crate::terminal_broker::TerminalTransportKind::SshPty,
                    TerminalGeometry::new(100, 30),
                )
                .expect("attach ordinary SSH PTY");
            broker
                .mark_output_ready(transport_id)
                .expect("mark fixture display ready");
            broker
                .register_integration_channel(transport_id, &integration_id, integration.shell)
                .expect("register isolated remote control channel");
            session.set_blocking(false);
            let mut fixture = Self {
                _known_hosts: known_hosts,
                session,
                shell_channel,
                integration: Some(integration),
                broker,
                transport_id: transport_id.into(),
                integration_id,
                agent_session_id: "fixture-agent-session".into(),
                display: Vec::new(),
            };
            fixture.pump_until(Duration::from_secs(8), |snapshot| {
                snapshot.integration_state
                    == crate::terminal_broker::TerminalIntegrationState::Ready
                    && snapshot.prompt_ready
            });
            fixture
        }

        fn connect_user_owned(
            username: &str,
            transport_id: &str,
            broker: crate::terminal_broker::TerminalSessionBroker,
        ) -> Self {
            Self::connect(username, transport_id, None, broker)
        }

        fn pump_once(&mut self) -> bool {
            let mut progress = false;
            let mut output = [0_u8; 8192];
            loop {
                match self.shell_channel.read(&mut output) {
                    Ok(0) => break,
                    Ok(read) => {
                        progress = true;
                        self.display.extend_from_slice(&output[..read]);
                        self.broker
                            .observe_raw_output(&self.transport_id, &output[..read])
                            .expect("broker accepts exact SSH PTY bytes");
                    }
                    Err(error) if is_retryable_channel_error_kind(error.kind()) => break,
                    Err(error) => panic!("SSH PTY output failed: {error}"),
                }
            }
            if let Some(integration) = self.integration.as_mut() {
                let mut control = [0_u8; 8192];
                loop {
                    match integration.control.read(&mut control) {
                        Ok(0) => break,
                        Ok(read) => {
                            progress = true;
                            for event in integration
                                .decoder
                                .push(&control[..read])
                                .expect("decode isolated SSH control bytes")
                            {
                                if let Err(error) = self.broker.accept_integration_event(
                                    &self.transport_id,
                                    &self.integration_id,
                                    event.clone(),
                                ) {
                                    panic!(
                                        "accept generation-bound remote lifecycle event {event:?}: {error}; snapshot={:?}",
                                        self.broker.snapshot(Some(&self.transport_id)).unwrap().session
                                    );
                                }
                            }
                        }
                        Err(error) if is_retryable_channel_error_kind(error.kind()) => break,
                        Err(error) => panic!("SSH control channel failed: {error}"),
                    }
                }
            }
            progress
        }

        fn pump_until(
            &mut self,
            timeout: Duration,
            ready: impl Fn(&crate::terminal_broker::TerminalBrokerSessionSnapshot) -> bool,
        ) {
            let deadline = Instant::now() + timeout;
            loop {
                self.pump_once();
                let snapshot = self
                    .broker
                    .snapshot(Some(&self.transport_id))
                    .expect("snapshot remote fixture")
                    .session
                    .expect("remote fixture stays attached");
                if ready(&snapshot) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "remote fixture condition timed out: {snapshot:?}"
                );
                thread::sleep(Duration::from_millis(5));
            }
        }

        fn begin(
            &mut self,
            operation_id: &str,
            command: &str,
        ) -> Arc<crate::terminal_broker::TerminalCommandOperation> {
            use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};

            self.broker
                .acquire_agent_lease(
                    &self.transport_id,
                    &self.agent_session_id,
                    "fixture-task",
                    operation_id,
                )
                .expect("acquire remote Agent lease")
                .expect("broker enabled");
            let operation =
                self.broker
                    .begin_command(&self.transport_id, operation_id, command)
                    .unwrap_or_else(|error| {
                        panic!(
                        "register remote command {command:?} before input: {error}; snapshot={:?}",
                        self.broker.snapshot(Some(&self.transport_id)).unwrap().session
                    )
                    });
            let input = format!("{command}\n");
            let broker = self.broker.clone();
            let transport_id = self.transport_id.clone();
            let shell_channel = &mut self.shell_channel;
            broker
                .admit_terminal_input(
                    &transport_id,
                    TerminalBrokerInputSource::Agent {
                        agent_session_id: self.agent_session_id.clone(),
                        task_id: "fixture-task".into(),
                        operation_id: operation_id.into(),
                    },
                    TerminalInputKind::Text,
                    input.as_bytes(),
                    || write_all_nonblocking(&self.session, shell_channel, input.as_bytes()),
                )
                .expect("write exact remote command through broker input admission");
            operation
        }

        fn execute(
            &mut self,
            operation_id: &str,
            command: &str,
        ) -> crate::terminal_broker::TerminalCommandSnapshot {
            let operation = self.begin(operation_id, command);
            self.pump_until(Duration::from_secs(8), |_| {
                operation
                    .snapshot()
                    .expect("snapshot operation")
                    .state
                    .is_terminal()
            });
            let drain_deadline = Instant::now() + Duration::from_millis(50);
            while Instant::now() < drain_deadline {
                self.pump_once();
                thread::sleep(Duration::from_millis(2));
            }
            let snapshot = operation.snapshot().expect("snapshot completed command");
            self.broker
                .retire_command(&self.transport_id, &snapshot.command_id)
                .expect("retire remote command");
            self.broker
                .release_agent_lease(
                    &self.transport_id,
                    &self.agent_session_id,
                    "fixture-task",
                    operation_id,
                )
                .expect("release remote Agent lease");
            snapshot
        }

        fn execute_user_command(&mut self, command: &str) -> String {
            let display_start = self.display.len();
            let event_sequence = self
                .broker
                .snapshot(Some(&self.transport_id))
                .unwrap()
                .session
                .unwrap()
                .integration_event_sequence;
            let input = format!("{command}\n");
            write_all_nonblocking(&self.session, &mut self.shell_channel, input.as_bytes())
                .expect("write user command to ordinary SSH PTY");
            self.pump_until(Duration::from_secs(8), |snapshot| {
                snapshot.prompt_ready && snapshot.integration_event_sequence > event_sequence
            });
            let drain_deadline = Instant::now() + Duration::from_millis(50);
            while Instant::now() < drain_deadline {
                self.pump_once();
                thread::sleep(Duration::from_millis(2));
            }
            String::from_utf8_lossy(&self.display[display_start..]).into_owned()
        }

        fn interrupt(
            &mut self,
            operation: &Arc<crate::terminal_broker::TerminalCommandOperation>,
            requested: crate::terminal_broker::TerminalCommandRequestedSettlement,
        ) -> crate::terminal_broker::TerminalCommandSnapshot {
            use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};

            let operation_id = operation.snapshot().unwrap().operation_id;
            self.pump_until(Duration::from_secs(5), |_| {
                operation.snapshot().unwrap().state
                    == crate::terminal_broker::TerminalCommandState::Running
            });
            operation.request_settlement(requested).unwrap();
            let broker = self.broker.clone();
            let transport_id = self.transport_id.clone();
            let shell_channel = &mut self.shell_channel;
            broker
                .admit_terminal_input(
                    &transport_id,
                    TerminalBrokerInputSource::System {
                        operation_id: operation_id.clone(),
                    },
                    TerminalInputKind::Interrupt,
                    b"\x03",
                    || write_all_nonblocking(&self.session, shell_channel, b"\x03"),
                )
                .unwrap();
            self.pump_until(Duration::from_secs(5), |_| {
                operation.snapshot().unwrap().state.is_terminal()
            });
            operation.snapshot().unwrap()
        }

        fn close_transport(&mut self) {
            self.session.set_blocking(true);
            self.session
                .disconnect(None, "forced Phase 4 fixture disconnect", None)
                .expect("force the isolated SSH transport to disconnect");
            self.broker
                .close_transport(
                    &self.transport_id,
                    crate::terminal_broker::TerminalGenerationCloseReason::TransportDisconnected,
                )
                .unwrap();
        }
    }

    impl Drop for RemoteFixtureTerminal {
        fn drop(&mut self) {
            if let Some(integration) = self.integration.take() {
                integration.close(&self.session);
            }
            let _ = self.shell_channel.send_eof();
            let _ = self.shell_channel.close();
        }
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn ordinary_ssh_bash_prepares_integration_with_compatible_startup() {
        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(4096);
        let mut terminal =
            RemoteFixtureTerminal::connect_user_owned("shellspan", "fixture-user-bash", broker);
        let snapshot = terminal
            .broker
            .snapshot(Some("fixture-user-bash"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            snapshot.integration_state,
            crate::terminal_broker::TerminalIntegrationState::Ready
        );
        assert!(snapshot.prompt_ready);
        let startup_display = String::from_utf8_lossy(&terminal.display);
        assert_eq!(
            startup_display
                .matches("shellspan-bash-login-marker")
                .count(),
            1
        );

        let compatibility = terminal.execute_user_command(
            r#"printf '__bash_compat__%s|%s|%s|%s|%s|%s|%s|%s__' "$HOME" "$TERM" "$(stty size)" "$-" "$LANG" "$SHELLSPAN_BASH_PROFILE_COUNT" "$SHELLSPAN_BASH_RC_COUNT" "$SHELLSPAN_BASH_PROFILE_ORDER"; shopt -q login_shell && printf '__bash_login__'; shellspan_fixture_alias; shellspan_fixture_function"#,
        );
        assert!(compatibility.contains(
            "__bash_compat__/home/shellspan|xterm-256color|30 100|himBHs|C.UTF-8|1|1|:bash_profile:bashrc__"
        ), "unexpected Bash compatibility output: {compatibility:?}");
        assert!(compatibility.contains("__bash_login__"));
        assert!(compatibility.contains("bash-alias-readybash-function-ready"));

        let history = terminal.execute_user_command("builtin history | tail -n 8");
        assert!(history.contains("shellspan-bash-history-ready"));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn ordinary_ssh_zsh_prepares_integration_with_compatible_startup() {
        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(4096);
        let mut terminal =
            RemoteFixtureTerminal::connect_user_owned("shellspan-zsh", "fixture-user-zsh", broker);
        let snapshot = terminal
            .broker
            .snapshot(Some("fixture-user-zsh"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            snapshot.integration_state,
            crate::terminal_broker::TerminalIntegrationState::Ready
        );
        assert!(snapshot.prompt_ready);
        let startup_display = String::from_utf8_lossy(&terminal.display);
        assert_eq!(
            startup_display
                .matches("shellspan-zsh-login-marker")
                .count(),
            1
        );

        let compatibility = terminal.execute_user_command(
            r#"printf '__zsh_compat__%s|%s|%s|%s|%s|%s|%s|%s|%s__' "$HOME" "$TERM" "$(stty size)" "$options[interactive]" "$options[login]" "$LANG" "$SHELLSPAN_ZSHENV_COUNT" "$SHELLSPAN_ZPROFILE_COUNT:$SHELLSPAN_ZSHRC_COUNT:$SHELLSPAN_ZLOGIN_COUNT" "$SHELLSPAN_ZSH_PROFILE_ORDER"; shellspan_fixture_alias; shellspan_fixture_function; [[ -z ${ZDOTDIR+x} ]] && printf '__zdotdir_unset__'"#,
        );
        assert!(compatibility.contains(
            "__zsh_compat__/home/shellspan-zsh|xterm-256color|30 100|on|on|C.UTF-8|1|1:1:1|:zshenv:zprofile:zshrc:zlogin__"
        ), "unexpected Zsh compatibility output: {compatibility:?}");
        assert!(compatibility.contains("zsh-alias-readyzsh-function-ready"));
        assert!(compatibility.contains("__zdotdir_unset__"));

        let history = terminal.execute_user_command("fc -l -8");
        assert!(history.contains("shellspan-zsh-history-ready"));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_control_failure_cleans_files_without_blocking_the_user_shell() {
        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(4096);
        let mut terminal = RemoteFixtureTerminal::connect_user_owned(
            "shellspan",
            "fixture-control-failure",
            broker,
        );
        let remote_root = terminal
            .integration
            .as_ref()
            .expect("remote integration is active")
            .remote_root
            .clone();
        let integration_id = terminal.integration_id.clone();
        terminal
            .integration
            .as_mut()
            .unwrap()
            .disable_after_control_failure(&terminal.session);
        terminal
            .broker
            .integration_channel_closed(
                &terminal.transport_id,
                &integration_id,
                "remoteControlChannelFailed",
            )
            .unwrap();
        terminal.session.set_blocking(true);
        let resources_removed = terminal
            .session
            .sftp()
            .unwrap()
            .stat(Path::new(&remote_root))
            .is_err();
        terminal.session.set_blocking(false);
        assert!(resources_removed);

        write_all_nonblocking(
            &terminal.session,
            &mut terminal.shell_channel,
            b"printf 'control-%s' fallback-alive\n",
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && !String::from_utf8_lossy(&terminal.display).contains("control-fallback-alive")
        {
            terminal.pump_once();
            thread::sleep(Duration::from_millis(5));
        }
        assert!(String::from_utf8_lossy(&terminal.display).contains("control-fallback-alive"));
        let snapshot = terminal
            .broker
            .snapshot(Some(&terminal.transport_id))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            snapshot.integration_state,
            crate::terminal_broker::TerminalIntegrationState::Degraded
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_bound_terminal_bash_reuses_source_shell_acceptance() {
        use crate::terminal_broker::{
            TerminalCommandRequestedSettlement, TerminalCommandState, TerminalGeometry,
            TerminalVisibleCommandRoute,
        };

        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(4096);
        let mut terminal =
            RemoteFixtureTerminal::connect("shellspan", "fixture-user-ssh-1", None, broker.clone());
        let initial_snapshot = broker
            .snapshot(Some("fixture-user-ssh-1"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            broker
                .remote_visible_command_route("fixture-user-ssh-1")
                .unwrap(),
            TerminalVisibleCommandRoute::TerminalExecute
        );

        let user_setup = terminal.execute_user_command(
            "export SHELLSPAN_USER_ONLY=user-shell-preserved; alias ss_user_alias='printf user-alias-preserved'; cd /tmp",
        );
        assert!(!user_setup.contains("not found"));
        let shared_user_state = terminal.execute(
            "bound-user-state",
            "printf 'env=%s cwd=%s ' \"$SHELLSPAN_USER_ONLY\" \"$PWD\"; ss_user_alias",
        );
        assert_eq!(shared_user_state.exit_code, Some(0));
        assert!(shared_user_state
            .combined_output
            .contains("env=user-shell-preserved cwd=/tmp user-alias-preserved"));

        let interactive = terminal.execute(
            "bound-interactive-shell",
            "case $- in *i*) printf interactive-bash;; *) false;; esac",
        );
        assert_eq!(interactive.exit_code, Some(0));
        assert!(interactive.combined_output.contains("interactive-bash"));

        terminal.execute(
            "bound-agent-state",
            "export SHELLSPAN_AGENT_ONLY=agent-shell-preserved; alias ss_agent_alias='printf agent-alias-preserved'; ss_agent_fn() { printf agent-function-preserved; }; cd /var/tmp",
        );
        let shared_agent_state = terminal.execute_user_command(
            "printf 'env=%s cwd=%s ' \"$SHELLSPAN_AGENT_ONLY\" \"$PWD\"; ss_agent_alias; ss_agent_fn",
        );
        assert!(shared_agent_state.contains(
            "env=agent-shell-preserved cwd=/var/tmp agent-alias-preservedagent-function-preserved"
        ));

        let remote_root = terminal
            .integration
            .as_ref()
            .expect("remote integration stays active")
            .remote_root
            .clone();
        let child = terminal.execute("bound-child-boundary", "env; ls -l /proc/$$/fd");
        assert!(!child.combined_output.contains(&remote_root));
        assert!(!String::from_utf8_lossy(&terminal.display).contains(&remote_root));

        let forged = terminal.execute(
            "bound-raw-forge",
            "python3 -c 'import os; os.write(1, bytes([69,0,55,55,0,47,116,109,112,0]))'",
        );
        assert_eq!(forged.exit_code, Some(0));
        assert_ne!(forged.exit_code, Some(77));

        let display_before_large = terminal.display.len();
        let large = terminal.execute("bound-large-output", "python3 -c 'print(chr(88)*20000)'");
        assert!(large.capture_truncated);
        assert!(terminal.display.len().saturating_sub(display_before_large) > 20_000);

        let exact = terminal.execute(
            "bound-exact",
            "tput setaf 2; printf 'remote-终端'; tput sgr0; false",
        );
        assert_eq!(
            exact.command_line,
            "tput setaf 2; printf 'remote-终端'; tput sgr0; false"
        );
        assert_eq!(exact.exit_code, Some(1));
        assert_eq!(exact.cwd.as_deref(), Some("/var/tmp"));
        assert!(String::from_utf8_lossy(&terminal.display).contains("remote-终端"));

        resize_pty_nonblocking(&terminal.session, &mut terminal.shell_channel, 132, 41)
            .expect("propagate SSH PTY resize through the production helper");
        broker
            .resize("fixture-user-ssh-1", TerminalGeometry::new(132, 41))
            .unwrap();
        let resize = terminal.execute("bound-resize", "stty size");
        assert!(resize.combined_output.contains("41 132"));

        for (id, requested, expected) in [
            (
                "bound-cancel",
                TerminalCommandRequestedSettlement::Cancelled,
                TerminalCommandState::Cancelled,
            ),
            (
                "bound-timeout",
                TerminalCommandRequestedSettlement::TimedOut,
                TerminalCommandState::TimedOut,
            ),
            (
                "bound-takeover",
                TerminalCommandRequestedSettlement::TakenOver,
                TerminalCommandState::TakenOver,
            ),
        ] {
            let operation = terminal.begin(id, "sleep 30");
            thread::sleep(Duration::from_millis(100));
            let settled = terminal.interrupt(&operation, requested);
            assert_eq!(settled.state, expected);
            terminal
                .broker
                .retire_command(&terminal.transport_id, &settled.command_id)
                .unwrap();
            terminal
                .broker
                .release_agent_lease(
                    &terminal.transport_id,
                    &terminal.agent_session_id,
                    "fixture-task",
                    id,
                )
                .unwrap();
            if expected == TerminalCommandState::TakenOver {
                let wrote = Arc::new(AtomicBool::new(false));
                let wrote_in_closure = Arc::clone(&wrote);
                assert!(terminal
                    .broker
                    .admit_terminal_input(
                        &terminal.transport_id,
                        crate::terminal_broker::TerminalBrokerInputSource::Agent {
                            agent_session_id: terminal.agent_session_id.clone(),
                            task_id: "fixture-task".into(),
                            operation_id: id.into(),
                        },
                        crate::terminal_broker::TerminalInputKind::Text,
                        b"forbidden-after-takeover\n",
                        move || {
                            wrote_in_closure.store(true, AtomicOrdering::Relaxed);
                            Ok(())
                        },
                    )
                    .is_err());
                assert!(!wrote.load(AtomicOrdering::Relaxed));
            }
        }

        let side_effect = terminal.begin(
            "bound-disconnect",
            "printf 'once\\n' >> /tmp/shellspan-bound-side-effect; sleep 30",
        );
        terminal.pump_until(Duration::from_secs(5), |_| {
            side_effect.snapshot().unwrap().state == TerminalCommandState::Running
        });
        thread::sleep(Duration::from_millis(100));
        terminal.close_transport();
        assert_eq!(
            side_effect.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        drop(terminal);

        let mut reconnected = RemoteFixtureTerminal::connect(
            "shellspan",
            "fixture-user-ssh-2",
            Some("fixture-user-ssh-1"),
            broker.clone(),
        );
        let reconnected_snapshot = broker
            .snapshot(Some("fixture-user-ssh-2"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            reconnected_snapshot.terminal_session_id,
            initial_snapshot.terminal_session_id
        );
        assert_eq!(reconnected_snapshot.terminal_generation, 2);
        assert!(broker
            .observe_raw_output("fixture-user-ssh-1", b"stale")
            .is_err());
        let count = reconnected.execute(
            "bound-reconcile",
            "wc -l < /tmp/shellspan-bound-side-effect; rm -f /tmp/shellspan-bound-side-effect",
        );
        assert!(count.combined_output.contains('1'));
        assert!(count.no_auto_replay);
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_bound_terminal_zsh_reuses_source_shell_smoke() {
        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(4096);
        let mut terminal =
            RemoteFixtureTerminal::connect("shellspan-zsh", "fixture-user-zsh-bound", None, broker);
        let user_setup = terminal.execute_user_command(
            "export SHELLSPAN_ZSH_USER=from-user; alias ss_zsh_user='printf zsh-user-alias'",
        );
        assert!(!user_setup.contains("not found"));
        let interactive = terminal.execute(
            "zsh-interactive-shell",
            "[[ -o interactive ]] && printf '%s:' \"$SHELLSPAN_ZSH_USER\"; ss_zsh_user",
        );
        assert_eq!(interactive.exit_code, Some(0));
        assert!(interactive
            .combined_output
            .contains("from-user:zsh-user-alias"));
        terminal.execute("zsh-export", "export SHELLSPAN_ZSH_PHASE4=kept");
        terminal.execute("zsh-alias-set", "alias ss_zsh_phase4='printf zsh-alias'");
        let value =
            terminal.execute_user_command("printf '%s:' \"$SHELLSPAN_ZSH_PHASE4\"; ss_zsh_phase4");
        assert!(value.contains("kept:zsh-alias"));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn ordinary_ssh_unsupported_shell_is_unavailable_without_a_second_transport() {
        let mut connection = crate::execution::fixture::isolated_ssh_connection();
        connection.username = "shellspan-sh".into();
        let (_known_hosts, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = crate::connection::open_authenticated_session(
            crate::connection::connect_tcp_stream(&connection.host, connection.port).unwrap(),
            &connection.username,
            connection.auth_method,
            connection.password.as_deref(),
            None,
            None,
            &connection.host,
            connection.port,
            Some(&known_hosts_path),
        )
        .unwrap();
        assert_eq!(
            detect_remote_login_shell(&session, &connection.username).unwrap(),
            TerminalShellKind::Unsupported
        );
        assert_eq!(
            RemoteSshShellIntegration::prepare(&session, &connection.username)
                .err()
                .as_deref(),
            Some("TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL")
        );

        let mut ordinary_shell = session.channel_session().unwrap();
        ordinary_shell
            .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
            .unwrap();
        ordinary_shell.shell().unwrap();
        session.set_blocking(false);
        write_all_nonblocking(
            &session,
            &mut ordinary_shell,
            b"printf 'unsupported-%s' fallback-ready\n",
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut output = Vec::new();
        let mut buffer = [0_u8; 1024];
        while Instant::now() < deadline
            && !String::from_utf8_lossy(&output).contains("unsupported-fallback-ready")
        {
            match ordinary_shell.read(&mut buffer) {
                Ok(read) if read > 0 => output.extend_from_slice(&buffer[..read]),
                Ok(_) => thread::sleep(Duration::from_millis(5)),
                Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("ordinary unsupported-shell fallback failed: {error}"),
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("unsupported-fallback-ready"));
        let _ = ordinary_shell.send_eof();
        let _ = ordinary_shell.close();
        session.set_blocking(true);

        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(64);
        broker
            .attach_transport(
                "fixture-user-unsupported",
                None,
                crate::terminal_broker::TerminalTransportKind::SshPty,
                crate::terminal_broker::TerminalGeometry::new(80, 24),
            )
            .unwrap();
        broker
            .mark_integration_unavailable(
                "fixture-user-unsupported",
                TerminalShellKind::Unsupported,
                "unsupportedRemoteShell",
            )
            .unwrap();
        let snapshot = broker
            .snapshot(Some("fixture-user-unsupported"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            snapshot.integration_state,
            crate::terminal_broker::TerminalIntegrationState::Unavailable
        );
        assert!(snapshot.integration_capabilities.is_empty());
        assert_eq!(
            broker
                .remote_visible_command_route("fixture-user-unsupported")
                .unwrap(),
            crate::terminal_broker::TerminalVisibleCommandRoute::Unavailable
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn ordinary_ssh_without_sftp_falls_back_to_a_usable_shell() {
        let mut connection = crate::execution::fixture::isolated_ssh_connection();
        connection.port = std::env::var("SHELLSPAN_E2E_SSH_NO_SFTP_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(22_224);
        let (_known_hosts, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = crate::connection::open_authenticated_session(
            crate::connection::connect_tcp_stream(&connection.host, connection.port).unwrap(),
            &connection.username,
            connection.auth_method,
            connection.password.as_deref(),
            connection.private_key_data.as_deref(),
            connection.passphrase.as_deref(),
            &connection.host,
            connection.port,
            Some(&known_hosts_path),
        )
        .unwrap();
        let prepare_error = match RemoteSshShellIntegration::prepare(&session, &connection.username)
        {
            Ok(_) => panic!("the no-SFTP fixture unexpectedly prepared integration"),
            Err(error) => error,
        };
        assert!(
            prepare_error.contains("SFTP") || prepare_error.contains("remote login shell"),
            "unexpected no-SFTP preparation error: {prepare_error}"
        );

        let mut ordinary_shell = session.channel_session().unwrap();
        ordinary_shell
            .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
            .unwrap();
        ordinary_shell.shell().unwrap();
        session.set_blocking(false);
        write_all_nonblocking(
            &session,
            &mut ordinary_shell,
            b"printf 'sftp-%s' fallback-ready\n",
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut output = Vec::new();
        let mut buffer = [0_u8; 1024];
        while Instant::now() < deadline
            && !String::from_utf8_lossy(&output).contains("sftp-fallback-ready")
        {
            match ordinary_shell.read(&mut buffer) {
                Ok(read) if read > 0 => output.extend_from_slice(&buffer[..read]),
                Ok(_) => thread::sleep(Duration::from_millis(5)),
                Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("no-SFTP ordinary shell fallback failed: {error}"),
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("sftp-fallback-ready"));
        session.set_blocking(true);
        let _ = ordinary_shell.send_eof();
        let _ = ordinary_shell.close();
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_integration_scope_cleans_resources_after_post_prepare_failure() {
        let connection = crate::execution::fixture::isolated_ssh_connection();
        let (_known_hosts, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = crate::connection::open_authenticated_session(
            crate::connection::connect_tcp_stream(&connection.host, connection.port).unwrap(),
            &connection.username,
            connection.auth_method,
            connection.password.as_deref(),
            connection.private_key_data.as_deref(),
            connection.passphrase.as_deref(),
            &connection.host,
            connection.port,
            Some(&known_hosts_path),
        )
        .unwrap();
        let integration = RemoteSshShellIntegration::prepare(&session, &connection.username)
            .expect("prepare scoped remote integration resources");
        let remote_root = integration.remote_root.clone();
        assert!(remote_root.contains("/.shellspan-terminal-integration-"));
        assert!(!remote_root.contains("agent-terminal"));
        let mut integration = Some(integration);

        let error = with_remote_integration_cleanup(&session, &mut integration, |_| {
            Err::<(), _>(ConnectionError::Other {
                message: "injected post-prepare failure".into(),
            })
        })
        .unwrap_err();
        assert_eq!(error.message(), "injected post-prepare failure");
        assert!(integration.is_none());
        assert!(session
            .sftp()
            .unwrap()
            .stat(Path::new(&remote_root))
            .is_err());
    }
