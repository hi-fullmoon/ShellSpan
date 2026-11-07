use super::*;
use crate::models::{
    ManagedSession, SessionCommandSender, SessionIdentity, SessionManager, SessionStatus,
    SessionTerminalKind, StatusEvent,
};
use crate::terminal_command::{local::PreparedNativeBash, protocol as nip};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::fd::{AsRawFd, FromRawFd};

struct NativeCase {
    case: PtyCase,
    terminal: fs::File,
    transport: SessionManager,
    messages: Receiver<nip::Message>,
    records: Vec<nip::Message>,
    connection: nip::ConnectionIdentity,
    expected: crate::terminal_command::registration::VerifiedNativeProfile,
    observation: std::path::PathBuf,
    phase: &'static str,
}

impl NativeCase {
    fn start(
        shell: &std::path::Path,
        resources: &std::path::Path,
        observation: std::path::PathBuf,
    ) -> Self {
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join(".zshrc"),
            "PROMPT='PUMP_NATIVE> '\nHISTFILE=$HOME/history\nHISTSIZE=1000\nSAVEHIST=1000\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".bash_profile"),
            "source \"$HOME/.bashrc\"\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".bashrc"),
            "PS1='PUMP_NATIVE> '\nHISTFILE=$HOME/history\n",
        )
        .unwrap();
        let native = PreparedNativeBash::prepare(shell, resources).unwrap();
        let expected = native.profile.clone();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 31,
                cols: 167,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let fd = pair.master.as_raw_fd().unwrap();
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        assert!(duplicate >= 0);
        let terminal = unsafe { fs::File::from_raw_fd(duplicate) };
        let kind = if shell.file_name().unwrap() == "zsh" {
            TerminalShellKind::Zsh
        } else {
            TerminalShellKind::Bash
        };
        let writer = super::super::super::take_writer(pair.master.as_ref(), kind).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut command = CommandBuilder::new(shell);
        command.cwd(home.path());
        command.env("HOME", home.path());
        command.env("TERM", "xterm-256color");
        command.env("LC_ALL", "en_US.UTF-8");
        native.configure(&mut command).unwrap();
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let connection = nip::ConnectionIdentity {
            terminal_session_id: uuid::Uuid::new_v4().to_string(),
            terminal_generation: 1,
            control_id: uuid::Uuid::new_v4().to_string(),
        };
        let probe = nip::ConnectionEnvelope {
            protocol: nip::PROTOCOL.into(),
            request_id: "initial".into(),
            connection: connection.clone(),
            payload: nip::ConnectionPayload::Probe,
        };
        let (send, messages) = unbounded();
        let control = native.start(
            probe,
            move |message| {
                send.send(message)
                    .map_err(|_| "probe receiver closed".into())
            },
            || {},
        );
        let control_failures = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let failures = control_failures.clone();
        let pump = LocalInputPump::spawn(
            writer,
            pair.master,
            Some(control),
            "native-pump-test".into(),
            move || {
                failures.fetch_add(1, Ordering::SeqCst);
            },
        );
        let transport = SessionManager::default();
        transport
            .insert(
                connection.terminal_session_id.clone(),
                ManagedSession {
                    sender: SessionCommandSender::Event(pump.sender.as_ref().unwrap().clone()),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: connection.terminal_session_id.clone(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "native-input-pump".into(),
                        host: "local".into(),
                        port: 0,
                        username: String::new(),
                    },
                },
            )
            .unwrap();
        let (sender, received) = crossbeam_channel::bounded(32);
        let output = thread::spawn(move || {
            let mut bytes = [0; 8192];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 || sender.send(bytes[..count].to_vec()).is_err() {
                    break;
                }
            }
        });
        Self {
            case: PtyCase {
                _home: home,
                child,
                pump,
                output: Some(output),
                received,
                raw: Vec::new(),
                control_failures,
            },
            terminal,
            transport,
            messages,
            records: Vec::new(),
            connection,
            expected,
            observation,
            phase: "initial-probe",
        }
    }

    fn capabilities(&mut self, request: &str, empty: bool) -> nip::PeerProfile {
        let deadline = crossbeam_channel::after(Duration::from_secs(8));
        loop {
            crossbeam_channel::select! {
                recv(self.case.received) -> bytes => self.case.raw.extend(bytes.unwrap()),
                recv(self.messages) -> message => {
                    let message=message.unwrap();
                    let matched=if let nip::Message::Connection(value)=&message {
                        if value.request_id==request {
                            if let nip::ConnectionPayload::Capabilities {profile,native_inline,editor_empty,..}=&value.payload {
                                assert!(*native_inline);assert!(self.expected.matches(profile));assert_eq!(*editor_empty,empty);Some(profile.clone())
                            } else {None}
                        } else {None}
                    } else {None};
                    self.records.push(message);if let Some(profile)=matched{return profile;}
                },
                recv(deadline) -> _ => panic!("real native pump capability response missing: {request}"),
            }
        }
    }

    fn editor_idle(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            self.case
                .raw
                .extend(self.case.received.try_iter().flatten());
            let fd = self.terminal.as_raw_fd();
            let mut modes = std::mem::MaybeUninit::<libc::termios>::uninit();
            if unsafe { libc::tcgetattr(fd, modes.as_mut_ptr()) } == 0 {
                let modes = unsafe { modes.assume_init() };
                if modes.c_lflag & (libc::ICANON | libc::ECHO) == 0
                    && unsafe { libc::tcgetpgrp(fd) }
                        == self.case.child.process_id().unwrap() as libc::pid_t
                {
                    return;
                }
            }
            assert!(
                Instant::now() < deadline,
                "actual editor did not regain the foreground raw input mode"
            );
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn probe(&self, request: &str) {
        let frame = nip::ConnectionEnvelope {
            protocol: nip::PROTOCOL.into(),
            request_id: request.into(),
            connection: self.connection.clone(),
            payload: nip::ConnectionPayload::Probe,
        };
        self.transport
            .write_native_control(
                &self.connection.terminal_session_id,
                &frame.encode().unwrap(),
                true,
            )
            .unwrap();
    }
}

