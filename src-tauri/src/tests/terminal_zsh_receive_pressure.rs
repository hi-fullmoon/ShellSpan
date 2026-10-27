use super::*;
use portable_pty::{native_pty_system, PtySize};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::{mpsc, Mutex};

struct PressureShell(Option<Box<dyn portable_pty::Child + Send + Sync>>);

impl Drop for PressureShell {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn receive(
    events: &mpsc::Receiver<TerminalIntegrationControlEvent>,
    predicate: impl Fn(&TerminalIntegrationControlEvent) -> bool,
) -> TerminalIntegrationControlEvent {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("native shell did not acknowledge the pressure-test input");
        if predicate(&event) {
            return event;
        }
    }
}

fn send_frame(
    writer: &mut dyn Write,
    events: &mpsc::Receiver<TerminalIntegrationControlEvent>,
    source: &str,
    exit: Option<(usize, libc::pid_t, &Path)>,
) {
    let encoded = crate::agent_runtime::native_editor_chunks(source, TerminalShellKind::Zsh)[0]
        .0
        .clone();
    let nonce = Uuid::new_v4().simple().to_string();
    let descriptor = format!("e{:04x}{}{}", encoded.len(), &nonce[..28], nonce);
    let frame = format!("{descriptor}{encoded}");
    writer.write_all(b"\x18\x02").unwrap();
    writer.flush().unwrap();
    receive(
        events,
        |event| matches!(event, TerminalIntegrationControlEvent::NativeCheckpoint { buffer } if buffer.is_empty()),
    );
    if let Some((split, pid, gate)) = exit {
        let raw_queue = unsafe { libc::kqueue() };
        assert!(raw_queue >= 0);
        let queue = unsafe { OwnedFd::from_raw_fd(raw_queue) };
        let mut change: libc::kevent = unsafe { std::mem::zeroed() };
        change.ident = pid as usize;
        change.filter = libc::EVFILT_PROC;
        change.flags = libc::EV_ADD | libc::EV_ONESHOT;
        change.fflags = libc::NOTE_EXIT;
        assert_eq!(
            unsafe {
                libc::kevent(
                    queue.as_raw_fd(),
                    &change,
                    1,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null(),
                )
            },
            0
        );
        let boundary = match split {
            0 => 9,
            1 => descriptor.len(),
            _ => descriptor.len() + encoded.len() / 2,
        };
        writer.write_all(&frame.as_bytes()[..boundary]).unwrap();
        writer.flush().unwrap();
        fs::write(gate, "release").unwrap();
        let timeout = libc::timespec {
            tv_sec: 1,
            tv_nsec: 0,
        };
        let mut exited: libc::kevent = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe {
                libc::kevent(
                    queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &mut exited,
                    1,
                    &timeout,
                )
            },
            1,
            "the real background job must exit while the native frame is incomplete"
        );
        assert_ne!(exited.fflags & libc::NOTE_EXIT, 0);
        writer.write_all(&frame.as_bytes()[boundary..]).unwrap();
    } else {
        writer.write_all(frame.as_bytes()).unwrap();
    }
    writer.flush().unwrap();
    let event = receive(events, |event| {
        matches!(
            event,
            TerminalIntegrationControlEvent::NativePrivateCheckpoint { .. }
        )
    });
    let TerminalIntegrationControlEvent::NativePrivateCheckpoint {
        descriptor: actual,
        buffer,
    } = event
    else {
        unreachable!()
    };
    assert_eq!(
        actual, descriptor,
        "the descriptor must survive concurrent child exit"
    );
    let first_difference = buffer
        .bytes()
        .zip(source.bytes())
        .position(|(actual, expected)| actual != expected);
    assert!(buffer == source, "native BUFFER changed during child exit: expected {} bytes, received {} bytes, first difference {first_difference:?}", source.len(), buffer.len());
    writer.write_all(b"\x18\x05").unwrap();
    writer.flush().unwrap();
    receive(
        events,
        |event| matches!(event, TerminalIntegrationControlEvent::CommandStart { command_line, .. } if command_line == source),
    );
    let ended = receive(events, |event| {
        matches!(event, TerminalIntegrationControlEvent::CommandEnd { .. })
    });
    assert!(matches!(
        ended,
        TerminalIntegrationControlEvent::CommandEnd { exit_code: 0, .. }
    ));
    receive(events, |event| {
        matches!(event, TerminalIntegrationControlEvent::PromptEnd)
    });
}

#[derive(Clone, Copy)]
enum ReceiveCase {
    ChildExit,
    SlowDescriptor,
    SlowPayload,
}

