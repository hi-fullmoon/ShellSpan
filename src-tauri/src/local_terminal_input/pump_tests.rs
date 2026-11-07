use super::*;
use crate::models::{
    ManagedSession, SessionCommandSender, SessionIdentity, SessionManager, SessionStatus,
    SessionTerminalKind, StatusEvent,
};
use crate::terminal_integration::TerminalShellKind;
use portable_pty::{native_pty_system, Child, CommandBuilder};
use std::io::Read;
use std::time::{Duration, Instant};

#[path = "pump_native_tests.rs"]
mod native;

struct PtyCase {
    _home: tempfile::TempDir,
    child: Box<dyn Child + Send + Sync>,
    pump: LocalInputPump,
    output: Option<thread::JoinHandle<()>>,
    received: Receiver<Vec<u8>>,
    raw: Vec<u8>,
    control_failures: Arc<std::sync::atomic::AtomicUsize>,
}

impl PtyCase {
    fn start(script: &str) -> Self {
        let home = tempfile::tempdir().unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 31,
                cols: 167,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", script]);
        command.cwd(home.path());
        command.env("HOME", home.path());
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer =
            super::super::take_writer(pair.master.as_ref(), TerminalShellKind::Zsh).unwrap();
        let control_failures = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let failures = control_failures.clone();
        let pump = LocalInputPump::spawn(
            writer,
            pair.master,
            None,
            "input-pump-test".into(),
            move || {
                failures.fetch_add(1, Ordering::SeqCst);
            },
        );
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
            _home: home,
            child,
            pump,
            output: Some(output),
            received,
            raw: Vec::new(),
            control_failures,
        }
    }

    fn input_transport(&self, id: &str) -> SessionManager {
        let transport = SessionManager::default();
        transport
            .insert(
                id.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(self.pump.sender.as_ref().unwrap().clone()),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: id.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "input-pump-test".into(),
                        host: "local".into(),
                        port: 0,
                        username: String::new(),
                    },
                },
            )
            .unwrap();
        transport
    }

    fn until(&mut self, marker: &[u8]) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !self.raw.windows(marker.len()).any(|value| value == marker) {
            self.raw.extend(
                self.received
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("real PTY output did not reach its expected marker"),
            );
        }
    }

    fn stop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            self.child.kill().unwrap();
        }
        self.pump.stop();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if self.pump.finished().try_recv().is_ok() {
                self.pump.join_finished().unwrap();
                break;
            }
            match self.received.recv_timeout(Duration::from_millis(5)) {
                Ok(bytes) => self.raw.extend(bytes),
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {}
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            }
            assert!(Instant::now() < deadline, "input pump did not terminate");
        }
        while self.child.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "owned PTY child did not terminate"
            );
            thread::sleep(Duration::from_millis(2));
        }
        if let Some(output) = self.output.take() {
            output.join().unwrap();
        }
    }
}

impl Drop for PtyCase {
    fn drop(&mut self) {
        if thread::panicking() {
            if let Some(directory) = std::env::var_os("SHELLSPAN_PUMP_FAILURE_EVIDENCE") {
                let directory = std::path::PathBuf::from(directory);
                let _ = std::fs::create_dir_all(&directory);
                let value = serde_json::json!({"failed":true,"childPid":self.child.process_id(),"rawHex":hex::encode(&self.raw),"controlFailures":self.control_failures.load(Ordering::SeqCst),"scope":"Actual partial PTY observation before test cleanup; no termination claim."});
                if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
                    let _ = std::fs::write(
                        directory.join(format!("pty-failure-{}.json", uuid::Uuid::new_v4())),
                        bytes,
                    );
                }
            }
        }
        if self.child.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.child.kill();
        }
        self.pump.stop();
        // On a failed assertion, dropping the receiver also releases a reader
        // blocked at the same bounded queue used by production.
    }
}

#[test]
fn input_pump_missing_control_preserves_ordinary_terminal_input() {
    use crate::terminal_command::protocol as nip;
    let mut case = PtyCase::start(
        "stty -echo; printf 'PUMP_READY\\n'; IFS= read -r line; printf 'RAW:%s\\n' \"$line\"",
    );
    case.until(b"PUMP_READY\r\n");
    let id = uuid::Uuid::new_v4().to_string();
    let transport = case.input_transport(&id);
    let probe = nip::ConnectionEnvelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "missing-control".into(),
        connection: nip::ConnectionIdentity {
            terminal_session_id: id.clone(),
            terminal_generation: 1,
            control_id: uuid::Uuid::new_v4().to_string(),
        },
        payload: nip::ConnectionPayload::Probe,
    };
    transport
        .write_native_control(&id, &probe.encode().unwrap(), false)
        .unwrap();
    case.pump
        .send(SessionCommand::Write("still-usable\n".into()))
        .unwrap();
    case.until(b"RAW:still-usable\r\n");
    assert_eq!(case.control_failures.load(Ordering::SeqCst), 1);
    transport.remove(&id).unwrap();
    case.stop();
}

#[test]
fn input_pump_preserves_resize_text_and_binary_order_on_a_real_pty() {
    let mut case = PtyCase::start(
        "stty -echo; printf 'PUMP_READY\\n'; IFS= read -r a; stty size; IFS= read -r b; printf 'ORDER:%s:%s\\n' \"$a\" \"$b\"",
    );
    case.until(b"PUMP_READY\r\n");
    case.pump
        .send(SessionCommand::Resize { cols: 91, rows: 37 })
        .unwrap();
    case.pump
        .send(SessionCommand::Write("first\n".into()))
        .unwrap();
    case.pump
        .send(SessionCommand::WriteBytes(b"second\n".to_vec()))
        .unwrap();
    case.until(b"ORDER:first:second\r\n");
    assert!(String::from_utf8_lossy(&case.raw).contains("37 91\r\n"));
    case.stop();
}

#[test]
fn input_pump_shutdown_releases_a_blocked_writer_and_closes_input() {
    let mut case = PtyCase::start("stty raw -echo; printf PUMP_READY; exec /bin/sleep 60");
    case.until(b"PUMP_READY");
    case.pump
        .send(SessionCommand::WriteBytes(vec![b'x'; 1024 * 1024]))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !case.pump.sender.as_ref().unwrap().is_empty() {
        assert!(
            Instant::now() < deadline,
            "writer did not receive its input"
        );
        thread::yield_now();
    }
    case.pump
        .send(SessionCommand::Write("not-for-a-later-host\n".into()))
        .unwrap();
    assert!(!case.pump.sender.as_ref().unwrap().is_empty());
    case.stop();
    assert!(case
        .pump
        .send(SessionCommand::Write("after-close".into()))
        .is_err());
    assert!(!String::from_utf8_lossy(&case.raw).contains("not-for-a-later-host"));
}
