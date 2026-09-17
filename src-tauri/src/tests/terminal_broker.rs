    use super::*;
    use crate::terminal_screen::TerminalScreenBuffer;

    fn attach_ready_user_ssh_transport(
        broker: &TerminalSessionBroker,
        transport_session_id: &str,
    ) -> TerminalBrokerAttachment {
        let attachment = broker
            .attach_transport(
                transport_session_id,
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap()
            .unwrap();
        let integration_id = format!("integration-{transport_session_id}");
        broker
            .register_integration_channel(
                transport_session_id,
                &integration_id,
                TerminalShellKind::Bash,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Bash,
            },
            TerminalIntegrationControlEvent::PromptStart {
                cwd: "/home/tester".into(),
            },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event(transport_session_id, &integration_id, event)
                .unwrap();
        }
        attachment
    }

    #[cfg(unix)]
    fn run_native_shell_broker_acceptance(shell: &str, args: &[&str], label: &str) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::thread;
        use std::time::{Duration, Instant};

        let broker = TerminalSessionBroker::enabled_for_test(512, 1_048_576, 1_048_576);
        let attachment = broker
            .attach_transport(
                "shell-transport",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        pair.master
            .resize(PtySize {
                rows: 33,
                cols: 111,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        broker
            .resize("shell-transport", TerminalGeometry::new(111, 33))
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new(shell);
        command.args(args);
        command.env("TERM", "xterm-256color");
        command.env("LC_ALL", "C");
        command.env("PS1", "");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let reader_broker = broker.clone();
        let reader_shell = shell.to_string();
        let reader_thread = thread::spawn(move || -> Result<_, String> {
            let mut raw = Vec::new();
            let mut frames = Vec::new();
            let mut buffer = [0_u8; 257];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let bytes = &buffer[..count];
                        let frame = reader_broker
                            .observe_raw_output("shell-transport", bytes)?
                            .ok_or_else(|| "enabled broker omitted a raw frame".to_string())?;
                        if frame.bytes != bytes {
                            return Err("broker display frame changed PTY bytes".into());
                        }
                        raw.extend_from_slice(bytes);
                        frames.push(frame);
                    }
                    // Unix PTY masters commonly report EIO after the slave
                    // closes. It is EOF only after some output was observed.
                    Err(error) if error.raw_os_error() == Some(libc::EIO) && !raw.is_empty() => {
                        break;
                    }
                    Err(error) => return Err(format!("read {reader_shell} PTY: {error}")),
                }
            }
            Ok((raw, frames))
        });

        let input = format!(
                        "printf 'SHELLSPAN_{label}_RAW_BEGIN:'; printf '\\377'; printf ':\\033[31mred\\033[0m:'; printf '\\346\\261\\211'; printf ':END'; exit\n"
                    );
        broker
            .admit_terminal_input(
                "shell-transport",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                input.as_bytes(),
                || {
                    writer
                        .write_all(input.as_bytes())
                        .map_err(|error| format!("write {shell} PTY: {error}"))?;
                    writer
                        .flush()
                        .map_err(|error| format!("flush {shell} PTY: {error}"))
                },
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            match child.try_wait().unwrap() {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    child.kill().unwrap();
                    panic!("{shell} PTY did not exit before acceptance deadline");
                }
            }
        };
        drop(writer);
        drop(pair.master);
        let (raw, frames) = reader_thread.join().unwrap().unwrap();

        assert!(status.success(), "{shell} exited unsuccessfully");
        assert!(raw.windows(2).any(|window| window == [0x1b, b'[']));
        assert!(
            raw.contains(&0xff),
            "{shell} did not emit the non-UTF-8 byte"
        );
        assert!(raw
            .windows(format!("SHELLSPAN_{label}_RAW_BEGIN:").len())
            .any(|window| window == format!("SHELLSPAN_{label}_RAW_BEGIN:").as_bytes()));
        assert_eq!(
            frames
                .iter()
                .flat_map(|frame| frame.bytes.iter().copied())
                .collect::<Vec<_>>(),
            raw
        );
        let mut next_offset = 0_u64;
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.sequence, index as u64 + 1);
            assert_eq!(frame.byte_offset, next_offset);
            next_offset += frame.bytes.len() as u64;
        }
        let replay = broker
            .replay_output(
                &attachment.terminal_session_id,
                attachment.terminal_generation,
                1,
                512,
                1_048_576,
            )
            .unwrap();
        assert_eq!(
            replay
                .frames
                .iter()
                .flat_map(|frame| frame.bytes.iter().copied())
                .collect::<Vec<_>>(),
            raw
        );
        let snapshot = broker
            .snapshot(Some("shell-transport"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(snapshot.geometry, TerminalGeometry::new(111, 33));
        assert_eq!(snapshot.next_byte_offset, raw.len() as u64);
        assert_eq!(snapshot.next_input_sequence, 2);
        assert_eq!(
            snapshot.subscribers.display.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(
            snapshot.subscribers.capture.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(
            snapshot.subscribers.integration.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(snapshot.subscribers.screen.observed_bytes, raw.len() as u64);
    }

    #[cfg(target_os = "windows")]
    fn run_windows_powershell_broker_acceptance(shell: &str, label: &str) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{ErrorKind, Read, Write};
        use std::thread;
        use std::time::{Duration, Instant};

        let broker = TerminalSessionBroker::enabled_for_test(512, 1_048_576, 1_048_576);
        let attachment = broker
            .attach_transport(
                "windows-shell-transport",
                None,
                TerminalTransportKind::WindowsConPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        pair.master
            .resize(PtySize {
                rows: 33,
                cols: 111,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        broker
            .resize("windows-shell-transport", TerminalGeometry::new(111, 33))
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new(shell);
        command.args(["-NoLogo", "-NoProfile"]);
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let reader_broker = broker.clone();
        let reader_shell = shell.to_string();
        let reader_thread = thread::spawn(move || -> Result<_, String> {
            let mut raw = Vec::new();
            let mut frames = Vec::new();
            let mut buffer = [0_u8; 31];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let bytes = &buffer[..count];
                        let frame = reader_broker
                            .observe_raw_output("windows-shell-transport", bytes)?
                            .ok_or_else(|| "enabled broker omitted a ConPTY frame".to_string())?;
                        if frame.bytes != bytes {
                            return Err("broker display frame changed ConPTY bytes".into());
                        }
                        raw.extend_from_slice(bytes);
                        frames.push(frame);
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            ErrorKind::BrokenPipe | ErrorKind::UnexpectedEof
                        ) && !raw.is_empty() =>
                    {
                        break;
                    }
                    Err(error) => return Err(format!("read {reader_shell} ConPTY: {error}")),
                }
            }
            Ok((raw, frames))
        });

        // Keep the actual output marker, ESC byte, Unicode scalar, geometry,
        // and long payload out of the echoed input. The second admission also
        // depends on variables created by the first, so reversing or dropping
        // either independently admitted write cannot satisfy the assertion.
        let output_marker = format!("SHELLSPAN_{label}_OUTPUT_BEGIN:");
        let first_input = format!("$m=('SHELL'+'SPAN_{label}_OUTPUT_BEGIN:'); $e=[char]27\r");
        assert!(!first_input
            .as_bytes()
            .windows(output_marker.len())
            .any(|window| window == output_marker.as_bytes()));
        let first_receipt = broker
            .admit_terminal_input(
                "windows-shell-transport",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                first_input.as_bytes(),
                || {
                    writer
                        .write_all(first_input.as_bytes())
                        .map_err(|error| format!("write {shell} ConPTY: {error}"))?;
                    writer
                        .flush()
                        .map_err(|error| format!("flush {shell} ConPTY: {error}"))
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(first_receipt.input_sequence, 1);
        assert_eq!(first_receipt.accepted_bytes, first_input.len());
        assert_eq!(first_receipt.source_owner_id, USER_OWNER_ID);

        let second_input = "if (($Host.UI.RawUI.WindowSize.Width -ne 111) -or ($Host.UI.RawUI.WindowSize.Height -ne 33)) { exit 91 }; [Console]::Write(($m+$e+'[31mred'+$e+'[0m:'+([char]0x6c49)+':111x33:'+('Q'*8)+':OUTPUT_END')); exit 0\r";
        assert!(!second_input
            .as_bytes()
            .windows(output_marker.len())
            .any(|window| window == output_marker.as_bytes()));
        assert!(!second_input.as_bytes().contains(&0x1b));
        assert!(!second_input
            .as_bytes()
            .windows("汉".len())
            .any(|window| window == "汉".as_bytes()));
        let second_receipt = broker
            .admit_terminal_input(
                "windows-shell-transport",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                second_input.as_bytes(),
                || {
                    writer
                        .write_all(second_input.as_bytes())
                        .map_err(|error| format!("write {shell} ConPTY: {error}"))?;
                    writer
                        .flush()
                        .map_err(|error| format!("flush {shell} ConPTY: {error}"))
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(second_receipt.input_sequence, 2);
        assert_eq!(second_receipt.accepted_bytes, second_input.len());
        assert_eq!(second_receipt.source_owner_id, USER_OWNER_ID);

        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            match child.try_wait().unwrap() {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    child.kill().unwrap();
                    panic!("{shell} ConPTY did not exit before acceptance deadline");
                }
            }
        };
        drop(writer);
        drop(pair.master);
        let (raw, frames) = reader_thread.join().unwrap().unwrap();

        assert!(status.success(), "{shell} exited unsuccessfully");
        let expected_shell_output = |reset: &[u8]| {
            let mut expected = output_marker.as_bytes().to_vec();
            expected.extend_from_slice(b"\x1b[31mred\x1b[");
            expected.extend_from_slice(reset);
            expected.extend_from_slice(b"m:");
            expected.extend_from_slice("汉".as_bytes());
            expected.extend_from_slice(b":111x33:");
            expected.extend(std::iter::repeat_n(b'Q', 8));
            expected.extend_from_slice(b":OUTPUT_END");
            expected
        };
        // ConPTY may canonicalize SGR reset `0m` to its equivalent `m`.
        // Either spelling is transport output; the Broker must preserve the
        // exact spelling it actually received, which the frame assertion below proves.
        let expected_variants = [expected_shell_output(b"0"), expected_shell_output(b"")];
        assert!(
            expected_variants.iter().any(|expected| raw
                .windows(expected.len())
                .any(|window| window == expected.as_slice())),
            "{shell} output did not contain the echo-independent payload; raw={:?}",
            String::from_utf8_lossy(&raw)
        );
        assert!(
            frames.len() > 1,
            "ConPTY output must span multiple raw frames"
        );
        assert_eq!(
            frames
                .iter()
                .flat_map(|frame| frame.bytes.iter().copied())
                .collect::<Vec<_>>(),
            raw
        );
        let mut next_offset = 0_u64;
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.sequence, index as u64 + 1);
            assert_eq!(frame.byte_offset, next_offset);
            next_offset += frame.bytes.len() as u64;
        }
        let bounded_replay = broker
            .replay_output(
                &attachment.terminal_session_id,
                attachment.terminal_generation,
                1,
                1,
                1_048_576,
            )
            .unwrap();
        assert_eq!(bounded_replay.frames, vec![frames[0].clone()]);
        assert_eq!(bounded_replay.through_sequence, 1);
        assert!(bounded_replay.has_more);
        let replay = broker
            .replay_output(
                &attachment.terminal_session_id,
                attachment.terminal_generation,
                1,
                512,
                1_048_576,
            )
            .unwrap();
        assert_eq!(
            replay
                .frames
                .iter()
                .flat_map(|frame| frame.bytes.iter().copied())
                .collect::<Vec<_>>(),
            raw
        );
        let snapshot = broker
            .snapshot(Some("windows-shell-transport"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(snapshot.geometry, TerminalGeometry::new(111, 33));
        assert_eq!(snapshot.next_byte_offset, raw.len() as u64);
        assert_eq!(snapshot.next_input_sequence, 3);
        assert_eq!(
            snapshot.subscribers.display.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(
            snapshot.subscribers.capture.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(
            snapshot.subscribers.integration.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(snapshot.subscribers.screen.observed_bytes, raw.len() as u64);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bash_pty_broker_preserves_raw_bytes_input_order_and_resize() {
        run_native_shell_broker_acceptance("/bin/bash", &["--noprofile", "--norc"], "MACOS_BASH");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_zsh_pty_broker_preserves_raw_bytes_input_order_and_resize() {
        run_native_shell_broker_acceptance("/bin/zsh", &["-f"], "MACOS_ZSH");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_bash_pty_broker_preserves_raw_bytes_input_order_and_resize() {
        run_native_shell_broker_acceptance("/bin/bash", &["--noprofile", "--norc"], "LINUX_BASH");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_zsh_pty_broker_preserves_raw_bytes_input_order_and_resize() {
        run_native_shell_broker_acceptance("/bin/zsh", &["-f"], "LINUX_ZSH");
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "run explicitly in the native Windows PowerShell 5.1 acceptance lane"]
    fn windows_powershell_5_1_conpty_broker_preserves_raw_bytes_order_and_resize() {
        run_windows_powershell_broker_acceptance("powershell.exe", "WINDOWS_POWERSHELL_5_1");
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "run explicitly in the native PowerShell 7 acceptance lane"]
    fn windows_powershell_7_conpty_broker_preserves_raw_bytes_order_and_resize() {
        run_windows_powershell_broker_acceptance("pwsh.exe", "POWERSHELL_7");
    }

    fn attached(broker: &TerminalSessionBroker, transport: &str) -> TerminalBrokerAttachment {
        broker
            .attach_transport(
                transport,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap()
    }

    fn frame(
        attachment: &TerminalBrokerAttachment,
        sequence: u64,
        byte_offset: u64,
        bytes: &[u8],
    ) -> TerminalRawOutputFrame {
        TerminalRawOutputFrame {
            protocol_version: 1,
            terminal_session_id: attachment.terminal_session_id.clone(),
            terminal_generation: attachment.terminal_generation,
            frame_type: "rawOutput",
            sequence,
            byte_offset,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn rollout_defaults_are_native_desktop_scoped_non_persisted_and_rollback_closes_generations() {
        let broker = TerminalSessionBroker::default();
        let snapshot = broker.snapshot(None).unwrap();
        assert_eq!(snapshot.rollout.name, TERMINAL_BROKER_FLAG_NAME);
        assert_eq!(
            snapshot.rollout.enabled,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        assert_eq!(
            snapshot.rollout.default_enabled,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        assert!(!snapshot.rollout.persisted);
        assert_eq!(snapshot.rollout.mode, "cooperative");
        assert_eq!(
            snapshot.shell_integration_rollout.enabled,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        assert_eq!(
            snapshot.terminal_execute_rollout.enabled,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        assert_eq!(
            snapshot.remote_bound_terminal_rollout.name,
            TERMINAL_REMOTE_BOUND_TERMINAL_FLAG_NAME
        );
        assert_eq!(
            snapshot.remote_bound_terminal_rollout.enabled,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        assert_eq!(
            snapshot.remote_bound_terminal_rollout.default_enabled,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        assert_eq!(
            snapshot.interactive_tools_rollout.name,
            TERMINAL_INTERACTIVE_TOOLS_FLAG_NAME
        );
        assert_eq!(
            snapshot.interactive_tools_rollout.enabled,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        assert_eq!(
            snapshot.interactive_tools_rollout.default_enabled,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        assert_eq!(
            snapshot.remote_interactive_tools_rollout.name,
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_FLAG_NAME
        );
        assert!(!snapshot.remote_interactive_tools_rollout.enabled);
        assert!(!snapshot.remote_interactive_tools_rollout.default_enabled);
        assert!(!snapshot.shell_integration_rollout.persisted);
        assert!(!snapshot.terminal_execute_rollout.persisted);
        assert!(!snapshot.remote_bound_terminal_rollout.persisted);
        assert!(!snapshot.interactive_tools_rollout.persisted);
        assert!(!snapshot.remote_interactive_tools_rollout.persisted);
        assert_eq!(
            broker
                .attach_transport(
                    "transport-1",
                    None,
                    if cfg!(target_os = "windows") {
                        TerminalTransportKind::WindowsConPty
                    } else {
                        TerminalTransportKind::LocalPty
                    },
                    TerminalGeometry::new(80, 24),
                )
                .unwrap()
                .is_some(),
            cfg!(any(target_os = "macos", target_os = "windows"))
        );

        let rollback = TerminalSessionBroker::enabled_for_test(8, 1_024, 32);
        attached(&rollback, "rollback-transport");
        rollback
            .apply_trusted_rollout(
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        let snapshot = rollback.snapshot(Some("rollback-transport")).unwrap();
        assert!(!snapshot.rollout.enabled);
        assert_eq!(
            snapshot.session.unwrap().close_reason,
            Some(TerminalGenerationCloseReason::BrokerShutdown)
        );
        assert!(rollback
            .observe_raw_output("rollback-transport", b"display remains available")
            .unwrap()
            .is_none());
    }

    #[test]
    fn remote_bound_terminal_environment_prefers_authoritative_name_and_reads_legacy_only_when_absent(
    ) {
        let mut authoritative_reads = Vec::new();
        let authoritative = trusted_rollout_value_with_legacy_alias_reader(
            TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE,
            TERMINAL_REMOTE_BOUND_TERMINAL_LEGACY_ENVIRONMENT_VARIABLE,
            false,
            |name| {
                authoritative_reads.push(name.to_string());
                if name == TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE {
                    Ok("off".into())
                } else {
                    panic!("the legacy alias must not be read when the authoritative value exists")
                }
            },
        )
        .unwrap();
        assert_eq!(
            authoritative,
            (false, TerminalBrokerRolloutSource::Environment)
        );
        assert_eq!(
            authoritative_reads,
            vec![TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE]
        );

        let mut fallback_reads = Vec::new();
        let fallback = trusted_rollout_value_with_legacy_alias_reader(
            TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE,
            TERMINAL_REMOTE_BOUND_TERMINAL_LEGACY_ENVIRONMENT_VARIABLE,
            false,
            |name| {
                fallback_reads.push(name.to_string());
                if name == TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE {
                    Err(std::env::VarError::NotPresent)
                } else {
                    Ok("on".into())
                }
            },
        )
        .unwrap();
        assert_eq!(fallback, (true, TerminalBrokerRolloutSource::Environment));
        assert_eq!(
            fallback_reads,
            vec![
                TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE,
                TERMINAL_REMOTE_BOUND_TERMINAL_LEGACY_ENVIRONMENT_VARIABLE,
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn phase6_windows_rollbacks_make_visible_commands_unavailable() {
        let broker = TerminalSessionBroker::default();
        broker
            .attach_transport(
                "windows-local",
                None,
                TerminalTransportKind::WindowsConPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap()
            .unwrap();
        broker
            .register_integration_channel(
                "windows-local",
                "windows-integration",
                TerminalShellKind::PowerShell7,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::PowerShell7,
            },
            TerminalIntegrationControlEvent::PromptStart {
                cwd: "C:\\workspace".into(),
            },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("windows-local", "windows-integration", event)
                .unwrap();
        }
        assert_eq!(
            broker.visible_command_route("windows-local").unwrap(),
            TerminalVisibleCommandRoute::TerminalExecute
        );

        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        assert_eq!(
            broker.visible_command_route("windows-local").unwrap(),
            TerminalVisibleCommandRoute::Unavailable,
            "Windows local rollback must make visible commands unavailable"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn phase6_macos_rollbacks_make_visible_commands_unavailable() {
        let broker = TerminalSessionBroker::default();
        broker
            .attach_transport(
                "macos-local",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap()
            .unwrap();
        broker
            .register_integration_channel(
                "macos-local",
                "macos-integration",
                TerminalShellKind::Zsh,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Zsh,
            },
            TerminalIntegrationControlEvent::PromptStart {
                cwd: "/tmp/workspace".into(),
            },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("macos-local", "macos-integration", event)
                .unwrap();
        }
        assert_eq!(
            broker.visible_command_route("macos-local").unwrap(),
            TerminalVisibleCommandRoute::TerminalExecute
        );

        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        assert_eq!(
            broker.visible_command_route("macos-local").unwrap(),
            TerminalVisibleCommandRoute::Unavailable,
            "macOS local rollback must make visible commands unavailable"
        );
    }

    #[test]
    fn rollout_counters_are_bounded_privacy_safe_and_cover_phase6_signals() {
        let broker = TerminalSessionBroker::phase5_enabled_for_test(4);
        let attachment = broker
            .attach_transport(
                "counter-transport",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(20, 4),
            )
            .unwrap()
            .unwrap();
        broker
            .register_integration_channel(
                "counter-transport",
                "counter-integration",
                TerminalShellKind::Zsh,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Zsh,
            },
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("counter-transport", "counter-integration", event)
                .unwrap();
        }

        let secret = "phase6-secret-must-not-be-counted";
        broker
            .observe_raw_output("counter-transport", secret.as_bytes())
            .unwrap();
        for _ in 0..TRANSPORT_LATENCY_SAMPLE_INTERVAL_FRAMES {
            broker
                .observe_raw_output("counter-transport", b"x")
                .unwrap();
        }
        broker.set_output_paused("counter-transport", true).unwrap();
        broker.set_output_paused("counter-transport", true).unwrap();
        assert_eq!(
            broker
                .wait_terminal(
                    "counter-transport",
                    TerminalWaitRequest {
                        after_screen_version: None,
                        after_output_sequence: None,
                        after_lifecycle_sequence: None,
                        text: None,
                        case_sensitive: false,
                        idle: None,
                        timeout: Duration::ZERO,
                    },
                )
                .unwrap()
                .reason,
            TerminalWaitReason::TimedOut
        );

        let timed_out = TerminalCommandOperation::new(
            attachment.terminal_session_id.clone(),
            attachment.terminal_generation,
            "counter-timeout".into(),
            "safe".into(),
            1,
            4,
            Arc::clone(&broker.counters),
        );
        assert!(timed_out
            .request_settlement(TerminalCommandRequestedSettlement::TimedOut)
            .unwrap());
        let taken_over = TerminalCommandOperation::new(
            attachment.terminal_session_id.clone(),
            attachment.terminal_generation,
            "counter-takeover".into(),
            "safe".into(),
            1,
            4,
            Arc::clone(&broker.counters),
        );
        assert!(taken_over
            .request_settlement(TerminalCommandRequestedSettlement::TakenOver)
            .unwrap());
        let uncertain = TerminalCommandOperation::new(
            attachment.terminal_session_id,
            attachment.terminal_generation,
            "counter-uncertain".into(),
            "safe".into(),
            1,
            4,
            Arc::clone(&broker.counters),
        );
        assert!(uncertain.mark_uncertain().unwrap());

        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        assert!(
            !broker
                .snapshot(None)
                .unwrap()
                .remote_bound_terminal_rollout
                .enabled
        );

        let snapshot = broker.snapshot(Some("counter-transport")).unwrap();
        assert_eq!(snapshot.counters.integration_ready, 1);
        assert_eq!(snapshot.counters.lifecycle_matched, 3);
        assert_eq!(snapshot.counters.uncertainty, 1);
        assert_eq!(snapshot.counters.timeout, 2);
        assert_eq!(snapshot.counters.takeover, 1);
        assert_eq!(snapshot.counters.truncation, 1);
        assert_eq!(snapshot.counters.backpressure, 1);
        assert_eq!(snapshot.counters.transport_latency_samples, 2);
        assert!(
            snapshot.counters.transport_latency_total_micros
                >= snapshot.counters.transport_latency_max_micros
        );
        let serialized = serde_json::to_string(&snapshot.counters).unwrap();
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("commandLine"));
        assert!(!serialized.contains("integrationId\":\"counter-integration"));
        let values = serde_json::from_str::<serde_json::Value>(&serialized).unwrap();
        assert!(values
            .as_object()
            .unwrap()
            .values()
            .all(serde_json::Value::is_u64));
    }

    #[test]
    fn failed_attachment_is_atomic_and_leaves_the_existing_generation_usable() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        let original = attached(&broker, "transport-1");
        let before = broker.snapshot(Some("transport-1")).unwrap().session;

        assert_eq!(
            broker
                .attach_transport(
                    "transport-candidate",
                    Some("unknown-predecessor"),
                    TerminalTransportKind::LocalPty,
                    TerminalGeometry::new(100, 30),
                )
                .unwrap_err(),
            "TERMINAL_BROKER_PREDECESSOR_NOT_FOUND"
        );

        assert_eq!(
            broker.snapshot(Some("transport-1")).unwrap().session,
            before
        );
        assert!(broker
            .snapshot(Some("transport-candidate"))
            .unwrap()
            .session
            .is_none());
        let output = broker
            .observe_raw_output("transport-1", b"still-usable")
            .unwrap()
            .unwrap();
        assert_eq!(output.terminal_session_id, original.terminal_session_id);
        assert_eq!(output.terminal_generation, 1);
    }

    #[test]
    fn closed_metadata_and_reconnect_transport_history_are_bounded() {
        let broker = TerminalSessionBroker::enabled_with_closed_capacity_for_test(2);
        for index in 1..=3 {
            let transport = format!("transport-{index}");
            attached(&broker, &transport);
            broker
                .close_transport(&transport, TerminalGenerationCloseReason::UserClosed)
                .unwrap();
        }

        assert_eq!(broker.metadata_counts(), (2, 2, 2));
        assert!(broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .is_none());
        let predecessor = broker
            .snapshot(Some("transport-2"))
            .unwrap()
            .session
            .unwrap();
        let replacement = broker
            .attach_transport(
                "transport-4",
                Some("transport-2"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            replacement.terminal_session_id,
            predecessor.terminal_session_id
        );
        assert_eq!(replacement.terminal_generation, 2);
        assert!(broker
            .snapshot(Some("transport-2"))
            .unwrap()
            .session
            .is_none());
        assert_eq!(broker.metadata_counts(), (2, 2, 1));

        // Repeated rollover for one logical session keeps only its current
        // transport mapping rather than one tombstone per generation.
        broker
            .attach_transport(
                "transport-5",
                Some("transport-4"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        assert_eq!(broker.metadata_counts(), (2, 2, 1));
    }

    #[test]
    fn raw_bytes_have_exact_sequence_offsets_and_independent_subscribers() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 3);
        let attachment = attached(&broker, "transport-1");
        let first = broker
            .observe_raw_output("transport-1", &[0xff, 0x00])
            .unwrap()
            .unwrap();
        let second = broker
            .observe_raw_output("transport-1", &[b'a', b'\r', b'\n'])
            .unwrap()
            .unwrap();
        assert_eq!((first.sequence, first.byte_offset), (1, 0));
        assert_eq!((second.sequence, second.byte_offset), (2, 2));
        assert_eq!(
            [first.bytes, second.bytes].concat(),
            [0xff, 0x00, b'a', b'\r', b'\n']
        );
        assert_eq!(
            broker.captured_bytes(&attachment.terminal_session_id),
            [0xff, 0x00, b'a']
        );

        let snapshot = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap();
        assert!(snapshot.capture_truncated);
        assert_eq!(
            snapshot.subscribers.capture.status,
            TerminalSubscriberStatus::Truncated
        );
        assert_eq!(snapshot.subscribers.display.through_output_sequence, 2);
        assert_eq!(snapshot.subscribers.integration.through_output_sequence, 2);
        assert_eq!(snapshot.subscribers.screen.through_output_sequence, 2);
        assert_eq!(snapshot.subscribers.display.observed_bytes, 5);
        assert_eq!(snapshot.next_byte_offset, 5);
    }

    #[test]
    fn replay_is_bounded_and_duplicate_and_gap_rules_are_exact() {
        let broker = TerminalSessionBroker::enabled_for_test(2, 4, 32);
        let attachment = attached(&broker, "transport-1");
        broker.observe_raw_output("transport-1", b"aa").unwrap();
        broker.observe_raw_output("transport-1", b"bb").unwrap();
        broker.observe_raw_output("transport-1", b"cc").unwrap();

        assert!(broker
            .replay_output(&attachment.terminal_session_id, 1, 1, 8, 64)
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_REPLAY_UNAVAILABLE:"));
        let replay = broker
            .replay_output(&attachment.terminal_session_id, 1, 2, 8, 64)
            .unwrap();
        assert_eq!(
            replay
                .frames
                .iter()
                .map(|frame| frame.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(!replay.has_more);

        assert_eq!(
            broker
                .ingest_test_frame(frame(&attachment, 3, 4, b"cc"))
                .unwrap(),
            RawFrameAcceptance::Duplicate
        );
        assert!(broker
            .ingest_test_frame(frame(&attachment, 3, 4, b"XX"))
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_CONFLICTING_DUPLICATE"));
        assert!(broker
            .ingest_test_frame(frame(&attachment, 5, 6, b"gap"))
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_OUTPUT_GAP:"));
        let gap_snapshot = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            gap_snapshot.subscribers.display.status,
            TerminalSubscriberStatus::Gap
        );
        assert_eq!(gap_snapshot.subscribers.display.through_output_sequence, 3);
        assert_eq!(
            broker
                .ingest_test_frame(frame(&attachment, 4, 6, b"ok"))
                .unwrap(),
            RawFrameAcceptance::Accepted
        );
        let repaired = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            repaired.subscribers.display.status,
            TerminalSubscriberStatus::Active
        );
    }

    #[test]
    fn reconnect_preserves_session_identity_resets_counters_and_rejects_stale_data() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        let first = attached(&broker, "transport-1");
        broker.observe_raw_output("transport-1", b"old").unwrap();
        let old_lease = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .lease
            .unwrap();

        let second = broker
            .attach_transport(
                "transport-2",
                Some("transport-1"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap()
            .unwrap();
        assert_eq!(second.terminal_session_id, first.terminal_session_id);
        assert_eq!(second.terminal_generation, first.terminal_generation + 1);
        assert!(broker.observe_raw_output("transport-1", b"stale").is_err());
        let new_frame = broker
            .observe_raw_output("transport-2", b"new")
            .unwrap()
            .unwrap();
        assert_eq!((new_frame.sequence, new_frame.byte_offset), (1, 0));
        broker.mark_output_ready("transport-2").unwrap();
        broker.set_output_paused("transport-2", true).unwrap();
        broker
            .resize("transport-2", TerminalGeometry::new(132, 43))
            .unwrap();
        let current = broker
            .snapshot(Some("transport-2"))
            .unwrap()
            .session
            .unwrap();
        assert!(current.output_listener_ready);
        assert!(current.output_paused);
        assert_eq!(current.geometry, TerminalGeometry::new(132, 43));

        let stale_input = TerminalInputRequest {
            terminal_session_id: first.terminal_session_id,
            terminal_generation: first.terminal_generation,
            lease_id: old_lease.lease_id,
            input_sequence: 1,
            source: TerminalBrokerInputSource::User,
            input_kind: TerminalInputKind::Text,
            bytes: b"stale".to_vec(),
        };
        assert!(broker
            .validate_test_input(&stale_input)
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_STALE_GENERATION"));
    }

    #[test]
    fn lease_identity_and_one_input_path_cover_user_agent_and_scoped_system_control() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        let attachment = attached(&broker, "transport-1");
        let written = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink = Arc::clone(&written);
        broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                b"user",
                move || {
                    sink.lock().unwrap().push(b"user".to_vec());
                    Ok(())
                },
            )
            .unwrap();
        let user_lease = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .lease
            .unwrap();
        let stale_sequence = TerminalInputRequest {
            terminal_session_id: attachment.terminal_session_id.clone(),
            terminal_generation: attachment.terminal_generation,
            lease_id: user_lease.lease_id.clone(),
            input_sequence: 1,
            source: TerminalBrokerInputSource::User,
            input_kind: TerminalInputKind::Text,
            bytes: b"duplicate".to_vec(),
        };
        assert!(broker
            .validate_test_input(&stale_sequence)
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_STALE_INPUT:"));
        let agent_lease = broker
            .acquire_agent_lease("transport-1", "agent-1", "task-1", "operation-1")
            .unwrap()
            .unwrap();
        assert!(broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                b"blocked",
                || panic!("rejected input must not reach the transport"),
            )
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH"));
        broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-1".into(),
                    task_id: "task-1".into(),
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Text,
                b"agent",
                || Ok(()),
            )
            .unwrap();
        broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::System {
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Interrupt,
                &[3],
                || Ok(()),
            )
            .unwrap();
        assert!(broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::System {
                    operation_id: "operation-wrong".into(),
                },
                TerminalInputKind::Interrupt,
                &[3],
                || panic!("unscoped control must not reach the transport"),
            )
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_SYSTEM_CONTROL_NOT_SCOPED"));
        assert_eq!(written.lock().unwrap().as_slice(), [b"user"]);
        assert_eq!(
            broker
                .snapshot(Some("transport-1"))
                .unwrap()
                .session
                .unwrap()
                .lease
                .unwrap()
                .lease_id,
            agent_lease.lease_id
        );
        assert!(broker
            .release_agent_lease("transport-1", "agent-1", "task-1", "operation-1")
            .unwrap());
        let user_lease = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .lease
            .unwrap();
        assert_ne!(user_lease.lease_id, agent_lease.lease_id);
        assert!(matches!(user_lease.owner, TerminalLeaseOwner::User { .. }));
        assert_eq!(attachment.terminal_generation, 1);
    }

    #[test]
    fn diagnostic_snapshot_contains_counts_but_not_raw_or_captured_content() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        attached(&broker, "transport-1");
        broker
            .observe_raw_output("transport-1", b"credential-like-secret")
            .unwrap();

        let json = serde_json::to_string(&broker.snapshot(Some("transport-1")).unwrap()).unwrap();
        assert!(!json.contains("credential-like-secret"));
        assert!(!json.contains("bytes"));
        assert!(json.contains("ownerId"));
        assert!(!json.contains("owner_id"));
        assert!(json.contains("captureByteCount"));
        assert!(json.contains("terminal_broker_v1"));
        assert!(json.contains("remoteBoundTerminalRollout"));
        assert!(json.contains("terminal_remote_bound_terminal_v1"));
    }

    #[test]
    fn failed_transport_admission_consumes_no_input_sequence() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        attached(&broker, "transport-1");
        assert_eq!(
            broker
                .admit_terminal_input(
                    "transport-1",
                    TerminalBrokerInputSource::User,
                    TerminalInputKind::Text,
                    b"not-written",
                    || Err("transport unavailable".into()),
                )
                .unwrap_err(),
            "transport unavailable"
        );
        assert_eq!(
            broker
                .snapshot(Some("transport-1"))
                .unwrap()
                .session
                .unwrap()
                .next_input_sequence,
            1
        );
    }

    fn ready_phase3_broker() -> TerminalSessionBroker {
        let broker = TerminalSessionBroker::phase3_enabled_for_test(32);
        attached(&broker, "transport-1");
        broker
            .register_integration_channel("transport-1", "integration-1", TerminalShellKind::Zsh)
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::Ready {
                    shell: TerminalShellKind::Zsh,
                },
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::PromptEnd,
            )
            .unwrap();
        broker
    }

    #[test]
    fn integration_state_revision_orders_lifecycle_failure_and_re_registration() {
        let broker = TerminalSessionBroker::phase3_enabled_for_test(32);
        attached(&broker, "transport-revision");
        let initial = broker
            .snapshot(Some("transport-revision"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(initial.integration_state_revision, 0);

        broker
            .register_integration_channel(
                "transport-revision",
                "integration-1",
                TerminalShellKind::Zsh,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Zsh,
            },
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("transport-revision", "integration-1", event)
                .unwrap();
        }
        let first_ready = broker
            .snapshot(Some("transport-revision"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(first_ready.integration_event_sequence, 3);
        assert_eq!(first_ready.integration_state_revision, 4);
        assert!(first_ready.prompt_ready);

        broker
            .integration_channel_closed(
                "transport-revision",
                "integration-1",
                "controlChannelClosed",
            )
            .unwrap();
        let degraded = broker
            .snapshot(Some("transport-revision"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(degraded.integration_event_sequence, 3);
        assert_eq!(degraded.integration_state_revision, 5);
        assert_eq!(
            degraded.integration_state,
            TerminalIntegrationState::Degraded
        );
        assert!(!degraded.prompt_ready);

        broker
            .register_integration_channel(
                "transport-revision",
                "integration-2",
                TerminalShellKind::Zsh,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Zsh,
            },
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("transport-revision", "integration-2", event)
                .unwrap();
        }
        let second_ready = broker
            .snapshot(Some("transport-revision"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(second_ready.integration_event_sequence, 3);
        assert_eq!(second_ready.integration_state_revision, 9);
        assert!(second_ready.prompt_ready);

        broker
            .acquire_agent_lease(
                "transport-revision",
                "agent-revision",
                "task-revision",
                "operation-revision",
            )
            .unwrap();
        let _operation = broker
            .begin_command(
                "transport-revision",
                "operation-revision",
                "printf revision",
            )
            .unwrap();
        let command_submitted = broker
            .snapshot(Some("transport-revision"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(command_submitted.integration_state_revision, 10);
        assert!(!command_submitted.prompt_ready);
    }

    #[test]
    fn production_config_accepts_cooperative_integration_only_after_all_flags_enable() {
        let broker = TerminalSessionBroker::default();
        assert_eq!(
            broker.visible_command_route("transport-posix").unwrap(),
            TerminalVisibleCommandRoute::Unavailable
        );
        broker
            .apply_trusted_phase3_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        for (transport, integration, kind, shell) in [
            (
                "transport-posix",
                "integration-posix",
                TerminalTransportKind::LocalPty,
                TerminalShellKind::Zsh,
            ),
            (
                "transport-powershell",
                "integration-powershell",
                TerminalTransportKind::WindowsConPty,
                TerminalShellKind::PowerShell7,
            ),
        ] {
            broker
                .attach_transport(transport, None, kind, TerminalGeometry::new(80, 24))
                .unwrap();
            broker
                .register_integration_channel(transport, integration, shell)
                .unwrap();

            broker
                .accept_integration_event(
                    transport,
                    integration,
                    TerminalIntegrationControlEvent::Ready { shell },
                )
                .unwrap();
            broker
                .accept_integration_event(
                    transport,
                    integration,
                    TerminalIntegrationControlEvent::PromptStart {
                        cwd: "/workspace".into(),
                    },
                )
                .unwrap();
            broker
                .accept_integration_event(
                    transport,
                    integration,
                    TerminalIntegrationControlEvent::PromptEnd,
                )
                .unwrap();
            let snapshot = broker.snapshot(Some(transport)).unwrap().session.unwrap();
            assert_eq!(snapshot.integration_state, TerminalIntegrationState::Ready);
            assert_eq!(snapshot.integration_reason, None);
            assert_eq!(
                broker.visible_command_route(transport).unwrap(),
                TerminalVisibleCommandRoute::TerminalExecute
            );
        }
    }

    fn begin_phase3_command(
        broker: &TerminalSessionBroker,
        operation_id: &str,
        command: &str,
    ) -> Arc<TerminalCommandOperation> {
        broker
            .acquire_agent_lease("transport-1", "agent-1", "task-1", operation_id)
            .unwrap();
        broker
            .begin_command("transport-1", operation_id, command)
            .unwrap()
    }

    #[test]
    fn raw_output_cannot_forge_command_lifecycle_or_exit_status() {
        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-1", "printf cooperative");
        broker
            .observe_raw_output("transport-1", b"commandEnd\0exitCode\00\0prompt-looking $ ")
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Submitted
        );

        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: "printf cooperative".into(),
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
        broker
            .observe_raw_output("transport-1", b"\x1b]133;D;0\x07\x1ecommand-end:forged\x1f")
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Running
        );

        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code: 7,
                    cwd: "/tmp/after".into(),
                },
            )
            .unwrap();
        let snapshot = operation.snapshot().unwrap();
        assert_eq!(snapshot.state, TerminalCommandState::Completed);
        assert_eq!(snapshot.exit_code, Some(7));
        assert_eq!(snapshot.cwd.as_deref(), Some("/tmp/after"));
        assert!(snapshot.combined_output.contains("commandEnd"));
    }

    #[test]
    fn exact_command_mismatch_fails_closed_and_degrades_integration() {
        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-1", "printf expected");
        assert_eq!(
            broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::CommandStart {
                        command_line: "printf different".into(),
                        cwd: "/tmp".into(),
                    },
                )
                .unwrap_err(),
            "TERMINAL_COMMAND_LINE_MISMATCH"
        );
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        let session = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            session.integration_state,
            TerminalIntegrationState::Degraded
        );
        assert_eq!(
            broker.visible_command_route("transport-1").unwrap(),
            TerminalVisibleCommandRoute::Unavailable
        );
    }

    #[test]
    fn cooperative_completion_classifies_cancel_timeout_and_takeover_races() {
        for (requested, expected) in [
            (
                TerminalCommandRequestedSettlement::Cancelled,
                TerminalCommandState::Cancelled,
            ),
            (
                TerminalCommandRequestedSettlement::TimedOut,
                TerminalCommandState::TimedOut,
            ),
            (
                TerminalCommandRequestedSettlement::TakenOver,
                TerminalCommandState::TakenOver,
            ),
        ] {
            let broker = ready_phase3_broker();
            let operation = begin_phase3_command(&broker, "operation-1", "sleep 60");
            broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::CommandStart {
                        command_line: "sleep 60".into(),
                        cwd: "/tmp".into(),
                    },
                )
                .unwrap();
            assert!(operation.request_settlement(requested).unwrap());
            assert!(!operation.request_settlement(requested).unwrap());
            broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::CommandEnd {
                        exit_code: 130,
                        cwd: "/tmp".into(),
                    },
                )
                .unwrap();
            let snapshot = operation.snapshot().unwrap();
            assert_eq!(snapshot.state, expected);
            assert_eq!(snapshot.exit_code, Some(130));
        }
    }

    #[test]
    fn reconnect_and_control_loss_make_inflight_commands_uncertain_without_replay() {
        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-1", "touch side-effect");
        let writes = Arc::new(Mutex::new(0_u32));
        let written = Arc::clone(&writes);
        broker
            .admit_terminal_input(
                "transport-1",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-1".into(),
                    task_id: "task-1".into(),
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Text,
                b"touch side-effect\n",
                move || {
                    *written.lock().unwrap() += 1;
                    Ok(())
                },
            )
            .unwrap();
        broker
            .attach_transport(
                "transport-2",
                Some("transport-1"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        assert_eq!(
            *writes.lock().unwrap(),
            1,
            "reconnect replayed terminal input"
        );
        assert_eq!(
            broker.visible_command_route("transport-2").unwrap(),
            if cfg!(any(target_os = "macos", target_os = "windows")) {
                TerminalVisibleCommandRoute::Unavailable
            } else {
                TerminalVisibleCommandRoute::Unavailable
            }
        );

        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-2", "external-side-effect");
        broker
            .integration_channel_closed("transport-1", "integration-1", "controlChannelClosed")
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
    }

    #[test]
    fn phase3_rollout_dependencies_and_rollback_are_frozen_and_fail_safe() {
        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-1", "state-changing-command");
        broker
            .apply_trusted_phase3_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        let snapshot = broker.snapshot(Some("transport-1")).unwrap();
        assert!(snapshot.shell_integration_rollout.enabled);
        assert!(!snapshot.terminal_execute_rollout.enabled);
        assert_eq!(
            broker.visible_command_route("transport-1").unwrap(),
            if cfg!(any(target_os = "macos", target_os = "windows")) {
                TerminalVisibleCommandRoute::Unavailable
            } else {
                TerminalVisibleCommandRoute::Unavailable
            }
        );

        broker
            .apply_trusted_phase3_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        let snapshot = broker.snapshot(Some("transport-1")).unwrap();
        assert!(!snapshot.shell_integration_rollout.enabled);
        assert!(!snapshot.terminal_execute_rollout.enabled);
        assert!(snapshot.terminal_execute_rollout.requested);
        assert!(!snapshot.terminal_execute_rollout.prerequisite_satisfied);
        assert_eq!(
            broker.visible_command_route("transport-1").unwrap(),
            TerminalVisibleCommandRoute::Unavailable
        );
    }

    #[test]
    fn command_capture_is_scoped_bounded_and_does_not_truncate_display() {
        let broker = ready_phase3_broker();
        broker.observe_raw_output("transport-1", b"before").unwrap();
        let operation = begin_phase3_command(&broker, "operation-1", "printf payload");
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: "printf payload".into(),
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
        broker
            .observe_raw_output("transport-1", b"0123456789abcdefghijklmnopqrstuvwxyz")
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code: 0,
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
        let snapshot = operation.snapshot().unwrap();
        assert_eq!(snapshot.combined_output.len(), 32);
        assert!(snapshot.capture_truncated);
        assert!(!snapshot.combined_output.contains("before"));
        let display = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .subscribers
            .display;
        assert_eq!(display.observed_bytes, 42);
    }

    #[test]
    fn remote_rollout_rejects_unintegrated_ssh_and_keeps_reconnect_generation_safe() {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        let first = broker
            .attach_transport(
                "user-ssh-1",
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            broker.remote_visible_command_route("user-ssh-1").unwrap(),
            TerminalVisibleCommandRoute::Unavailable,
            "an ordinary SSH terminal is unavailable until its integration reaches a Prompt boundary"
        );

        broker.mark_output_ready("user-ssh-1").unwrap();
        broker
            .close_transport(
                "user-ssh-1",
                TerminalGenerationCloseReason::TransportDisconnected,
            )
            .unwrap();
        let second = broker
            .attach_transport(
                "user-ssh-2",
                Some("user-ssh-1"),
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap()
            .unwrap();

        assert_eq!(second.terminal_session_id, first.terminal_session_id);
        assert_eq!(second.terminal_generation, first.terminal_generation + 1);
        assert_eq!(broker.metadata_counts().2, 0);
        assert!(broker.observe_raw_output("user-ssh-1", b"stale").is_err());
    }

    #[test]
    fn ready_user_ssh_transport_is_the_remote_visible_command_route() {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        attach_ready_user_ssh_transport(&broker, "user-ssh");

        assert_eq!(
            broker.remote_visible_command_route("user-ssh").unwrap(),
            TerminalVisibleCommandRoute::TerminalExecute,
            "a ready ordinary SSH transport must be the boundTerminal execution target"
        );
    }

    #[test]
    fn ready_user_ssh_transport_runs_a_command_under_an_agent_lease() {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        attach_ready_user_ssh_transport(&broker, "user-ssh");
        let lease = broker
            .acquire_agent_lease("user-ssh", "agent-session-1", "task-1", "operation-1")
            .unwrap()
            .unwrap();

        let operation = broker
                .begin_command("user-ssh", "operation-1", "printf source-shell")
                .unwrap_or_else(|error| {
                    panic!(
                        "ordinary SSH transport rejected terminal_execute after acquiring its Agent lease: {error}"
                    )
                });
        assert_eq!(
            broker.remote_visible_command_route("user-ssh").unwrap(),
            TerminalVisibleCommandRoute::Unavailable,
            "an active command must make the shared source terminal busy"
        );
        broker
            .accept_integration_event(
                "user-ssh",
                "integration-user-ssh",
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: "printf source-shell".into(),
                    cwd: "/home/tester".into(),
                },
            )
            .unwrap();
        broker
            .observe_raw_output("user-ssh", b"source-shell")
            .unwrap();
        broker
            .accept_integration_event(
                "user-ssh",
                "integration-user-ssh",
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code: 0,
                    cwd: "/home/tester".into(),
                },
            )
            .unwrap();

        let snapshot = operation.snapshot().unwrap();
        assert_eq!(snapshot.state, TerminalCommandState::Completed);
        assert_eq!(snapshot.exit_code, Some(0));
        assert_eq!(snapshot.combined_output, "source-shell");
        broker
            .retire_command("user-ssh", &snapshot.command_id)
            .unwrap();
        assert!(broker
            .release_agent_lease("user-ssh", "agent-session-1", "task-1", "operation-1",)
            .unwrap());
        assert!(!lease.lease_id.is_empty());
    }

    #[test]
    fn ordinary_ssh_route_rejects_prompt_busy_and_non_user_lease_states() {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        attach_ready_user_ssh_transport(&broker, "user-ssh");
        broker
            .accept_integration_event(
                "user-ssh",
                "integration-user-ssh",
                TerminalIntegrationControlEvent::PromptStart {
                    cwd: "/home/tester".into(),
                },
            )
            .unwrap();
        assert_eq!(
            broker.remote_visible_command_route("user-ssh").unwrap(),
            TerminalVisibleCommandRoute::Unavailable
        );
        assert!(broker
            .acquire_agent_lease("user-ssh", "agent-session-1", "task-1", "operation-busy")
            .unwrap_err()
            .starts_with("TERMINAL_VISIBLE_COMMAND_BUSY"));
        broker
            .accept_integration_event(
                "user-ssh",
                "integration-user-ssh",
                TerminalIntegrationControlEvent::PromptEnd,
            )
            .unwrap();
        broker
            .acquire_agent_lease("user-ssh", "agent-session-1", "task-1", "operation-1")
            .unwrap();
        assert_eq!(
            broker.remote_visible_command_route("user-ssh").unwrap(),
            TerminalVisibleCommandRoute::Unavailable,
            "route admission requires the current Broker lease owner to remain the user"
        );
    }

    #[test]
    fn ordinary_ssh_route_rejects_failed_integration() {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        broker
            .attach_transport(
                "user-ssh",
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap();
        broker
            .mark_integration_unavailable("user-ssh", TerminalShellKind::Bash, "fixtureUnavailable")
            .unwrap();
        assert_eq!(
            broker.remote_visible_command_route("user-ssh").unwrap(),
            TerminalVisibleCommandRoute::Unavailable
        );
    }

    #[test]
    fn remote_rollout_disable_keeps_user_transport_open_and_makes_inflight_uncertain() {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        attach_ready_user_ssh_transport(&broker, "user-ssh");
        broker
            .acquire_agent_lease("user-ssh", "agent-session-1", "task-1", "operation-1")
            .unwrap();
        let operation = broker
            .begin_command("user-ssh", "operation-1", "side-effect")
            .unwrap();

        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();

        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        assert_eq!(
            broker.remote_visible_command_route("user-ssh").unwrap(),
            TerminalVisibleCommandRoute::Unavailable
        );
        let snapshot = broker.snapshot(Some("user-ssh")).unwrap().session.unwrap();
        assert!(
            snapshot.open,
            "rollout disable must not close the user SSH transport"
        );
        assert_eq!(snapshot.close_reason, None);
        assert!(matches!(
            snapshot.lease.unwrap().owner,
            TerminalLeaseOwner::User { .. }
        ));
        assert!(broker
            .admit_terminal_input(
                "user-ssh",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-session-1".into(),
                    task_id: "task-1".into(),
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Text,
                b"must-not-write\n",
                || panic!("rollout-disabled Agent input must not reach the user transport"),
            )
            .unwrap_err()
            .starts_with("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE"));
        broker
            .observe_raw_output("user-ssh", b"user transport remains usable")
            .unwrap();
    }

    #[test]
    fn ordinary_ssh_disconnect_marks_inflight_uncertain_and_rejects_stale_input() {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        attach_ready_user_ssh_transport(&broker, "user-ssh");
        broker
            .acquire_agent_lease("user-ssh", "agent-session-1", "task-1", "operation-1")
            .unwrap();
        let operation = broker
            .begin_command("user-ssh", "operation-1", "side-effect")
            .unwrap();
        broker
            .close_transport(
                "user-ssh",
                TerminalGenerationCloseReason::TransportDisconnected,
            )
            .unwrap();

        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        assert!(broker
            .admit_terminal_input(
                "user-ssh",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-session-1".into(),
                    task_id: "task-1".into(),
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Text,
                b"must-not-replay\n",
                || panic!("stale Agent input must not reach the disconnected transport"),
            )
            .is_err());
    }

    #[test]
    fn remote_visible_commands_do_not_publish_unaccepted_interactive_tools() {
        let broker = TerminalSessionBroker::phase5_enabled_for_test(4_096);
        let rollout = broker.snapshot(None).unwrap();
        assert!(rollout.remote_bound_terminal_rollout.enabled);
        assert!(rollout.interactive_tools_rollout.enabled);
        assert!(!rollout.remote_interactive_tools_rollout.enabled);

        attach_ready_user_ssh_transport(&broker, "user-ssh-visible-only");
        broker.mark_output_ready("user-ssh-visible-only").unwrap();

        assert_eq!(
            broker
                .remote_visible_command_route("user-ssh-visible-only")
                .unwrap(),
            TerminalVisibleCommandRoute::TerminalExecute
        );
        assert_eq!(
            broker.screen_snapshot("user-ssh-visible-only").unwrap_err(),
            "TERMINAL_SCREEN_UNAVAILABLE"
        );
    }

    #[test]
    fn interactive_screen_wait_tracks_output_text_resize_and_alternate_buffer() {
        let broker = TerminalSessionBroker::phase5_enabled_for_test(4_096);
        broker
            .attach_transport(
                "interactive-transport",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(20, 4),
            )
            .unwrap()
            .unwrap();
        let initial = broker.screen_snapshot("interactive-transport").unwrap();
        assert_eq!((initial.columns, initial.rows), (20, 4));

        let waiter = {
            let broker = broker.clone();
            std::thread::spawn(move || {
                broker
                    .wait_terminal(
                        "interactive-transport",
                        TerminalWaitRequest {
                            after_screen_version: Some(initial.screen_version),
                            after_output_sequence: None,
                            after_lifecycle_sequence: None,
                            text: None,
                            case_sensitive: false,
                            idle: None,
                            timeout: Duration::from_secs(2),
                        },
                    )
                    .unwrap()
            })
        };
        broker
            .observe_raw_output(
                "interactive-transport",
                b"Select: [y/N]\x1b[?1049hmenu\x1b[2;4H",
            )
            .unwrap();
        let changed = waiter.join().unwrap();
        assert_eq!(changed.reason, TerminalWaitReason::ScreenChanged);
        let snapshot = changed.snapshot.unwrap();
        assert_eq!(snapshot.active_buffer, TerminalScreenBuffer::Alternate);
        assert_eq!((snapshot.cursor.row, snapshot.cursor.column), (1, 3));

        let found = broker
            .wait_terminal(
                "interactive-transport",
                TerminalWaitRequest {
                    after_screen_version: None,
                    after_output_sequence: None,
                    after_lifecycle_sequence: None,
                    text: Some("MENU".into()),
                    case_sensitive: false,
                    idle: None,
                    timeout: Duration::from_secs(1),
                },
            )
            .unwrap();
        assert_eq!(found.reason, TerminalWaitReason::TextFound);
        broker
            .observe_raw_output("interactive-transport", b"\x1b[?1049lREPL> ready")
            .unwrap();
        assert_eq!(
            broker
                .screen_snapshot("interactive-transport")
                .unwrap()
                .active_buffer,
            TerminalScreenBuffer::Primary
        );

        let before_resize = broker.screen_snapshot("interactive-transport").unwrap();
        broker
            .resize("interactive-transport", TerminalGeometry::new(32, 6))
            .unwrap();
        let after_resize = broker.screen_snapshot("interactive-transport").unwrap();
        assert!(after_resize.screen_version > before_resize.screen_version);
        assert_eq!((after_resize.columns, after_resize.rows), (32, 6));
        assert_eq!(after_resize.content.len(), 6);
    }

    #[test]
    fn interactive_wait_observes_idle_and_terminal_closure_without_replay() {
        let broker = TerminalSessionBroker::phase5_enabled_for_test(4_096);
        broker
            .attach_transport(
                "interactive-close",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(40, 5),
            )
            .unwrap()
            .unwrap();
        broker
            .observe_raw_output("interactive-close", b"working")
            .unwrap();
        let idle = broker
            .wait_terminal(
                "interactive-close",
                TerminalWaitRequest {
                    after_screen_version: None,
                    after_output_sequence: None,
                    after_lifecycle_sequence: None,
                    text: None,
                    case_sensitive: false,
                    idle: Some(Duration::from_millis(5)),
                    timeout: Duration::from_secs(1),
                },
            )
            .unwrap();
        assert_eq!(idle.reason, TerminalWaitReason::Idle);

        let waiter = {
            let broker = broker.clone();
            std::thread::spawn(move || {
                broker
                    .wait_terminal(
                        "interactive-close",
                        TerminalWaitRequest {
                            after_screen_version: Some(u64::MAX - 1),
                            after_output_sequence: None,
                            after_lifecycle_sequence: None,
                            text: None,
                            case_sensitive: false,
                            idle: None,
                            timeout: Duration::from_secs(2),
                        },
                    )
                    .unwrap()
            })
        };
        std::thread::sleep(Duration::from_millis(10));
        broker
            .close_transport(
                "interactive-close",
                TerminalGenerationCloseReason::UserClosed,
            )
            .unwrap();
        let closed = waiter.join().unwrap();
        assert_eq!(closed.reason, TerminalWaitReason::Closed);
        assert!(!closed.open);
        assert!(closed.snapshot.is_none());
    }
