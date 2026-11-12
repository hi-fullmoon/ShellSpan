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
