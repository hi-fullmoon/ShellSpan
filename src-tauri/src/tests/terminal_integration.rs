use super::*;

fn prepare_test_integration(shell: TerminalShellKind) -> (TempDir, PreparedLocalShellIntegration) {
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
    assert_eq!(
        prepare_bundled_powershell_module(directory.path()).unwrap_err(),
        "TERMINAL_NATIVE_EDITOR_CACHE_INTEGRITY_MISMATCH_5"
    );
}

#[test]
fn bundled_editor_cache_failure_records_stage_without_private_path() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("editors"), b"occupied cache parent").unwrap();
    let error = prepare_bundled_powershell_module(directory.path()).unwrap_err();
    assert!(
        error.starts_with("TERMINAL_NATIVE_EDITOR_CACHE_CREATE_PARENT_OS_"),
        "{error}"
    );
    assert!(!error.contains(&directory.path().to_string_lossy().to_string()));
}

#[cfg(windows)]
fn locked_cache_fixture() -> (TempDir, PathBuf, PathBuf, File) {
    use std::os::windows::fs::OpenOptionsExt;
    let directory = tempfile::tempdir().unwrap();
    let staging = directory.path().join("staging");
    let target = directory.path().join("installed");
    fs::create_dir(&staging).unwrap();
    fs::write(staging.join("retained.txt"), b"owned cache fixture").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(staging.join("retained.txt"))
        .unwrap();
    assert_eq!(
        fs::rename(&staging, &target).unwrap_err().raw_os_error(),
        Some(5)
    );
    (directory, staging, target, held)
}

#[cfg(windows)]
#[test]
fn cache_install_waits_for_a_transient_file_share_lock() {
    let (_directory, staging, target, held) = locked_cache_fixture();
    let unlock = thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        drop(held);
    });
    let result = install_bundled_powershell_cache(&staging, &target, Duration::from_millis(500));
    unlock.join().unwrap();
    result.unwrap();
    assert!(!staging.exists());
    assert_eq!(
        fs::read(target.join("retained.txt")).unwrap(),
        b"owned cache fixture"
    );
}

#[cfg(windows)]
#[test]
fn cache_install_bounds_a_persistent_file_share_lock() {
    let (_directory, staging, target, held) = locked_cache_fixture();
    let start = Instant::now();
    let error =
        install_bundled_powershell_cache(&staging, &target, Duration::from_millis(40)).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(5));
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(!target.exists());
    assert_eq!(
        fs::read(staging.join("retained.txt")).unwrap(),
        b"owned cache fixture"
    );
    drop(held);
}

#[cfg(windows)]
#[test]
fn cache_install_preserves_a_competing_destination_and_missing_source() {
    let directory = tempfile::tempdir().unwrap();
    let staging = directory.path().join("staging");
    let target = directory.path().join("installed");
    fs::create_dir(&staging).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(staging.join("candidate.txt"), b"candidate").unwrap();
    fs::write(target.join("retained.txt"), b"retained").unwrap();
    assert!(
        install_bundled_powershell_cache(&staging, &target, Duration::from_millis(500)).is_err()
    );
    assert_eq!(fs::read(target.join("retained.txt")).unwrap(), b"retained");
    assert_eq!(
        fs::read(staging.join("candidate.txt")).unwrap(),
        b"candidate"
    );
    assert_eq!(
        install_bundled_powershell_cache(
            &directory.path().join("missing"),
            &target,
            Duration::from_millis(500)
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
fn bundled_editor_keeps_desktop_path_limit_without_imposing_it_on_core() {
    let directory = tempfile::tempdir().unwrap();
    let data = directory
        .path()
        .join("a".repeat(70))
        .join("b".repeat(70))
        .join("c".repeat(40));
    assert_eq!(
        prepare_bundled_powershell_module_for_host(&data, true).unwrap_err(),
        "TERMINAL_NATIVE_EDITOR_PATH_TOO_LONG"
    );
    let core = prepare_bundled_powershell_module_for_host(&data, false).unwrap();
    assert!(core
        .join("PSReadLine/2.4.5/Microsoft.PowerShell.PSReadLine.dll")
        .is_file());
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
        b"B\x00123\0running\0-\0".as_slice(),
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
    let script = powershell_history_redirect(Path::new("C:/owned user's data"), path);
    assert!(script.contains(
        "'C:/owned user''s data' 'C:/owned user''s data/shell-history/windowsPowerShell.txt'"
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
    let target =
        remote.then(|| std::env::var("SHELLSPAN_ENTER_SSH_TARGET").expect("SSH target required"));
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
        assert!(root.starts_with("/tmp/shellspan-enter.") && !root.contains(char::is_whitespace));
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
                        libc::tcgetattr(pair.master.as_raw_fd().unwrap(), modes.as_mut_ptr()) == 0
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
            if unsafe { libc::tcgetattr(pair.master.as_raw_fd().unwrap(), modes.as_mut_ptr()) } == 0
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
            .write_all(b"printf 'ignore-ready\\n'; sleep 0.4 && printf 'IGNORED-INT-SURVIVED\\n'\r")
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
                    sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
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
                unsafe { libc::tcgetattr(pair.master.as_raw_fd().unwrap(), modes.as_mut_ptr()) },
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