fn verify_receive(case: ReceiveCase) {
    let (_fixture, integration) = prepare_test_integration(TerminalShellKind::Zsh);
    let home = tempfile::tempdir().unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 180,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer =
        crate::local_terminal_input::take_writer(pair.master.as_ref(), TerminalShellKind::Zsh)
            .unwrap();
    let mut command = CommandBuilder::new("/bin/zsh");
    command.env("HOME", home.path());
    command.env("TERM", "xterm-256color");
    integration.configure_command(&mut command).unwrap();
    let mut child = PressureShell(Some(pair.slave.spawn_command(command).unwrap()));
    drop(pair.slave);
    let (sender, events) = mpsc::channel();
    let _control = integration.start_reader(
        move |event| {
            let _ = sender.send(event);
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
    receive(&events, |event| {
        matches!(event, TerminalIntegrationControlEvent::PromptEnd)
    });
    let effects = home.path().join("effects");
    if matches!(case, ReceiveCase::ChildExit) {
        for round in 0..24 {
            let gate = home.path().join(format!("exit-{round}"));
            let handle = format!("job-{}", Uuid::new_v4().simple());
            let pid_file = home.path().join(format!("pid-{round}"));
            let job = format!("zmodload -F zsh/system p:sysparams; builtin printf '%s' \"$sysparams[pid]\" > {}; local_deadline=$((SECONDS + 3)); while [[ ! -f {} && $SECONDS -lt $local_deadline ]]; do /bin/sleep 0.005; done; exit 19", shlex::try_quote(pid_file.to_str().unwrap()).unwrap(), shlex::try_quote(gate.to_str().unwrap()).unwrap());
            let launch =
                crate::terminal_jobs::shell_submission(&job, &handle, TerminalShellKind::Zsh)
                    .unwrap();
            send_frame(writer.as_mut(), &events, &launch, None);
            let deadline = Instant::now() + Duration::from_secs(2);
            let pid = loop {
                if let Some(pid) = fs::read_to_string(&pid_file)
                    .ok()
                    .and_then(|value| value.parse::<libc::pid_t>().ok())
                {
                    assert!(pid > 0);
                    break pid;
                }
                assert!(
                    Instant::now() < deadline,
                    "the native job did not publish its PID"
                );
                thread::sleep(Duration::from_millis(1));
            };
            let source = format!(
                r#": {}
printf '%s\n' {round} >> {}"#,
                shlex::try_quote(&"'\"".repeat(1400)).unwrap(),
                shlex::try_quote(effects.to_str().unwrap()).unwrap()
            );
            assert!(source.len() <= 8192);
            send_frame(
                writer.as_mut(),
                &events,
                &source,
                Some((round % 3, pid, &gate)),
            );
            assert_eq!(
                fs::read_to_string(&effects).unwrap().lines().count(),
                round + 1,
                "each complete source must execute exactly once"
            );
        }
    } else {
        let source = format!(
            "printf forbidden > {}",
            shlex::try_quote(effects.to_str().unwrap()).unwrap()
        );
        let encoded = crate::agent_runtime::native_editor_chunks(&source, TerminalShellKind::Zsh)
            [0]
        .0
        .clone();
        let nonce = Uuid::new_v4().simple().to_string();
        let descriptor = format!("e{:04x}{}{}", encoded.len(), &nonce[..28], nonce);
        let frame = format!("{descriptor}{encoded}");
        writer.write_all(b"\x18\x02").unwrap();
        writer.flush().unwrap();
        receive(
            &events,
            |event| matches!(event, TerminalIntegrationControlEvent::NativeCheckpoint { buffer } if buffer.is_empty()),
        );
        let start = Instant::now();
        let mut sent = if matches!(case, ReceiveCase::SlowDescriptor) {
            9
        } else {
            descriptor.len() + 16
        };
        writer.write_all(&frame.as_bytes()[..sent]).unwrap();
        writer.flush().unwrap();
        let mut timed_out = false;
        while start.elapsed() < Duration::from_millis(2600) {
            if let Ok(event) = events.try_recv() {
                if let TerminalIntegrationControlEvent::NativePrivateCheckpoint { buffer, .. } =
                    event
                {
                    assert!(
                        buffer.is_empty(),
                        "a partial frame must never replace BUFFER"
                    );
                    timed_out = true;
                    break;
                }
            }
            assert!(
                sent < frame.len(),
                "the deliberately slow frame must remain incomplete"
            );
            writer.write_all(&frame.as_bytes()[sent..sent + 1]).unwrap();
            writer.flush().unwrap();
            sent += 1;
            thread::sleep(Duration::from_millis(80));
        }
        assert!(
            timed_out,
            "slow input extended the original native frame deadline"
        );
        assert!(start.elapsed() >= Duration::from_millis(1700));
        writer.write_all(b"\x03").unwrap();
        writer.write_all(&frame.as_bytes()[sent..]).unwrap();
        writer.write_all(b"\rprintf forbidden\r").unwrap();
        writer.flush().unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(!effects.exists(), "a timed-out frame must never execute");
        assert!(
            !events.try_iter().any(|event| matches!(
                event,
                TerminalIntegrationControlEvent::CommandStart { .. }
                    | TerminalIntegrationControlEvent::PromptEnd
            )),
            "a timed-out frame returned to the editor"
        );
        let visible = output.lock().unwrap().clone();
        assert!(
            !String::from_utf8_lossy(&visible).contains("\\x"),
            "late encoded data leaked into the visible terminal"
        );
    }
    let mut finished = child.0.take().unwrap();
    finished.kill().unwrap();
    finished.wait().unwrap();
    drop(writer);
    drop(pair.master);
    output_thread.join().unwrap();
}

#[test]
fn zsh_native_frame_survives_child_exit_during_fragmented_receive() {
    verify_receive(ReceiveCase::ChildExit);
}

#[test]
fn zsh_native_descriptor_deadline_does_not_restart_for_each_byte() {
    verify_receive(ReceiveCase::SlowDescriptor);
}

#[test]
fn zsh_native_payload_deadline_does_not_restart_for_each_byte() {
    verify_receive(ReceiveCase::SlowPayload);
}