impl Drop for NativeCase {
    fn drop(&mut self) {
        if thread::panicking() {
            let record = serde_json::json!({"failed":true,"phase":self.phase,"childPid":self.case.child.process_id(),"records":&self.records,"scope":"Partial actual observation before failed-case cleanup; no completed operation or termination claim."});
            if let Ok(bytes) = serde_json::to_vec_pretty(&record) {
                let _ = fs::write(self.observation.with_extension("json"), bytes);
            }
            let _ = fs::write(self.observation.with_extension("pty"), &self.case.raw);
        }
    }
}

#[test]
#[ignore = "requires exact macOS native resources and the frozen4790-byte display fixture"]
fn native_input_pump_large_input_control_order_and_cancel_preserve_real_pty() {
    require_native_mac();
    let fixture: serde_json::Value = serde_json::from_slice(
        &fs::read(
            std::env::var_os("SHELLSPAN_LOCAL_INPUT_FIXTURE")
                .expect("explicit frozen fixture required"),
        )
        .unwrap(),
    )
    .unwrap();
    let command = fixture["command"].as_str().unwrap();
    let output = fixture["output"].as_str().unwrap();
    assert_eq!(command.len(), 4790);
    assert_eq!(
        nip::sha(command),
        "a2e6eeb088f7ea7f65901126b507926f37ab9fd638cf52163ea6076d25f1aa43"
    );
    assert_eq!(
        nip::sha(output),
        "a53bc44ed67c2900b925d887aa3d599c3abc8e138f57abcd5040d80f61d7d2bc"
    );
    let owner = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let resources = owner.join(".artifacts/tests/native-input-p2/resources/native-input");
    let evidence = owner
        .join(".artifacts/tests/native-input-p3/input-pump")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    let zsh = crate::terminal_command::editors::local_zle_shell(&resources).unwrap();
    let shells = [
        ("zsh".to_string(), zsh),
        (
            "bash-4.1".into(),
            resources.join("gnu-bash-4.1-readline-6.0-macos-arm64-native/bash"),
        ),
        (
            "bash-4.4".into(),
            resources.join("gnu-bash-4.4-readline-7.0-macos-arm64-native/bash"),
        ),
        (
            "bash-5.3".into(),
            resources.join("gnu-bash-5.3-readline-8.3.6-macos-arm64-native/bash"),
        ),
    ];
    for (name, shell) in shells {
        let mut native =
            NativeCase::start(&shell, &resources, evidence.join(format!("{name}-failed")));
        let profile = native.capabilities("initial", true);
        native.editor_idle();
        native.phase = "original4790-byte-output";
        native
            .case
            .pump
            .send(SessionCommand::Write(command.into()))
            .unwrap();
        native.case.until(b"MANUAL_DISPLAY_READY\r\n");
        let expected = output.replace('\n', "\r\n");
        assert!(native
            .case
            .raw
            .windows(expected.len())
            .any(|bytes| bytes == expected.as_bytes()));
        native.editor_idle();
        native.phase = "post-output-control";
        native.probe("after-output");
        native.capabilities("after-output", true);
        let blocked = native.case._home.path().join("must-not-execute");
        let quoted = shlex::try_quote(blocked.to_str().unwrap()).unwrap();
        let draft = format!("printf X > {quoted} #{}", "x".repeat(5000));
        native.phase = "nonempty-draft-control";
        native.case.pump.send(SessionCommand::Write(draft)).unwrap();
        native.probe("draft-present");
        native.capabilities("draft-present", false);
        native.phase = "cancel-and-next-enter";
        for input in ["\x03", "\r", "printf '%s%s\\n' PUMP_CANCEL _RESTORED\r"] {
            native
                .case
                .pump
                .send(SessionCommand::Write(input.into()))
                .unwrap();
        }
        native.case.until(b"PUMP_CANCEL_RESTORED\r\n");
        assert!(!blocked.exists());
        native.editor_idle();
        native.probe("after-cancel");
        native.capabilities("after-cancel", true);
        native.phase = "shutdown";
        native
            .transport
            .remove(&native.connection.terminal_session_id)
            .unwrap();
        native.case.stop();
        let record = serde_json::json!({"profile":profile,"commandSha256":nip::sha(command),"outputSha256":nip::sha(output),"inputBytes":command.len(),"fullOutputMatched":true,"draftWasNonempty":true,"cancelThenEnterDidNotExecute":!blocked.exists(),"controlRestoredEmpty":true,"inputAndReaderJoined":true,"childExit":native.case.child.try_wait().unwrap().map(|status|status.exit_code()),"records":&native.records,"rawSha256":hex::encode(Sha256::digest(&native.case.raw)),"scope":"Actual native modules/PTY/input pump and SessionManager control frames; no Agent source submission, GUI, model or whole acceptance claim."});
        fs::write(
            evidence.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        fs::write(evidence.join(format!("{name}.pty")), &native.case.raw).unwrap();
    }
}

fn require_native_mac() {
    #[cfg(not(target_arch = "aarch64"))]
    panic!("actual macOS arm64 native resources required");
}
