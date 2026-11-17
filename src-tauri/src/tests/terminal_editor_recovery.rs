use super::*;
use crate::agent_runtime::{
    TerminalExecuteRegistry, TerminalInputSource, TerminalInteractiveRegistry, TerminalLeaseManager,
};
use crate::models::{
    ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
    SessionStatus, SessionTerminalKind, StatusEvent,
};
use crate::terminal_broker::{
    TerminalGeometry, TerminalLeaseOwner, TerminalSessionBroker, TerminalTransportKind,
    TerminalWaitReason, TerminalWaitRequest,
};
use crate::terminal_command::protocol::InputMode;
use portable_pty::{native_pty_system, PtySize};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

const TRANSPORT: &str = "editor-recovery-pty";
const AGENT: &str = "editor-recovery-agent";
const TASK: &str = "editor-recovery-task";

struct EditorShell(Box<dyn portable_pty::Child + Send + Sync>);

impl Drop for EditorShell {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_screen(interactive: &TerminalInteractiveRegistry, text: &str) {
    let result = interactive
        .wait(
            TRANSPORT,
            TerminalWaitRequest {
                after_screen_version: None,
                after_output_sequence: None,
                after_lifecycle_sequence: None,
                text: Some(text.into()),
                case_sensitive: true,
                idle: None,
                timeout: Duration::from_secs(5),
            },
        )
        .unwrap();
    assert_eq!(
        result.reason,
        TerminalWaitReason::TextFound,
        "editor did not render {text:?}: {:?}",
        result.snapshot
    );
}

fn verify_editor_recovery(
    editor: &str,
    shell_path: &str,
    shell: TerminalShellKind,
    native_prepare_rejection: Option<&str>,
) {
    let version = std::process::Command::new(editor)
        .arg("--version")
        .output()
        .expect("install the real editor before running this acceptance test");
    assert!(version.status.success(), "{editor} --version failed");
    let home = tempfile::tempdir().unwrap();
    let evidence = std::env::var_os("SHELLSPAN_RAW_EDITOR_EVIDENCE").map(|root| {
        let directory = Path::new(&root).join(format!("{}-{editor}", shell.protocol_name()));
        fs::create_dir(&directory).unwrap();
        directory
    });
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let original = fs::read_to_string(repository.join("src/lib/README.md")).unwrap();
    let document = home.path().join("editor-document.md");
    fs::write(&document, &original).unwrap();
    let broker = TerminalSessionBroker::phase5_enabled_for_test(65_536);
    broker
        .attach_transport(
            TRANSPORT,
            None,
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(120, 30),
        )
        .unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = crate::local_terminal_input::take_writer(pair.master.as_ref(), shell).unwrap();
    let mut command = CommandBuilder::new(shell_path);
    command.arg("-l");
    command.cwd(home.path());
    command.env("HOME", home.path());
    command.env("ZDOTDIR", home.path());
    command.env("XDG_CONFIG_HOME", home.path().join("config"));
    command.env("XDG_DATA_HOME", home.path().join("data"));
    command.env("XDG_STATE_HOME", home.path().join("state"));
    command.env("XDG_CACHE_HOME", home.path().join("cache"));
    command.env("HISTFILE", home.path().join("history"));
    command.env("TERM", "xterm-256color");
    command.env("LC_ALL", "C");
    let mut child = EditorShell(pair.slave.spawn_command(command).unwrap());
    let shell_pid = child.0.process_id().unwrap();
    drop(pair.slave);
    let output_broker = broker.clone();
    let raw = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&raw);
    let mut capture_file = evidence
        .as_ref()
        .map(|directory| fs::File::create_new(directory.join("pty.bin")).unwrap());
    let output = thread::spawn(move || {
        let mut bytes = [0; 4096];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 {
                break;
            }
            if let Some(file) = &mut capture_file {
                file.write_all(&bytes[..count]).unwrap();
            }
            output_broker
                .observe_raw_output(TRANSPORT, &bytes[..count])
                .unwrap();
            captured.lock().unwrap().extend_from_slice(&bytes[..count]);
        }
    });

    let leases = TerminalLeaseManager::new(broker.clone());
    let commands = TerminalExecuteRegistry::new(leases.clone(), broker.clone());
    let interactive = TerminalInteractiveRegistry::new(leases.clone(), broker.clone());
    let sessions = SessionManager::default();
    let (sender, receiver) = crossbeam_channel::unbounded();
    sessions
        .insert(
            TRANSPORT.into(),
            ManagedSession {
                sender: SessionCommandSender::Event(sender),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: TRANSPORT.into(),
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
    let transport = thread::spawn(move || {
        while let Ok(SessionCommand::Write(data)) = receiver.recv() {
            writer.write_all(data.as_bytes()).unwrap();
            writer.flush().unwrap();
        }
    });

    let user_input = |text: &str| {
        leases
            .write(&sessions, TRANSPORT, text.into(), TerminalInputSource::User)
            .unwrap();
    };
    let editor_command = |text: &str| user_input(&format!("\x1b{text}\r"));
    let effect = home.path().join("rejected-agent-effect");
    let reject_agent = |operation: &str| {
        let session = || broker.snapshot(Some(TRANSPORT)).unwrap().session.unwrap();
        let before = session();
        let queried = session();
        assert_eq!(queried.input_mode, InputMode::Raw);
        assert_eq!(queried.next_input_sequence, before.next_input_sequence);
        assert!(queried.native_peer_profile.is_none());
        assert!(queried.native_display_binding.is_none());
        let source = format!(
            "printf %s executed > {}",
            shell_single_quote(effect.to_str().unwrap())
        );
        let Err(error) = commands.start(
            &sessions,
            TRANSPORT,
            AGENT,
            TASK,
            operation,
            &source,
            shell.enter(),
        ) else {
            panic!("raw terminal unexpectedly accepted Agent execution");
        };
        assert!(
            error.starts_with("TERMINAL_NATIVE_INPUT_REQUIRED:"),
            "{error}"
        );
        let after = session();
        assert_eq!(after.terminal_generation, before.terminal_generation);
        assert_eq!(after.next_input_sequence, before.next_input_sequence);
        assert_eq!(after.lease, before.lease);
        assert!(after
            .lease
            .as_ref()
            .is_some_and(|lease| matches!(lease.owner, TerminalLeaseOwner::User { .. })));
        assert!(after.input_observation.active_command.is_none());
        assert!(!after.input_observation.native_recovery_required);
        assert!(!effect.exists());
        serde_json::json!({"operation":operation,"before":before,"after":after,"error":error})
    };
    user_input("printf '%s%s\\n' SHELLSPAN_ RAW_READY\r");
    wait_screen(&interactive, "SHELLSPAN_RAW_READY");
    let mut rejections = vec![reject_agent("before-editor")];
    user_input("printf '%s%s\\n' SHELLSPAN_RAW_ EDITX");
    wait_screen(&interactive, "EDITX");
    let printed = |expected: &str| {
        String::from_utf8_lossy(&raw.lock().unwrap())
            .split(['\r', '\n'])
            .any(|line| line == expected)
    };
    assert!(!printed("SHELLSPAN_RAW_EDITX"));
    user_input("\x7f\r");
    wait_until(Duration::from_secs(5), || printed("SHELLSPAN_RAW_EDIT"));
    assert!(!printed("SHELLSPAN_RAW_EDITX"));
    for modified in [false, true] {
        let source = format!(
            "{} -u NONE -i NONE -n -N --cmd 'set nomore notitle noundofile' -c 'set laststatus=2 statusline=ShellSpanEditorReady' {}",
            shell_single_quote(editor),
            shell_single_quote(document.to_str().unwrap())
        );
        user_input(&format!("{source}\r"));
        // The command echo contains the marker too. Only accept Vim's alternate screen.
        wait_until(Duration::from_secs(5), || {
            interactive.read(TRANSPORT).is_ok_and(|screen| {
                screen.active_buffer == crate::terminal_screen::TerminalScreenBuffer::Alternate
                    && screen
                        .content
                        .iter()
                        .any(|row| row.contains("ShellSpanEditorReady"))
            })
        });
        if !modified {
            rejections.push(reject_agent("during-editor-read"));
        }

        let prefix = "ShellSpan unsaved editor regression: ";
        if modified {
            user_input(&format!("\x1bggI{prefix}"));
        }
        editor_command(":qa");
        if modified {
            wait_screen(&interactive, "No write since last change");
            assert_eq!(
                fs::read_to_string(&document).unwrap(),
                original,
                "refused exit must neither save nor discard the user's buffer"
            );
            assert_eq!(
                interactive.read(TRANSPORT).unwrap().active_buffer,
                crate::terminal_screen::TerminalScreenBuffer::Alternate
            );
            rejections.push(reject_agent("during-editor-edit"));
            // Dismiss the editor's error prompt. Saving is an explicit, separate
            // test action, never an automatic response to the refused exit.
            user_input("\r");
            editor_command(":w");
            let expected = format!("{prefix}{original}");
            wait_until(Duration::from_secs(5), || {
                fs::read_to_string(&document).is_ok_and(|contents| contents == expected)
            });
            editor_command(":qa");
        }
        wait_until(Duration::from_secs(5), || {
            interactive.read(TRANSPORT).is_ok_and(|screen| {
                screen.active_buffer == crate::terminal_screen::TerminalScreenBuffer::Primary
            })
        });
        let suffix = if modified { "EDIT" } else { "READ" };
        user_input(&format!("printf '%s%s\\n' SHELLSPAN_RECOVERED_ {suffix}\r"));
        wait_screen(&interactive, &format!("SHELLSPAN_RECOVERED_{suffix}"));
        assert_eq!(
            fs::read_to_string(&document).unwrap(),
            if modified {
                format!("{prefix}{original}")
            } else {
                original.clone()
            }
        );
    }
    rejections.push(reject_agent("after-editor"));
    user_input("exit\r");
    let mut status = None;
    wait_until(Duration::from_secs(5), || {
        status = child.0.try_wait().unwrap();
        status.is_some()
    });
    assert!(status.unwrap().success());
    sessions.remove(TRANSPORT).unwrap();
    transport.join().unwrap();
    drop(pair.master);
    output.join().unwrap();
    assert!(!effect.exists());
    if let Some(directory) = evidence {
        fs::write(
            directory.join("result.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "shell":shell_path,"shellPid":shell_pid,"editor":editor,"rejections":rejections,
                "nativePrepareRejection":native_prepare_rejection,
                "normalShellExit":true,"ordinaryDraftEditVerified":true,"refusedUnsavedExit":true,
                "explicitSaveVerified":true,"rejectedEffectPresent":effect.exists()
            }))
            .unwrap(),
        )
        .unwrap();
    }
}

