    use super::*;

    fn prepare_test_integration(
        shell: TerminalShellKind,
    ) -> (TempDir, PreparedLocalShellIntegration) {
        let fixture = tempfile::tempdir().unwrap();
        let data_dir = crate::shellspan_data_dir(&fixture.path().join("user home"));
        let integration = PreparedLocalShellIntegration::prepare(shell, &data_dir).unwrap();
        (fixture, integration)
    }

    #[test]
    fn local_bootstraps_use_app_temporary_storage_and_clean_up_only_their_own_directory() {
        let shell = if cfg!(windows) {
            TerminalShellKind::WindowsPowerShell
        } else {
            TerminalShellKind::Bash
        };
        let (fixture, first) = prepare_test_integration(shell);
        let data_dir = crate::shellspan_data_dir(&fixture.path().join("user home"));
        let temporary_root = data_dir.join("tmp");
        let second = PreparedLocalShellIntegration::prepare(shell, &data_dir).unwrap();
        let first_root = first.bootstrap_root.path().to_path_buf();
        let second_root = second.bootstrap_root.path().to_path_buf();
        assert_eq!(first_root.parent(), Some(temporary_root.as_path()));
        assert_eq!(second_root.parent(), Some(temporary_root.as_path()));
        assert_ne!(first_root, second_root);
        assert!(first.bootstrap_path.is_file());
        assert!(second.bootstrap_path.is_file());
        let unrelated = temporary_root.join("keep.txt");
        fs::write(&unrelated, "keep").unwrap();

        drop(first);
        assert!(!first_root.exists());
        assert!(second.bootstrap_path.is_file());
        assert_eq!(fs::read_to_string(&unrelated).unwrap(), "keep");
        drop(second);
        assert!(!second_root.exists());
        assert!(temporary_root.is_dir());
    }

    #[test]
    fn unavailable_app_temporary_storage_fails_without_falling_back() {
        let fixture = tempfile::tempdir().unwrap();
        fs::write(fixture.path().join("tmp"), "occupied").unwrap();
        let shell = if cfg!(windows) {
            TerminalShellKind::WindowsPowerShell
        } else {
            TerminalShellKind::Bash
        };
        let error = PreparedLocalShellIntegration::prepare(shell, fixture.path())
            .err()
            .expect("a file blocking the temporary directory must reject setup");
        assert!(error.starts_with("failed to create shell integration temporary root:"));
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 1);
        assert_eq!(
            fs::read_to_string(fixture.path().join("tmp")).unwrap(),
            "occupied"
        );
    }

    #[test]
    fn ssh_control_decoder_accepts_split_frames_and_rejects_raw_forgery_bytes() {
        let mut decoder = TerminalIntegrationStreamDecoder::default();
        assert!(decoder.push(b"R\0ba").unwrap().is_empty());
        let events = decoder
            .push(b"sh\0P\0/home/tester\0Q\0S\0printf ok\0/home/tester\0")
            .unwrap();
        assert_eq!(
            events,
            vec![
                TerminalIntegrationControlEvent::Ready {
                    shell: TerminalShellKind::Bash,
                },
                TerminalIntegrationControlEvent::PromptStart {
                    cwd: "/home/tester".into(),
                },
                TerminalIntegrationControlEvent::PromptEnd,
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: "printf ok".into(),
                    cwd: "/home/tester".into(),
                },
            ]
        );
        decoder.finish().unwrap();

        let mut forged_raw = TerminalIntegrationStreamDecoder::default();
        assert!(forged_raw
            .push(b"escape ]133; commandEnd exit=0")
            .unwrap()
            .is_empty());
        assert!(forged_raw.finish().is_err());
    }

    #[test]
    fn detects_supported_shells_without_guessing_unknown_names() {
        assert_eq!(
            TerminalShellKind::detect("/bin/bash"),
            TerminalShellKind::Bash
        );
        assert_eq!(
            TerminalShellKind::detect("/bin/zsh"),
            TerminalShellKind::Zsh
        );
        assert_eq!(
            TerminalShellKind::detect(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
            TerminalShellKind::WindowsPowerShell
        );
        assert_eq!(
            TerminalShellKind::detect("pwsh.exe"),
            TerminalShellKind::PowerShell7
        );
        assert_eq!(
            TerminalShellKind::detect("/bin/fish"),
            TerminalShellKind::Unsupported
        );
    }

    #[test]
    fn control_protocol_is_binary_framed_and_preserves_newlines_and_unicode() {
        let bytes = b"R\0zsh\0P\0/tmp/\xe7\xbb\x88\xe7\xab\xaf\0Q\0S\0printf one; printf two\0/tmp\0E\07\0/tmp\0";
        let mut events = Vec::new();
        read_control_events(&mut bytes.as_slice(), &mut |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert_eq!(events.len(), 5);
        assert_eq!(
            events[3],
            TerminalIntegrationControlEvent::CommandStart {
                command_line: "printf one; printf two".into(),
                cwd: "/tmp".into(),
            }
        );
        assert_eq!(
            events[4],
            TerminalIntegrationControlEvent::CommandEnd {
                exit_code: 7,
                cwd: "/tmp".into(),
            }
        );
    }

    #[test]
    fn malformed_or_oversized_control_records_fail_closed() {
        assert!(read_control_events(&mut b"S\0unterminated".as_slice(), &mut |_| Ok(())).is_err());
        let oversized = vec![b'x'; MAX_CONTROL_FIELD_BYTES + 1];
        assert!(read_control_events(&mut oversized.as_slice(), &mut |_| Ok(())).is_err());
    }

    #[test]
    fn powershell_contract_has_no_nested_shell_or_terminal_markers() {
        for shell in [
            TerminalShellKind::WindowsPowerShell,
            TerminalShellKind::PowerShell7,
        ] {
            let script = powershell_bootstrap("pipe-id", shell);
            assert!(script.contains("$__shellspanModule = New-Module"));
            assert!(script.contains("NamedPipeServerStream"));
            assert!(script.contains("[System.IO.Pipes.PipeDirection]::Out"));
            assert!(script.contains("[System.IO.Pipes.PipeTransmissionMode]::Byte"));
            assert!(script.contains("[System.IO.Pipes.PipeOptions]::None"));
            assert!(
                script.find("WaitForConnection()").unwrap()
                    < script.find("Send-ShellSpanControl @('R'").unwrap()
            );
            assert!(script.contains("AddToHistoryHandler"));
            assert!(script.contains("Start-ShellSpanCommand $CommandLine"));
            if shell == TerminalShellKind::WindowsPowerShell {
                assert!(script.contains("Invoke-ShellSpanFirstEnter"));
                assert!(script.contains(
                    "Set-PSReadLineKeyHandler -Chord Enter -Function $script:OriginalEnterFunction"
                ));
                assert!(script.contains("$script:InstallHistoryOnPrompt = $true"));
            }
            assert!(script.contains("$PreviousSuccess = $?"));
            assert!(script.contains("$global:LASTEXITCODE"));
            assert!(script.contains("$global:LASTEXITCODE -ne 0"));
            assert!(script.contains("(Get-Location).ProviderPath"));
            assert!(!script.contains("PipeOptions]::Inheritable"));
            assert!(!script.contains("EncodedCommand"));
            assert!(!script.contains("BEGIN:"));
            assert!(!script.contains("[Agent]"));
            assert!(!script.contains("powershell.exe -"));
            assert!(!script.contains("pwsh.exe -"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn posix_bootstraps_use_shell_hooks_and_a_non_inherited_fifo() {
        let bash = bash_bootstrap(Path::new("/private/control"), true, true);
        let zsh = zsh_bootstrap(Path::new("/private/control"), true, false);
        assert!(bash.contains("trap '__shellspan_preexec' DEBUG"));
        assert!(bash.contains("READLINE_LINE"));
        assert!(zsh.contains("add-zsh-hook preexec"));
        assert!(zsh.contains("add-zle-hook-widget line-init"));
        for script in [bash, zsh] {
            assert!(script.contains(">\"$__shellspan_control_path\""));
            assert!(!script.contains("control_fd"));
            assert!(!script.contains("BEGIN:"));
            assert!(!script.contains("[Agent]"));
            assert!(!script.contains("/bin/sh -c"));
        }
    }

    #[test]
    fn remote_bash_bootstrap_restores_home_without_reloading_system_profile() {
        let script = remote_posix_bootstrap(
            TerminalShellKind::Bash,
            "/tmp/private/control",
            "/home/fixture user's",
        )
        .unwrap();

        assert!(script.starts_with("HOME='/home/fixture user'\"'\"'s'\nexport HOME\n"));
        assert!(script.contains("source \"$HOME/.bash_profile\""));
        assert!(script.contains("source \"$HOME/.bash_login\""));
        assert!(script.contains("source \"$HOME/.profile\""));
        assert!(
            !script.contains("source /etc/profile"),
            "bash -l loads /etc/profile before the private .bash_profile"
        );
    }

    #[test]
    fn remote_zsh_bootstrap_leaves_login_file_order_to_zdotdir() {
        let script = remote_posix_bootstrap(
            TerminalShellKind::Zsh,
            "/tmp/private/control",
            "/home/fixture",
        )
        .unwrap();

        assert!(script.starts_with("[[ -r \"$HOME/.zshrc\" ]]"));
        assert!(script.contains("unset ZDOTDIR"));
        assert!(!script.contains(".zprofile"));
        assert!(!script.contains(".zlogin"));
    }

    #[cfg(unix)]
    #[test]
    fn posix_resources_are_private_bounded_and_cleaned_before_reader_start() {
        use std::os::unix::fs::{FileTypeExt, PermissionsExt};

        for shell in [TerminalShellKind::Bash, TerminalShellKind::Zsh] {
            let (_fixture, integration) = prepare_test_integration(shell);
            let root = integration.bootstrap_root.path().to_path_buf();
            let fifo = root.join("control");
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let fifo_metadata = fs::metadata(&fifo).unwrap();
            assert!(fifo_metadata.file_type().is_fifo());
            assert_eq!(fifo_metadata.permissions().mode() & 0o777, 0o600);
            assert!(fs::read_dir(&root).unwrap().count() <= 5);

            drop(integration);
            assert!(!root.exists(), "startup rollback leaked {}", root.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn posix_reader_stop_and_failure_cleanup_are_bounded() {
        use std::sync::mpsc;

        let (_fixture, integration) = prepare_test_integration(TerminalShellKind::Bash);
        let root = integration.bootstrap_root.path().to_path_buf();
        let mut handle = integration.start_reader(|_| Ok(()), |_| {});
        handle.stop();
        handle.stop();
        drop(handle);
        assert!(!root.exists(), "normal close leaked {}", root.display());

        let (_fixture, integration) = prepare_test_integration(TerminalShellKind::Zsh);
        let root = integration.bootstrap_root.path().to_path_buf();
        let handle = integration.start_reader(|_| Ok(()), |_| {});
        drop(handle);
        assert!(!root.exists(), "disconnect leaked {}", root.display());

        let (_fixture, integration) = prepare_test_integration(TerminalShellKind::Bash);
        let root = integration.bootstrap_root.path().to_path_buf();
        let fifo = root.join("control");
        let (closed_tx, closed_rx) = mpsc::channel();
        let handle = integration.start_reader(
            |_| Err("intentional control failure".into()),
            move |error| closed_tx.send(error).unwrap(),
        );
        let mut writer = File::options().write(true).open(&fifo).unwrap();
        writer.write_all(b"R\0bash\0").unwrap();
        writer.flush().unwrap();
        assert_eq!(
            closed_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Some("intentional control failure".into())
        );
        drop(writer);
        drop(handle);
        assert!(!root.exists(), "failed reader leaked {}", root.display());
    }

    #[cfg(unix)]
    #[test]
    fn posix_same_uid_reopen_is_documented_out_of_scope_tampering() {
        let (_fixture, integration) = prepare_test_integration(TerminalShellKind::Zsh);
        let fifo = integration.bootstrap_root.path().join("control");

        let mut same_uid_writer = File::options().write(true).open(&fifo).unwrap();
        same_uid_writer.write_all(b"Q\0").unwrap();

        // This records the cooperative-shell boundary: mode 0700/0600
        // constrains other users but cannot distinguish the interactive shell
        // from deliberately tampering same-UID code once the path is found.
        // Visible terminal is not a sandbox; strong lifecycle work uses Direct.
        drop(same_uid_writer);
        drop(integration);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run_native_visible_command_acceptance(shell_path: &str, shell: TerminalShellKind) {
        use crate::terminal_broker::{
            TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
        };
        use portable_pty::{native_pty_system, PtySize};
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        use std::time::Instant;

        let broker = TerminalSessionBroker::phase3_enabled_for_test(4_096);
        let transport_id = format!("native-{}", shell.protocol_name());
        broker
            .attach_transport(
                &transport_id,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(180, 30),
            )
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 180,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let (_fixture, integration) = prepare_test_integration(shell);
        let integration_root = integration.bootstrap_root.path().to_path_buf();
        let integration_id = integration.integration_id().to_string();
        broker
            .register_integration_channel(&transport_id, &integration_id, shell)
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut command = CommandBuilder::new(shell_path);
        command.env("HOME", home.path());
        command.env("TERM", "xterm-256color");
        command.env("LANG", "C.UTF-8");
        command.env("LC_ALL", "C.UTF-8");
        integration.configure_command(&mut command).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let control_broker = broker.clone();
        let control_transport = transport_id.clone();
        let control_integration = integration_id.clone();
        let closed_broker = broker.clone();
        let closed_transport = transport_id.clone();
        let closed_integration = integration_id.clone();
        let _integration_control = integration.start_reader(
            move |event| {
                control_broker.accept_integration_event(
                    &control_transport,
                    &control_integration,
                    event,
                )
            },
            move |error| {
                if error.is_some() {
                    let _ = closed_broker.integration_channel_closed(
                        &closed_transport,
                        &closed_integration,
                        "controlChannelFailed",
                    );
                }
            },
        );
        let display = Arc::new(Mutex::new(Vec::<u8>::new()));
        let display_reader = Arc::clone(&display);
        let output_broker = broker.clone();
        let output_transport = transport_id.clone();
        let output_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        display_reader
                            .lock()
                            .unwrap()
                            .extend_from_slice(&buffer[..count]);
                        output_broker
                            .observe_raw_output(&output_transport, &buffer[..count])
                            .unwrap();
                    }
                }
            }
        });

        wait_for_prompt(&broker, &transport_id);
        let ready = broker
            .snapshot(Some(&transport_id))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(ready.integration_event_sequence, 3);
        assert_eq!(
            ready.integration_capabilities,
            [
                "promptLifecycle",
                "commandLifecycle",
                "exactCommandLine",
                "exitStatus",
                "currentDirectory",
            ]
        );
        let descendant_fds = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "/bin/sh -c 'for f in /dev/fd/*; do if [ -p \"$f\" ]; then printf \"S\\000forged\\000/tmp\\000\" >\"$f\" 2>/dev/null; exit 9; fi; done; exit 0'",
        );
        assert_eq!(
            descendant_fds.exit_code,
            Some(0),
            "foreground child inherited the integration FIFO"
        );
        let environment = execute_visible(&broker, &writer, &transport_id, shell, "/usr/bin/env");
        let integration_root_text = integration_root.to_string_lossy().into_owned();
        for secret in [
            integration_root_text.as_str(),
            "__shellspan_control_path",
            "shellspan-terminal-integration-",
            integration_id.as_str(),
        ] {
            assert!(
                !environment.combined_output.contains(secret),
                "integration control detail leaked through child environment: {secret}"
            );
        }
        let diagnostic =
            serde_json::to_string(&broker.snapshot(Some(&transport_id)).unwrap()).unwrap();
        assert!(!diagnostic.contains(&integration_root_text));
        execute_visible(&broker, &writer, &transport_id, shell, "PS1=''");
        let empty_prompt = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "printf empty-prompt-independent",
        );
        assert!(empty_prompt
            .combined_output
            .contains("empty-prompt-independent"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "PS1=$'\\n\\033[35mcustom>\\033[0m '",
        );
        let prompt_independent = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "printf prompt-independent",
        );
        assert!(prompt_independent
            .combined_output
            .contains("prompt-independent"));
        let test_cwd = tempfile::tempdir().unwrap();
        let quoted_cwd = shell_single_quote(test_cwd.path().to_str().unwrap());
        let cd = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            &format!("cd {quoted_cwd}"),
        );
        assert_eq!(cd.exit_code, Some(0));
        assert_eq!(cd.cwd.as_deref(), test_cwd.path().to_str());

        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "export SHELLSPAN_PHASE3_VALUE='终端值'",
        );
        let environment = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "printf '%s' \"$SHELLSPAN_PHASE3_VALUE\"",
        );
        assert!(environment.combined_output.contains("终端值"));

        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "alias ss_phase3_alias='printf alias-ok'",
        );
        let alias = execute_visible(&broker, &writer, &transport_id, shell, "ss_phase3_alias");
        assert!(alias.combined_output.contains("alias-ok"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "ss_phase3_function(){ printf function-ok; }",
        );
        let function =
            execute_visible(&broker, &writer, &transport_id, shell, "ss_phase3_function");
        assert!(function.combined_output.contains("function-ok"));

        let option_command = match shell {
            TerminalShellKind::Bash => "set -o noclobber",
            TerminalShellKind::Zsh => "setopt noclobber",
            _ => unreachable!(),
        };
        execute_visible(&broker, &writer, &transport_id, shell, option_command);
        let option_check = match shell {
            TerminalShellKind::Bash => "[[ -o noclobber ]] && printf option-ok",
            TerminalShellKind::Zsh => "[[ -o noclobber ]] && printf option-ok",
            _ => unreachable!(),
        };
        let option = execute_visible(&broker, &writer, &transport_id, shell, option_check);
        assert!(option.combined_output.contains("option-ok"));

        let rich = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "printf '\\033[31m终端\\033[0m'; false",
        );
        assert_eq!(rich.command_line, "printf '\\033[31m终端\\033[0m'; false");
        assert_eq!(rich.exit_code, Some(1));
        assert!(rich.combined_output.contains("\u{1b}[31m终端\u{1b}[0m"));

        for (requested, expected) in [
            (
                crate::terminal_broker::TerminalCommandRequestedSettlement::Cancelled,
                crate::terminal_broker::TerminalCommandState::Cancelled,
            ),
            (
                crate::terminal_broker::TerminalCommandRequestedSettlement::TimedOut,
                crate::terminal_broker::TerminalCommandState::TimedOut,
            ),
            (
                crate::terminal_broker::TerminalCommandRequestedSettlement::TakenOver,
                crate::terminal_broker::TerminalCommandState::TakenOver,
            ),
        ] {
            let interrupted =
                execute_interrupted_visible(&broker, &writer, &transport_id, shell, requested);
            assert_eq!(interrupted.state, expected);
            assert!(interrupted.exit_code.is_some());
        }

        let before_large = display.lock().unwrap().len();
        let large = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "i=0; while (( i < 12000 )); do printf x; (( i++ )); done",
        );
        assert!(large.capture_truncated);
        assert_eq!(large.combined_output.len(), 4_096);
        wait_until(Duration::from_secs(2), || {
            display.lock().unwrap().len() >= before_large + 12_000
        });

        writer.lock().unwrap().write_all(b"exit\n").unwrap();
        writer.lock().unwrap().flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        drop(writer);
        drop(pair.master);
        output_thread.join().unwrap();
        let display_bytes = display.lock().unwrap();
        let display = String::from_utf8_lossy(&display_bytes);
        assert!(!display.contains(&integration_root_text));
        assert!(!display.contains(integration_id.as_str()));
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn execute_visible(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        transport_id: &str,
        shell: TerminalShellKind,
        command: &str,
    ) -> crate::terminal_broker::TerminalCommandSnapshot {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        let operation_id = format!("operation-{}", Uuid::new_v4().simple());
        broker
            .acquire_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
            .unwrap();
        let operation = broker
            .begin_command(transport_id, &operation_id, command)
            .unwrap();
        let input = format!("{}{}", command, shell.enter());
        broker
            .admit_terminal_input(
                transport_id,
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-session".into(),
                    task_id: "task-phase3".into(),
                    operation_id: operation_id.clone(),
                },
                TerminalInputKind::Text,
                input.as_bytes(),
                || {
                    let mut writer = writer.lock().unwrap();
                    writer
                        .write_all(input.as_bytes())
                        .map_err(|error| error.to_string())?;
                    writer.flush().map_err(|error| error.to_string())
                },
            )
            .unwrap();
        let mut snapshot = operation
            .wait_until_terminal(Duration::from_secs(8))
            .unwrap();
        assert!(
            snapshot.state.is_terminal(),
            "command did not settle: {snapshot:?}"
        );
        assert_eq!(
            snapshot.state,
            crate::terminal_broker::TerminalCommandState::Completed,
            "exact lifecycle failed for command {command:?}: {snapshot:?}; broker={:?}",
            broker.snapshot(Some(transport_id)).unwrap()
        );
        thread::sleep(Duration::from_millis(40));
        broker
            .retire_command(transport_id, &snapshot.command_id)
            .unwrap();
        snapshot = operation.snapshot().unwrap();
        broker
            .release_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
            .unwrap();
        wait_for_prompt(broker, transport_id);
        snapshot
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn execute_interrupted_visible(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        transport_id: &str,
        shell: TerminalShellKind,
        requested: crate::terminal_broker::TerminalCommandRequestedSettlement,
    ) -> crate::terminal_broker::TerminalCommandSnapshot {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        use std::io::Write;

        let operation_id = format!("operation-{}", Uuid::new_v4().simple());
        broker
            .acquire_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
            .unwrap();
        let command = "sleep 10";
        let operation = broker
            .begin_command(transport_id, &operation_id, command)
            .unwrap();
        let input = format!("{}{}", command, shell.enter());
        broker
            .admit_terminal_input(
                transport_id,
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-session".into(),
                    task_id: "task-phase3".into(),
                    operation_id: operation_id.clone(),
                },
                TerminalInputKind::Text,
                input.as_bytes(),
                || {
                    let mut writer = writer.lock().unwrap();
                    writer
                        .write_all(input.as_bytes())
                        .map_err(|error| error.to_string())?;
                    writer.flush().map_err(|error| error.to_string())
                },
            )
            .unwrap();
        wait_until(Duration::from_secs(2), || {
            operation.snapshot().is_ok_and(|snapshot| {
                snapshot.state == crate::terminal_broker::TerminalCommandState::Running
            })
        });
        // preexec is emitted immediately before the shell launches the
        // foreground program. Let the PTY foreground process group settle so
        // this acceptance case measures interrupt behavior, not the tiny
        // preexec-to-exec scheduling window.
        thread::sleep(Duration::from_millis(100));
        assert!(operation.request_settlement(requested).unwrap());
        broker
            .admit_terminal_input(
                transport_id,
                TerminalBrokerInputSource::System {
                    operation_id: operation_id.clone(),
                },
                TerminalInputKind::Interrupt,
                &[3],
                || {
                    let mut writer = writer.lock().unwrap();
                    writer.write_all(&[3]).map_err(|error| error.to_string())?;
                    writer.flush().map_err(|error| error.to_string())
                },
            )
            .unwrap();
        if requested == crate::terminal_broker::TerminalCommandRequestedSettlement::TakenOver {
            broker
                .release_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
                .unwrap();
            assert!(broker
                .admit_terminal_input(
                    transport_id,
                    TerminalBrokerInputSource::Agent {
                        agent_session_id: "agent-session".into(),
                        task_id: "task-phase3".into(),
                        operation_id: operation_id.clone(),
                    },
                    TerminalInputKind::Text,
                    b"rejected",
                    || panic!("post-takeover Agent input reached the terminal"),
                )
                .is_err());
        }
        let mut snapshot = operation
            .wait_until_terminal(Duration::from_secs(3))
            .unwrap();
        assert!(
            snapshot.state.is_terminal(),
            "{requested:?} interrupt did not settle: {snapshot:?}"
        );
        thread::sleep(Duration::from_millis(40));
        broker
            .retire_command(transport_id, &snapshot.command_id)
            .unwrap();
        snapshot = operation.snapshot().unwrap();
        if requested != crate::terminal_broker::TerminalCommandRequestedSettlement::TakenOver {
            broker
                .release_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
                .unwrap();
        }
        wait_for_prompt(broker, transport_id);
        snapshot
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn wait_for_prompt(broker: &crate::terminal_broker::TerminalSessionBroker, transport_id: &str) {
        use std::time::Instant;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = broker.snapshot(Some(transport_id)).unwrap();
            if snapshot.session.as_ref().is_some_and(|session| {
                session.integration_state == crate::terminal_broker::TerminalIntegrationState::Ready
                    && session.prompt_ready
            }) {
                return;
            }
            assert!(Instant::now() < deadline, "prompt not ready: {snapshot:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) {
        use std::time::Instant;
        let deadline = Instant::now() + timeout;
        while !predicate() {
            assert!(Instant::now() < deadline, "condition did not become true");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn shell_single_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_bash_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/bash", TerminalShellKind::Bash);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_zsh_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/zsh", TerminalShellKind::Zsh);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_native_bash_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/bash", TerminalShellKind::Bash);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_native_zsh_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/zsh", TerminalShellKind::Zsh);
    }

    #[cfg(target_os = "windows")]
    fn run_windows_visible_command_acceptance(executable: &str, shell: TerminalShellKind) {
        use crate::terminal_broker::{
            TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
        };
        use portable_pty::{native_pty_system, PtySize};
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        use std::time::Instant;

        let broker = TerminalSessionBroker::phase3_enabled_for_test(4_096);
        let transport_id = format!("native-{}", shell.protocol_name());
        broker
            .attach_transport(
                &transport_id,
                None,
                TerminalTransportKind::WindowsConPty,
                TerminalGeometry::new(180, 30),
            )
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 180,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let (_fixture, integration) = prepare_test_integration(shell);
        let _history_fixture = if shell == TerminalShellKind::WindowsPowerShell {
            let root = tempfile::tempdir().unwrap();
            let history_path = root.path().join("history.txt");
            fs::write(&history_path, "Write-Output 'saved-history-only'\n").unwrap();
            let bootstrap = fs::read_to_string(&integration.bootstrap_path).unwrap();
            let history_setting = format!(
                "Import-Module PSReadLine\n    Set-PSReadLineOption -HistorySavePath '{}'",
                history_path.to_string_lossy().replace('\'', "''")
            );
            let seeded = bootstrap.replacen("Import-Module PSReadLine", &history_setting, 1);
            fs::write(&integration.bootstrap_path, seeded).unwrap();
            Some(root)
        } else {
            None
        };
        let integration_id = integration.integration_id().to_string();
        broker
            .register_integration_channel(&transport_id, &integration_id, shell)
            .unwrap();
        let mut command = CommandBuilder::new(executable);
        command.env("TERM", "xterm-256color");
        integration.configure_command(&mut command).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let control_broker = broker.clone();
        let control_transport = transport_id.clone();
        let control_integration = integration_id.clone();
        let closed_broker = broker.clone();
        let closed_transport = transport_id.clone();
        let _integration_control = integration.start_reader(
            move |event| {
                control_broker.accept_integration_event(
                    &control_transport,
                    &control_integration,
                    event,
                )
            },
            move |error| {
                if error.is_some() {
                    let _ = closed_broker.integration_channel_closed(
                        &closed_transport,
                        &integration_id,
                        "controlChannelFailed",
                    );
                }
            },
        );
        let display = Arc::new(Mutex::new(Vec::<u8>::new()));
        let display_reader = Arc::clone(&display);
        let output_broker = broker.clone();
        let output_transport = transport_id.clone();
        let output_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        display_reader
                            .lock()
                            .unwrap()
                            .extend_from_slice(&buffer[..count]);
                        output_broker
                            .observe_raw_output(&output_transport, &buffer[..count])
                            .unwrap();
                    }
                }
            }
        });

        wait_for_prompt(&broker, &transport_id);
        let cwd = tempfile::tempdir().unwrap();
        let path = cwd.path().to_string_lossy().replace('\'', "''");
        let changed = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            &format!("Set-Location -LiteralPath '{path}'"),
        );
        let reported_cwd = std::path::Path::new(changed.cwd.as_deref().unwrap())
            .canonicalize()
            .unwrap();
        assert_eq!(reported_cwd, cwd.path().canonicalize().unwrap());
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "$env:SHELLSPAN_PHASE3_VALUE='终端值'",
        );
        let environment = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "[Console]::Write($env:SHELLSPAN_PHASE3_VALUE)",
        );
        assert!(environment.combined_output.contains("终端值"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "Set-Alias -Name ss_phase3_alias -Value Write-Output",
        );
        let alias = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "ss_phase3_alias alias-ok",
        );
        assert!(alias.combined_output.contains("alias-ok"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "function ss_phase3_function { [Console]::Write('function-ok') }",
        );
        let function =
            execute_visible(&broker, &writer, &transport_id, shell, "ss_phase3_function");
        assert!(function.combined_output.contains("function-ok"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "$ErrorActionPreference='Continue'",
        );
        let rich = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "[Console]::Write(\"`e[31m终端`e[0m\")",
        );
        assert_eq!(rich.exit_code, Some(0));
        assert!(rich.combined_output.contains("终端"));
        let native_failure = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "cmd.exe /d /c exit 7",
        );
        assert_eq!(native_failure.exit_code, Some(7));
        let cmdlet_failure = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "$global:LASTEXITCODE=0; Write-Error expected",
        );
        assert_eq!(cmdlet_failure.exit_code, Some(1));
        let before_large = display.lock().unwrap().len();
        let large = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "1..12000 | ForEach-Object { [Console]::Write('x') }",
        );
        assert!(large.capture_truncated);
        wait_until(Duration::from_secs(3), || {
            display.lock().unwrap().len() >= before_large + 12_000
        });

        writer.lock().unwrap().write_all(b"exit\r").unwrap();
        writer.lock().unwrap().flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        drop(writer);
        drop(pair.master);
        output_thread.join().unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires native Windows PowerShell 5.1 and ConPTY"]
    fn windows_powershell_5_1_visible_command_integration() {
        run_windows_visible_command_acceptance(
            "powershell.exe",
            TerminalShellKind::WindowsPowerShell,
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires native PowerShell 7 and ConPTY"]
    fn windows_powershell_7_visible_command_integration() {
        run_windows_visible_command_acceptance("pwsh.exe", TerminalShellKind::PowerShell7);
    }
