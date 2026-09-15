    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crate::terminal_broker::TerminalSessionBroker;
    use crossbeam_channel::{unbounded, Receiver};
    #[cfg(any(unix, target_os = "windows"))]
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    #[cfg(any(unix, target_os = "windows"))]
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicBool;
    #[cfg(any(unix, target_os = "windows"))]
    use std::sync::mpsc;
    #[cfg(any(unix, target_os = "windows"))]
    use std::thread;
    #[cfg(any(unix, target_os = "windows"))]
    use std::time::Instant;

    fn ready_leases() -> TerminalLeaseManager {
        let leases = TerminalLeaseManager::new(TerminalSessionBroker::disabled_for_test());
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        leases
    }

    fn sessions(session_id: &str) -> (SessionManager, Receiver<SessionCommand>) {
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                session_id.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: session_id.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "Local".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        (sessions, receiver)
    }

    fn commitment(capability: &str) -> String {
        Sha256::digest(capability.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn protocol(marker: &str, capability: &str, output: &str, code: i32, prompt: &str) -> String {
        format!(
            "wrapper echo\r\n\u{1e}{marker}:BEGIN:{}\u{1f}{output}\u{1e}{marker}:END:{capability}:{code}\u{1f}{prompt}",
            commitment(capability)
        )
    }

    #[cfg(any(unix, target_os = "windows"))]
    fn run_local_shell_protocol(wrapper: &str, cols: u16, rows: u16) -> String {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open a real local terminal");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("clone the real terminal reader");
        let mut writer = pair
            .master
            .take_writer()
            .expect("take the real terminal writer");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = CommandBuilder::new("powershell.exe");
            command.args(["-NoLogo", "-NoProfile"]);
            command
        };
        #[cfg(unix)]
        let mut command = CommandBuilder::new("/bin/sh");
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn the production local shell");
        drop(pair.slave);

        let (output_tx, output_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut output = String::new();
            let result = reader
                .read_to_string(&mut output)
                .map(|_| output)
                .map_err(|error| error.to_string());
            let _ = output_tx.send(result);
        });
        #[cfg(target_os = "windows")]
        let input = format!("{wrapper}\rexit\r");
        #[cfg(unix)]
        let input = format!("{wrapper}\nexit\n");
        writer
            .write_all(input.as_bytes())
            .expect("write the authenticated command wrapper");
        writer.flush().expect("flush the authenticated wrapper");

        // Windows ConPTY startup can be delayed when the full Rust suite runs
        // several native-terminal fixtures concurrently. Keep the poll bounded,
        // but allow enough headroom for a busy validation host.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match child.try_wait().expect("poll the local shell") {
                Some(_) => break,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                None => {
                    child.kill().expect("terminate the timed-out local shell");
                    panic!("the local shell did not exit before the PTY deadline");
                }
            }
        }
        drop(writer);
        drop(pair.master);
        output_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("receive local terminal output before the deadline")
            .expect("read local terminal output")
    }

    #[cfg(any(unix, target_os = "windows"))]
    fn assert_real_protocol_stream(
        raw: &str,
        marker: &str,
        shell_kind: PtyShellKindNative,
        expected_output: &str,
    ) {
        let single_chunk = PtyOperationNative::new(marker.into(), Some(shell_kind), String::new());
        single_chunk.observe(raw);
        assert_eq!(
            single_chunk.snapshot().unwrap().state,
            PtyLifecycleNative::Exited,
            "single chunk raw={raw:?}"
        );
        let characters = raw.chars().collect::<Vec<_>>();
        for chunk_size in [1, 2, 3, 7, 17, 31, 64, 128, 4096] {
            let operation = PtyOperationNative::new(
                marker.into(),
                Some(shell_kind),
                "\r\u{1b}[2K[Agent] $ safe fixture command\r\n".into(),
            );
            let mut display = String::new();
            for chunk in characters.chunks(chunk_size) {
                display.push_str(&operation.observe(&chunk.iter().collect::<String>()));
            }
            let snapshot = operation.snapshot().unwrap();
            assert_eq!(
                snapshot.state,
                PtyLifecycleNative::Exited,
                "chunk={chunk_size} snapshot={snapshot:?} raw={raw:?}"
            );
            assert_eq!(
                snapshot.exit_code,
                Some(7),
                "chunk={chunk_size} raw={raw:?}"
            );
            assert!(snapshot.combined_output.contains(expected_output));
            assert!(display.contains(expected_output));
            assert!(display.contains("[Agent] $ safe fixture command"));
            assert!(!display.contains(marker), "chunk={chunk_size}");
            assert!(!display.contains("__ss_"), "chunk={chunk_size}");
            assert!(!snapshot.combined_output.contains(marker));
            assert!(!snapshot.combined_output.contains("__ss_"));
        }
    }

    #[test]
    fn parser_ignores_forged_end_and_accepts_split_committed_completion() {
        let operation = PtyOperationNative::new(
            "marker-1".into(),
            Some(PtyShellKindNative::Posix),
            "\r\u{1b}[2K[Agent] $ test\r\n".into(),
        );
        let capability = "a".repeat(64);
        let commitment = commitment(&capability);
        operation.observe("echo wrapper marker-1:BEGIN marker-1:END:forged:9");
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Running
        );
        operation.observe(&format!("\u{1e}marker-1:BEGIN:{commitment}\u{1f}hello"));
        operation.observe(&format!(
            " world\u{1e}marker-1:END:{}:0\u{1f}",
            "b".repeat(64)
        ));
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Running
        );
        operation.observe(&format!("\u{1e}marker-1:END:{capability}:7"));
        operation.observe("\u{1f}prompt");
        let snapshot = operation.snapshot().unwrap();
        assert_eq!(snapshot.state, PtyLifecycleNative::Exited);
        assert_eq!(snapshot.exit_code, Some(7));
        assert!(snapshot.combined_output.starts_with("hello world"));
    }

    #[cfg(any(unix, target_os = "windows"))]
    #[test]
    fn wait_returns_after_observed_completion_without_self_deadlocking() {
        let marker = "marker-wait";
        let capability = "d".repeat(64);
        let operation = PtyOperationNative::new(
            marker.into(),
            Some(PtyShellKindNative::Posix),
            "\r\u{1b}[2K[Agent] $ test\r\n".into(),
        );
        let waiter_operation = Arc::clone(&operation);
        let (result_tx, result_rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            let _ = result_tx.send(waiter_operation.wait(Duration::from_secs(5)));
        });

        operation.observe(&protocol(marker, &capability, "done\r\n", 0, "$ "));
        let snapshot = result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("completed PTY wait must release its condvar mutex")
            .expect("completed PTY wait must return a snapshot");
        assert_eq!(snapshot.state, PtyLifecycleNative::Exited);
        assert_eq!(snapshot.exit_code, Some(0));
        waiter.join().expect("join PTY waiter");
    }

    #[test]
    fn parser_chunk_matrix_hides_wrapper_and_markers_and_preserves_prompt() {
        let marker = "marker-matrix";
        let capability = "c".repeat(64);
        let raw = protocol(
            marker,
            &capability,
            "first\r\nsecond\r\n",
            23,
            "\u{1b}[32m$ \u{1b}[0m",
        );
        for chunk_size in 1..=raw.len() {
            let operation = PtyOperationNative::new(
                marker.into(),
                Some(PtyShellKindNative::Posix),
                "\r\u{1b}[2K[Agent] $ printf safe\r\n".into(),
            );
            let mut display = String::new();
            let mut offset = 0;
            while offset < raw.len() {
                let end = (offset + chunk_size).min(raw.len());
                display.push_str(&operation.observe(&raw[offset..end]));
                offset = end;
            }
            let snapshot = operation.snapshot().unwrap();
            assert_eq!(
                snapshot.state,
                PtyLifecycleNative::Exited,
                "chunk={chunk_size}"
            );
            assert_eq!(snapshot.exit_code, Some(23), "chunk={chunk_size}");
            assert_eq!(
                snapshot.combined_output, "first\r\nsecond\r\n",
                "chunk={chunk_size}"
            );
            assert_eq!(
                display,
                "\r\u{1b}[2K[Agent] $ printf safe\r\nfirst\r\nsecond\r\n\u{1b}[32m$ \u{1b}[0m",
                "chunk={chunk_size}"
            );
            assert!(!display.contains(marker), "chunk={chunk_size}");
            assert!(!display.contains("wrapper echo"), "chunk={chunk_size}");
        }
    }

    #[test]
    fn powershell_parser_hides_conpty_wrapped_protocol_for_every_chunk_boundary() {
        fn wrapped_record(record: &str) -> String {
            let mut wrapped = String::new();
            let mut previous = None;
            for segment in record.as_bytes().chunks(31) {
                if let Some(boundary) = previous {
                    wrapped.push_str("\r\n\u{1b}[23;40H");
                    wrapped.push(boundary as char);
                }
                wrapped.push_str(std::str::from_utf8(segment).unwrap());
                previous = segment.last().copied();
            }
            wrapped.push_str("        \r\n");
            wrapped
        }

        let marker =
            "shellspan_native_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let capability = "a".repeat(64);
        let raw = format!(
            "wrapper echo\r\n{}visible\r\n{}PS C:\\> ",
            wrapped_record(&format!("{marker}:BEGIN:{}", commitment(&capability))),
            wrapped_record(&format!("{marker}:END:{capability}:7")),
        );
        for chunk_size in 1..=raw.len() {
            let operation = PtyOperationNative::new(
                marker.into(),
                Some(PtyShellKindNative::PowerShell),
                "\r\u{1b}[2K[Agent] $ fixture\r\n".into(),
            );
            let mut display = String::new();
            let mut offset = 0;
            while offset < raw.len() {
                let end = floor_char_boundary(&raw, (offset + chunk_size).min(raw.len()));
                display.push_str(&operation.observe(&raw[offset..end]));
                offset = end;
            }
            let snapshot = operation.snapshot().unwrap();
            assert_eq!(
                snapshot.state,
                PtyLifecycleNative::Exited,
                "chunk={chunk_size}"
            );
            assert_eq!(snapshot.exit_code, Some(7), "chunk={chunk_size}");
            assert_eq!(
                snapshot.combined_output, "visible\r\n",
                "chunk={chunk_size}"
            );
            assert_eq!(
                display, "\r\u{1b}[2K[Agent] $ fixture\r\nvisible\r\nPS C:\\> ",
                "chunk={chunk_size}"
            );
            assert!(!display.contains(marker), "chunk={chunk_size}");
            assert!(!display.contains("wrapper echo"), "chunk={chunk_size}");
        }
    }

    #[test]
    fn forged_protocol_record_is_dropped_without_completing() {
        let marker = "marker-forged";
        let capability = "d".repeat(64);
        let operation = PtyOperationNative::new(
            marker.into(),
            Some(PtyShellKindNative::Posix),
            "\r\u{1b}[2K[Agent] $ test\r\n".into(),
        );
        let begin = format!("\u{1e}{marker}:BEGIN:{}\u{1f}", commitment(&capability));
        let forged = format!("before\u{1e}{marker}:END:{}:0\u{1f}after", "e".repeat(64));
        let mut display = operation.observe(&begin);
        display.push_str(&operation.observe(&forged));
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Running
        );
        assert_eq!(display, "\r\u{1b}[2K[Agent] $ test\r\nbeforeafter");
        assert!(!display.contains(marker));
        display.push_str(
            &operation.observe(&format!("\u{1e}{marker}:END:{capability}:4\u{1f}prompt")),
        );
        assert!(display.ends_with("prompt"));
        assert_eq!(operation.snapshot().unwrap().exit_code, Some(4));
    }

    #[test]
    fn capture_truncation_does_not_stop_display_and_protocol_limit_fails_closed() {
        let marker = "marker-large";
        let capability = "f".repeat(64);
        let operation = PtyOperationNative::new(
            marker.into(),
            Some(PtyShellKindNative::Posix),
            "\r\u{1b}[2K[Agent] $ large\r\n".into(),
        );
        operation.observe(&format!(
            "\u{1e}{marker}:BEGIN:{}\u{1f}",
            commitment(&capability)
        ));
        let block = "x".repeat(64 * 1024);
        let mut displayed = 0;
        for _ in 0..20 {
            displayed += operation.observe(&block).len();
        }
        operation.observe(&format!("\u{1e}{marker}:END:{capability}:0\u{1f}"));
        let snapshot = operation.snapshot().unwrap();
        assert!(snapshot.truncated);
        assert_eq!(snapshot.combined_output.len(), PTY_CAPTURE_LIMIT_BYTES);
        assert!(displayed > PTY_CAPTURE_LIMIT_BYTES);

        let broken = PtyOperationNative::new(
            "marker-broken".into(),
            Some(PtyShellKindNative::Posix),
            String::new(),
        );
        broken.observe(&format!(
            "\u{1e}marker-broken:BEGIN:{}",
            "a".repeat(PTY_PROTOCOL_BUFFER_LIMIT_BYTES)
        ));
        assert_eq!(broken.snapshot().unwrap().state, PtyLifecycleNative::Failed);
    }

    #[test]
    fn shell_probe_recognizes_remote_posix_and_powershell_but_rejects_unknown() {
        assert_eq!(
            classify_shell_probe("-bash"),
            Some(PtyShellKindNative::Posix)
        );
        assert_eq!(
            classify_shell_probe("/bin/zsh"),
            Some(PtyShellKindNative::Posix)
        );
        assert_eq!(
            classify_shell_probe(""),
            Some(PtyShellKindNative::PowerShell)
        );
        assert_eq!(classify_shell_probe("$0"), None);
        assert_eq!(classify_shell_probe("fish"), None);
    }

    #[test]
    fn remote_probe_selects_posix_wrapper_and_unknown_shell_never_gets_one() {
        for (reported_shell, expect_wrapper) in [("-bash", true), ("$0", false)] {
            let leases = ready_leases();
            let registry = PtyRegistryNative::new(leases.clone());
            let (sessions, receiver) = sessions("terminal-1");
            let worker_registry = registry.clone();
            let worker_sessions = sessions.clone();
            let worker = std::thread::spawn(move || {
                worker_registry.start(
                    &worker_sessions,
                    "terminal-1",
                    "agent-1",
                    "task-1",
                    "operation-1",
                    "printf done",
                    None,
                )
            });
            let probe = match receiver.recv_timeout(Duration::from_secs(1)).unwrap() {
                SessionCommand::Write(value) => value,
                _ => panic!("expected shell probe"),
            };
            let prefix = probe
                .strip_prefix("echo ")
                .and_then(|value| value.strip_suffix("$0\r"))
                .unwrap();
            registry.observe("terminal-1", &format!("{prefix}{reported_shell}\r\n"));
            let started = worker.join().unwrap();
            if expect_wrapper {
                assert!(started.is_ok());
                let wrapper = match receiver.recv_timeout(Duration::from_secs(1)).unwrap() {
                    SessionCommand::Write(value) => value,
                    _ => panic!("expected POSIX wrapper"),
                };
                assert!(wrapper.contains("/bin/sh -c"));
                registry
                    .terminal_closed("terminal-1")
                    .expect("cleanup probed operation");
            } else {
                assert!(started.err().unwrap().starts_with("PTY_SHELL_UNSUPPORTED:"));
                assert!(receiver.try_recv().is_err());
                assert!(leases.lease("terminal-1").is_none());
            }
        }
    }

    #[test]
    fn command_display_is_redacted_before_the_acquired_event() {
        let leases = TerminalLeaseManager::new(TerminalSessionBroker::disabled_for_test());
        let command_display = Arc::new(Mutex::new(None));
        let captured = command_display.clone();
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    *captured.lock().unwrap() = event.command_display.clone();
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let registry = PtyRegistryNative::new(leases);
        let (sessions, _receiver) = sessions("terminal-1");
        let operation = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "curl --token extremely-sensitive-value",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();
        assert_eq!(
            operation.command_display,
            "\r\u{1b}[2K[Agent] $ [REDACTED]\r\n"
        );
        let display = command_display.lock().unwrap().clone().unwrap();
        assert_eq!(display, "[Agent] $ [REDACTED]");
        assert!(!display.contains("extremely-sensitive-value"));
        registry.terminal_closed("terminal-1").unwrap();
    }

    #[test]
    fn ansi_is_removed_from_model_text_before_rust_redaction() {
        let raw = "\u{1b}[31mpassword=very-secret\u{1b}[0m";
        assert_eq!(
            crate::redaction::redact_sensitive_text(&strip_ansi(raw)),
            crate::redaction::REDACTED_VALUE
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_powershell_wrapper_emits_authenticated_boundary_and_exit_code() {
        let marker = "marker-powershell-baseline";
        let wrapper = build_powershell_wrapper("Write-Output 'visible-output'; exit 7", marker);
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-Command", &wrapper])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("visible-output"));
        assert!(stdout.contains(&format!("{marker}:BEGIN:")));
        assert!(stdout.contains(&format!(":END:")));
        assert!(stdout.contains(":7"));
    }

    #[test]
    fn displayed_agent_command_is_single_line_and_bounded() {
        let command = format!("Write-Output {}\nWrite-Output done", "x".repeat(200));
        let display = agent_command_display(&command);
        assert!(display.starts_with("[Agent] $ Write-Output "));
        assert!(display.ends_with('…'));
        assert!(!display.contains('\n'));
        assert!(
            display.chars().count()
                <= "[Agent] $ ".chars().count() + COMMAND_DISPLAY_LIMIT_CHARS + 1
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_conpty_visible_command_protocol_is_end_to_end() {
        let marker =
            "shellspan_native_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let wrapper =
            build_powershell_wrapper("Write-Output 'visible-conpty-output'; exit 7", marker);
        for rows in [24, 64] {
            for cols in [40, 80, 120, 240] {
                let raw = run_local_shell_protocol(&wrapper, cols, rows);
                assert_real_protocol_stream(
                    &raw,
                    marker,
                    PtyShellKindNative::PowerShell,
                    "visible-conpty-output",
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn posix_wrapper_emits_authenticated_boundary_and_exit_code() {
        let marker = "marker-posix-baseline";
        let wrapper = build_posix_wrapper("printf visible-output; exit 7", marker);
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &wrapper])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("visible-output"));
        assert!(stdout.contains(&format!("\u{1e}{marker}:BEGIN:")));
        assert!(stdout.contains(":END:"));
        assert!(stdout.contains(":7\u{1f}"));
    }

    #[cfg(unix)]
    #[test]
    fn local_posix_pty_visible_command_protocol_is_end_to_end() {
        let marker = "marker-local-posix-e2e";
        let wrapper = build_posix_wrapper("printf visible-posix-output; exit 7", marker);
        let raw = run_local_shell_protocol(&wrapper, 240, 24);
        assert_real_protocol_stream(
            &raw,
            marker,
            PtyShellKindNative::Posix,
            "visible-posix-output",
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_ssh_posix_visible_command_protocol_is_end_to_end() {
        use ssh2::{ExtendedData, Session};
        use std::net::TcpStream;

        let host = std::env::var("SHELLSPAN_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("SHELLSPAN_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username =
            std::env::var("SHELLSPAN_E2E_SSH_USERNAME").unwrap_or_else(|_| "shellspan".into());
        let password =
            std::env::var("SHELLSPAN_E2E_SSH_PASSWORD").unwrap_or_else(|_| "shellspan-e2e".into());
        let tcp = TcpStream::connect((host.as_str(), port)).expect("connect to SSH fixture");
        tcp.set_read_timeout(Some(Duration::from_secs(15)))
            .expect("bound fixture read timeout");
        tcp.set_write_timeout(Some(Duration::from_secs(15)))
            .expect("bound fixture write timeout");
        let mut session = Session::new().expect("create SSH fixture session");
        session.set_tcp_stream(tcp);
        session.handshake().expect("handshake with SSH fixture");
        session
            .userauth_password(&username, &password)
            .expect("authenticate to SSH fixture");
        assert!(session.authenticated());
        let mut channel = session
            .channel_session()
            .expect("open SSH terminal channel");
        channel
            .request_pty("xterm-256color", None, Some((240, 24, 0, 0)))
            .expect("request SSH PTY");
        channel
            .handle_extended_data(ExtendedData::Merge)
            .expect("merge SSH terminal output");
        channel.shell().expect("start SSH POSIX shell");

        let marker = "marker-remote-ssh-posix-e2e";
        let wrapper = build_posix_wrapper("printf visible-ssh-output; exit 7", marker);
        channel
            .write_all(format!("{wrapper}\nexit\n").as_bytes())
            .expect("write SSH wrapper");
        channel.flush().expect("flush SSH wrapper");
        let mut raw = String::new();
        channel
            .read_to_string(&mut raw)
            .expect("read SSH protocol stream");
        channel.wait_close().expect("close SSH fixture channel");

        assert_real_protocol_stream(
            &raw,
            marker,
            PtyShellKindNative::Posix,
            "visible-ssh-output",
        );
    }

    #[test]
    fn registration_failure_rolls_back_the_new_lease() {
        let leases = ready_leases();
        let registry = PtyRegistryNative::new(leases.clone());
        let (sessions, _receiver) = sessions("terminal-1");
        registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "echo first",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();
        leases
            .release_terminal("terminal-1", TerminalLeaseReleaseReason::Failed)
            .unwrap();

        let error = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-2",
                "task-2",
                "operation-2",
                "echo second",
                Some(PtyShellKindNative::Posix),
            )
            .err()
            .expect("second registration must fail");
        assert!(error.starts_with("TERMINAL_LEASE_BUSY:"));
        assert!(leases.lease("terminal-1").is_none());
    }

    #[test]
    fn a_second_visible_agent_is_busy_without_writing_or_replacing_the_owner() {
        let leases = ready_leases();
        let registry = PtyRegistryNative::new(leases.clone());
        let (sessions, receiver) = sessions("terminal-1");
        registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "sleep 10",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();
        let first_write_count = receiver.try_iter().count();
        let error = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-2",
                "task-2",
                "operation-2",
                "echo must-not-run",
                Some(PtyShellKindNative::Posix),
            )
            .err()
            .expect("a second Agent must be rejected immediately");
        assert!(error.starts_with("TERMINAL_LEASE_BUSY:"));
        assert_eq!(receiver.try_iter().count(), 0);
        assert_eq!(first_write_count, 1);
        assert_eq!(
            leases.lease("terminal-1").unwrap().operation_id,
            "operation-1"
        );
        registry.terminal_closed("terminal-1").unwrap();
    }

    #[test]
    fn frontend_rejection_or_timeout_never_writes_a_wrapper_and_cleans_the_lease() {
        for rejection in ["pendingInput", "credentialPrompt", "timeout"] {
            let leases = TerminalLeaseManager::new(TerminalSessionBroker::disabled_for_test());
            if rejection != "timeout" {
                let acknowledger = leases.clone();
                let rejection = rejection.to_string();
                leases
                    .set_publisher(Arc::new(move |event| {
                        if event.state == super::super::TerminalLeaseEventState::Acquired {
                            acknowledger
                                .acknowledge_frontend_ready(
                                    &event.session_id,
                                    &event.agent_session_id,
                                    &event.operation_id,
                                    true,
                                    true,
                                    rejection == "pendingInput",
                                    false,
                                    rejection == "credentialPrompt",
                                )
                                .unwrap();
                        }
                    }))
                    .unwrap();
            }
            let registry = PtyRegistryNative::new(leases.clone());
            let (sessions, receiver) = sessions("terminal-1");
            assert!(registry
                .start(
                    &sessions,
                    "terminal-1",
                    "agent-1",
                    "task-1",
                    "operation-1",
                    "echo must-not-run",
                    Some(PtyShellKindNative::Posix),
                )
                .is_err());
            assert!(leases.lease("terminal-1").is_none(), "{rejection}");
            assert!(
                receiver
                    .try_iter()
                    .all(|command| !matches!(command, SessionCommand::Write(_))),
                "{rejection}"
            );
        }
    }

    #[test]
    fn takeover_wins_once_sends_control_c_and_releases() {
        let leases = ready_leases();
        let registry = PtyRegistryNative::new(leases.clone());
        let (sessions, receiver) = sessions("terminal-1");
        let operation = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "sleep 10",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();

        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-2", "operation-1")
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_OWNER_MISMATCH:"));
        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-1", "operation-2")
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_OPERATION_MISMATCH:"));

        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-1", "operation-1")
            .unwrap());
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::TakenOver
        );
        assert!(leases.lease("terminal-1").is_none());
        assert!(receiver
            .try_iter()
            .any(|command| matches!(command, SessionCommand::Write(data) if data == "\u{3}")));
        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-1", "operation-1")
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_NOT_FOUND:"));
    }

    #[test]
    fn completed_terminal_state_beats_late_takeover() {
        let leases = ready_leases();
        let registry = PtyRegistryNative::new(leases.clone());
        let (sessions, _receiver) = sessions("terminal-1");
        let operation = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "true",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();
        assert!(operation.finish(PtyLifecycleNative::Exited, ""));
        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-1", "operation-1")
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_ALREADY_TERMINAL:"));
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Exited
        );
        assert!(registry.terminal_closed("terminal-1").unwrap());
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Exited
        );
        assert!(leases.lease("terminal-1").is_none());
    }

    #[test]
    fn cancel_disconnect_timeout_and_shutdown_are_idempotent_cleanup_paths() {
        let cases = ["cancel", "closed", "timeout", "shutdown"];
        for case in cases {
            let leases = ready_leases();
            let registry = PtyRegistryNative::new(leases.clone());
            let (sessions, _receiver) = sessions("terminal-1");
            let operation = registry
                .start(
                    &sessions,
                    "terminal-1",
                    "agent-1",
                    "task-1",
                    "operation-1",
                    "sleep 10",
                    Some(PtyShellKindNative::Posix),
                )
                .unwrap();
            match case {
                "cancel" => assert_eq!(registry.cancel_task(&sessions, "task-1").unwrap(), 1),
                "closed" => assert!(registry.terminal_closed("terminal-1").unwrap()),
                "timeout" => {
                    let snapshot = operation.wait(Duration::ZERO).unwrap();
                    assert_eq!(snapshot.state, PtyLifecycleNative::TimedOut);
                    registry
                        .interrupt_timed_out(&sessions, "terminal-1", "operation-1")
                        .unwrap();
                }
                "shutdown" => assert_eq!(registry.shutdown_all(&sessions).unwrap(), 1),
                _ => unreachable!(),
            }
            assert!(leases.lease("terminal-1").is_none(), "case={case}");
            assert!(!registry.terminal_closed("terminal-1").unwrap());
        }
    }