fn verify_bash_editor_recovery(editor: &str) {
    let bash = std::env::var("SHELLSPAN_RAW_EDITOR_BASH").unwrap_or_else(|_| "/bin/bash".into());
    verify_editor_recovery(editor, &bash, TerminalShellKind::Bash, None);
}

fn verify_zsh_editor_recovery(editor: &str) {
    let Ok(zsh) = std::env::var("SHELLSPAN_RAW_EDITOR_ZSH") else {
        verify_editor_recovery(editor, "/bin/zsh", TerminalShellKind::Zsh, None);
        return;
    };
    let resources = std::env::var_os("SHELLSPAN_RAW_EDITOR_RESOURCES")
        .expect("Provide the frozen production resources for the alternate Zsh");
    let resources = Path::new(&resources);
    let shell = Path::new(&zsh);
    assert!(shell.is_absolute() && resources.is_absolute());
    let Err(error) = crate::terminal_command::local::PreparedNativeBash::prepare(shell, resources)
    else {
        panic!("Alternate Zsh unexpectedly qualified for the production native profile");
    };
    assert_eq!(error, "TERMINAL_NATIVE_PROFILE_UNSUPPORTED");
    verify_editor_recovery(editor, &zsh, TerminalShellKind::Zsh, Some(&error));
}

