use super::*;
use crate::agent_runtime::{
    TerminalExecuteRegistry, TerminalInteractiveInputKindNative, TerminalInteractiveRegistry,
    TerminalKeyNative, TerminalLeaseEventState, TerminalLeaseManager,
};
use crate::models::{
    ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
    SessionStatus, SessionTerminalKind, StatusEvent,
};
use crate::terminal_broker::{
    TerminalCommandState, TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
    TerminalWaitReason, TerminalWaitRequest,
};
use portable_pty::{native_pty_system, PtySize};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

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

fn input(
    interactive: &TerminalInteractiveRegistry,
    sessions: &SessionManager,
    text: Option<&str>,
    key: Option<TerminalKeyNative>,
) {
    interactive
        .write(
            sessions,
            TRANSPORT,
            AGENT,
            TASK,
            if key.is_some() {
                TerminalInteractiveInputKindNative::Key
            } else {
                TerminalInteractiveInputKindNative::Text
            },
            text,
            key,
        )
        .unwrap();
}

fn editor_command(
    interactive: &TerminalInteractiveRegistry,
    sessions: &SessionManager,
    text: &str,
) {
    input(interactive, sessions, None, Some(TerminalKeyNative::Escape));
    input(interactive, sessions, Some(text), None);
    input(interactive, sessions, None, Some(TerminalKeyNative::Enter));
}

