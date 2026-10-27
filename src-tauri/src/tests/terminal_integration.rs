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
    fn bundled_powershell_editor_is_content_addressed_and_refuses_modified_cache() {
        let directory = tempfile::tempdir().unwrap();
        let first = prepare_bundled_powershell_module(directory.path()).unwrap();
        assert_eq!(
            first,
            prepare_bundled_powershell_module(directory.path()).unwrap()
        );
        assert!(first.starts_with(directory.path()));
        let module = first.join("PSReadLine/2.4.5/Microsoft.PowerShell.PSReadLine.dll");
        let original = fs::read(&module).unwrap();
        let mut changed = original;
        changed[0] ^= 1;
        fs::write(&module, changed).unwrap();
        assert!(prepare_bundled_powershell_module(directory.path())
            .unwrap_err()
            .contains("integrity mismatch"));
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
        let bytes = b"R\0zsh\0P\0/tmp/\xe7\xbb\x88\xe7\xab\xaf\0Q\0S\0printf one; printf two\0/tmp\0E\x007\0/tmp\0";
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
    fn native_input_control_records_are_framed_bounded_and_strict() {
        let bytes = b"I\x001\0J\0printf one\nprintf two\0TERMINAL_INPUT_UNSUPPORTED\0W\0";
        let mut decoder = TerminalIntegrationStreamDecoder::default();
        let mut events = Vec::new();
        for byte in bytes {
            events.extend(decoder.push(&[*byte]).unwrap());
        }
        decoder.finish().unwrap();
        assert_eq!(
            events,
            vec![
                TerminalIntegrationControlEvent::NativeInput { enabled: true },
                TerminalIntegrationControlEvent::InputRejected {
                    command_line: "printf one\nprintf two".into(),
                    reason: "TERMINAL_INPUT_UNSUPPORTED".into()
                },
                TerminalIntegrationControlEvent::NativePrivateReady,
            ]
        );
        let mut local_events = Vec::new();
        read_control_events(&mut bytes.as_slice(), &mut |event| {
            local_events.push(event);
            Ok(())
        })
        .unwrap();
        assert_eq!(events, local_events);
        assert!(TerminalIntegrationStreamDecoder::default()
            .push(b"I\x002\0")
            .is_err());
        assert!(read_control_events(&mut b"I\0maybe\0".as_slice(), &mut |_| Ok(())).is_err());
        assert!(read_control_events(&mut b"J\0incomplete\0".as_slice(), &mut |_| Ok(())).is_err());
        for bytes in [
            b"C\x001\0".as_slice(),
            b"C\x000\0".as_slice(),
            b"U\0".as_slice(),
        ] {
            let mut decoder = TerminalIntegrationStreamDecoder::default();
            let decoded = decoder.push(bytes).unwrap();
            let mut local = Vec::new();
            let mut reader = bytes;
            read_control_events(&mut reader, &mut |event| {
                local.push(event);
                Ok(())
            })
            .unwrap();
            assert_eq!(decoded, local);
        }
        assert!(TerminalIntegrationStreamDecoder::default()
            .push(b"C\0unexpected\0")
            .is_err());
    }

    #[test]
    fn native_checkpoints_and_job_records_are_exact_and_bounded_in_both_decoders() {
        let handle = "job-0123456789abcdef0123456789abcdef";
        for fields in [
            vec!["H", "1"],
            vec!["L", "1", ""],
            vec!["A", "literal '\"\n\r\t"],
            vec!["K", "1"],
            vec!["V", "1"],
            vec![
                "M",
                "p0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "",
            ],
            vec!["B", handle, "running", "-"],
            vec!["F", handle, "7"],
            vec!["B", handle, "settled", "7"],
        ] {
            let bytes = fields.join("\0") + "\0";
            let mut stream = TerminalIntegrationStreamDecoder::default();
            let mut decoded = Vec::new();
            for byte in bytes.as_bytes() {
                decoded.extend(stream.push(&[*byte]).unwrap());
            }
            stream.finish().unwrap();
            let mut local = Vec::new();
            read_control_events(&mut bytes.as_bytes(), &mut |event| {
                local.push(event);
                Ok(())
            })
            .unwrap();
            assert_eq!(decoded, local);
        }
        for mut bytes in [
            b"H\x002\0".as_slice(),
            b"V\x002\0".as_slice(),
            b"M\0descriptor\0missing".as_slice(),
            b"L\x000\0\0".as_slice(),
            b"L\x001\0missing".as_slice(),
            b"A\0missing".as_slice(),
            b"B\0123\0running\0-\0".as_slice(),
        ] {
            let mut decoder = TerminalIntegrationStreamDecoder::default();
            let result = decoder.push(bytes);
            assert!(result.is_err() || decoder.finish().is_err());
            assert!(read_control_events(&mut bytes, &mut |_| Ok(())).is_err());
        }
        let oversized = format!("A\0{}\0", "界".repeat(10923));
        assert!(TerminalIntegrationStreamDecoder::default()
            .push(oversized.as_bytes())
            .is_err());
        assert!(read_control_events(&mut oversized.as_bytes(), &mut |_| Ok(())).is_err());
    }

    #[test]
    fn bash_submission_uses_only_native_eval_with_one_unchanged_source_argument() {
        for source in [
            "printf 'a'\nprintf \"$HOME `literal`\"",
            "cat <<'EOF'\na\tb\rc\nEOF",
            "for x in a b; do printf '%s' \"$x\"; done\n",
        ] {
            let submitted = bash_native_submission(source).unwrap();
            let words = shlex::split(&submitted).unwrap();
            assert_eq!(words[..5], ["(exit", "$?);", "builtin", "eval", "--"]);
            assert_eq!(words[5], source);
            assert_eq!(
                submitted.matches('\n').count(),
                source.matches('\n').count()
            );
        }
        assert!(
            bash_native_submission(&"'\"$`\\\n".repeat(1_300))
                .unwrap()
                .len()
                <= MAX_CONTROL_FIELD_BYTES
        );
    }

    #[test]
    fn powershell_foreground_contract_has_no_nested_shell_or_terminal_markers() {
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
            // The guarded background worker encodes only its trusted pipe
            // bootstrap. Foreground source is still accepted by PSReadLine;
            // neither it nor captured state is placed in process arguments.
            let foreground = script.replace(include_str!("../terminal_job_host.cs"), "");
            assert!(!foreground.contains("EncodedCommand"));
            let worker = include_str!("../terminal_job_host.cs");
            assert!(worker.contains("Unicode.GetBytes(bootstrap)"));
            let arguments = worker
                .split("var start = new System.Diagnostics.ProcessStartInfo")
                .nth(1)
                .unwrap()
                .split("start.UseShellExecute")
                .next()
                .unwrap();
            assert!(arguments.contains("GetBytes(bootstrap)"));
            assert!(!arguments.contains("packet"));
            assert!(!arguments.contains("Source"));
            assert!(
                worker
                    .find("AssignProcessToJobObject(job, process.Handle)")
                    .unwrap()
                    < worker.find("writer.Write(bytes.Length)").unwrap()
            );
            assert!(!script.contains("BEGIN:"));
            assert!(!script.contains("[Agent]"));
            assert!(!script.contains("powershell.exe -"));
            assert!(!script.contains("pwsh.exe -"));
        }
    }

    #[test]
    fn explicit_powershell_history_path_preserves_user_history_policy() {
        let path = Path::new("C:/owned user's data/shell-history/windowsPowerShell.txt");
        let script = powershell_history_redirect(path);
        assert!(script.contains(
            "-HistorySavePath 'C:/owned user''s data/shell-history/windowsPowerShell.txt'"
        ));
        assert!(!script.contains("HistorySaveStyle"));
        assert!(!script.contains("AddToHistoryHandler"));
        assert!(!script.contains("ClearHistory"));
    }

    #[cfg(unix)]
    #[test]
    fn posix_bootstraps_use_shell_hooks_and_a_non_inherited_fifo() {
        let bash = bash_bootstrap(Path::new("/private/control"), true, true);
        let zsh = zsh_bootstrap(Path::new("/private/control"), true, false, Some("/bin/zsh"));
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
            "/bin/bash",
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
            "/bin/zsh",
        )
        .unwrap();

        assert!(script.starts_with("typeset -gr __shellspan_parser_executable='/bin/zsh'"));
        assert!(script.contains("[[ -r \"$HOME/.zshrc\" ]]"));
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
        run_native_visible_command_acceptance_with_screen(shell_path, shell, false);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run_native_visible_command_acceptance_with_screen(
        shell_path: &str,
        shell: TerminalShellKind,
        screen: bool,
    ) {
        run_native_visible_command_acceptance_mode(shell_path, shell, screen, false);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run_native_visible_command_acceptance_mode(
        shell_path: &str,
        shell: TerminalShellKind,
        screen: bool,
        checkpoint_failure: bool,
    ) {
        use crate::terminal_broker::{
            TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
        };
        use portable_pty::{native_pty_system, PtySize};
        use std::sync::{Arc, Mutex};
        use std::time::Instant;

        let user_profile = (shell == TerminalShellKind::Zsh)
            .then(|| std::env::var_os("SHELLSPAN_TEST_NATIVE_ZSH_USER_HOME"))
            .flatten();
        let initial_columns = if user_profile.is_some() && screen {
            32
        } else {
            180
        };
        let expected_native_input = shell == TerminalShellKind::Zsh
            || std::process::Command::new(shell_path)
                .args(["-c", "(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 1) ))"])
                .status()
                .unwrap()
                .success();
        let broker = if screen {
            TerminalSessionBroker::phase5_enabled_for_test(4_096)
        } else {
            TerminalSessionBroker::phase3_enabled_for_test(4_096)
        };
        let transport_id = format!("native-{}", shell.protocol_name());
        broker
            .attach_transport(
                &transport_id,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(initial_columns, 30),
            )
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: u16::try_from(initial_columns).unwrap(),
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(
            crate::local_terminal_input::take_writer(pair.master.as_ref(), shell).unwrap(),
        ));
        let (_fixture, integration) = prepare_test_integration(shell);
        let integration_root = integration.bootstrap_root.path().to_path_buf();
        let integration_id = integration.integration_id().to_string();
        broker
            .register_integration_channel(&transport_id, &integration_id, shell)
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut command = CommandBuilder::new(shell_path);
        command.env(
            "HOME",
            user_profile.as_deref().unwrap_or(home.path().as_os_str()),
        );
        command.env("HISTFILE", home.path().join("history.txt"));
        command.env("TERM", "xterm-256color");
        command.env("LANG", "C.UTF-8");
        command.env("LC_ALL", "C.UTF-8");
        integration.configure_command(&mut command).unwrap();
        if user_profile.is_some() {
            // configure_command regenerates this owned bootstrap. Redirect
            // history afterwards and before the first editable prompt.
            let mut bootstrap = File::options()
                .append(true)
                .open(integration_root.join(".zshrc"))
                .unwrap();
            writeln!(
                bootstrap,
                "HISTFILE={}",
                shell_single_quote(home.path().join("history.txt").to_str().unwrap())
            )
            .unwrap();
        }
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let control_broker = broker.clone();
        let control_transport = transport_id.clone();
        let control_integration = integration_id.clone();
        let closed_broker = broker.clone();
        let closed_transport = transport_id.clone();
        let closed_integration = integration_id.clone();
        let mut integration_control = integration.start_reader(
            move |event| {
                if let Ok(path)=std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
                    let record=match &event {
                        TerminalIntegrationControlEvent::NativeCheckpoint{buffer}=>Some(serde_json::json!({"kind":"A","bytes":buffer.len(),"tail":buffer.chars().rev().take(60).collect::<Vec<_>>().into_iter().rev().collect::<String>()})),
                        TerminalIntegrationControlEvent::CommandStart{command_line,..}=>Some(serde_json::json!({"kind":"S","commandLine":command_line})),
                        TerminalIntegrationControlEvent::InputRejected{command_line,reason}=>Some(serde_json::json!({"kind":"J","commandLine":command_line,"reason":reason})),
                        _=>Some(serde_json::json!({"event":format!("{event:?}")})),
                    };
                    if let Some(record)=record { let mut trace=File::options().create(true).append(true).open(path).unwrap(); writeln!(trace,"{record}").unwrap(); }
                }
                control_broker.accept_integration_event(
                    &control_transport,
                    &control_integration,
                    event,
                )
            },
            move |_| {
                let _ = closed_broker.integration_channel_closed(
                    &closed_transport,
                    &closed_integration,
                    "controlChannelClosed",
                );
            },
        );
        let display = Arc::new(Mutex::new(Vec::<u8>::new()));
        let display_reader = Arc::clone(&display);
        let output_broker = broker.clone();
        let output_transport = transport_id.clone();
        let output_thread = thread::spawn(move || {
            let mut raw_trace = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE")
                .ok()
                .map(|prefix| File::create(format!("{prefix}.full.raw.bin")).unwrap());
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if let Some(trace) = raw_trace.as_mut() {
                            trace.write_all(&buffer[..count]).unwrap();
                        }
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
        assert_eq!(
            ready.integration_event_sequence,
            if shell == TerminalShellKind::Zsh {
                8
            } else {
                7
            }
        );
        let mut expected_capabilities = vec![
            "promptLifecycle",
            "commandLifecycle",
            "exactCommandLine",
            "exitStatus",
            "currentDirectory",
        ];
        if expected_native_input {
            expected_capabilities.push("nativeScriptInput");
            expected_capabilities.push("nativeJobControl");
        }
        assert_eq!(ready.integration_capabilities, expected_capabilities);
        let integration_root_text = integration_root.to_string_lossy().into_owned();
        let typing_display_start;
        // Keep the native cwd alive through all later parser/job checks.
        let test_cwd = tempfile::tempdir().unwrap();
        if user_profile.is_none() {
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
            let environment =
                execute_visible(&broker, &writer, &transport_id, shell, "/usr/bin/env");
            for secret in [
                integration_root_text.as_str(),
                "__shellspan_control_path",
                "SHELLSPAN_NATIVE_PARSER",
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

            // Observe real PTY display before completion, then require the tool
            // capture to contain the same unmodified bytes from that stream.
            let streaming_start = display.lock().unwrap().len();
            let streaming = thread::scope(|scope| {
                let command = scope.spawn(|| {
                    execute_visible(
                        &broker,
                        &writer,
                        &transport_id,
                        shell,
                        "printf '\\033[32mstage-one-stream\\033[0m'; sleep 2; printf stage-one-end",
                    )
                });
                wait_until(Duration::from_secs(2), || {
                    let bytes = display.lock().unwrap();
                    bytes[streaming_start..]
                        .windows(b"\x1b[32mstage-one-stream\x1b[0m".len())
                        .any(|part| part == b"\x1b[32mstage-one-stream\x1b[0m")
                });
                assert!(
                    !command.is_finished(),
                    "raw display arrived only after command completion"
                );
                command.join().unwrap()
            });
            assert_eq!(streaming.exit_code, Some(0));
            assert!(streaming
                .combined_output
                .contains("\x1b[32mstage-one-stream\x1b[0m"));
            assert!(streaming.combined_output.contains("stage-one-end"));

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

            typing_display_start = display.lock().unwrap().len();
            if screen {
                // Exercise animated input across several actual terminal rows.
                pair.master
                    .resize(PtySize {
                        rows: 30,
                        cols: 32,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .unwrap();
                broker
                    .resize(&transport_id, TerminalGeometry::new(32, 30))
                    .unwrap();
                // The earlier lifecycle test intentionally uses raw ANSI in PS1.
                // Use a width-correct prompt for the wrapping/display regression.
                execute_visible(&broker, &writer, &transport_id, shell, "PS1='typing> '");
                execute_visible(&broker, &writer, &transport_id, shell, "clear");
            }
        } else {
            typing_display_start = display.lock().unwrap().len();
            let history = execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "printf '%s' \"$HISTFILE\"; (( ${+functions[prompt_powerlevel9k_setup]} ))",
            );
            assert_eq!(
                history.exit_code,
                Some(0),
                "real Powerlevel prompt was not loaded"
            );
            assert!(history
                .combined_output
                .contains(home.path().join("history.txt").to_str().unwrap()));
            for source in [
                "export SHELLSPAN_PHASE3_VALUE='终端值'",
                "alias ss_phase3_alias='printf alias-ok'",
                "ss_phase3_function(){ printf function-ok; }",
                "setopt noclobber",
            ] {
                assert_eq!(
                    execute_visible(&broker, &writer, &transport_id, shell, source).exit_code,
                    Some(0)
                );
            }
        }
        verify_native_command_typing(
            &broker,
            &writer,
            &transport_id,
            shell,
            &mut integration_control,
            &display,
            typing_display_start,
            expected_native_input,
            checkpoint_failure,
        );
        // The final case intentionally loses integration while input is pending.
        // Teardown must not bypass the recovery guard by injecting an exit line.
        child.kill().unwrap();
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
        assert!(
            !display.contains(&integration_root_text),
            "{}",
            display
                .lines()
                .filter(|line| line.contains(&integration_root_text))
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert!(!display.contains(integration_id.as_str()));
        if shell == TerminalShellKind::Bash && expected_native_input {
            assert!(
                !display.contains("error setting terminal attributes"),
                "native receive reported a tty attribute failure: {display}"
            );
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn verify_native_command_typing(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        transport_id: &str,
        shell: TerminalShellKind,
        integration_control: &mut TerminalIntegrationControlHandle,
        display: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        typing_display_start: usize,
        expected_native_input: bool,
        checkpoint_failure: bool,
    ) {
        use crate::agent_runtime::{
            TerminalCommandPhase, TerminalExecuteRegistry, TerminalExecuteValidationStage,
            TerminalLeaseEventState, TerminalLeaseManager,
        };
        use crate::models::{
            ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
            SessionStatus, SessionTerminalKind, StatusEvent,
        };
        use crate::terminal_broker::TerminalCommandState;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};
        use std::time::Instant;

        let leases = TerminalLeaseManager::new(broker.clone());
        let acknowledger = leases.clone();
        let reduced_motion = Arc::new(AtomicBool::new(false));
        let preference = Arc::clone(&reduced_motion);
        let phases = Arc::new(Mutex::new(Vec::new()));
        let observed_phases = Arc::clone(&phases);
        let native_script_lease = Arc::new(Mutex::new(None));
        let observed_script_lease = Arc::clone(&native_script_lease);
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == TerminalLeaseEventState::Acquired {
                    if event.operation_id == "native-script" {
                        assert_eq!(event.command_execution, Some(true));
                        assert!(event.command_display.is_none());
                        *observed_script_lease.lock().unwrap() = Some(event.clone());
                    }
                    acknowledger
                        .set_reduced_motion(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            preference.load(Ordering::SeqCst),
                        )
                        .unwrap();
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
                if let Some(phase) = event.command_phase {
                    observed_phases.lock().unwrap().push(phase);
                }
            }))
            .unwrap();
        let registry = TerminalExecuteRegistry::new(leases.clone(), broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = crossbeam_channel::unbounded();
        sessions
            .insert(
                transport_id.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: transport_id.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: shell.protocol_name().into(),
                        host: "local".into(),
                        port: 0,
                        username: "".into(),
                    },
                },
            )
            .unwrap();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let observed_writes = Arc::clone(&writes);
        let transport_writer = Arc::clone(writer);
        let worker = thread::spawn(move || {
            while let Ok(SessionCommand::Write(input)) = receiver.recv() {
                let mut writer = transport_writer.lock().unwrap();
                writer.write_all(input.as_bytes()).unwrap();
                writer.flush().unwrap();
                observed_writes
                    .lock()
                    .unwrap()
                    .push((Instant::now(), input));
            }
        });
        let output = tempfile::tempdir().unwrap();
        for readonly_locale in [false, true] {
            if shell != TerminalShellKind::Bash || !expected_native_input || checkpoint_failure {
                break;
            }
            // Exercise the production receiver and then let real Readline move
            // left and insert a character before a separate bind-x snapshot.
            // Reading the callback's assigned number alone would miss a
            // character/byte offset mismatch when Readline applies the value.
            let label = if readonly_locale {
                "cursor-readonly"
            } else {
                "cursor"
            };
            let snapshot = output.path().join(format!("native-{label}-buffer"));
            let locale_setup = if readonly_locale {
                "readonly LC_ALL; "
            } else {
                ""
            };
            let setup = format!(
                "{locale_setup}__shellspan_native_frame_checkpoint() {{ if [[ $1 == cursor ]]; then builtin printf '%s' \"$READLINE_LINE\" >| {}; else __shellspan_emit M \"$1\" \"$READLINE_LINE\"; fi; }}; bind -x '\"\\C-x\\C-y\":__shellspan_native_frame_checkpoint cursor'",
                shell_single_quote(snapshot.to_str().unwrap())
            );
            assert_eq!(
                execute_visible(broker, writer, transport_id, shell, &setup).exit_code,
                Some(0)
            );
            let source = "printf '中文🙂'";
            // The read-only case uses the actual foreground eval envelope.
            // Its frame contains both original source and displayed line.
            let submitted = if readonly_locale {
                bash_native_submission(source).unwrap()
            } else {
                source.to_owned()
            };
            let original_length =
                bash_native_eval_source(&submitted).map_or(0, |original| original.len() * 4);
            let encoded = crate::agent_runtime::native_editor_chunks(&submitted, shell)[0]
                .0
                .clone();
            let geometry = broker
                .snapshot(Some(transport_id))
                .unwrap()
                .session
                .unwrap()
                .geometry;
            let descriptor = format!(
                "b{:05x}{:04x}{:04x}{:04x}{}{}",
                encoded.len(),
                original_length,
                geometry.rows,
                geometry.columns,
                &Uuid::new_v4().simple().to_string()[..15],
                Uuid::new_v4().simple()
            );
            let display_start = display.lock().unwrap().len();
            {
                let mut input = writer.lock().unwrap();
                write!(input, "\u{18}\u{2}{descriptor}{encoded}\u{2}X\u{18}\u{19}").unwrap();
                input.flush().unwrap();
            }
            wait_until(Duration::from_secs(3), || {
                fs::metadata(&snapshot)
                    .is_ok_and(|metadata| metadata.len() == (submitted.len() + 1) as u64)
            });
            let actual = fs::read_to_string(&snapshot).unwrap();
            // Clear through the production discard widget before assertions,
            // so a failing cursor test never accepts the staged source.
            {
                let mut input = writer.lock().unwrap();
                input.write_all(b"\x18\x04").unwrap();
                input.flush().unwrap();
            }
            assert_eq!(
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "bind -r '\"\\C-x\\C-y\"'; __shellspan_native_frame_checkpoint() { __shellspan_emit M \"$1\" \"$READLINE_LINE\"; }; [[ $LC_ALL == C.UTF-8 ]]"
                )
                .exit_code,
                Some(0)
            );
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                fs::write(
                    format!("{prefix}.{label}.raw.bin"),
                    &display.lock().unwrap()[display_start..],
                )
                .unwrap();
                fs::write(format!("{prefix}.{label}.buffer.txt"), &actual).unwrap();
            }
            let mut expected = submitted.clone();
            let last = expected.pop().unwrap();
            expected.push('X');
            expected.push(last);
            assert_eq!(
                actual, expected,
                "{label}: native Readline did not apply the multibyte end-of-line position"
            );
            assert!(
                !String::from_utf8_lossy(&display.lock().unwrap()[display_start..])
                    .contains("LC_ALL: readonly variable"),
                "the native receiver attempted to change a read-only locale"
            );
            if readonly_locale {
                assert_eq!(
                    execute_visible(
                        broker,
                        writer,
                        transport_id,
                        shell,
                        "[[ $LC_ALL == C.UTF-8 ]] && ! (LC_ALL=C) 2>/dev/null"
                    )
                    .exit_code,
                    Some(0),
                    "the receiver changed LC_ALL or removed its read-only attribute"
                );
            }
        }
        if shell == TerminalShellKind::Zsh && !checkpoint_failure {
            assert!(!broker.has_active_shell_jobs(transport_id).unwrap());
            let label = format!("FOREGROUND-ONCE-{}", Uuid::new_v4().simple());
            let effect = output.path().join("foreground-once");
            fs::write(&effect, "").unwrap();
            let source = format!(
                "printf '{label}\\n'\nprintf once >> {}",
                shell_single_quote(effect.to_str().unwrap())
            );
            let operation = registry
                .start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "foreground-source-once",
                    &source,
                    shell.enter(),
                )
                .unwrap();
            let result = registry
                .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
            assert_eq!(result.exit_code, Some(0), "{result:?}");
            wait_for_prompt(broker, transport_id);
            assert_eq!(fs::read_to_string(&effect).unwrap(), "once");
            let geometry = broker
                .snapshot(Some(transport_id))
                .unwrap()
                .session
                .unwrap()
                .geometry;
            let bytes = display.lock().unwrap().clone();
            let (cells, _) = native_display_cells(&bytes, geometry);
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                fs::write(format!("{prefix}.foreground-once.cells.txt"), &cells).unwrap();
            }
            assert_eq!(
                cells.matches(&format!("printf '{label}\\n'")).count(),
                1,
                "multiline foreground source without jobs must be shown exactly once"
            );
            leases.release_turn("typing-agent").unwrap();
        }
        if checkpoint_failure {
            assert!(expected_native_input);
            let delayed_frame = output.path().join("delayed-source-frame");
            let checkpoint_definition = if shell == TerminalShellKind::Bash {
                format!("__shellspan_native_frame_checkpoint() {{ if [[ -z $READLINE_LINE ]]; then __shellspan_emit M \"$1\" \"$READLINE_LINE\"; else builtin printf '%s\\0' M \"$1\" \"$READLINE_LINE\" >| {}; fi; }}", shell_single_quote(delayed_frame.to_str().unwrap()))
            } else {
                format!("__shellspan_native_frame_checkpoint() {{ if [[ -z $BUFFER ]]; then __shellspan_emit M \"$1\" \"$BUFFER\"; else builtin printf '%s\\0' M \"$1\" \"$BUFFER\" >| {}; fi; }}", shell_single_quote(delayed_frame.to_str().unwrap()))
            };
            let operation = registry
                .start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "disable-native-checkpoint",
                    &checkpoint_definition,
                    shell.enter(),
                )
                .unwrap();
            assert_eq!(
                registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                    .unwrap()
                    .exit_code,
                Some(0)
            );
            wait_for_prompt(broker, transport_id);
            let mut previous_frame = None;
            for takeover in [false, true] {
                let id = format!("checkpoint-wait-cancel-{}", Uuid::new_v4());
                let effect = output.path().join(&id);
                let source = format!(
                    "printf should-never-run >| {}",
                    shell_single_quote(effect.to_str().unwrap())
                );
                let target = crate::agent_runtime::AgentToolTargetNative::Local {
                    target_id: "checkpoint-fault-owner".into(),
                    session_id: transport_id.into(),
                    cwd: None,
                };
                let job = broker
                    .prepare_shell_job(
                        transport_id,
                        &target,
                        "typing-agent",
                        "typing-task",
                        &id,
                        &source,
                    )
                    .unwrap();
                let first =
                    crate::agent_runtime::native_editor_chunks(&job.submitted_command_line, shell)
                        .first()
                        .unwrap()
                        .0
                        .clone();
                let before = writes.lock().unwrap().len();
                let operation = thread::scope(|scope| {
                    let typing = scope.spawn(|| {
                        registry.start_native_submission(
                            &sessions,
                            transport_id,
                            "typing-agent",
                            "typing-task",
                            &id,
                            &source,
                            shell.enter(),
                            Some(&job.submitted_command_line),
                            |_| Ok(()),
                        )
                    });
                    wait_until(Duration::from_secs(5), || {
                        writes.lock().unwrap()[before..]
                            .iter()
                            .any(|(_, wire)| wire == &first)
                    });
                    if let Some(event) = previous_frame.clone() {
                        let integration = broker
                            .snapshot(Some(transport_id))
                            .unwrap()
                            .session
                            .unwrap()
                            .integration_id
                            .unwrap();
                        broker
                            .accept_integration_event(transport_id, &integration, event)
                            .unwrap();
                        assert!(
                            broker.native_input_enabled(transport_id).unwrap(),
                            "a retired nonce quarantined its successor"
                        );
                        thread::sleep(Duration::from_millis(200));
                        assert!(
                            !typing.is_finished(),
                            "a retired nonce confirmed its successor's frame"
                        );
                        assert!(!writes.lock().unwrap()[before..]
                            .iter()
                            .any(|(_, wire)| wire == "\u{18}\u{5}"));
                    }
                    let cancel_started = Instant::now();
                    if takeover {
                        registry
                            .takeover(&sessions, transport_id, "typing-agent", &id)
                            .unwrap();
                    } else {
                        registry.cancel_task(&sessions, "typing-task").unwrap();
                    }
                    let operation = typing.join().unwrap().unwrap();
                    assert!(
                        cancel_started.elapsed() < Duration::from_secs(1),
                        "checkpoint cancellation did not wake its waiter"
                    );
                    operation
                });
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                    .unwrap();
                assert_eq!(
                    result.state,
                    if takeover {
                        TerminalCommandState::TakenOver
                    } else {
                        TerminalCommandState::Cancelled
                    }
                );
                wait_for_prompt(broker, transport_id);
                assert!(!effect.exists());
                let after = writes.lock().unwrap();
                assert_eq!(
                    after[before..].len(),
                    5,
                    "a cancelled checkpoint sent more chunks or a final accept key"
                );
                assert_eq!(
                    after[before + 4].1,
                    if matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh) {
                        "\u{18}\u{4}"
                    } else {
                        "\u{3}"
                    }
                );
                drop(after);
                if matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh) {
                    let mut events = Vec::new();
                    let bytes = fs::read(&delayed_frame).unwrap();
                    read_control_events(&mut bytes.as_slice(), &mut |event| {
                        events.push(event);
                        Ok(())
                    })
                    .unwrap();
                    assert_eq!(events.len(), 1);
                    assert!(
                        matches!(&events[0], TerminalIntegrationControlEvent::NativePrivateCheckpoint { descriptor, buffer } if descriptor.starts_with(if shell == TerminalShellKind::Bash { 'b' } else { 'e' }) && buffer == &job.submitted_command_line)
                    );
                    previous_frame = events.pop();
                }
                assert_eq!(
                    broker
                        .shell_job(
                            &job.process_handle,
                            "checkpoint-fault-owner",
                            "typing-agent",
                            "typing-task"
                        )
                        .unwrap()
                        .state,
                    "rejected"
                );
                leases.release_turn("typing-agent").unwrap();
            }
            let effect = output.path().join("should-never-run");
            let source = format!(
                "printf should-never-run >| {}\nprintf tail",
                shell_single_quote(effect.to_str().unwrap())
            );
            let error = registry
                .start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "lost-native-checkpoint",
                    &source,
                    shell.enter(),
                )
                .unwrap_err();
            assert!(
                error.contains("TERMINAL_INPUT_RECOVERY_REQUIRED"),
                "{error}"
            );
            if matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh) {
                let integration = broker
                    .snapshot(Some(transport_id))
                    .unwrap()
                    .session
                    .unwrap()
                    .integration_id
                    .unwrap();
                let bytes = fs::read(&delayed_frame).unwrap();
                read_control_events(&mut bytes.as_slice(), &mut |event| {
                    broker.accept_integration_event(transport_id, &integration, event)
                })
                .unwrap();
                assert!(
                    !broker.native_input_enabled(transport_id).unwrap(),
                    "a late real frame released recovery after its deadline"
                );
            }
            wait_for_prompt(broker, transport_id);
            let admitted = broker.admit_terminal_input(
                transport_id,
                crate::terminal_broker::TerminalBrokerInputSource::User,
                crate::terminal_broker::TerminalInputKind::Text,
                b"\n",
                || panic!("quarantined input was forwarded after an ordinary trusted prompt"),
            );
            assert!(admitted
                .unwrap_err()
                .contains("TERMINAL_INPUT_RECOVERY_REQUIRED"));
            assert!(
                !effect.exists(),
                "source executed after an unacknowledged native edit"
            );
            assert!(!broker.native_input_enabled(transport_id).unwrap());
            leases.release_turn("typing-agent").unwrap();
            sessions.remove(transport_id).unwrap();
            worker.join().unwrap();
            return;
        }
        assert_eq!(
            broker.native_input_enabled(transport_id).unwrap(),
            expected_native_input
        );
        if expected_native_input {
            reduced_motion.store(true, Ordering::SeqCst);
            let draft_effect = output.path().join("preserved-user-draft");
            let agent_effect = output.path().join("agent-must-not-run");
            let draft = format!(
                "printf '%s' draft-preserved >| {}",
                shell_single_quote(draft_effect.to_str().unwrap())
            );
            leases
                .write(
                    &sessions,
                    transport_id,
                    draft,
                    crate::agent_runtime::TerminalInputSource::User,
                )
                .unwrap();
            let attempted = format!(
                "printf forbidden >| {}\nprintf tail",
                shell_single_quote(agent_effect.to_str().unwrap())
            );
            let error = registry
                .start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "existing-user-draft",
                    &attempted,
                    shell.enter(),
                )
                .unwrap_err();
            assert!(error.contains("TERMINAL_FRONTEND_PENDING_INPUT"), "{error}");
            leases.release_turn("typing-agent").unwrap();
            leases
                .write(
                    &sessions,
                    transport_id,
                    shell.enter().into(),
                    crate::agent_runtime::TerminalInputSource::User,
                )
                .unwrap();
            wait_for_prompt(broker, transport_id);
            assert_eq!(
                fs::read_to_string(&draft_effect).unwrap(),
                "draft-preserved",
                "an agent probe or cancellation erased the existing user draft"
            );
            assert!(!agent_effect.exists());
            if shell == TerminalShellKind::Bash {
                let effect = output.path().join("fresh-native-interrupt");
                let script = format!("printf '\\033[31mfresh-native-running\\033[0m'\nsleep 10\nprintf forbidden >| {}", shell_single_quote(effect.to_str().unwrap()));
                let start = display.lock().unwrap().len();
                let operation = registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        "fresh-native-interrupt",
                        &script,
                        shell.enter(),
                    )
                    .unwrap();
                wait_until(Duration::from_secs(3), || {
                    display.lock().unwrap()[start..]
                        .windows(b"\x1b[31mfresh-native-running\x1b[0m".len())
                        .any(|bytes| bytes == b"\x1b[31mfresh-native-running\x1b[0m")
                });
                registry.cancel_task(&sessions, "typing-task").unwrap();
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(3))
                    .unwrap();
                assert_eq!(result.state, TerminalCommandState::Cancelled);
                wait_for_prompt(broker, transport_id);
                assert!(
                    !effect.exists(),
                    "native receive changed SIGINT semantics before any background job"
                );
                leases.release_turn("typing-agent").unwrap();
            }
            verify_native_shell_jobs(
                broker,
                &registry,
                &sessions,
                transport_id,
                shell,
                display,
                &writes,
                writer,
                &leases,
            );
            if shell == TerminalShellKind::Zsh
                && std::env::var_os("SHELLSPAN_TEST_NATIVE_ZSH_USER_HOME").is_some()
            {
                leases.release_turn("typing-agent").unwrap();
                sessions.remove(transport_id).unwrap();
                worker.join().unwrap();
                return;
            }
            reduced_motion.store(false, Ordering::SeqCst);
            let file = output.path().join("native-script");
            fs::write(&file, "").unwrap();
            let command = format!("export SHELLSPAN_NATIVE_SCRIPT=kept\nprintf '%s\\n' 'first' >> {}\ncat <<'SHELLSPAN_END'\nquoted '\"' and\tliteral Tab\nSHELLSPAN_END\nprintf '%s\\n' \"$SHELLSPAN_NATIVE_SCRIPT\" >> {}", shell_single_quote(file.to_str().unwrap()), shell_single_quote(file.to_str().unwrap()));
            let native_display_start = display.lock().unwrap().len();
            let operation = registry
                .start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "native-script",
                    &command,
                    shell.enter(),
                )
                .unwrap();
            let result = registry
                .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
            assert_eq!(result.command_line, command);
            assert_eq!(
                result.submitted_command_line,
                if shell == TerminalShellKind::Bash {
                    Some(bash_native_submission(&command).unwrap())
                } else {
                    None
                }
            );
            assert_eq!(result.exit_code, Some(0), "{result:?}");
            assert!(
                result
                    .combined_output
                    .contains("quoted '\"' and\tliteral Tab"),
                "{result:?}"
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), "first\nkept\n");
            if let Ok(path) = std::env::var("SHELLSPAN_NATIVE_SCRIPT_TRACE_PATH") {
                fs::write(&path, &display.lock().unwrap()[native_display_start..]).unwrap();
                let geometry = broker
                    .snapshot(Some(transport_id))
                    .unwrap()
                    .session
                    .unwrap()
                    .geometry;
                fs::write(format!("{path}.json"), serde_json::to_vec(&serde_json::json!({ "commandLine": result.command_line, "submittedCommandLine": result.submitted_command_line, "columns": geometry.columns, "rows": geometry.rows, "leaseEvent": native_script_lease.lock().unwrap().clone().expect("real native script acquisition") })).unwrap()).unwrap();
            }
            wait_for_prompt(broker, transport_id);
            leases.release_turn("typing-agent").unwrap();
            let inherited = execute_visible(broker, writer, transport_id, shell, "[[ -o noclobber ]] && ss_phase3_alias; ss_phase3_function; printf ':%s:%s' \"$SHELLSPAN_NATIVE_SCRIPT\" \"$SHELLSPAN_PHASE3_VALUE\"");
            assert!(
                inherited
                    .combined_output
                    .contains("alias-okfunction-ok:kept:终端值"),
                "native script lost current shell state: {inherited:?}"
            );
            execute_visible(broker, writer, transport_id, shell, "false");
            let script = "printf 'previous-status:%s\\n' \"$?\"\nalias ss_native_same_buffer='printf new-alias-kept'\nss_native_same_buffer\n";
            let operation = registry
                .start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "native-status-alias",
                    script,
                    shell.enter(),
                )
                .unwrap();
            let result = registry
                .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
            assert_eq!(
                result.exit_code,
                Some(if shell == TerminalShellKind::Zsh {
                    127
                } else {
                    0
                }),
                "{result:?}"
            );
            assert!(
                result.combined_output.contains("previous-status:1\r\n"),
                "native dispatch lost the preceding exit status: {result:?}"
            );
            if shell == TerminalShellKind::Bash {
                assert!(
                    result
                        .combined_output
                        .contains("previous-status:1\r\nnew-alias-kept"),
                    "{result:?}"
                );
            }
            wait_for_prompt(broker, transport_id);
            leases.release_turn("typing-agent").unwrap();
            // ZLE parses one accepted buffer before executing it, so an alias
            // newly defined there becomes callable in the next buffer.
            let alias =
                execute_visible(broker, writer, transport_id, shell, "ss_native_same_buffer");
            assert_eq!(alias.exit_code, Some(0), "{alias:?}");
            assert!(
                alias.combined_output.contains("new-alias-kept"),
                "{alias:?}"
            );
            writes.lock().unwrap().clear();
            phases.lock().unwrap().clear();
            for incomplete in [
                "echo 'unfinished",
                "if true; then",
                "cat <<EOF\nmissing end",
            ] {
                let effect = output.path().join("incomplete-prefix");
                let script = format!(
                    "printf forbidden >| {}\n{incomplete}",
                    shell_single_quote(effect.to_str().unwrap())
                );
                let started = registry.start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "incomplete-native",
                    &script,
                    shell.enter(),
                );
                let error = if incomplete.starts_with("cat") {
                    started.unwrap_err()
                } else {
                    let result = registry
                        .wait(
                            &sessions,
                            transport_id,
                            &started.unwrap(),
                            Duration::from_secs(5),
                        )
                        .unwrap();
                    assert_eq!(result.state, TerminalCommandState::Failed, "{result:?}");
                    result.input_rejection.unwrap()
                };
                assert!(error.starts_with("TERMINAL_INPUT_UNSUPPORTED"), "{error}");
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                assert!(!leases.has_lease(transport_id).unwrap());
                leases
                    .write(
                        &sessions,
                        transport_id,
                        shell.enter().into(),
                        crate::agent_runtime::TerminalInputSource::User,
                    )
                    .unwrap();
                thread::sleep(Duration::from_millis(100));
                wait_for_prompt(broker, transport_id);
                assert!(
                    !effect.exists(),
                    "incomplete script executed its prefix or left an executable buffer"
                );
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
            }
            if shell == TerminalShellKind::Zsh {
                let script = "for item (one two) print -r -- \"native-zsh:$item\"\n";
                let operation = registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        "native-zsh-grammar",
                        script,
                        shell.enter(),
                    )
                    .unwrap();
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                    .unwrap();
                assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
                assert_eq!(result.command_line, script);
                assert!(
                    result
                        .combined_output
                        .contains("native-zsh:one\r\nnative-zsh:two\r\n"),
                    "valid Zsh syntax was lost: {result:?}"
                );
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                let rejected = output.path().join("native-parser-refusal");
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "setopt cshjunkiequotes",
                );
                let script = format!(
                    "printf forbidden >| {}\nprintf '%s' 'a\nb'",
                    shell_single_quote(rejected.to_str().unwrap())
                );
                let operation = registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        "native-parser-refusal",
                        &script,
                        shell.enter(),
                    )
                    .unwrap();
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                    .unwrap();
                assert_eq!(result.state, TerminalCommandState::Failed, "{result:?}");
                let error = result.input_rejection.unwrap();
                assert!(error.starts_with("TERMINAL_INPUT_UNSUPPORTED"), "{error}");
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                assert!(
                    !rejected.exists(),
                    "native parser refusal executed a script prefix"
                );
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "unsetopt cshjunkiequotes",
                );
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "SHELLSPAN_SAVED_PATH=$PATH; PATH=/shellspan-no-executable-search",
                );
                let script = "printf '%s' 'pinned\tparser'\nprintf path-safe";
                let operation = registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        "native-pinned-parser",
                        script,
                        shell.enter(),
                    )
                    .unwrap();
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                    .unwrap();
                assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
                assert_eq!(result.exit_code, Some(0), "{result:?}");
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "PATH=$SHELLSPAN_SAVED_PATH; unset SHELLSPAN_SAVED_PATH",
                );
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
            }
            for flow in ["ixon", "-ixon"] {
                execute_visible(broker, writer, transport_id, shell, &format!("stty {flow}"));
                let script = "  printf '%s' 'literal\rCR'\nprintf '%s' 'literal\tTab'\nprintf '%s' 'CRLF\r\ninside'\n";
                let operation = registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        "native-cr-tab",
                        script,
                        shell.enter(),
                    )
                    .unwrap();
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                    .unwrap();
                assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
                assert_eq!(result.command_line, script);
                assert_eq!(result.exit_code, Some(0), "{result:?}");
                assert!(
                    result
                        .combined_output
                        .contains("literal\rCRliteral\tTabCRLF\r\r\ninside"),
                    "literal controls were normalized: {result:?}"
                );
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                let modes = execute_visible(broker, writer, transport_id, shell, "stty -a");
                let pattern = if flow == "ixon" {
                    r"(?:^|[\s;])ixon(?:[\s;]|$)"
                } else {
                    r"(?:^|[\s;])-ixon(?:[\s;]|$)"
                };
                assert!(
                    regex::Regex::new(pattern)
                        .unwrap()
                        .is_match(&modes.combined_output),
                    "native input changed TTY flow control: {modes:?}"
                );
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
            }
            let original_comments = broker.native_comments_enabled(transport_id).unwrap();
            if shell == TerminalShellKind::Zsh {
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "unsetopt interactivecomments",
                );
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
                for tail in ["# plain comment", "#'unfinished", "#\"'\\$`"] {
                    let effect = output.path().join("native-comment-refusal");
                    let script = format!(
                        "printf forbidden >| {}\n{tail}",
                        shell_single_quote(effect.to_str().unwrap())
                    );
                    let error = registry
                        .start(
                            &sessions,
                            transport_id,
                            "typing-agent",
                            "typing-task",
                            "native-comment-refusal",
                            &script,
                            shell.enter(),
                        )
                        .unwrap_err();
                    assert!(error.contains("INTERACTIVE_COMMENTS"), "{error}");
                    assert!(writes.lock().unwrap().is_empty());
                    assert!(!leases.has_lease(transport_id).unwrap());
                    assert!(!effect.exists());
                }
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "setopt interactivecomments",
                );
            }
            for suffix in ["'", "'\"$`\\", "终端"] {
                let effect = output.path().join("native-byte-boundary");
                let prefix = format!(
                    "printf once >| {}\n#",
                    shell_single_quote(effect.to_str().unwrap())
                );
                let mut script = prefix.clone();
                script.push_str(&suffix.repeat((8192 - prefix.len()) / suffix.len()));
                script.push_str(&"x".repeat(8192 - script.len()));
                assert_eq!(script.len(), 8192);
                let operation = registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        "native-byte-boundary",
                        &script,
                        shell.enter(),
                    )
                    .unwrap();
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(8))
                    .unwrap();
                assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
                assert_eq!(result.command_line, script);
                if shell == TerminalShellKind::Bash {
                    assert_eq!(
                        result.submitted_command_line,
                        Some(bash_native_submission(&script).unwrap())
                    );
                }
                assert_eq!(fs::read_to_string(&effect).unwrap(), "once");
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
                script.push('x');
                assert!(registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        "native-byte-overflow",
                        &script,
                        shell.enter()
                    )
                    .is_err());
                assert!(writes.lock().unwrap().is_empty());
                assert!(!leases.has_lease(transport_id).unwrap());
            }
            if shell == TerminalShellKind::Zsh && !original_comments {
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "unsetopt interactivecomments",
                );
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
            }
            for mode in ["native-cancel", "native-takeover"] {
                wait_for_prompt(broker, transport_id);
                let effect = output.path().join(mode);
                let script = format!(
                    "printf first >| {}\nprintf second >> {}",
                    shell_single_quote(effect.to_str().unwrap()),
                    shell_single_quote(effect.to_str().unwrap())
                );
                let operation = thread::scope(|scope| {
                    let typing = scope.spawn(|| {
                        registry.start(
                            &sessions,
                            transport_id,
                            "typing-agent",
                            "typing-task",
                            mode,
                            &script,
                            shell.enter(),
                        )
                    });
                    let submitted = if shell == TerminalShellKind::Bash {
                        bash_native_submission(&script).unwrap()
                    } else {
                        script.clone()
                    };
                    wait_until(Duration::from_secs(5), || {
                        writes.lock().unwrap().iter().any(|(_, data)| {
                            data == &crate::agent_runtime::native_editor_final_chunk(
                                &submitted, shell,
                            )
                        })
                    });
                    assert!(!effect.exists());
                    if mode == "native-takeover" {
                        registry
                            .takeover(&sessions, transport_id, "typing-agent", mode)
                            .unwrap();
                    } else {
                        registry.cancel_task(&sessions, "typing-task").unwrap();
                    }
                    typing.join().unwrap().unwrap()
                });
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                    .unwrap();
                assert_eq!(
                    result.state,
                    if mode == "native-takeover" {
                        TerminalCommandState::TakenOver
                    } else {
                        TerminalCommandState::Cancelled
                    }
                );
                assert!(!writes
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(_, data)| data == "\u{18}\u{5}"));
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                leases
                    .write(
                        &sessions,
                        transport_id,
                        shell.enter().into(),
                        crate::agent_runtime::TerminalInputSource::User,
                    )
                    .unwrap();
                wait_for_prompt(broker, transport_id);
                assert!(
                    !effect.exists(),
                    "user Enter executed a cancelled native buffer"
                );
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
            }
            for mode in [
                "native-running-cancel",
                "native-running-timeout",
                "native-running-takeover",
                "single-running-cancel",
                "single-running-timeout",
            ] {
                let effect = output.path().join(mode);
                let separator = if mode.starts_with("single") {
                    "; "
                } else {
                    "\n"
                };
                let trap_state = output.path().join(format!("{mode}-int-trap"));
                let tty_state = output.path().join(format!("{mode}-tty"));
                let probe = if shell == TerminalShellKind::Bash {
                    format!(
                        "stty -a >| {}; trap -p INT >| {}; ",
                        shell_single_quote(tty_state.to_str().unwrap()),
                        shell_single_quote(trap_state.to_str().unwrap())
                    )
                } else {
                    String::new()
                };
                let script = format!("{probe}printf '\\033[31mnative-running\\033[0m'{separator}sleep 10{separator}printf forbidden >| {}", shell_single_quote(effect.to_str().unwrap()));
                let display_start = display.lock().unwrap().len();
                let operation = registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        mode,
                        &script,
                        shell.enter(),
                    )
                    .unwrap();
                wait_until(Duration::from_secs(3), || {
                    display.lock().unwrap()[display_start..]
                        .windows(b"\x1b[31mnative-running\x1b[0m".len())
                        .any(|part| part == b"\x1b[31mnative-running\x1b[0m")
                });
                assert!(!operation.snapshot().unwrap().state.is_terminal());
                if shell == TerminalShellKind::Bash {
                    assert_eq!(
                        fs::read_to_string(&trap_state).unwrap(),
                        "",
                        "{mode}: prompt-only INT trap reached foreground source"
                    );
                }
                if shell == TerminalShellKind::Bash {
                    let settings = fs::read_to_string(&tty_state).unwrap();
                    assert!(
                        settings.split_whitespace().any(|word| word == "isig"),
                        "{mode}: native input disabled terminal signals: {settings}"
                    );
                }
                thread::sleep(Duration::from_millis(100));
                assert!(
                    !effect.exists(),
                    "{mode}: tail executed before the running command was interrupted"
                );
                assert_eq!(
                    operation.snapshot().unwrap().state,
                    TerminalCommandState::Running,
                    "{mode}: foreground output arrived without a matched native start"
                );
                let interrupt_start = writes.lock().unwrap().len();
                let expected = if mode.ends_with("takeover") {
                    registry
                        .takeover(&sessions, transport_id, "typing-agent", mode)
                        .unwrap();
                    TerminalCommandState::TakenOver
                } else if mode.ends_with("cancel") {
                    registry.cancel_task(&sessions, "typing-task").unwrap();
                    TerminalCommandState::Cancelled
                } else {
                    TerminalCommandState::TimedOut
                };
                let result = registry
                    .wait(
                        &sessions,
                        transport_id,
                        &operation,
                        Duration::from_millis(100),
                    )
                    .unwrap();
                assert_eq!(result.state, expected, "{mode}: {result:?}");
                assert!(
                    writes.lock().unwrap()[interrupt_start..]
                        .iter()
                        .any(|(_, wire)| wire == "\u{3}"),
                    "{mode}: native cancellation did not send its interrupt"
                );
                assert!(result
                    .combined_output
                    .contains("\x1b[31mnative-running\x1b[0m"));
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                assert!(
                    !effect.exists(),
                    "{mode}: interrupted script continued executing subsequent lines; tty={:?}; raw tail={:?}",
                    fs::read_to_string(&tty_state).ok(),
                    String::from_utf8_lossy(&display.lock().unwrap()[display_start..]).chars().rev().take(1800).collect::<String>().chars().rev().collect::<String>()
                );
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
            }
            if shell == TerminalShellKind::Bash {
                execute_visible(
                    broker,
                    writer,
                    transport_id,
                    shell,
                    "trap 'printf user-int-handler' INT",
                );
                assert!(!broker.native_input_enabled(transport_id).unwrap());
                let error = registry
                    .start(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        "native-user-trap",
                        "printf one\nprintf two",
                        shell.enter(),
                    )
                    .unwrap_err();
                assert!(error.starts_with("TERMINAL_INPUT_UNSUPPORTED"));
                writes.lock().unwrap().clear();
                let operation = registry.start(&sessions, transport_id, "typing-agent", "typing-task", "single-user-trap", "printf '\\033[31muser-trap-running\\033[0m'; sleep 10; printf user-trap-tail", shell.enter()).unwrap();
                wait_until(Duration::from_secs(3), || {
                    operation.snapshot().unwrap().state == TerminalCommandState::Running
                });
                thread::sleep(Duration::from_millis(100));
                registry.cancel_task(&sessions, "typing-task").unwrap();
                let result = registry
                    .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                    .unwrap();
                assert_eq!(
                    result.state,
                    TerminalCommandState::Uncertain,
                    "a user SIGINT handler cannot certify cancellation: {result:?}"
                );
                assert!(result.no_auto_replay);
                wait_for_prompt(broker, transport_id);
                leases.release_turn("typing-agent").unwrap();
                execute_visible(broker, writer, transport_id, shell, "trap - INT");
                assert!(broker.native_input_enabled(transport_id).unwrap());
                writes.lock().unwrap().clear();
                phases.lock().unwrap().clear();
            }
        } else {
            let error = registry
                .start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "bash3-unsupported",
                    "printf first\nprintf second",
                    shell.enter(),
                )
                .unwrap_err();
            assert!(error.starts_with("TERMINAL_INPUT_UNSUPPORTED"));
            assert!(writes.lock().unwrap().is_empty());
            assert!(!leases.has_lease(transport_id).unwrap());
        }
        for command in ["echo \u{3}", "", "sleep 1 &", "sleep 1 &!", "sleep 1 &|"] {
            let arguments =
                serde_json::json!({"command": command, "explanation": "verify input rejection"});
            if command.is_empty() || command.contains('\u{3}') {
                assert!(crate::agent_runtime::validate_tool_arguments_native(
                    "terminal_execute",
                    &arguments
                )
                .is_err());
            }
            assert!(registry
                .start(
                    &sessions,
                    transport_id,
                    "typing-agent",
                    "typing-task",
                    "rejected-input",
                    command,
                    shell.enter()
                )
                .is_err());
            assert!(!leases.has_lease(transport_id).unwrap());
            assert!(writes.lock().unwrap().is_empty());
            assert!(phases.lock().unwrap().is_empty());
        }
        if broker
            .snapshot(None)
            .unwrap()
            .interactive_tools_rollout
            .enabled
            && shell == TerminalShellKind::Zsh
        {
            wait_until(Duration::from_secs(2), || {
                broker
                    .bracketed_paste_enabled(transport_id)
                    .unwrap_or(false)
            });
        }
        for mode in [
            "unicode",
            "wrap",
            "cancel",
            "pause-cancel",
            "takeover",
            "reduced",
            "integration-loss",
        ] {
            wait_for_prompt(broker, transport_id);
            writes.lock().unwrap().clear();
            phases.lock().unwrap().clear();
            reduced_motion.store(mode == "reduced", Ordering::SeqCst);
            let file = output.path().join(mode);
            let quoted_file = shell_single_quote(file.to_str().unwrap());
            let value = if mode == "wrap" {
                "wrapped-command"
            } else {
                "终端e\u{301}👩‍💻"
            };
            let command = if mode == "integration-loss" && expected_native_input {
                format!("printf '%s' '{value}' > {quoted_file}\nprintf forbidden >> {quoted_file}")
            } else {
                format!("printf '%s' '{value}' > {quoted_file}")
            };
            crate::agent_runtime::validate_tool_arguments_native("terminal_execute", &serde_json::json!({"command": &command, "explanation": "verify real terminal input"})).unwrap();
            let operation_id = format!("typing-{}", Uuid::new_v4().simple());
            let operation = thread::scope(|scope| {
                let typing = scope.spawn(|| {
                    registry.start_with_revalidation(
                        &sessions,
                        transport_id,
                        "typing-agent",
                        "typing-task",
                        &operation_id,
                        &command,
                        shell.enter(),
                        |stage| {
                            if stage == TerminalExecuteValidationStage::InputWrite {
                                assert!(!file.exists(), "{mode}: command executed before submit");
                            }
                            Ok(())
                        },
                    )
                });
                if matches!(
                    mode,
                    "cancel" | "pause-cancel" | "takeover" | "integration-loss"
                ) {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while {
                        let inputs = writes.lock().unwrap();
                        if mode == "integration-loss" && expected_native_input {
                            let submitted = if shell == TerminalShellKind::Bash {
                                bash_native_submission(&command).unwrap()
                            } else {
                                command.clone()
                            };
                            !inputs.iter().any(|(_, input)| {
                                input
                                    == &crate::agent_runtime::native_editor_final_chunk(
                                        &submitted, shell,
                                    )
                            })
                        } else if mode == "pause-cancel"
                            || (mode == "integration-loss"
                                && broker
                                    .bracketed_paste_enabled(transport_id)
                                    .unwrap_or(false))
                        {
                            inputs
                                .iter()
                                .map(|(_, input)| {
                                    input
                                        .strip_prefix("\u{1b}[200~")
                                        .and_then(|text| text.strip_suffix("\u{1b}[201~"))
                                        .unwrap_or(input.as_str())
                                })
                                .collect::<String>()
                                != command
                        } else {
                            inputs.len() < 3
                        }
                    } {
                        assert!(Instant::now() < deadline, "typing never reached transport");
                        thread::sleep(Duration::from_millis(5));
                    }
                    assert!(!file.exists(), "command executed before submission");
                    if mode == "integration-loss" {
                        // Close the actual FIFO reader while the PTY stays open.
                        integration_control.stop();
                    } else if mode != "takeover" {
                        registry.cancel_task(&sessions, "typing-task").unwrap();
                    } else {
                        registry
                            .takeover(&sessions, transport_id, "typing-agent", &operation_id)
                            .unwrap();
                    }
                }
                typing.join().unwrap()
            });
            if mode == "integration-loss" {
                assert!(operation
                    .unwrap_err()
                    .starts_with("TERMINAL_INPUT_RECOVERY_REQUIRED"));
                assert!(!file.exists());
                leases.release_turn("typing-agent").unwrap();
                assert!(!leases.has_lease(transport_id).unwrap());
                assert_eq!(
                    sessions.target_state(transport_id).unwrap().status,
                    SessionStatus::Connected
                );
                let error = leases
                    .write(
                        &sessions,
                        transport_id,
                        "\n".into(),
                        crate::agent_runtime::TerminalInputSource::User,
                    )
                    .unwrap_err();
                assert!(
                    error.starts_with("TERMINAL_INPUT_RECOVERY_REQUIRED"),
                    "{error}"
                );
                assert!(!writes
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(_, input)| input == shell.enter() || input == "\u{18}\u{5}"));
                continue;
            }
            let operation = operation.unwrap();
            let snapshot = registry
                .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                .unwrap();
            let inputs = writes.lock().unwrap();
            if matches!(mode, "cancel" | "pause-cancel" | "takeover") {
                assert_eq!(
                    snapshot.state,
                    if mode == "takeover" {
                        TerminalCommandState::TakenOver
                    } else {
                        TerminalCommandState::Cancelled
                    }
                );
                assert!(!file.exists(), "cancelled typing executed a command");
                assert_eq!(inputs.last().unwrap().1, "\u{3}");
                assert_eq!(
                    inputs.iter().filter(|(_, input)| input == "\u{3}").count(),
                    1,
                    "{mode}: cancellation must not interrupt the replacement prompt twice"
                );
                assert!(!inputs.iter().any(|(_, input)| input == shell.enter()));
                assert_eq!(*phases.lock().unwrap(), [TerminalCommandPhase::Typing]);
            } else {
                assert_eq!(
                    snapshot.state,
                    TerminalCommandState::Completed,
                    "{mode}: {snapshot:?}"
                );
                assert_eq!(fs::read_to_string(&file).unwrap(), value);
                if mode == "reduced" {
                    assert_eq!(inputs.len(), 1);
                    assert_eq!(*phases.lock().unwrap(), [TerminalCommandPhase::Running]);
                } else {
                    assert!(inputs.len() > 2 && inputs.len() <= 49);
                    assert_eq!(
                        inputs[..inputs.len() - 1]
                            .iter()
                            .map(|(_, input)| input.as_str())
                            .collect::<String>(),
                        command
                    );
                    assert!(
                        inputs.iter().all(|(_, input)| !input.contains('\u{1b}')),
                        "animated input must not toggle bracketed-paste highlighting"
                    );
                    assert_eq!(inputs.last().unwrap().1, shell.enter());
                    assert!(
                        inputs
                            .last()
                            .unwrap()
                            .0
                            .duration_since(inputs[inputs.len() - 2].0)
                            >= Duration::from_millis(100)
                    );
                    assert_eq!(
                        *phases.lock().unwrap(),
                        [TerminalCommandPhase::Typing, TerminalCommandPhase::Running]
                    );
                    if mode == "wrap"
                        && broker
                            .bracketed_paste_enabled(transport_id)
                            .unwrap_or(false)
                    {
                        if let Ok(path) = std::env::var("SHELLSPAN_TYPING_TRACE_PATH") {
                            fs::write(path, &display.lock().unwrap()[typing_display_start..])
                                .unwrap();
                        }
                    }
                }
            }
            drop(inputs);
            wait_for_prompt(broker, transport_id);
            leases.release_turn("typing-agent").unwrap();
            // A trusted prompt must release the recovery guard for normal use.
            leases
                .write(
                    &sessions,
                    transport_id,
                    shell.enter().into(),
                    crate::agent_runtime::TerminalInputSource::User,
                )
                .unwrap();
            thread::sleep(Duration::from_millis(30));
            wait_for_prompt(broker, transport_id);
        }
        sessions.remove(transport_id).unwrap();
        worker.join().unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn execute_visible(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        transport_id: &str,
        shell: TerminalShellKind,
        command: &str,
    ) -> crate::terminal_broker::TerminalCommandSnapshot {
        execute_visible_with_timeout(
            broker,
            writer,
            transport_id,
            shell,
            command,
            Duration::from_secs(8),
        )
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn execute_visible_with_timeout(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        transport_id: &str,
        shell: TerminalShellKind,
        command: &str,
        timeout: Duration,
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
        let mut snapshot = operation.wait_until_terminal(timeout).unwrap();
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
    #[track_caller]
    fn wait_for_prompt(broker: &crate::terminal_broker::TerminalSessionBroker, transport_id: &str) {
        wait_for_prompt_with_timeout(broker, transport_id, Duration::from_secs(5));
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    #[track_caller]
    fn wait_for_prompt_with_timeout(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        transport_id: &str,
        timeout: Duration,
    ) {
        use std::time::Instant;
        let deadline = Instant::now() + timeout;
        loop {
            let snapshot = broker.snapshot(Some(transport_id)).unwrap();
            if snapshot.session.as_ref().is_some_and(|session| {
                session.integration_state == crate::terminal_broker::TerminalIntegrationState::Ready
                    && session.prompt_ready
            }) {
                return;
            }
            if Instant::now() >= deadline {
                let frames = snapshot.session.as_ref().and_then(|session| {
                    broker
                        .replay_output(
                            &session.terminal_session_id,
                            session.terminal_generation,
                            session.replay_first_sequence.unwrap_or(1),
                            512,
                            4096,
                        )
                        .ok()
                });
                let raw = frames
                    .map(|batch| {
                        batch
                            .frames
                            .into_iter()
                            .flat_map(|frame| frame.bytes)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let tail = crate::redaction::redact_sensitive_text(&String::from_utf8_lossy(&raw));
                panic!(
                    "prompt not ready at {}: {snapshot:?}; shared PTY tail={tail:?}",
                    std::panic::Location::caller()
                );
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) {
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

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn native_display_cells(
        bytes: &[u8],
        geometry: crate::terminal_broker::TerminalGeometry,
    ) -> (String, std::collections::HashSet<usize>) {
        let rows = u16::try_from(geometry.rows).unwrap();
        let columns = u16::try_from(geometry.columns).unwrap();
        let mut parser = vt100::Parser::new(rows, columns, 20_000);
        parser.process(bytes);
        parser.screen_mut().set_scrollback(usize::MAX);
        let history = parser.screen().scrollback();
        let mut cells = String::new();
        let mut colored_printf = std::collections::HashSet::new();
        for offset in (0..=history).rev() {
            parser.screen_mut().set_scrollback(offset);
            for row in 0..if offset == 0 { rows } else { 1 } {
                for column in 0..columns {
                    if column + 6 <= columns {
                        let word = (column..column + 6)
                            .map(|col| parser.screen().cell(row, col).unwrap().contents())
                            .collect::<String>();
                        if word == "printf"
                            && parser.screen().cell(row, column).unwrap().fgcolor()
                                != vt100::Color::Default
                        {
                            colored_printf.insert(cells.len());
                        }
                    }
                    let text = parser.screen().cell(row, column).unwrap().contents();
                    if text.is_empty() {
                        cells.push(' ');
                    } else {
                        cells.push_str(&text);
                    }
                }
            }
        }
        (cells, colored_printf)
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn verify_native_shell_jobs(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        registry: &crate::agent_runtime::TerminalExecuteRegistry,
        sessions: &crate::models::SessionManager,
        transport: &str,
        shell: TerminalShellKind,
        display: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        writes: &std::sync::Arc<std::sync::Mutex<Vec<(Instant, String)>>>,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        leases: &crate::agent_runtime::TerminalLeaseManager,
    ) {
        use crate::agent_runtime::AgentToolTargetNative;
        use crate::terminal_broker::TerminalCommandState;
        let target = AgentToolTargetNative::Local {
            target_id: "native-job-owner".into(),
            session_id: transport.into(),
            cwd: None,
        };
        let run = |source: &str, submitted: Option<&str>| {
            let id = format!("native-job-{}", Uuid::new_v4());
            // Prepared submissions are bound to this operation before a lease.
            let operation = registry.start_native_submission(
                sessions,
                transport,
                "typing-agent",
                "typing-task",
                &id,
                source,
                shell.enter(),
                submitted,
                |_| Ok(()),
            );
            operation.map(|operation| {
                registry
                    .wait(sessions, transport, &operation, Duration::from_secs(5))
                    .unwrap()
            })
        };
        let launch = |source: &str| {
            let id = format!("native-job-{}", Uuid::new_v4());
            let job = broker
                .prepare_shell_job(
                    transport,
                    &target,
                    "typing-agent",
                    "typing-task",
                    &id,
                    source,
                )
                .unwrap();
            let operation = registry.start_native_submission(
                sessions,
                transport,
                "typing-agent",
                "typing-task",
                &id,
                source,
                shell.enter(),
                Some(&job.submitted_command_line),
                |_| Ok(()),
            );
            let operation = operation.unwrap_or_else(|error| {
                if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                    fs::write(
                        format!("{prefix}.launch-failed.raw.bin"),
                        &*display.lock().unwrap(),
                    )
                    .unwrap();
                }
                panic!("native job launch failed: {error}");
            });
            let result = registry
                .wait(sessions, transport, &operation, Duration::from_secs(5))
                .unwrap();
            if result.state != TerminalCommandState::Completed {
                if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                    fs::write(
                        format!("{prefix}.failed.raw.bin"),
                        &*display.lock().unwrap(),
                    )
                    .unwrap();
                    fs::write(
                        format!("{prefix}.failed.submission"),
                        &job.submitted_command_line,
                    )
                    .unwrap();
                }
            }
            assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
            assert_eq!(result.command_line, source);
            assert_eq!(result.exit_code, Some(0), "job launch failed: {result:?}");
            assert_eq!(
                result.submitted_command_line.as_ref(),
                Some(&job.submitted_command_line)
            );
            wait_for_prompt(broker, transport);
            job
        };
        let observe = |job: &crate::terminal_jobs::NativeShellJob, stop: bool| {
            let id = format!("native-job-control-{}", Uuid::new_v4());
            let fresh = broker
                .shell_job(
                    &job.process_handle,
                    "native-job-owner",
                    "typing-agent",
                    "typing-task",
                )
                .unwrap();
            if matches!(fresh.state.as_str(), "exited")
                || fresh.control_lost
                || fresh.native_active == Some(false)
            {
                return fresh;
            }
            let line = broker.prepare_shell_job_control(&fresh, &id, stop).unwrap();
            let operation = registry.start_native_submission(
                sessions,
                transport,
                "typing-agent",
                "typing-task",
                &id,
                &line,
                shell.enter(),
                Some(&line),
                |_| Ok(()),
            );
            let operation = operation.unwrap_or_else(|error| {
                if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                    fs::write(
                        format!("{prefix}.control-failed.raw.bin"),
                        &*display.lock().unwrap(),
                    )
                    .unwrap();
                }
                panic!("native job control failed: {error}");
            });
            let result = registry
                .wait(sessions, transport, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
            wait_for_prompt(broker, transport);
            broker
                .shell_job(
                    &job.process_handle,
                    "native-job-owner",
                    "typing-agent",
                    "typing-task",
                )
                .unwrap()
        };
        let until_exit = |job: &crate::terminal_jobs::NativeShellJob| {
            let deadline = Instant::now() + Duration::from_secs(6);
            loop {
                let observed = observe(job, false);
                if matches!(observed.state.as_str(), "exited" | "uncertain") {
                    break observed;
                }
                assert!(
                    Instant::now() < deadline,
                    "job did not settle: {observed:?}"
                );
                thread::sleep(Duration::from_millis(20));
            }
        };
        let directory = tempfile::tempdir().unwrap();
        let completion_gate = directory.path().join("release-natural-exit");
        if shell == TerminalShellKind::Bash {
            let effect = directory.path().join("same-buffer-alias");
            let alias = launch(&format!(
                "alias ss_job_same_buffer='printf alias-ok'\nss_job_same_buffer >| {}\n",
                shell_single_quote(effect.to_str().unwrap())
            ));
            assert_eq!(until_exit(&alias).exit_code, Some(0));
            assert_eq!(fs::read_to_string(&effect).unwrap(), "alias-ok");
            assert_eq!(
                run("type ss_job_same_buffer >/dev/null 2>&1", None)
                    .unwrap()
                    .exit_code,
                Some(1),
                "a background alias definition changed the parent shell"
            );
            wait_for_prompt(broker, transport);
            assert_eq!(
                run("shopt -u expand_aliases", None).unwrap().exit_code,
                Some(0)
            );
            let disabled = launch(&format!(
                "alias ss_job_same_buffer='printf forbidden'\nss_job_same_buffer >| {}\n",
                shell_single_quote(effect.to_str().unwrap())
            ));
            assert_eq!(until_exit(&disabled).exit_code, Some(127));
            assert_eq!(fs::read_to_string(&effect).unwrap(), "");
            assert_eq!(
                run("shopt -q expand_aliases", None).unwrap().exit_code,
                Some(1)
            );
            assert_eq!(
                run("shopt -s expand_aliases", None).unwrap().exit_code,
                Some(0)
            );
            wait_for_prompt(broker, transport);
        }
        if matches!(shell, TerminalShellKind::Zsh | TerminalShellKind::Bash) {
            let effect = directory.path().join("group-escape");
            let source = format!(
                ")\nprintf forbidden >| {}\n(",
                shell_single_quote(effect.to_str().unwrap())
            );
            let id = format!("source-group-escape-{}", Uuid::new_v4());
            let job = broker
                .prepare_shell_job(
                    transport,
                    &target,
                    "typing-agent",
                    "typing-task",
                    &id,
                    &source,
                )
                .unwrap();
            let operation = registry
                .start_native_submission(
                    sessions,
                    transport,
                    "typing-agent",
                    "typing-task",
                    &id,
                    &source,
                    shell.enter(),
                    Some(&job.submitted_command_line),
                    |_| Ok(()),
                )
                .unwrap();
            let result = registry
                .wait(sessions, transport, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Failed, "{result:?}");
            assert_eq!(
                result.input_rejection.as_deref(),
                Some("TERMINAL_INPUT_UNSUPPORTED")
            );
            assert!(
                !effect.exists(),
                "invalid source escaped the asynchronous native child"
            );
            wait_for_prompt(broker, transport);
        }
        if shell == TerminalShellKind::Zsh
            && std::env::var_os("SHELLSPAN_TEST_NATIVE_ZSH_USER_HOME").is_none()
        {
            let survivor = launch("sleep 60");
            for option in ["errexit", "errreturn"] {
                assert_eq!(
                    run(&format!("setopt {option}; false && true"), None)
                        .unwrap()
                        .exit_code,
                    Some(1)
                );
                wait_for_prompt(broker, transport);
                assert_eq!(observe(&survivor, false).state, "running");
                let effect = directory.path().join(format!("unsupported-{option}"));
                let source = format!(
                    "printf forbidden >| {}",
                    shell_single_quote(effect.to_str().unwrap())
                );
                let id = format!("unsupported-context-{}", Uuid::new_v4());
                let job = broker
                    .prepare_shell_job(
                        transport,
                        &target,
                        "typing-agent",
                        "typing-task",
                        &id,
                        &source,
                    )
                    .unwrap();
                let operation = registry
                    .start_native_submission(
                        sessions,
                        transport,
                        "typing-agent",
                        "typing-task",
                        &id,
                        &source,
                        shell.enter(),
                        Some(&job.submitted_command_line),
                        |_| Ok(()),
                    )
                    .unwrap();
                let result = registry
                    .wait(sessions, transport, &operation, Duration::from_secs(5))
                    .unwrap();
                assert_eq!(result.state, TerminalCommandState::Failed, "{result:?}");
                assert!(result
                    .input_rejection
                    .as_deref()
                    .unwrap_or_default()
                    .contains("TERMINAL_BACKGROUND_UNSUPPORTED"));
                assert!(
                    !effect.exists(),
                    "an explicitly unsupported context executed source"
                );
                wait_for_prompt(broker, transport);
                let restored = run(
                    &format!("[[ -o {option} ]] && printf option-preserved; unsetopt {option}"),
                    None,
                )
                .unwrap();
                assert!(restored.combined_output.contains("option-preserved"));
                assert_eq!(restored.exit_code, Some(0));
                wait_for_prompt(broker, transport);
            }
            observe(&survivor, true);
            assert_eq!(until_exit(&survivor).state, "exited");
            assert_eq!(run("setopt errexit", None).unwrap().exit_code, Some(0));
            let effect = directory.path().join("errexit-source");
            let supported = launch(&format!(
                "printf '%s' \"$?\" >| {}; false; printf forbidden >> {}",
                shell_single_quote(effect.to_str().unwrap()),
                shell_single_quote(effect.to_str().unwrap())
            ));
            assert_eq!(until_exit(&supported).exit_code, Some(1));
            assert_eq!(fs::read_to_string(&effect).unwrap(), "0");
            let restored = run(
                "[[ -o errexit ]] && printf option-preserved; unsetopt errexit",
                None,
            )
            .unwrap();
            assert!(restored.combined_output.contains("option-preserved"));
            wait_for_prompt(broker, transport);
        }
        let natural = launch(&format!(
            "while [[ ! -f {} ]]; do sleep 0.01; done; sleep 0.1; exit 7",
            shell_single_quote(completion_gate.to_str().unwrap())
        ));
        let revision = broker
            .shell_job(
                &natural.process_handle,
                "native-job-owner",
                "typing-agent",
                "typing-task",
            )
            .unwrap()
            .observation_revision;
        let natural_result = thread::scope(|scope| {
            scope.spawn(|| {
                wait_until(Duration::from_secs(3), || {
                    broker
                        .shell_job(
                            &natural.process_handle,
                            "native-job-owner",
                            "typing-agent",
                            "typing-task",
                        )
                        .unwrap()
                        .observation_revision
                        > revision
                });
                fs::write(&completion_gate, "release").unwrap();
            });
            crate::agent_runtime::NativeToolEngine::manage_registered_job_for_test(
                broker, leases, registry, sessions, &natural, false, 5000,
            )
            .unwrap()
        });
        let natural_data = natural_result.data.unwrap();
        assert_eq!(
            natural_data["state"], "exited",
            "a single wait must discover natural completion after its first running observation"
        );
        assert_eq!(natural_data["exitCode"], 7);
        assert_eq!(natural_data["waitTimedOut"], false);
        let bounded = launch("sleep 60");
        let bounded_result =
            crate::agent_runtime::NativeToolEngine::manage_registered_job_for_test(
                broker, leases, registry, sessions, &bounded, false, 1000,
            )
            .unwrap();
        assert_eq!(bounded_result.data.as_ref().unwrap()["waitTimedOut"], true);
        assert!(
            broker.native_input_enabled(transport).unwrap(),
            "a bounded observation must not quarantine a healthy editor at its deadline"
        );
        let stopped = crate::agent_runtime::NativeToolEngine::manage_registered_job_for_test(
            broker, leases, registry, sessions, &bounded, true, 10000,
        )
        .unwrap();
        let stopped_data = stopped.data.unwrap();
        assert_eq!(stopped_data["job"]["nativeActive"], false);
        assert_eq!(stopped_data["job"]["controlLost"], false);
        wait_for_prompt(broker, transport);
        let marker = directory.path().join("once");
        if matches!(shell, TerminalShellKind::Zsh | TerminalShellKind::Bash) {
            let prefix = format!("BG-DISPLAY-{}-", Uuid::new_v4().simple());
            let visible = format!("APPROVED-SOURCE-{}", Uuid::new_v4().simple());
            let counter = directory.path().join("display-count");
            let gate = directory.path().join("display-release");
            let overlap_gate = directory.path().join("display-overlap");
            let short_gate = directory.path().join("display-short-overlap");
            assert_eq!(
                run(
                    &format!(
                        "SS_DISPLAY_ROOT={}",
                        shell_single_quote(directory.path().to_str().unwrap())
                    ),
                    None
                )
                .unwrap()
                .exit_code,
                Some(0)
            );
            let start = display.lock().unwrap().len();
            let script = format!("printf '{visible}\\n'\nfor n in {{1..12}}; do if (( n == 4 )); then while [[ ! -f $SS_DISPLAY_ROOT/display-overlap ]]; do sleep 0.01; done; elif (( n == 7 )); then while [[ ! -f $SS_DISPLAY_ROOT/display-short-overlap ]]; do sleep 0.01; done; fi; printf '{prefix}%s-END\\n' \"$n\"; printf '%s' \"$n\" >| $SS_DISPLAY_ROOT/display-count; sleep 1; done\nwhile [[ ! -f $SS_DISPLAY_ROOT/display-release ]]; do sleep 0.01; done");
            let producer = launch(&script);
            for threshold in [3, 6, 9, 12] {
                wait_until(Duration::from_secs(4), || {
                    fs::read_to_string(&counter)
                        .ok()
                        .and_then(|s| s.parse::<usize>().ok())
                        .is_some_and(|count| count >= threshold)
                });
                if matches!(threshold, 3 | 6) {
                    let foreground = if threshold == 3 {
                        format!(
                            "printf 'LONG-{visible}\\n'\n: '{}'\nprintf 'LONG-END-{visible}\\n'",
                            "approved-字-".repeat(400)
                        )
                    } else {
                        format!("printf 'SHORT-{visible}\\n'")
                    };
                    assert!(threshold == 3 || foreground.len() < 512);
                    let submitted_foreground = if shell == TerminalShellKind::Bash {
                        bash_native_submission(&foreground).unwrap()
                    } else {
                        foreground.clone()
                    };
                    let first_wire =
                        crate::agent_runtime::native_editor_chunks(&submitted_foreground, shell)[0]
                            .0
                            .clone();
                    let mut overlapped = false;
                    let id = format!("display-overlap-{}", Uuid::new_v4());
                    let operation = registry.start_native_submission(sessions, transport, "typing-agent", "typing-task", &id, &foreground, shell.enter(), None, |stage| {
                        if matches!(stage, crate::agent_runtime::TerminalExecuteValidationStage::InputWrite)
                            && !overlapped
                            && writes.lock().unwrap().iter().any(|(_, wire)| wire == &first_wire)
                        {
                            fs::write(if threshold == 3 { &overlap_gate } else { &short_gate }, "release").unwrap();
                            wait_until(Duration::from_secs(3), || String::from_utf8_lossy(&display.lock().unwrap()[start..]).contains(&format!("{prefix}{}-END", threshold+1)));
                            overlapped = true;
                        }
                        Ok(())
                    }).unwrap();
                    let result = registry
                        .wait(sessions, transport, &operation, Duration::from_secs(5))
                        .unwrap();
                    assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
                    assert_eq!(result.exit_code, Some(0));
                    assert_eq!(result.command_line, foreground);
                    assert_eq!(
                        result.submitted_command_line,
                        if shell == TerminalShellKind::Bash {
                            Some(bash_native_submission(&foreground).unwrap())
                        } else {
                            None
                        }
                    );
                    assert!(
                        overlapped,
                        "the background line must arrive after a real source frame and before acceptance"
                    );
                    if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                        fs::write(
                            format!("{prefix}.foreground-{threshold}.source"),
                            &foreground,
                        )
                        .unwrap();
                    }
                    wait_for_prompt(broker, transport);
                }
                assert_eq!(observe(&producer, false).state, "running");
            }
            wait_until(Duration::from_secs(3), || {
                String::from_utf8_lossy(&display.lock().unwrap()[start..])
                    .contains(&format!("{prefix}12-END"))
            });
            let bytes = display.lock().unwrap().clone();
            let raw = String::from_utf8_lossy(&bytes[start..]);
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                fs::write(format!("{prefix}.raw.bin"), &bytes).unwrap();
                fs::write(format!("{prefix}.source"), &script).unwrap();
            }
            assert!(
                !raw.contains("__shellspan_"),
                "private implementation leaked into actual raw VT: {raw:?}"
            );
            let geometry = broker
                .snapshot(Some(transport))
                .unwrap()
                .session
                .unwrap()
                .geometry;
            let (cells, colored_printf) = native_display_cells(&bytes, geometry);
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                fs::write(format!("{prefix}.cells.txt"), &cells).unwrap();
            }
            let visible_source = if shell == TerminalShellKind::Bash {
                // Check the actual eval argument, including shlex's native
                // quote spelling, rather than unquoted approved source text.
                let quoted = shlex::try_quote(&script).unwrap().into_owned();
                quoted.lines().next().unwrap().to_string()
            } else {
                format!("printf '{visible}\\n'")
            };
            assert_eq!(
                cells.matches(&visible_source).count(),
                1,
                "the first background source must be shown exactly once"
            );
            assert!(
                // Native ZLE clips the first row of input taller than the
                // viewport even without ShellSpan (saved native baseline).
                // Keep the 5KB source and BG4 overlap; require exact native
                // acceptance above and real source text at the visible tail.
                cells.contains(&format!("LONG-END-{visible}")),
                "foreground source tail disappeared during real BG4 overlap"
            );
            assert!(
                cells.contains(&format!("SHORT-{visible}")),
                "short foreground source disappeared during real BG7 overlap"
            );
            if std::env::var_os("SHELLSPAN_TEST_NATIVE_ZSH_USER_HOME").is_some() {
                let source_offset = cells.find(&format!("printf 'SHORT-{visible}\\n'")).unwrap();
                assert!(
                    colored_printf.contains(&source_offset),
                    "the real profile's source command lost native syntax coloring"
                );
            }
            let mut previous_raw = 0;
            let mut previous_cells = 0;
            for number in 1..=12 {
                let line = format!("{prefix}{number}-END");
                assert_eq!(
                    raw.matches(&line).count(),
                    1,
                    "raw output was lost or duplicated: {line}"
                );
                assert_eq!(
                    cells.matches(&line).count(),
                    1,
                    "logical native cells lost or duplicated: {line}"
                );
                let raw_position = raw.find(&line).unwrap();
                let cell_position = cells.find(&line).unwrap();
                assert!(
                    raw_position >= previous_raw && cell_position >= previous_cells,
                    "native output reordered: {line}"
                );
                previous_raw = raw_position;
                previous_cells = cell_position;
            }
            fs::write(&gate, "release").unwrap();
            assert_eq!(until_exit(&producer).state, "exited");
            wait_for_prompt(broker, transport);
            let completed = display.lock().unwrap().clone();
            assert!(
                !String::from_utf8_lossy(&completed[start..]).contains("__shellspan_"),
                "private implementation leaked through native completion notification"
            );
        }
        fs::write(&marker, "").unwrap();
        let inherited = directory.path().join("state");
        fs::write(&inherited, "").unwrap();
        let parent_cwd = broker
            .snapshot(Some(transport))
            .unwrap()
            .session
            .unwrap()
            .current_directory;
        let display_start = display.lock().unwrap().len();
        let first = launch(&format!("printf 'once\\n' >> {}; {{ ss_phase3_alias; ss_phase3_function; printf ':job-state:%s:%s:' \"$SHELLSPAN_PHASE3_VALUE\" \"$PWD\"; cd /; printf ':child-cwd:%s:' \"$PWD\"; }} >> {}; sleep 3; printf 'job-%s-end' one", shell_single_quote(marker.to_str().unwrap()), shell_single_quote(inherited.to_str().unwrap())));
        let second = launch("sleep 0.3; printf job-two-end; exit 7");
        let marker_deadline = Instant::now() + Duration::from_secs(2);
        while fs::read_to_string(&marker).unwrap().is_empty() && Instant::now() < marker_deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fs::read_to_string(&marker).unwrap(), "once\n");
        assert!(broker
            .shell_job(
                &first.process_handle,
                "native-job-owner",
                "another-agent",
                "typing-task"
            )
            .is_err());
        assert!(broker
            .shell_job(
                &first.process_handle,
                "native-job-owner",
                "typing-agent",
                "another-task"
            )
            .is_err());
        let foreground = run("printf foreground-while-jobs-run", None).unwrap();
        assert_eq!(foreground.exit_code, Some(0));
        assert!(foreground
            .combined_output
            .contains("foreground-while-jobs-run"));
        assert_eq!(
            observe(&first, false).state,
            "running",
            "bounded observation must not stop a running job"
        );
        assert_eq!(until_exit(&second).exit_code, Some(7));
        assert_eq!(until_exit(&first).exit_code, Some(0));
        let inherited_state = fs::read_to_string(&inherited).unwrap();
        assert!(
            inherited_state.contains("alias-okfunction-ok:job-state:终端值:"),
            "background did not inherit current shell state: {inherited_state:?}"
        );
        assert!(fs::read_to_string(&inherited)
            .unwrap()
            .contains(":child-cwd:/:"));
        assert_eq!(
            broker
                .snapshot(Some(transport))
                .unwrap()
                .session
                .unwrap()
                .current_directory,
            parent_cwd,
            "background chpwd must not change parent integration cwd"
        );
        assert_eq!(
            run("printf '%s' \"$(cd /; pwd)\"", None).unwrap().cwd,
            parent_cwd,
            "command substitution must not change parent integration cwd"
        );
        assert!(
            String::from_utf8_lossy(&display.lock().unwrap()[display_start..])
                .contains("job-one-end")
        );
        assert_eq!(fs::read_to_string(&marker).unwrap(), "once\n");
        // Native jobspecs avoid IFS parsing and numeric slot/PID credentials.
        assert_eq!(run("IFS=:", None).unwrap().exit_code, Some(0));
        let survivor = launch("sleep 60");
        let stopped = launch("sleep 60");
        assert_eq!(
            run(
                &format!("builtin kill -s STOP '%( {};'", stopped.process_handle),
                None
            )
            .unwrap()
            .exit_code,
            Some(0)
        );
        thread::sleep(Duration::from_millis(50));
        assert_eq!(
            observe(&stopped, false).state,
            "stopped",
            "stopped jobs remain live and controllable"
        );
        observe(&stopped, true);
        assert_eq!(until_exit(&stopped).state, "exited");
        assert_eq!(observe(&survivor, false).state, "running");
        assert!(broker
            .prepare_shell_job_control(&until_exit(&first), "retired-control", true)
            .is_err());
        assert_eq!(
            observe(&survivor, false).state,
            "running",
            "old handle must not signal a new job slot"
        );
        observe(&survivor, true);
        assert_eq!(until_exit(&survivor).state, "exited");
        assert_eq!(run("unset IFS", None).unwrap().exit_code, Some(0));
        let natural127 = launch("exit 127");
        assert_eq!(until_exit(&natural127).exit_code, Some(127));
        let previous = directory.path().join("previous-status");
        assert_eq!(run("false", None).unwrap().exit_code, Some(1));
        wait_for_prompt(broker, transport);
        let inherited_status = launch(&format!(
            "printf '%s' \"$?\" >| {}",
            shell_single_quote(previous.to_str().unwrap())
        ));
        assert_eq!(until_exit(&inherited_status).exit_code, Some(0));
        assert_eq!(
            fs::read_to_string(&previous).unwrap(),
            "1",
            "background source did not inherit the shell's preceding status"
        );
        let changed_path = launch("export PATH=/shellspan-no-such-path; exit 11");
        assert_eq!(
            until_exit(&changed_path).exit_code,
            Some(11),
            "child PATH must not disable its completion receipt"
        );
        assert_eq!(
            run(
                "export SS_JOB_OLD_PATH=$PATH; export PATH=/shellspan-no-such-path",
                None
            )
            .unwrap()
            .exit_code,
            Some(0)
        );
        let parent_path = launch("/bin/sleep 0.1; exit 12");
        assert_eq!(
            until_exit(&parent_path).exit_code,
            Some(12),
            "parent PATH must not disable job observation/cleanup"
        );
        assert_eq!(
            run("export PATH=$SS_JOB_OLD_PATH; unset SS_JOB_OLD_PATH", None)
                .unwrap()
                .exit_code,
            Some(0)
        );
        let own_trap = launch("trap 'printf user-job-cleanup' EXIT; sleep 0.1; exit 9");
        let observed = until_exit(&own_trap);
        assert!(
            observed.exit_code == Some(9)
                || (observed.state == "uncertain" && observed.exit_code.is_none()),
            "lost notification must never invent success: {observed:?}"
        );
        let replacement = launch(&format!(
            "printf '%s' '{}'; sleep 60",
            own_trap.process_handle
        ));
        assert!(broker
            .prepare_shell_job_control(&observed, "old-handle-stop", true)
            .is_err());
        assert_eq!(
            observe(&replacement, false).state,
            "running",
            "source mentioning an old handle must not acquire its identity"
        );
        observe(&replacement, true);
        assert_eq!(until_exit(&replacement).state, "exited");
        assert_eq!(
            run("__shellspan_job_register() { :; }", None)
                .unwrap()
                .exit_code,
            Some(0)
        );
        wait_for_prompt(broker, transport);
        let missing_ack = directory.path().join("missing-start-ack");
        fs::write(&missing_ack, "").unwrap();
        let unknown = launch(&format!(
            "printf 'once\\n' >> {}; /bin/sleep 60",
            shell_single_quote(missing_ack.to_str().unwrap())
        ));
        broker
            .mark_shell_job_uncertain(&unknown.process_handle)
            .unwrap();
        let uncertain = broker
            .shell_job(
                &unknown.process_handle,
                "native-job-owner",
                "typing-agent",
                "typing-task",
            )
            .unwrap();
        assert!(!uncertain.launch_confirmed);
        assert_eq!(
            uncertain.accepted_command_line,
            Some(unknown.submitted_command_line.clone())
        );
        let reconciled = observe(&unknown, false);
        assert_eq!(reconciled.state, "running");
        assert!(reconciled.launch_confirmed);
        observe(&unknown, true);
        assert_eq!(until_exit(&unknown).state, "exited");
        assert_eq!(
            fs::read_to_string(&missing_ack).unwrap(),
            "once\n",
            "unconfirmed native launch was replayed"
        );
        assert_eq!(
            run(
                "__shellspan_job_register() { __shellspan_emit B \"$1\" running -; }",
                None
            )
            .unwrap()
            .exit_code,
            Some(0)
        );
        wait_for_prompt(broker, transport);
        let long = format!(
            ": {}\nprintf native-long-while-jobs-finish",
            shlex::try_quote(&"'\"".repeat(1400)).unwrap()
        );
        assert!(long.len() <= 8192);
        if let Ok(path) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
            fs::write(
                format!("{path}.expected.json"),
                serde_json::to_vec(&long).unwrap(),
            )
            .unwrap();
        }
        for wave in 0..3 {
            let quick: Vec<_> = (0..8)
                .map(|index| launch(&format!("sleep 0.5; exit {index}")))
                .collect();
            for iteration in 0..6 {
                let result = run(&long, None).unwrap();
                assert_eq!(
                    result.exit_code,
                    Some(0),
                    "long source failed in wave {wave}, iteration {iteration}: state={:?} rejection={:?}; broker={:?}",
                    result.state,
                    result.input_rejection,
                    broker.snapshot(Some(transport)).unwrap().session
                );
                assert_eq!(result.command_line, long);
            }
            for (index, job) in quick.iter().enumerate() {
                assert_eq!(until_exit(job).exit_code, Some(index as i32));
            }
        }
        assert!(
            broker.native_input_enabled(transport).unwrap(),
            "concurrent job completion corrupted the control stream"
        );
        for takeover in [false, true] {
            let id = format!("job-edit-cancel-{}", Uuid::new_v4());
            let clears_before = writes
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, input)| input == "\u{18}\u{4}")
                .count();
            let effect = directory.path().join(&id);
            let source = format!(
                "printf should-never-run >| {}",
                shell_single_quote(effect.to_str().unwrap())
            );
            let job = broker
                .prepare_shell_job(
                    transport,
                    &target,
                    "typing-agent",
                    "typing-task",
                    &id,
                    &source,
                )
                .unwrap();
            let operation = thread::scope(|scope| {
                let launch = scope.spawn(|| {
                    registry.start_native_submission(
                        sessions,
                        transport,
                        "typing-agent",
                        "typing-task",
                        &id,
                        &source,
                        shell.enter(),
                        Some(&job.submitted_command_line),
                        |_| Ok(()),
                    )
                });
                let encoded = crate::agent_runtime::native_editor_final_chunk(
                    &job.submitted_command_line,
                    shell,
                );
                wait_until(Duration::from_secs(5), || {
                    let queued = writes
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|(_, data)| data == &encoded);
                    queued
                        && registry
                            .native_editor_confirmed_for_test(transport, &id)
                            .unwrap_or(false)
                });
                if takeover {
                    registry
                        .takeover(sessions, transport, "typing-agent", &id)
                        .unwrap();
                } else {
                    registry.cancel_task(sessions, "typing-task").unwrap();
                }
                launch.join().unwrap().unwrap()
            });
            let result = registry
                .wait(sessions, transport, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(
                writes
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(_, input)| input == "\u{18}\u{4}")
                    .count(),
                clears_before + 1,
                "native editor cancellation must clear once without interrupting prompt hooks"
            );
            assert_eq!(
                result.state,
                if takeover {
                    TerminalCommandState::TakenOver
                } else {
                    TerminalCommandState::Cancelled
                }
            );
            wait_for_prompt(broker, transport);
            let sequence = broker
                .snapshot(Some(transport))
                .unwrap()
                .session
                .unwrap()
                .integration_event_sequence;
            broker
                .admit_terminal_input(
                    transport,
                    crate::terminal_broker::TerminalBrokerInputSource::User,
                    crate::terminal_broker::TerminalInputKind::Text,
                    b"\n",
                    || {
                        let mut writer = writer.lock().unwrap();
                        writer.write_all(b"\n").map_err(|error| error.to_string())?;
                        writer.flush().map_err(|error| error.to_string())
                    },
                )
                .unwrap();
            wait_until(Duration::from_secs(5), || {
                broker
                    .snapshot(Some(transport))
                    .unwrap()
                    .session
                    .is_some_and(|session| {
                        session.prompt_ready && session.integration_event_sequence > sequence
                    })
            });
            assert!(
                !effect.exists(),
                "cancelled native job launch executed on subsequent user Enter"
            );
            assert_eq!(
                broker
                    .shell_job(
                        &job.process_handle,
                        "native-job-owner",
                        "typing-agent",
                        "typing-task"
                    )
                    .unwrap()
                    .state,
                "rejected"
            );
            leases.release_turn("typing-agent").unwrap();
        }
        let owned_a = launch("sleep 60");
        let owned_b = launch("sleep 60");
        assert_eq!(
            registry
                .cleanup_shell_jobs(sessions, Some("another-task"))
                .unwrap(),
            0
        );
        assert_eq!(observe(&owned_a, false).state, "running");
        registry
            .cleanup_shell_jobs(sessions, Some("typing-task"))
            .unwrap();
        for job in [&owned_a, &owned_b] {
            let final_job = broker
                .shell_job(
                    &job.process_handle,
                    "native-job-owner",
                    "typing-agent",
                    "typing-task",
                )
                .unwrap();
            assert_eq!(
                final_job.state, "exited",
                "task cancellation did not confirm cleanup: {final_job:?}"
            );
            assert!(final_job.stop_requested);
        }
        if shell == TerminalShellKind::Bash {
            // Repeated real child exits and TERM/CONT settlements overlap the
            // next native descriptor/data receive. Bash 4.1's read -N/-s used
            // an interruptible tcsetattr here even though Readline was raw.
            let counter = directory.path().join("receive-exit-stress-count");
            fs::write(&counter, "").unwrap();
            let start = display.lock().unwrap().len();
            for _ in 0..24 {
                let quick = launch(&format!(
                    "printf x >> {}; sleep 0.01; exit 19",
                    shell_single_quote(counter.to_str().unwrap())
                ));
                let stopped = launch("sleep 60");
                assert_eq!(until_exit(&quick).exit_code, Some(19));
                observe(&stopped, true);
                assert_eq!(until_exit(&stopped).state, "exited");
            }
            assert_eq!(fs::read_to_string(&counter).unwrap(), "x".repeat(24));
            let bytes = display.lock().unwrap();
            let raw = String::from_utf8_lossy(&bytes[start..]);
            assert!(
                !raw.contains("error setting terminal attributes"),
                "native receive changed terminal attributes while children were exiting"
            );
            assert!(
                !raw.contains("__shellspan_"),
                "private receive/control implementation leaked during exit stress"
            );
        }
        let ordinary_start = writes.lock().unwrap().len();
        assert_eq!(run("set +m", None).unwrap().exit_code, Some(0));
        if shell == TerminalShellKind::Zsh {
            assert!(
                !writes.lock().unwrap()[ordinary_start..]
                    .iter()
                    .any(|(_, wire)| wire == "\u{18}\u{2}"),
                "ordinary short input without active jobs changed to the frame path"
            );
        }
        wait_for_prompt(broker, transport);
        let before = writes.lock().unwrap().len();
        assert!(broker
            .prepare_shell_job(
                transport,
                &target,
                "typing-agent",
                "typing-task",
                "monitor-off",
                "printf never"
            )
            .unwrap_err()
            .contains("TERMINAL_BACKGROUND_UNSUPPORTED"));
        assert_eq!(writes.lock().unwrap().len(), before);
        assert_eq!(
            run("[[ ! -o monitor ]]", None).unwrap().exit_code,
            Some(0),
            "background gate changed the user's monitor option"
        );
        assert_eq!(run("set -m", None).unwrap().exit_code, Some(0));
        wait_for_prompt(broker, transport);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_bash_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/bash", TerminalShellKind::Bash);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    #[ignore = "requires SHELLSPAN_TEST_MODERN_BASH pointing to a native Bash 4.1+ executable"]
    fn native_modern_bash_complete_script_acceptance() {
        let path =
            std::env::var("SHELLSPAN_TEST_MODERN_BASH").expect("native Bash executable required");
        assert!(std::process::Command::new(&path)
            .args([
                "-c",
                "(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 1) ))"
            ])
            .status()
            .unwrap()
            .success());
        run_native_visible_command_acceptance_with_screen(
            &path,
            TerminalShellKind::Bash,
            std::env::var_os("SHELLSPAN_NATIVE_SCRIPT_NARROW").is_some(),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_zsh_missing_editor_checkpoint_quarantines_until_reconnect() {
        run_native_visible_command_acceptance_mode("/bin/zsh", TerminalShellKind::Zsh, false, true);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    #[ignore = "requires SHELLSPAN_TEST_MODERN_BASH pointing to native Bash 4+"]
    fn native_modern_bash_missing_editor_checkpoint_quarantines_until_reconnect() {
        let path =
            std::env::var("SHELLSPAN_TEST_MODERN_BASH").expect("native Bash executable required");
        run_native_visible_command_acceptance_mode(&path, TerminalShellKind::Bash, false, true);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn native_bash_repeated_enter_does_not_echo_ahead_of_prompts() {
        run_bash_repeated_enter_acceptance(false, false);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn native_bash_restores_prompt_modes_after_user_removes_exit_trap() {
        run_bash_repeated_enter_acceptance(false, true);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn bash_previous_trap_preserves_status_and_arguments_without_spawning_a_job() {
        let script = format!(
            "{}\n{}",
            bash_bootstrap(Path::new("/dev/null"), false, false),
            r#"set -T
trap 'if [[ ${BASH_SUBSHELL:-0} != 0 ]]; then builtin printf "unexpected-subshell\n"; fi' DEBUG
for status in 0 1 130; do
  __shellspan_run_previous_trap "trap -- 'printf \"status:%s arg:%s\\n\" \"\$?\" \"\$1\"' SIGINT" "$status" user-argument
done
trap - DEBUG
"#,
        );
        let output = std::process::Command::new("/bin/bash")
            .args(["--noprofile", "--norc", "-c", &script])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            std::str::from_utf8(&output.stdout).unwrap(),
            "status:0 arg:user-argument\nstatus:1 arg:user-argument\nstatus:130 arg:user-argument\n"
        );
        assert!(output.stderr.is_empty(), "{output:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_bash_concurrent_prompt_helpers_preserve_job_control() {
        for _ in 0..3 {
            let workers: Vec<_> = (0..4)
                .map(|_| thread::spawn(|| run_bash_keyboard_acceptance(false, true, "")))
                .collect();
            for worker in workers {
                worker.join().unwrap();
            }
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    #[ignore = "requires SHELLSPAN_ENTER_SSH_TARGET and existing SSH authentication"]
    fn ssh_bash_repeated_enter_does_not_echo_ahead_of_prompts() {
        run_bash_repeated_enter_acceptance(true, false);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    #[ignore = "requires SHELLSPAN_ENTER_SSH_TARGET and existing SSH authentication"]
    fn ssh_bash_restores_prompt_modes_after_user_removes_exit_trap() {
        run_bash_repeated_enter_acceptance(true, true);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run_bash_repeated_enter_acceptance(remote: bool, remove_exit_trap: bool) {
        // Keep the real settings change and slow hook without making the hook
        // itself create foreground jobs subject to macOS Bash 3's setpgid race.
        run_bash_keyboard_acceptance(
            remote,
            remove_exit_trap,
            ": \"$(exec stty -ixon </dev/tty)\" \"$(exec sleep 0.01)\"",
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run_bash_keyboard_acceptance(remote: bool, remove_exit_trap: bool, prompt_command: &str) {
        use portable_pty::{native_pty_system, PtySize};
        use std::io::Write;
        use std::sync::mpsc;
        use std::time::Instant;

        let (_fixture, integration) = prepare_test_integration(TerminalShellKind::Bash);
        let home = tempfile::tempdir().unwrap();
        // A real prompt command creates the same cooked-mode window as slow
        // profile hooks/control-channel writes, without changing transport data.
        let profile = format!(
            "PS1='enter-probe$ '; PROMPT_COMMAND={}\n\
            trap 'status=$?; printf \"exit-mode-start\\n\"; stty -a; printf \"exit-mode-end\\nexit-status=%s\\nexit-arg=%s\\n\" \"$status\" \"$1\"' EXIT\n",
            shell_single_quote(prompt_command)
        );
        fs::write(home.path().join(".bash_profile"), &profile).unwrap();
        let target = remote
            .then(|| std::env::var("SHELLSPAN_ENTER_SSH_TARGET").expect("SSH target required"));
        let mut remote_root = None;
        if let Some(target) = &target {
            let output = std::process::Command::new("ssh")
                .args([
                    "-oBatchMode=yes",
                    "-oConnectTimeout=8",
                    target,
                    "umask 077; mktemp -d /tmp/shellspan-enter.XXXXXXXX",
                ])
                .output()
                .unwrap();
            assert!(output.status.success(), "SSH temporary directory failed");
            let root = String::from_utf8(output.stdout).unwrap().trim().to_string();
            assert!(
                root.starts_with("/tmp/shellspan-enter.") && !root.contains(char::is_whitespace)
            );
            let mut upload = std::process::Command::new("ssh")
                .args([
                    "-oBatchMode=yes",
                    target,
                    &format!("umask 077; cat > {}/bashrc", shell_single_quote(&root)),
                ])
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            // Execute the production remote bootstrap in a real SSH PTY. The
            // isolated control stream is not used for screen assertions.
            upload
                .stdin
                .take()
                .unwrap()
                .write_all(
                    format!(
                        "{profile}{}",
                        bash_bootstrap(Path::new("/dev/null"), false, false)
                    )
                    .as_bytes(),
                )
                .unwrap();
            assert!(upload.wait().unwrap().success());
            remote_root = Some(root);
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 300,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = crate::local_terminal_input::take_writer(
            pair.master.as_ref(),
            if remote {
                TerminalShellKind::Unsupported
            } else {
                TerminalShellKind::Bash
            },
        )
        .unwrap();
        let mut command = if let Some(target) = &target {
            let mut command = CommandBuilder::new("ssh");
            command.args([
                "-tt",
                "-oBatchMode=yes",
                "-oConnectTimeout=8",
                target,
                &format!(
                    "bash --noprofile --rcfile {}/bashrc -i; status=$?; printf 'outer-mode-start\\n'; stty -a; printf 'outer-mode-end\\nouter-status=%s\\n' \"$status\"; exit \"$status\"",
                    shell_single_quote(remote_root.as_ref().unwrap())
                ),
            ]);
            command
        } else {
            let mut command = CommandBuilder::new("/bin/bash");
            command.env("HOME", home.path());
            command.env("HISTFILE", home.path().join("history.txt"));
            integration.configure_command(&mut command).unwrap();
            command
        };
        command.env("TERM", "xterm-256color");
        command.env("BASH_SILENCE_DEPRECATION_WARNING", "1");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut control = integration.start_reader(|_| Ok(()), |_| {});
        let (sender, receiver) = mpsc::channel();
        let output_thread = thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 || sender.send(buffer[..count].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut owned_job_group: Option<libc::pid_t> = None;
        let mut interrupt_modes = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut bytes = Vec::new();
            let receive_prompts = |bytes: &mut Vec<u8>, expected: usize| {
                let prompt_count = |bytes: &[u8]| {
                    let mut terminal = vt100::Parser::new(300, 120, 0);
                    terminal.process(bytes);
                    terminal
                        .screen()
                        .contents()
                        .lines()
                        .filter(|line| line.starts_with("enter-probe$"))
                        .count()
                };
                let deadline = Instant::now() + Duration::from_secs(15);
                // Readline can redraw PS1 on the same line before delivering a
                // signal trap. A redraw is not another completed prompt cycle.
                while prompt_count(bytes) < expected {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    bytes.extend(receiver.recv_timeout(remaining).unwrap_or_else(|error| {
                        panic!(
                            "Bash prompt timed out ({error}): expected {expected}, received {}; output: {:?}",
                            prompt_count(bytes),
                            String::from_utf8_lossy(bytes)
                        )
                    }));
                }
            };
            let wait_for_readline = || {
                if !remote {
                    wait_until(Duration::from_secs(15), || {
                        let mut modes = std::mem::MaybeUninit::<libc::termios>::uninit();
                        unsafe {
                            libc::tcgetattr(pair.master.as_raw_fd().unwrap(), modes.as_mut_ptr())
                                == 0
                                && modes.assume_init().c_lflag & (libc::ICANON | libc::ECHO) == 0
                        }
                    });
                }
            };
            receive_prompts(&mut bytes, 1);
            for _ in 0..60 {
                writer.write_all(b"\r").unwrap();
                writer.flush().unwrap();
                thread::sleep(Duration::from_millis(5));
            }
            receive_prompts(&mut bytes, 61);
            if prompt_command.is_empty() {
                assert!(
                    !String::from_utf8_lossy(&bytes).contains("setpgid"),
                    "prompt helpers triggered a process-group warning: {:?}",
                    String::from_utf8_lossy(&bytes)
                );
            }
            let mut terminal = vt100::Parser::new(300, 120, 0);
            terminal.process(&bytes);
            let contents = terminal.screen().contents();
            assert_eq!(
                contents.lines().count(),
                61,
                "unexpected blank lines: {contents:?}"
            );
            assert!(
                contents
                    .lines()
                    .all(|line| line.trim_end() == "enter-probe$"),
                "{contents:?}"
            );

            // Exercise real line editing and preserve intentional empty output lines.
            writer
                .write_all(b"printf 'EDIT:%s\\n' abx\x7fc\x1b[D\x04c; printf 'first\\n\\nlast\\n'; stty -a; printf 'bash-major:%s\\n' \"${BASH_VERSINFO[0]}\"; if (( BASH_VERSINFO[0] < 4 )); then [[ -z $(trap -p INT) ]] && printf 'BASH3-DEFAULT-INT\\n'; fi\r")
                .unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 62);
            terminal = vt100::Parser::new(300, 120, 0);
            terminal.process(&bytes);
            let contents = terminal.screen().contents();
            assert!(contents.contains("EDIT:abc"), "{contents:?}");
            assert!(contents.contains("first\n\nlast"), "{contents:?}");
            let output = String::from_utf8_lossy(&bytes);
            if !prompt_command.is_empty() {
                assert!(
                    output.contains("-ixon"),
                    "prompt hook settings were overwritten: {output:?}"
                );
            }
            let major = regex::Regex::new(r"bash-major:(\d+)")
                .unwrap()
                .captures(&output)
                .unwrap()[1]
                .parse::<u32>()
                .unwrap();
            if major < 4 {
                assert!(
                    output.contains("BASH3-DEFAULT-INT\r\n"),
                    "Bash 3 must retain default prompt cancellation without a user INT handler: {output:?}"
                );
            }
            let changed_modes =
                regex::Regex::new(r"(?:^|[\s;])-(?:echo|icrnl|echoctl)(?:[\s;]|$)").unwrap();
            assert!(
                !changed_modes.is_match(&String::from_utf8_lossy(&bytes)),
                "command inherited prompt modes: {contents:?}"
            );

            // A single transport burst must not lose or echo any of its Enters.
            writer.write_all(&[b'\r'; 80]).unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 142);
            terminal = vt100::Parser::new(300, 120, 0);
            terminal.process(&bytes);
            let contents = terminal.screen().contents();
            let tail: Vec<_> = contents.lines().rev().take(80).collect();
            assert_eq!(tail.len(), 80);
            assert!(
                tail.iter().all(|line| line.trim_end() == "enter-probe$"),
                "{contents:?}"
            );

            let signal_phase_start = bytes.len();
            // Kernel echo during prompt setup does not prove Readline consumed
            // the input. Require the actual editor mode before typing it.
            wait_for_readline();
            writer.write_all(b"typed-before-cancel").unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !String::from_utf8_lossy(&bytes).contains("typed-before-cancel") {
                bytes.extend(
                    receiver
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .unwrap(),
                );
            }
            let interrupt_start = bytes.len();
            if !remote {
                let mut modes = std::mem::MaybeUninit::<libc::termios>::uninit();
                if unsafe { libc::tcgetattr(pair.master.as_raw_fd().unwrap(), modes.as_mut_ptr()) }
                    == 0
                {
                    let modes = unsafe { modes.assume_init() };
                    interrupt_modes = Some((modes.c_iflag, modes.c_lflag));
                }
            }
            writer.write_all(b"\x03").unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 143);
            if major >= 4 {
                assert!(
                    String::from_utf8_lossy(&bytes[interrupt_start..]).contains("^C"),
                    "Ctrl+C feedback was lost"
                );
            }
            writer
                .write_all(b"printf 'INT-status:%s\\n' \"$?\"\r")
                .unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 144);
            terminal = vt100::Parser::new(300, 120, 0);
            terminal.process(&bytes);
            assert!(
                regex::Regex::new(r"(?m)^INT-status:\d+$")
                    .unwrap()
                    .is_match(&terminal.screen().contents()),
                "default SIGINT did not cancel the input: {:?}",
                String::from_utf8_lossy(&bytes)
            );
            if major >= 4 {
                assert!(
                    String::from_utf8_lossy(&bytes).contains("INT-status:130\r\n"),
                    "Ctrl+C status changed"
                );
            }

            // Runtime signal handlers must still run once, with the original status.
            writer
                .write_all(b"set -- user-signal-arg; trap 'printf \"CUSTOM-INT:%s\\n\" \"$?\"; printf \"CUSTOM-ARG:%s\\n\" \"$1\"' INT\r")
                .unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 145);
            // PS1 is written before Readline switches the terminal to raw input.
            // Sending a signal in that window tests prompt setup rather than
            // the installed handler at an input prompt.
            wait_for_readline();
            writer.write_all(b"\x03").unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 146);
            assert!(
                String::from_utf8_lossy(&bytes).contains("CUSTOM-ARG:user-signal-arg\r\n"),
                "custom INT handler did not report the original arguments: {:?}",
                String::from_utf8_lossy(&bytes)
            );
            if major >= 4 {
                assert_eq!(
                    String::from_utf8_lossy(&bytes)
                        .matches("CUSTOM-INT:130\r\n")
                        .count(),
                    1,
                    "custom INT handler lost its status or ran repeatedly"
                );
            }
            if prompt_command.is_empty() {
                let output = String::from_utf8_lossy(&bytes[signal_phase_start..]);
                assert!(
                    !output.contains("setpgid"),
                    "signal helpers triggered a process-group warning: {output:?}"
                );
            }

            // Ignoring INT at a prompt must remain inherited by foreground programs.
            writer.write_all(b"trap '' INT\r").unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 147);
            writer
                .write_all(
                    b"printf 'ignore-ready\\n'; sleep 0.4 && printf 'IGNORED-INT-SURVIVED\\n'\r",
                )
                .unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !String::from_utf8_lossy(&bytes).contains("ignore-ready\r\n") {
                bytes.extend(
                    receiver
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .unwrap(),
                );
            }
            writer.write_all(b"\x03").unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 148);
            assert!(
                String::from_utf8_lossy(&bytes).contains("IGNORED-INT-SURVIVED\r\n"),
                "ignored SIGINT was reset for a foreground program"
            );
            writer.write_all(b"trap - INT\r").unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 149);
            // Without Readline, the canonical line discipline must translate Enter.
            writer.write_all(b"set +o emacs\r").unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 150);
            writer
                .write_all(b"printf 'NO-EDITING-ENTER-WORKS\\n'\r")
                .unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 151);
            assert!(
                String::from_utf8_lossy(&bytes).contains("NO-EDITING-ENTER-WORKS\r\n"),
                "Enter no longer submitted a command with line editing disabled"
            );
            writer.write_all(b"set -o emacs\r").unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, 152);
            let mut final_prompt = 153;
            if !remote {
                let terminal_fd = pair.master.as_raw_fd().unwrap();
                let shell_pid = child.process_id().unwrap() as libc::pid_t;
                assert_eq!(
                    unsafe { libc::tcgetpgrp(terminal_fd) },
                    shell_pid,
                    "the shell did not regain its terminal"
                );
                writer
                    .write_all(b"/bin/sh -c 'printf \"JOB-READY:%s\\n\" \"$$\"; exec sleep 30'\r")
                    .unwrap();
                writer.flush().unwrap();
                let ready = regex::Regex::new(r"JOB-READY:(\d+)").unwrap();
                let deadline = Instant::now() + Duration::from_secs(15);
                while !ready.is_match(&String::from_utf8_lossy(&bytes)) {
                    bytes.extend(
                        receiver
                            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                            .unwrap(),
                    );
                }
                let group = ready.captures(&String::from_utf8_lossy(&bytes)).unwrap()[1]
                    .parse::<libc::pid_t>()
                    .unwrap();
                owned_job_group = Some(group);
                assert_ne!(
                    group, shell_pid,
                    "foreground command shares the shell's process group"
                );
                assert_eq!(unsafe { libc::tcgetpgrp(terminal_fd) }, group);
                // The shell prints JOB-READY before exec. Wait for the actual
                // foreground program so Ctrl+Z cannot race /bin/sh startup.
                let pid = sysinfo::Pid::from_u32(group as u32);
                let mut processes = sysinfo::System::new();
                wait_until(Duration::from_secs(15), || {
                    processes.refresh_processes_specifics(
                        sysinfo::ProcessesToUpdate::Some(&[pid]),
                        true,
                        sysinfo::ProcessRefreshKind::nothing()
                            .with_exe(sysinfo::UpdateKind::Always),
                    );
                    processes
                        .process(pid)
                        .and_then(|process| process.exe())
                        .and_then(|exe| exe.file_name())
                        .is_some_and(|name| name == "sleep")
                });
                writer.write_all(b"\x1a").unwrap();
                writer.flush().unwrap();
                receive_prompts(&mut bytes, 153);
                writer.write_all(b"[[ -n $(jobs -s -p %+) ]] && printf 'JOB-STOPPED\\n'; bg %+; [[ -n $(jobs -r -p %+) ]] && printf 'JOB-BACKGROUND\\n'\r").unwrap();
                writer.flush().unwrap();
                receive_prompts(&mut bytes, 154);
                let output = String::from_utf8_lossy(&bytes);
                assert!(
                    output.contains("JOB-STOPPED\r\n"),
                    "Ctrl+Z did not stop the foreground job: {output:?}"
                );
                assert!(
                    output.contains("JOB-BACKGROUND\r\n"),
                    "bg did not resume the job: {output:?}"
                );
                writer.write_all(b"fg %+\r").unwrap();
                writer.flush().unwrap();
                let deadline = Instant::now() + Duration::from_secs(15);
                while unsafe { libc::tcgetpgrp(terminal_fd) } != group {
                    assert!(
                        Instant::now() < deadline,
                        "fg did not restore the job's terminal ownership"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                writer.write_all(b"\x03").unwrap();
                writer.flush().unwrap();
                receive_prompts(&mut bytes, 155);
                writer.write_all(b"printf 'JOB-INT-status:%s\\n' \"$?\"; [[ -o monitor ]] && printf 'MONITOR-ON\\n'; set +m\r").unwrap();
                writer.flush().unwrap();
                receive_prompts(&mut bytes, 156);
                writer
                    .write_all(b"[[ ! -o monitor ]] && printf 'MONITOR-OFF\\n'; set -m\r")
                    .unwrap();
                writer.flush().unwrap();
                receive_prompts(&mut bytes, 157);
                let output = String::from_utf8_lossy(&bytes);
                assert!(
                    output.contains("JOB-INT-status:130\r\n"),
                    "Ctrl+C failed after fg: {output:?}"
                );
                assert!(
                    output.contains("MONITOR-ON\r\n"),
                    "helpers disabled job control: {output:?}"
                );
                assert!(
                    output.contains("MONITOR-OFF\r\n"),
                    "helpers overrode the user's monitor setting: {output:?}"
                );
                final_prompt = 158;
            }
            let final_command: &[u8] = if remove_exit_trap {
                b"trap - EXIT; false\r"
            } else {
                b"false\r"
            };
            writer.write_all(final_command).unwrap();
            writer.flush().unwrap();
            receive_prompts(&mut bytes, final_prompt);
            writer.write_all(b"\x04").unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            while let Ok(chunk) =
                receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                bytes.extend(chunk);
            }
            let output = String::from_utf8_lossy(&bytes);
            if !remote {
                let mut modes = std::mem::MaybeUninit::<libc::termios>::uninit();
                // The owned master FD remains open after the shell exits.
                assert_eq!(
                    unsafe {
                        libc::tcgetattr(pair.master.as_raw_fd().unwrap(), modes.as_mut_ptr())
                    },
                    0
                );
                let modes = unsafe { modes.assume_init() };
                assert_ne!(
                    modes.c_iflag & libc::ICRNL,
                    0,
                    "ICRNL was not restored on EOF"
                );
                assert_ne!(
                    modes.c_lflag & libc::ECHOCTL,
                    0,
                    "ECHOCTL was not restored on EOF"
                );
                assert_eq!(
                    modes.c_iflag & libc::IXON,
                    if prompt_command.is_empty() {
                        libc::IXON
                    } else {
                        0
                    },
                    "prompt hook IXON setting was lost on EOF"
                );
            }
            if remove_exit_trap {
                assert!(
                    !output.contains("exit-mode-start\r\n"),
                    "removed EXIT handler ran again"
                );
                if !remote {
                    return;
                }
            } else {
                assert!(
                    output.contains("exit-arg=user-signal-arg\r\n"),
                    "EXIT handler lost the shell's positional arguments"
                );
            }
            let (start, end, status) = if remove_exit_trap {
                (
                    "outer-mode-start\r\n",
                    "outer-mode-end\r\n",
                    "outer-status=1\r\n",
                )
            } else {
                (
                    "exit-mode-start\r\n",
                    "exit-mode-end\r\n",
                    "exit-status=1\r\n",
                )
            };
            let exit_modes = output
                .split_once(start)
                .and_then(|(_, tail)| tail.split_once(end))
                .map(|(modes, _)| modes)
                .expect("previous EXIT handler did not report terminal settings");
            assert!(
                !changed_modes.is_match(exit_modes),
                "exit inherited prompt modes: {output:?}"
            );
            assert!(
                exit_modes.contains("-ixon"),
                "user terminal settings were lost: {output:?}"
            );
            assert!(
                output.contains(status),
                "EOF exit status changed: {output:?}"
            );
        }));
        if result.is_err() && std::env::var_os("SHELLSPAN_BASH_FAILURE_DIAGNOSTICS").is_some() {
            #[cfg(target_os = "macos")]
            eprintln!(
                "Bash input routing: {}",
                crate::local_terminal_input::interrupt_diagnostic()
            );
            eprintln!("Bash modes immediately before SIGINT: {interrupt_modes:?}");
            let fd = pair.master.as_raw_fd().unwrap();
            let mut modes = std::mem::MaybeUninit::<libc::termios>::uninit();
            if unsafe { libc::tcgetattr(fd, modes.as_mut_ptr()) } == 0 {
                let modes = unsafe { modes.assume_init() };
                eprintln!(
                    "Bash failure terminal: foreground={}, shell={:?}, iflag={}, lflag={}",
                    unsafe { libc::tcgetpgrp(fd) },
                    child.process_id(),
                    modes.c_iflag,
                    modes.c_lflag
                );
            }
            if let Some(pid) = child.process_id() {
                let mut processes = sysinfo::System::new();
                processes.refresh_processes_specifics(
                    sysinfo::ProcessesToUpdate::All,
                    true,
                    sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
                );
                let mut parents = vec![sysinfo::Pid::from_u32(pid)];
                let mut sampled_children = 0;
                while let Some(parent) = parents.pop() {
                    for (pid, process) in processes.processes() {
                        if process.parent() == Some(parent) {
                            parents.push(*pid);
                            eprintln!(
                                "Bash failure descendant: pid={} parent={} group={} status={:?} name={:?} exe={:?}",
                                pid.as_u32(), parent.as_u32(),
                                unsafe { libc::getpgid(pid.as_u32() as libc::pid_t) },
                                process.status(), process.name(), process.exe()
                            );
                            if cfg!(target_os = "macos") && sampled_children < 2 {
                                sampled_children += 1;
                                if let Ok(trace) = tempfile::NamedTempFile::new() {
                                    let sampled = std::process::Command::new("sample")
                                        .args([&pid.as_u32().to_string(), "1", "-file"])
                                        .arg(trace.path())
                                        .output();
                                    if sampled.is_ok_and(|output| output.status.success()) {
                                        if let Ok(trace) = fs::read_to_string(trace.path()) {
                                            eprintln!("Bash descendant stack pid={pid}: {trace}");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if cfg!(target_os = "macos") {
                    if let Ok(trace) = tempfile::NamedTempFile::new() {
                        let sampled = std::process::Command::new("sample")
                            .args([&pid.to_string(), "1", "-file"])
                            .arg(trace.path())
                            .output();
                        if sampled.is_ok_and(|output| output.status.success()) {
                            if let Ok(trace) = fs::read_to_string(trace.path()) {
                                eprintln!("Bash failure stack: {trace}");
                            }
                        }
                    }
                }
                if let Ok(status) = std::process::Command::new("ps")
                    .args([
                        "-o",
                        "pid,ppid,pgid,stat,wchan,command",
                        "-p",
                        &pid.to_string(),
                    ])
                    .output()
                {
                    eprintln!(
                        "Bash failure process: {}",
                        String::from_utf8_lossy(&status.stdout)
                    );
                }
            }
            for (label, input) in [
                ("redraw", b"\x0c".as_slice()),
                (
                    "input probe",
                    b"printf 'SHELLSPAN_POST_INTERRUPT:%s\\n' \"$?\"\r".as_slice(),
                ),
                ("canonical newline probe", b"\n".as_slice()),
            ] {
                if let Err(error) = writer.write_all(input).and_then(|()| writer.flush()) {
                    eprintln!("Bash failure {label} unavailable: {error}");
                    break;
                }
                let mut diagnostic = Vec::new();
                let deadline = Instant::now() + Duration::from_secs(1);
                while let Ok(chunk) =
                    receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    diagnostic.extend(chunk);
                }
                eprintln!(
                    "Bash failure {label}: {:?}",
                    String::from_utf8_lossy(&diagnostic)
                );
            }
        }
        if let Some(group) = owned_job_group {
            // Reap only this fixture's job on assertion failure, without leaving
            // a background process holding the PTY output reader open.
            if unsafe { libc::getsid(group) } == child.process_id().unwrap() as libc::pid_t {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        child.wait().unwrap();
        control.stop();
        drop(writer);
        drop(pair.master);
        output_thread.join().unwrap();
        if let (Some(target), Some(root)) = (&target, &remote_root) {
            let cleanup = std::process::Command::new("ssh")
                .args([
                    "-oBatchMode=yes",
                    target,
                    &format!(
                        "rm -f -- {}/bashrc; rmdir -- {}",
                        shell_single_quote(root),
                        shell_single_quote(root)
                    ),
                ])
                .status()
                .unwrap();
            assert!(cleanup.success(), "SSH test cleanup failed");
        }
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_zsh_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/zsh", TerminalShellKind::Zsh);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_zsh_typing_with_negotiated_bracketed_paste() {
        run_native_visible_command_acceptance_with_screen("/bin/zsh", TerminalShellKind::Zsh, true);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires explicit SHELLSPAN_TEST_NATIVE_ZSH_USER_HOME and the real Powerlevel profile"]
    fn macos_native_zsh_user_powerlevel_profile_preserves_job_display() {
        assert!(std::env::var_os("SHELLSPAN_TEST_NATIVE_ZSH_USER_HOME").is_some());
        run_native_visible_command_acceptance("/bin/zsh", TerminalShellKind::Zsh);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires explicit SHELLSPAN_TEST_NATIVE_ZSH_USER_HOME and the real Powerlevel profile"]
    fn macos_native_zsh_user_powerlevel_profile_preserves_job_display_narrow() {
        assert!(std::env::var_os("SHELLSPAN_TEST_NATIVE_ZSH_USER_HOME").is_some());
        run_native_visible_command_acceptance_with_screen("/bin/zsh", TerminalShellKind::Zsh, true);
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
    include!("terminal_integration_windows.rs");

    #[cfg(target_os = "windows")]
    include!("terminal_editor_windows.rs");