#[test]
#[ignore = "requires installed Vim; run the native_editor_recovery acceptance filter explicitly"]
fn native_editor_recovery_vim_bash() {
    verify_bash_editor_recovery("vim");
}

#[test]
#[ignore = "requires installed Vim; run the native_editor_recovery acceptance filter explicitly"]
fn native_editor_recovery_vim_zsh() {
    verify_zsh_editor_recovery("vim");
}

#[test]
#[ignore = "requires installed Neovim; run the native_editor_recovery acceptance filter explicitly"]
fn native_editor_recovery_nvim_bash() {
    verify_bash_editor_recovery("nvim");
}

#[test]
#[ignore = "requires installed Neovim; run the native_editor_recovery acceptance filter explicitly"]
fn native_editor_recovery_nvim_zsh() {
    verify_zsh_editor_recovery("nvim");
}

#[cfg(target_arch = "aarch64")]
#[test]
#[ignore = "requires installed Vim and Neovim, and verified macOS arm64 Bash/Zsh resources"]
fn native_prompt_recovers_terminal_after_editor_exit() {
    use crate::terminal_command::{artifacts, editors, local::PreparedNativeBash, protocol};

    let resources = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/tests/native-input-p2/resources/native-input");
    let shells = [
        artifacts::shellspan_bash(&resources).unwrap(),
        editors::local_zle_shell(&resources).unwrap(),
    ];
    for shell in shells {
        let is_zsh = shell.file_name().is_some_and(|name| name == "zsh");
        let home = tempfile::tempdir().unwrap();
        for file in [".bash_profile", ".zshrc"] {
            fs::write(home.path().join(file), "PS1='TTY ready> '\n").unwrap();
        }
        fs::write(home.path().join("keys"), b"ivim recovered\x1b:wq\r").unwrap();
        let prepared = PreparedNativeBash::prepare(&shell, &resources).unwrap();
        let mut tty_recovery = crate::terminal_display_recovery::DisplayRecovery::new(
            prepared.display_recovery_token(),
        );
        let recovery_root = prepared.tty_recovery_root().to_owned();
        let answer_root = recovery_root.clone();
        let hold_reply = Arc::new(AtomicBool::new(false));
        let reader_hold_reply = Arc::clone(&hold_reply);
        let (late_reply_tx, late_reply_rx) = std::sync::mpsc::channel();
        let broker = TerminalSessionBroker::phase5_enabled_for_test(65_536);
        broker
            .attach_transport_with_mode(
                TRANSPORT,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(100, 30),
                InputMode::NativeInline,
            )
            .unwrap();
        let probe = broker
            .register_native_channel(TRANSPORT, prepared.profile.clone())
            .unwrap();
        broker
            .arm_display_recovery(TRANSPORT, prepared.display_recovery_token())
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(prepared.shell_override().unwrap_or(&shell));
        command.cwd(home.path());
        command.env("HOME", home.path());
        command.env("ZDOTDIR", home.path());
        command.env("INPUTRC", "/dev/null");
        command.env("TERM", "xterm-256color");
        command.env("LC_ALL", "en_US.UTF-8");
        prepared.configure(&mut command).unwrap();
        let output_broker = broker.clone();
        let _control = prepared.start(
            probe,
            move |message| {
                if let protocol::Message::Connection(message) = message {
                    if matches!(
                        message.payload,
                        protocol::ConnectionPayload::Capabilities { .. }
                    ) {
                        output_broker.accept_native_capabilities(TRANSPORT, &message)?;
                    }
                }
                Ok(())
            },
            || {},
        );
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let child = EditorShell(pair.slave.spawn_command(command).unwrap());
        drop(pair.slave);
        let (sender, receiver) = std::sync::mpsc::channel();
        let display_broker = broker.clone();
        let output = thread::spawn(move || {
            let mut buffer = [0; 4096];
            let mut pending = Vec::new();
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if let Some(reply) = tty_recovery.tty_reply(&buffer[..count]) {
                    if reader_hold_reply.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        late_reply_tx.send(reply).unwrap();
                    } else {
                        reply.answer_local(&answer_root).unwrap();
                    }
                }
                pending.extend_from_slice(&buffer[..count]);
                let mut text = String::new();
                crate::drain_decoded_output(&mut pending, &mut text);
                let display = display_broker
                    .observe_display_output(TRANSPORT, &text)
                    .unwrap()
                    .unwrap();
                if sender.send(display.text.into_bytes()).is_err() {
                    break;
                }
            }
        });
        let read_until = |marker: &str| {
            let mut bytes = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !bytes
                .windows(marker.len())
                .any(|part| part == marker.as_bytes())
            {
                let chunk = receiver
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or_else(|error| {
                        panic!("{shell:?}: {error}: {}", String::from_utf8_lossy(&bytes))
                    });
                bytes.extend(chunk);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let read_prompt = || read_until("TTY ready> ");
        read_prompt();
        assert!(broker
            .wait_native_initialization(TRANSPORT, Duration::from_secs(5))
            .unwrap()
            .is_some());
        writer
            .write_all(b"stty -ixon; before_vim=$(stty -g)\r")
            .unwrap();
        read_prompt();
        writer.write_all(b"vim -Nu NONE -i NONE -n -s keys document < /dev/null; printf 'VIM-%s:%s:%s\\n' EXIT \"$?\" \"$(stty speed)\"\r").unwrap();
        let damaged = read_prompt();
        assert!(damaged.contains("VIM-EXIT:0:0\n"), "{shell:?}: {damaged:?}");
        writer.write_all(b"test \"$(stty -g)\" = \"$before_vim\" && printf 'RECOVERY-%s\\nsecond line\\n' VERIFIED\r").unwrap();
        let recovered = read_prompt();
        assert!(
            recovered.contains("RECOVERY-VERIFIED\r\nsecond line\r\n"),
            "{shell:?}: {recovered:?}"
        );
        assert_eq!(
            fs::read(home.path().join("document")).unwrap(),
            b"vim recovered\n"
        );

        writer
            .write_all(b"printf 'MAIN-HISTORY-%s\\n' PRESERVED\r")
            .unwrap();
        let normal = read_prompt();
        writer
            .write_all(b"nvim --clean -i NONE -n document\r")
            .unwrap();
        let running = read_until("vim recovered");
        let mut screen = vt100::Parser::new(30, 100, 100);
        screen.process(normal.as_bytes());
        screen.process(running.as_bytes());
        assert!(screen.screen().alternate_screen(), "{shell:?}: {running:?}");
        assert!(screen.screen().application_cursor());
        assert!(screen.screen().application_keypad());
        let fd = pair.master.as_raw_fd().unwrap();
        let shell_group = child.0.process_id().unwrap() as libc::pid_t;
        let editor_group = unsafe { libc::tcgetpgrp(fd) };
        assert!(editor_group > 1 && editor_group != shell_group);
        assert_eq!(unsafe { libc::kill(-editor_group, libc::SIGKILL) }, 0);
        let ended = read_prompt();
        assert!(
            ended.contains("\x1b[?1049l") && ended.contains("\x1b[?1l"),
            "{shell:?}: {ended:?}"
        );
        screen.process(ended.as_bytes());
        assert!(!screen.screen().alternate_screen(), "{shell:?}: {ended:?}");
        assert!(!screen.screen().application_cursor());
        assert!(!screen.screen().application_keypad());
        assert_eq!(
            screen.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::None
        );
        assert!(screen
            .screen()
            .contents()
            .contains("MAIN-HISTORY-PRESERVED"));
        writer
            .write_all(b"printf '%s%s\\n' FOLLOWUP- OK\r")
            .unwrap();
        let followup = read_prompt();
        assert!(
            followup.contains("FOLLOWUP-OK\r\n"),
            "{shell:?}: {followup:?}"
        );

        writer.write_all(b"printf '\\033[?1004h'\r").unwrap();
        let shell_focus = read_prompt();
        screen.process(shell_focus.as_bytes());
        writer
            .write_all(b"sh -c 'printf SLEEP-%s READY; exec sleep 60'\r")
            .unwrap();
        let sleeping = read_until("SLEEP-READY");
        let sleep_group = unsafe { libc::tcgetpgrp(fd) };
        assert!(sleep_group > 1 && sleep_group != shell_group);
        assert_eq!(unsafe { libc::kill(-sleep_group, libc::SIGINT) }, 0);
        let interrupted = read_prompt();
        assert!(
            !interrupted.contains("\x1b[?1004l"),
            "{shell:?}: {interrupted:?}"
        );
        assert!(
            !interrupted.contains("\x1b[?1049l"),
            "{shell:?}: {interrupted:?}"
        );
        screen.process(sleeping.as_bytes());
        screen.process(interrupted.as_bytes());
        writer
            .write_all(
                b"[[ $(stty -g) == \"$before_vim\" ]] && printf 'INTERRUPT-%s\\n' PRESERVED\r",
            )
            .unwrap();
        let ordinary_tty = read_prompt();
        assert!(
            ordinary_tty.contains("INTERRUPT-PRESERVED\r\n"),
            "{shell:?}: {ordinary_tty:?}"
        );

        if is_zsh {
            writer.write_all(b"sleep 60 & unrelated_pid=$!\r").unwrap();
            read_prompt();
        }
        writer
            .write_all(b"nvim --clean -i NONE -n document || :\r")
            .unwrap();
        let wrapped = read_until("vim recovered");
        screen.process(wrapped.as_bytes());
        assert!(screen.screen().alternate_screen());
        let editor_group = unsafe { libc::tcgetpgrp(fd) };
        assert!(editor_group > 1 && editor_group != shell_group);
        assert_eq!(unsafe { libc::kill(-editor_group, libc::SIGKILL) }, 0);
        let wrapped_end = read_prompt();
        assert!(
            wrapped_end.contains("\x1b[?1049l"),
            "{shell:?}: {wrapped_end:?}"
        );
        assert!(
            !wrapped_end.contains("\x1b[?1004l"),
            "{shell:?}: {wrapped_end:?}"
        );
        screen.process(wrapped_end.as_bytes());
        assert!(!screen.screen().alternate_screen());
        assert!(!screen.screen().application_cursor());
        writer
            .write_all(b"printf '\\r\\nWRAPPED-%s:%s\\r\\n' EXIT \"$?\"\r")
            .unwrap();
        let wrapped_status = read_prompt();
        assert!(
            wrapped_status.contains("WRAPPED-EXIT:0"),
            "{shell:?}: {wrapped_status:?}"
        );
        writer.write_all(b"[[ $(stty -g) == \"$before_vim\" ]] && printf 'WRAPPED-%s\\nSECOND-LINE\\n' RECOVERED\r").unwrap();
        let wrapped_tty = read_prompt();
        assert!(
            wrapped_tty.contains("WRAPPED-RECOVERED\r\nSECOND-LINE\r\n"),
            "{shell:?}: {wrapped_tty:?}"
        );
        if is_zsh {
            writer.write_all(b"kill -0 \"$unrelated_pid\" && printf 'BACKGROUND-%s\\n' ALIVE; kill \"$unrelated_pid\"; wait \"$unrelated_pid\" || :\r").unwrap();
            let background = read_prompt();
            assert!(
                background.contains("BACKGROUND-ALIVE\r\n"),
                "{shell:?}: {background:?}"
            );
        }
        writer
            .write_all(b"stty -onlcr; custom_tty=$(stty -g)\r")
            .unwrap();
        read_prompt();
        writer.write_all(b"[[ $(stty -g) == \"$custom_tty\" ]] && printf 'CUSTOM-%s\\nSECOND-LINE\\n' PRESERVED\r").unwrap();
        let custom = read_prompt();
        assert!(
            custom.contains("CUSTOM-PRESERVED\nSECOND-LINE\n"),
            "{shell:?}: {custom:?}"
        );
        writer.write_all(b"stty \"$before_vim\"\r").unwrap();
        let before_suspend = read_prompt();

        if is_zsh {
            writer
                .write_all(b"sh -c 'sleep 2; exec nvim --clean -i NONE -n document' &\r")
                .unwrap();
            read_prompt();
            writer.write_all(b"fg || :\r").unwrap();
        } else {
            writer
                .write_all(b"nvim --clean -i NONE -n document || :\r")
                .unwrap();
        }
        let stopping = read_until("vim recovered");
        assert!(stopping.contains("\x1b[?1049h"), "{shell:?}: {stopping:?}");
        let editor_group = unsafe { libc::tcgetpgrp(fd) };
        assert!(editor_group > 1 && editor_group != shell_group);
        assert_eq!(unsafe { libc::kill(-editor_group, libc::SIGSTOP) }, 0);
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(read_prompt));
        let stopped = stopped.unwrap();
        screen.process(stopping.as_bytes());
        screen.process(stopped.as_bytes());
        assert!(screen.screen().alternate_screen(), "{shell:?}: {stopped:?}");
        assert!(!stopped.contains("\x1b[?1049l"), "{shell:?}: {stopped:?}");

        if is_zsh {
            assert!(
                stopped.contains(&format!(";0; {editor_group} ; {editor_group} \x07")),
                "{shell:?}: {stopped:?}"
            );
            writer.write_all(b"fg\r").unwrap();
            let resumed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let deadline = Instant::now() + Duration::from_secs(5);
                while unsafe { libc::tcgetpgrp(fd) } != editor_group {
                    assert!(
                        Instant::now() < deadline,
                        "{shell:?}: editor did not resume"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
            }));
            hold_reply.store(true, std::sync::atomic::Ordering::Release);
            let killed = unsafe { libc::kill(-editor_group, libc::SIGKILL) };
            resumed.unwrap();
            assert_eq!(killed, 0);
            read_prompt();
            let late_reply = late_reply_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            writer.write_all(b"[[ $(stty -g) != \"$before_vim\" && $__shellspan_saved_prompt_tty == \"$before_vim\" ]] && printf 'TIMEOUT-%s\\n' PRESERVED\r").unwrap();
            let timed_out = read_prompt();
            assert!(
                timed_out.contains("TIMEOUT-PRESERVED\n"),
                "{shell:?}: {timed_out:?}"
            );
            late_reply.answer_local(&recovery_root).unwrap();
            writer.write_all(b"[[ $(stty -g) != \"$before_vim\" && $__shellspan_saved_prompt_tty == \"$before_vim\" ]] && printf 'LATE-%s\\n' IGNORED\r").unwrap();
            let late = read_prompt();
            assert!(late.contains("LATE-IGNORED\n"), "{shell:?}: {late:?}");

            writer
                .write_all(b"nvim --clean -i NONE -n document || :\r")
                .unwrap();
            let next_editor = read_until("vim recovered");
            assert!(
                next_editor.contains("\x1b[?1049h"),
                "{shell:?}: {next_editor:?}"
            );
            let next_group = unsafe { libc::tcgetpgrp(fd) };
            assert!(next_group > 1 && next_group != shell_group && next_group != editor_group);
            assert_eq!(unsafe { libc::kill(-next_group, libc::SIGKILL) }, 0);
            let next_prompt = read_prompt();
            assert!(
                next_prompt.contains("\x1b[?1049l"),
                "{shell:?}: {next_prompt:?}"
            );
            writer.write_all(b"[[ $(stty -g) == \"$before_vim\" ]] && printf 'NEXT-%s\\nSECOND-LINE\\n' RECOVERED\r").unwrap();
            let recovered = read_prompt();
            assert!(
                recovered.contains("NEXT-RECOVERED\r\nSECOND-LINE\r\n"),
                "{shell:?}: {recovered:?}"
            );

            writer
                .write_all(b"nvim --clean -i NONE -n document || :\r")
                .unwrap();
            let partial_cleanup_editor = read_until("vim recovered");
            assert!(partial_cleanup_editor.contains("\x1b[?1049h"));
            let partial_cleanup_group = unsafe { libc::tcgetpgrp(fd) };
            assert!(partial_cleanup_group > 1 && partial_cleanup_group != shell_group);
            // Leave the alternate screen through the real Neovim TUI while
            // keeping the program's raw termios settings until SIGKILL.
            writer
                .write_all(
                    b":lua io.stdout:write(string.char(27)..\"[?1049l\"); io.stdout:flush()\r",
                )
                .unwrap();
            let left_alternate = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                read_until("\x1b[?1049l")
            }));
            assert_eq!(
                unsafe { libc::kill(-partial_cleanup_group, libc::SIGKILL) },
                0
            );
            left_alternate.unwrap();
            let partial_cleanup_prompt = read_prompt();
            assert!(
                !partial_cleanup_prompt.contains("\x1b[?1049l"),
                "{partial_cleanup_prompt:?}"
            );
            writer.write_all(b"[[ $(stty -g) == \"$before_vim\" ]] && printf 'PARTIAL-%s\\nSECOND-LINE\\n' RECOVERED\r").unwrap();
            let recovered = read_prompt();
            assert!(
                recovered.contains("PARTIAL-RECOVERED\r\nSECOND-LINE\r\n"),
                "{shell:?}: {recovered:?}"
            );
        } else {
            assert_eq!(unsafe { libc::kill(-editor_group, libc::SIGKILL) }, 0);
        }

        if let Some(evidence) = std::env::var_os("SHELLSPAN_RAW_EDITOR_EVIDENCE") {
            let name = shell.file_name().unwrap().to_str().unwrap();
            fs::write(
                Path::new(&evidence).join(format!("display-recovery-{name}.json")),
                serde_json::to_vec(&[
                    normal,
                    running,
                    ended,
                    followup,
                    shell_focus,
                    sleeping,
                    interrupted,
                    wrapped,
                    wrapped_end,
                    wrapped_status,
                    before_suspend,
                    stopping,
                    stopped,
                ])
                .unwrap(),
            )
            .unwrap();
        }

        drop(child);
        output.join().unwrap();
    }
}