fn verify_editor_recovery(editor: &str, shell_path: &str, shell: TerminalShellKind) {
    let version = std::process::Command::new(editor)
        .arg("--version")
        .output()
        .expect("install the real editor before running this acceptance test");
    assert!(version.status.success(), "{editor} --version failed");
    let home = tempfile::tempdir().unwrap();
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let original = fs::read_to_string(repository.join("src/lib/README.md")).unwrap();
    let document = home.path().join("editor-document.md");
    fs::write(&document, &original).unwrap();
    let (_root, integration) = prepare_test_integration(shell);
    let broker = TerminalSessionBroker::phase5_enabled_for_test(65_536);
    broker
        .attach_transport(
            TRANSPORT,
            None,
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(120, 30),
        )
        .unwrap();
    let integration_id = integration.integration_id().to_string();
    broker
        .register_integration_channel(TRANSPORT, &integration_id, shell)
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
    command.env("HOME", home.path());
    command.env("XDG_CONFIG_HOME", home.path().join("config"));
    command.env("XDG_DATA_HOME", home.path().join("data"));
    command.env("XDG_STATE_HOME", home.path().join("state"));
    command.env("XDG_CACHE_HOME", home.path().join("cache"));
    command.env("HISTFILE", home.path().join("history"));
    command.env("TERM", "xterm-256color");
    command.env("LC_ALL", "C");
    integration.configure_command(&mut command).unwrap();
    let control_broker = broker.clone();
    let _control = integration.start_reader(
        move |event| control_broker.accept_integration_event(TRANSPORT, &integration_id, event),
        |_| {},
    );
    let mut child = EditorShell(pair.slave.spawn_command(command).unwrap());
    drop(pair.slave);
    let output_broker = broker.clone();
    let output = thread::spawn(move || {
        let mut bytes = [0; 4096];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 {
                break;
            }
            output_broker
                .observe_raw_output(TRANSPORT, &bytes[..count])
                .unwrap();
        }
    });
    wait_for_prompt(&broker, TRANSPORT);

    let leases = TerminalLeaseManager::new(broker.clone());
    let acknowledger = leases.clone();
    leases
        .set_publisher(Arc::new(move |event| {
            if event.state == TerminalLeaseEventState::Acquired {
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

    for modified in [false, true] {
        let source = format!(
            "{} -u NONE -i NONE -n -N --cmd 'set nomore notitle noundofile' -c 'set laststatus=2 statusline=ShellSpanEditorReady' {}",
            shell_single_quote(editor),
            shell_single_quote(document.to_str().unwrap())
        );
        let operation = commands
            .start(
                &sessions,
                TRANSPORT,
                AGENT,
                TASK,
                "open-editor",
                &source,
                shell.enter(),
            )
            .unwrap();
        // The command echo also contains the statusline marker. Require the
        // editor's real alternate screen before observing the timeout.
        wait_until(Duration::from_secs(5), || {
            interactive.read(TRANSPORT).is_ok_and(|screen| {
                screen.active_buffer == crate::terminal_screen::TerminalScreenBuffer::Alternate
                    && screen
                        .content
                        .iter()
                        .any(|row| row.contains("ShellSpanEditorReady"))
            })
        });
        let result = commands
            .wait(&sessions, TRANSPORT, &operation, Duration::from_millis(50))
            .unwrap();
        assert_eq!(result.state, TerminalCommandState::Uncertain);
        assert!(
            !broker
                .snapshot(Some(TRANSPORT))
                .unwrap()
                .session
                .unwrap()
                .prompt_ready
        );

        let prefix = "ShellSpan unsaved editor regression: ";
        if modified {
            input(
                &interactive,
                &sessions,
                None,
                Some(TerminalKeyNative::Escape),
            );
            input(&interactive, &sessions, Some("ggI"), None);
            input(&interactive, &sessions, Some(prefix), None);
        }
        editor_command(&interactive, &sessions, ":qa");
        if modified {
            wait_screen(&interactive, "No write since last change");
            assert_eq!(
                fs::read_to_string(&document).unwrap(),
                original,
                "refused exit must neither save nor discard the user's buffer"
            );
            assert_eq!(
                interactive
                    .release_at_prompt(TRANSPORT, AGENT, TASK)
                    .unwrap_err(),
                "TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY"
            );
            // Dismiss the editor's error prompt. Saving is an explicit, separate
            // test action, never an automatic response to the refused exit.
            input(
                &interactive,
                &sessions,
                None,
                Some(TerminalKeyNative::Enter),
            );
            editor_command(&interactive, &sessions, ":w");
            let expected = format!("{prefix}{original}");
            wait_until(Duration::from_secs(5), || {
                fs::read_to_string(&document).is_ok_and(|contents| contents == expected)
            });
            editor_command(&interactive, &sessions, ":qa");
        }
        wait_for_prompt(&broker, TRANSPORT);
        interactive
            .release_at_prompt(TRANSPORT, AGENT, TASK)
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        let next = commands
            .start(
                &sessions,
                TRANSPORT,
                AGENT,
                TASK,
                "after-editor",
                "printf editor-recovery-complete",
                shell.enter(),
            )
            .unwrap();
        let result = commands
            .wait(&sessions, TRANSPORT, &next, Duration::from_secs(5))
            .unwrap();
        assert_eq!(result.state, TerminalCommandState::Completed);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.combined_output.contains("editor-recovery-complete"));
        wait_for_prompt(&broker, TRANSPORT);
        assert_eq!(
            fs::read_to_string(&document).unwrap(),
            if modified {
                format!("{prefix}{original}")
            } else {
                original.clone()
            }
        );
    }
    interactive.release_turn(AGENT).unwrap();
    leases.release_turn(AGENT).unwrap();
    sessions.remove(TRANSPORT).unwrap();
    transport.join().unwrap();
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    drop(pair.master);
    output.join().unwrap();
}

#[test]
#[ignore = "requires installed Vim; run the native_editor_recovery acceptance filter explicitly"]
fn native_editor_recovery_vim_bash() {
    verify_editor_recovery("vim", "/bin/bash", TerminalShellKind::Bash);
}

#[test]
#[ignore = "requires installed Vim; run the native_editor_recovery acceptance filter explicitly"]
fn native_editor_recovery_vim_zsh() {
    verify_editor_recovery("vim", "/bin/zsh", TerminalShellKind::Zsh);
}

#[test]
#[ignore = "requires installed Neovim; run the native_editor_recovery acceptance filter explicitly"]
fn native_editor_recovery_nvim_bash() {
    verify_editor_recovery("nvim", "/bin/bash", TerminalShellKind::Bash);
}

#[test]
#[ignore = "requires installed Neovim; run the native_editor_recovery acceptance filter explicitly"]
fn native_editor_recovery_nvim_zsh() {
    verify_editor_recovery("nvim", "/bin/zsh", TerminalShellKind::Zsh);
}
