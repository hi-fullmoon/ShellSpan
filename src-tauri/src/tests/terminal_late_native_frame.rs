use super::*;
use portable_pty::{native_pty_system, PtySize};
use std::sync::{mpsc, Mutex};

struct NativeShell(Box<dyn portable_pty::Child + Send + Sync>);

impl Drop for NativeShell {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn verify_late_frame(shell_path: &str, shell: TerminalShellKind, split: usize) {
    let (_root, integration) = prepare_test_integration(shell);
    let home = tempfile::tempdir().unwrap();
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
    command.env("TERM", "xterm-256color");
    integration.configure_command(&mut command).unwrap();
    let mut child = NativeShell(pair.slave.spawn_command(command).unwrap());
    drop(pair.slave);
    let (send, events) = mpsc::channel();
    let _control = integration.start_reader(
        move |event| {
            send.send(event).unwrap();
            Ok(())
        },
        |_| {},
    );
    let output = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&output);
    let output_thread = thread::spawn(move || {
        let mut bytes = [0; 4096];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 {
                break;
            }
            captured.lock().unwrap().extend_from_slice(&bytes[..count]);
        }
    });
    let wait = |stage: &str, predicate: fn(&TerminalIntegrationControlEvent) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut last = None;
        loop {
            let event = events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| {
                    let bytes = output.lock().unwrap();
                    panic!("{shell_path} split={split} {stage}: {error}; last event={last:?}; terminal={:?}", String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(700)..]));
                });
            if predicate(&event) {
                return;
            }
            last = Some(event);
        }
    };
    wait("initial prompt", |event| {
        matches!(event, TerminalIntegrationControlEvent::PromptEnd)
    });
    let effect = home.path().join("must-not-execute");
    let source = format!(
        "printf forbidden > {}\nprintf late-frame",
        shell_single_quote(effect.to_str().unwrap())
    );
    let submitted = if shell == TerminalShellKind::Bash {
        bash_native_submission(&source).unwrap()
    } else {
        source
    };
    let encoded = crate::agent_runtime::native_editor_chunks(&submitted, shell)[0]
        .0
        .clone();
    let nonce = Uuid::new_v4().simple().to_string();
    let descriptor = if shell == TerminalShellKind::Bash {
        let original = bash_native_eval_source(&submitted).unwrap().len() * 4;
        format!(
            "b{:05x}{original:04x}001e0078{}{}",
            encoded.len(),
            &nonce[..15],
            nonce
        )
    } else {
        format!("e{:04x}{}{}", encoded.len(), &nonce[..28], nonce)
    };
    let start = output.lock().unwrap().len();
    writer.write_all(b"\x18\x02").unwrap();
    writer.flush().unwrap();
    wait(
        "receiver ready",
        |event| matches!(event, TerminalIntegrationControlEvent::NativeCheckpoint { buffer } if buffer.is_empty()),
    );
    let frame = format!("{descriptor}{encoded}");
    let boundary = match split {
        0 => 9,
        1 => descriptor.len(),
        _ => descriptor.len() + encoded.len() / 2,
    };
    writer.write_all(frame[..boundary].as_bytes()).unwrap();
    writer.flush().unwrap();
    // Wait for the real receiver deadline, then deliver bytes still in flight.
    wait("frame timeout", |event| {
        matches!(
            event,
            TerminalIntegrationControlEvent::NativePrivateCheckpoint { .. }
        )
    });
    // Interruption does not prove that a delayed frame has finished arriving.
    writer.write_all(b"\x03").unwrap();
    writer.flush().unwrap();
    thread::sleep(Duration::from_millis(250));
    write!(writer, "{}\r", &frame[boundary..]).unwrap();
    writer.flush().unwrap();
    thread::sleep(Duration::from_millis(250));
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    drop(writer);
    drop(pair.master);
    output_thread.join().unwrap();
    let bytes = output.lock().unwrap();
    let visible = String::from_utf8_lossy(&bytes[start..]);
    assert!(
        !visible.contains("\\x"),
        "late private frame leaked to the terminal: {visible}"
    );
    assert!(!effect.exists(), "a timed-out source was executed");
    assert!(
        !events.try_iter().any(|event| matches!(
            event,
            TerminalIntegrationControlEvent::PromptEnd
                | TerminalIntegrationControlEvent::CommandStart { .. }
        )),
        "a timed-out frame returned to the command editor before reconnect"
    );
}

#[test]
fn native_zsh_late_frames_never_reach_the_editor() {
    for split in 0..3 {
        verify_late_frame("/bin/zsh", TerminalShellKind::Zsh, split);
    }
}

#[test]
#[ignore = "requires SHELLSPAN_TEST_MODERN_BASH pointing to native Bash 4.1+"]
fn native_bash_late_frames_never_reach_the_editor() {
    let shell = std::env::var("SHELLSPAN_TEST_MODERN_BASH").unwrap();
    for split in 0..3 {
        verify_late_frame(&shell, TerminalShellKind::Bash, split);
    }
}
