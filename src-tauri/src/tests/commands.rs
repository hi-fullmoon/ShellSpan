    #[cfg(unix)]
    use super::rollback_local_broker_attachment_failure;
    use super::{
        collect_local_output_batch, configure_local_terminal_environment, detect_key_type,
        expand_home_path, remove_failed_session_registration, should_prepare_remote_integration,
        should_release_local_startup_output, visible_command_integration_presentation,
        wait_for_local_worker_activity, LocalWorkerActivity, LOCAL_OUTPUT_DRAIN_BUDGET,
        LOCAL_OUTPUT_QUEUE_CAPACITY, LOCAL_OUTPUT_READY_TIMEOUT,
    };
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
        SessionStatus, SessionTerminalKind, StatusEvent,
    };
    use crossbeam_channel::{bounded, never, unbounded, TryRecvError, TrySendError};
    use portable_pty::CommandBuilder;
    #[cfg(any(unix, windows))]
    use portable_pty::{native_pty_system, PtySize};
    use std::ffi::OsStr;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    use std::io::Read;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn local_open_and_reveal_reject_relative_or_missing_paths() {
        assert_eq!(
            super::open_path("relative.txt".into()).unwrap_err(),
            "path must be absolute"
        );
        assert_eq!(
            super::reveal_path("relative.txt".into()).unwrap_err(),
            "path must be absolute"
        );

        let directory = tempfile::tempdir().unwrap();
        let missing = directory
            .path()
            .join("missing.txt")
            .to_string_lossy()
            .into_owned();
        assert!(super::open_path(missing.clone())
            .unwrap_err()
            .contains("path does not exist"));
        assert!(super::reveal_path(missing)
            .unwrap_err()
            .contains("path does not exist"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reveal_uses_one_quoted_explorer_select_argument() {
        let path = std::path::Path::new(r"C:\Users\tester\My Documents\todo.html");
        assert_eq!(
            super::explorer_select_argument(path),
            r#"/select,"C:\Users\tester\My Documents\todo.html""#
        );
    }

    #[test]
    fn ordinary_ssh_prepares_integration_only_for_the_remote_rollout() {
        assert!(should_prepare_remote_integration(true));
        assert!(!should_prepare_remote_integration(false));
    }

    #[test]
    fn user_ssh_visible_command_presentation_requires_real_integration_readiness() {
        use crate::terminal_broker::{TerminalIntegrationState, TerminalTransportKind};

        assert_eq!(
            visible_command_integration_presentation(
                TerminalIntegrationState::Unavailable,
                Some("remoteBoundTerminalDisabled"),
                TerminalTransportKind::SshPty,
                true,
                true,
            ),
            (
                TerminalIntegrationState::Unavailable,
                Some("remoteBoundTerminalDisabled".into())
            )
        );
        assert_eq!(
            visible_command_integration_presentation(
                TerminalIntegrationState::Ready,
                None,
                TerminalTransportKind::SshPty,
                true,
                false,
            ),
            (
                TerminalIntegrationState::Unavailable,
                Some("remoteBoundTerminalDisabled".into())
            )
        );
    }

    fn registered_test_session(manager: &SessionManager, session_id: &str) {
        let (sender, _receiver) = unbounded();
        manager
            .insert(
                session_id.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: session_id.into(),
                        status: SessionStatus::Connecting,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(false)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "cleanup-test".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn local_attach_failure_removes_registry_entry_closes_pty_and_reaps_child() {
        let manager = SessionManager::default();
        registered_test_session(&manager, "failed-attach");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 60"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let error = rollback_local_broker_attachment_failure(
            &manager,
            "failed-attach",
            child.as_mut(),
            move || drop(pair.master),
            "TERMINAL_BROKER_PREDECESSOR_NOT_FOUND",
        );

        assert_eq!(
            error,
            "TERMINAL_BROKER_ATTACH_FAILED: TERMINAL_BROKER_PREDECESSOR_NOT_FOUND"
        );
        assert!(manager.status("failed-attach").is_err());
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn ssh_attach_failure_removes_pending_session_registration() {
        let manager = SessionManager::default();
        registered_test_session(&manager, "failed-ssh-attach");

        assert!(remove_failed_session_registration(&manager, "failed-ssh-attach").is_none());
        assert!(manager.status("failed-ssh-attach").is_err());
    }
    use std::time::{Duration, Instant};

    fn never_activity_channels() -> (
        crossbeam_channel::Receiver<()>,
        crossbeam_channel::Receiver<()>,
        crossbeam_channel::Receiver<Instant>,
    ) {
        (never(), never(), never())
    }

    #[test]
    fn local_output_arrival_wakes_an_idle_worker_without_polling() {
        let (command_tx, command_rx) = unbounded();
        let _keep_commands_open = command_tx;
        let (output_tx, output_rx) = bounded(1);
        let (child_rx, state_rx, timeout_rx) = never_activity_channels();
        let barrier = Arc::new(Barrier::new(2));
        let worker_barrier = Arc::clone(&barrier);
        let (activity_tx, activity_rx) = bounded(1);
        let worker = thread::spawn(move || {
            worker_barrier.wait();
            let activity = wait_for_local_worker_activity(
                &command_rx,
                &child_rx,
                &state_rx,
                &output_rx,
                &timeout_rx,
            );
            activity_tx.send(activity).unwrap();
        });

        barrier.wait();
        assert!(matches!(activity_rx.try_recv(), Err(TryRecvError::Empty)));
        output_tx.send(b"first".to_vec()).unwrap();

        match activity_rx.recv().unwrap() {
            LocalWorkerActivity::Output(Ok(bytes)) => assert_eq!(bytes, b"first"),
            _ => panic!("output did not wake the idle local worker"),
        }
        worker.join().unwrap();
    }

    #[test]
    fn local_commands_win_a_ready_output_race() {
        let (command_tx, command_rx) = unbounded();
        let (output_tx, output_rx) = bounded(1);
        let (child_rx, state_rx, timeout_rx) = never_activity_channels();
        output_tx.send(b"output".to_vec()).unwrap();
        command_tx
            .send(SessionCommand::Write("input".to_string()))
            .unwrap();

        match wait_for_local_worker_activity(
            &command_rx,
            &child_rx,
            &state_rx,
            &output_rx,
            &timeout_rx,
        ) {
            LocalWorkerActivity::Command(Ok(SessionCommand::Write(data))) => {
                assert_eq!(data, "input")
            }
            _ => panic!("a ready output item starved a ready command"),
        }
        assert_eq!(output_rx.recv().unwrap(), b"output");
    }

    #[test]
    fn local_pause_leaves_output_queued_until_resume_notification() {
        let (command_tx, command_rx) = unbounded();
        let _keep_commands_open = command_tx;
        let (output_tx, output_rx) = bounded(1);
        let paused_output_rx = never();
        let (state_tx, state_rx) = bounded(1);
        let (child_rx, _, timeout_rx) = never_activity_channels();
        output_tx.send(b"held".to_vec()).unwrap();
        state_tx.send(()).unwrap();

        assert!(matches!(
            wait_for_local_worker_activity(
                &command_rx,
                &child_rx,
                &state_rx,
                &paused_output_rx,
                &timeout_rx,
            ),
            LocalWorkerActivity::OutputStateChanged
        ));
        assert_eq!(output_rx.len(), 1, "pause consumed output before resume");

        match wait_for_local_worker_activity(
            &command_rx,
            &child_rx,
            &state_rx,
            &output_rx,
            &timeout_rx,
        ) {
            LocalWorkerActivity::Output(Ok(bytes)) => assert_eq!(bytes, b"held"),
            _ => panic!("resume did not continue the queued output"),
        }
    }

    #[test]
    fn local_ready_gate_holds_then_releases_startup_output() {
        assert!(!should_release_local_startup_output(
            false,
            false,
            false,
            Duration::from_secs(1),
            32,
        ));
        assert!(should_release_local_startup_output(
            false,
            false,
            true,
            Duration::from_secs(1),
            32,
        ));
        assert!(!should_release_local_startup_output(
            false,
            true,
            true,
            LOCAL_OUTPUT_READY_TIMEOUT,
            32,
        ));
    }

    #[test]
    fn local_close_and_child_exit_leave_tail_output_for_shutdown_drain() {
        for exit_first in [false, true] {
            let (command_tx, command_rx) = unbounded();
            let (output_tx, output_rx) = bounded(1);
            let (child_tx, child_rx) = bounded(1);
            let state_rx = never();
            let timeout_rx = never();
            output_tx.send(b"tail".to_vec()).unwrap();
            if exit_first {
                child_tx.send(()).unwrap();
            } else {
                command_tx.send(SessionCommand::Close).unwrap();
            }

            let activity = wait_for_local_worker_activity(
                &command_rx,
                &child_rx,
                &state_rx,
                &output_rx,
                &timeout_rx,
            );
            assert!(matches!(
                activity,
                LocalWorkerActivity::ChildExited
                    | LocalWorkerActivity::Command(Ok(SessionCommand::Close))
            ));
            assert_eq!(output_rx.recv().unwrap(), b"tail");
        }
    }

    #[test]
    fn local_output_batch_is_ordered_bounded_and_yields_for_commands() {
        let (output_tx, output_rx) = bounded(LOCAL_OUTPUT_DRAIN_BUDGET + 2);
        for index in 0..LOCAL_OUTPUT_DRAIN_BUDGET + 2 {
            output_tx.send(vec![index as u8]).unwrap();
        }
        let first = output_rx.recv().unwrap();
        let mut pending = Vec::new();

        let chunks = collect_local_output_batch(first, &output_rx, &mut pending);

        assert_eq!(chunks, LOCAL_OUTPUT_DRAIN_BUDGET);
        assert_eq!(
            pending,
            (0..LOCAL_OUTPUT_DRAIN_BUDGET as u8).collect::<Vec<_>>()
        );
        assert_eq!(output_rx.len(), 2, "batch drained past its fairness budget");
    }

    #[test]
    fn local_reader_queue_has_a_fixed_backpressure_bound() {
        let (output_tx, output_rx) = bounded(LOCAL_OUTPUT_QUEUE_CAPACITY);
        for _ in 0..LOCAL_OUTPUT_QUEUE_CAPACITY {
            output_tx.try_send(vec![0]).unwrap();
        }
        assert!(matches!(
            output_tx.try_send(vec![1]),
            Err(TrySendError::Full(_))
        ));
        assert_eq!(output_rx.len(), LOCAL_OUTPUT_QUEUE_CAPACITY);
    }

    #[test]
    fn local_sessions_have_independent_wakeups() {
        let barrier = Arc::new(Barrier::new(3));
        let mut outputs = Vec::new();
        let mut completions = Vec::new();
        let mut workers = Vec::new();
        for session in 0..2_u8 {
            let (command_tx, command_rx) = unbounded();
            let (output_tx, output_rx) = bounded(1);
            let (child_rx, state_rx, timeout_rx) = never_activity_channels();
            let barrier = Arc::clone(&barrier);
            let (done_tx, done_rx) = bounded(1);
            workers.push(thread::spawn(move || {
                let _keep_commands_open = command_tx;
                barrier.wait();
                let activity = wait_for_local_worker_activity(
                    &command_rx,
                    &child_rx,
                    &state_rx,
                    &output_rx,
                    &timeout_rx,
                );
                done_tx.send(activity).unwrap();
            }));
            outputs.push((session, output_tx));
            completions.push(done_rx);
        }
        barrier.wait();

        outputs[1].1.send(vec![1]).unwrap();
        assert!(matches!(
            completions[1].recv().unwrap(),
            LocalWorkerActivity::Output(Ok(bytes)) if bytes == vec![1]
        ));
        assert!(matches!(
            completions[0].try_recv(),
            Err(TryRecvError::Empty)
        ));

        outputs[0].1.send(vec![0]).unwrap();
        assert!(matches!(
            completions[0].recv().unwrap(),
            LocalWorkerActivity::Output(Ok(bytes)) if bytes == vec![0]
        ));
        for worker in workers {
            worker.join().unwrap();
        }
    }

    #[test]
    fn local_shell_uses_xterm_terminal_capabilities() {
        let mut command = CommandBuilder::new("shell");

        configure_local_terminal_environment(&mut command);

        assert_eq!(command.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        assert_eq!(command.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
        assert_eq!(
            command.get_env("TERM_PROGRAM"),
            Some(OsStr::new("ShellSpan"))
        );
        assert_eq!(
            command.get_env("TERM_PROGRAM_VERSION"),
            Some(OsStr::new(env!("CARGO_PKG_VERSION"))),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_real_pty_smoke_uses_a_direct_deterministic_process() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open a real local PTY");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("clone the real PTY reader");
        let mut command = CommandBuilder::new("/usr/bin/printf");
        command.arg("shellspan-pty-smoke\\n");
        configure_local_terminal_environment(&mut command);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn a fixed executable without a shell");
        drop(pair.slave);

        let mut output = String::new();
        reader
            .read_to_string(&mut output)
            .expect("read the deterministic PTY output");
        let status = child.wait().expect("wait for the PTY child");

        assert!(status.success());
        assert_eq!(output.replace("\r\n", "\n"), "shellspan-pty-smoke\n");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_real_pty_runs_the_shell_boundary_protocol() {
        use std::io::Write;

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 160,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open a real local PTY for the shell protocol");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("clone the real shell PTY reader");
        let mut writer = pair
            .master
            .take_writer()
            .expect("take the real shell PTY writer");
        let mut command = CommandBuilder::new("/bin/zsh");
        command.arg("-f");
        configure_local_terminal_environment(&mut command);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn the native macOS shell through a PTY");
        drop(pair.slave);

        let marker = "SHELLSPAN_NATIVE_TEST_0123456789abcdef0123456789abcdef0123456789abcdef";
        let wrapper = format!(
            "m='{marker}'; c='printf macos-shell-protocol; false'; k=$(LC_ALL=C /usr/bin/od -An -N24 -tx1 /dev/urandom | /usr/bin/tr -d '[:space:]'); h=$(/usr/bin/printf %s \"$k\" | /usr/bin/shasum -a 256); h=${{h%% *}}; /usr/bin/printf '\\036%s:BEGIN:%s\\037\\n' \"$m\" \"$h\"; if /bin/sh -c \"$c\" </dev/null; then x=0; else x=$?; fi; /usr/bin/printf '\\036%s:END:%s:%d\\037\\n' \"$m\" \"$k\" \"$x\"\nexit\n"
        );
        writer
            .write_all(wrapper.as_bytes())
            .expect("write the shell boundary protocol to the PTY");
        writer.flush().expect("flush the shell boundary protocol");
        drop(writer);

        let mut output = String::new();
        reader
            .read_to_string(&mut output)
            .expect("read the shell boundary protocol output");
        let status = child.wait().expect("wait for the native shell");

        assert!(status.success());
        assert!(output.contains(
            "\u{1e}SHELLSPAN_NATIVE_TEST_0123456789abcdef0123456789abcdef0123456789abcdef:BEGIN:"
        ));
        assert!(output.contains("macos-shell-protocol"));
        assert!(output.contains(
            "\u{1e}SHELLSPAN_NATIVE_TEST_0123456789abcdef0123456789abcdef0123456789abcdef:END:"
        ));
        assert!(output.contains(":1\u{1f}"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_real_conpty_smoke_runs_the_production_powershell() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open a real Windows ConPTY");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("clone the real ConPTY reader");
        let mut writer = pair
            .master
            .take_writer()
            .expect("take the real ConPTY writer");
        let mut command = CommandBuilder::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile"]);
        configure_local_terminal_environment(&mut command);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn the production Windows shell through ConPTY");
        drop(pair.slave);

        let (output_tx, output_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut output = String::new();
            let result = reader
                .read_to_string(&mut output)
                .map(|_| output)
                .map_err(|error| error.to_string());
            let _ = output_tx.send(result);
        });
        writer
            .write_all(b"Write-Output 'shellspan-conpty-smoke'\rexit 7\r")
            .expect("write deterministic commands to the PowerShell ConPTY");
        writer
            .flush()
            .expect("flush deterministic commands to the PowerShell ConPTY");

        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            match child.try_wait().expect("poll the ConPTY child") {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                None => {
                    child.kill().expect("terminate the timed-out ConPTY child");
                    panic!("the production PowerShell did not exit before the ConPTY deadline");
                }
            }
        };

        assert_eq!(status.exit_code(), 7);
        // Keep the input writer alive until the explicit `exit 7`; dropping it earlier makes
        // ConPTY terminate interactive PowerShell with STATUS_CONTROL_C_EXIT (0xC000013A).
        drop(writer);
        // Closing the ConPTY master releases the reader EOF after the child has exited.
        drop(pair.master);
        let output = output_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("read the PowerShell ConPTY output before the deadline")
            .expect("read deterministic PowerShell ConPTY output");

        assert!(
            output.contains("shellspan-conpty-smoke"),
            "missing ConPTY smoke marker in {output:?}"
        );
    }

    #[test]
    fn detect_key_type_recognizes_openssh_ed25519_private_key() {
        let body = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"openssh-key-v1\x00\x00\x00\x00\x00\x00\x00\x00ssh-ed25519",
        );
        let key = format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----",
            body
        );
        assert_eq!(detect_key_type(&key), "ed25519");
    }

    #[test]
    fn detect_key_type_recognizes_openssh_rsa_private_key() {
        let body = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"openssh-key-v1\x00\x00\x00\x00\x00\x00\x00\x00ssh-rsa",
        );
        let key = format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----",
            body
        );
        assert_eq!(detect_key_type(&key), "rsa");
    }

    #[test]
    fn expands_openssh_home_relative_identity_paths() {
        let home = std::path::Path::new("/home/tester");
        assert_eq!(
            expand_home_path("~/.ssh/id_ed25519", home),
            home.join(".ssh/id_ed25519")
        );
        assert_eq!(
            expand_home_path("~\\.ssh\\id_ed25519", home),
            home.join(".ssh\\id_ed25519")
        );
        assert_eq!(
            expand_home_path("/tmp/id_ed25519", home),
            std::path::PathBuf::from("/tmp/id_ed25519")
        );
    }
