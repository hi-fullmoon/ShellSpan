//! Live NIP integration: a real GNU Bash/Readline module, socket and PTY.
//! No synthesized lifecycle/readiness/proof events enter the Broker.
use crate::terminal_broker::{
    TerminalCommandState, TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
};
use crate::terminal_command::protocol::{
    self as nip, ConnectionPayload, InputMode, Message, Payload,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

enum Input {
    Private(Vec<u8>),
    Pty(Vec<u8>),
    Stop,
}
struct NativeShell {
    home: tempfile::TempDir,
    broker: TerminalSessionBroker,
    control: UnixStream,
    writer: crossbeam_channel::Sender<Input>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    workers: Vec<thread::JoinHandle<()>>,
    raw: Arc<Mutex<Vec<u8>>>,
    reads: Arc<Mutex<Vec<serde_json::Value>>>,
    received: Vec<u8>,
    evidence: PathBuf,
    decoder: nip::Decoder,
    accept_keys: Arc<AtomicUsize>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    control_id: Option<String>,
    profile: Option<crate::terminal_command::registration::VerifiedNativeProfile>,
    expected_profile_id: String,
}
impl NativeShell {
    fn start(case: &str) -> Self {
        Self::start_for_root(case, None)
    }
    fn start_for_root(case: &str, explicit_root: Option<&std::path::Path>) -> Self {
        Self::start_with_options(case, explicit_root, true)
    }
    fn start_with_options(
        case: &str,
        explicit_root: Option<&std::path::Path>,
        inband: bool,
    ) -> Self {
        Self::start_with_editor(case, explicit_root, inband, true)
    }
    fn start_with_editor(
        case: &str,
        explicit_root: Option<&std::path::Path>,
        inband: bool,
        emacs: bool,
    ) -> Self {
        Self::start_with_manifest(case, explicit_root, inband, emacs, None)
    }
    fn start_with_manifest(
        case: &str,
        explicit_root: Option<&std::path::Path>,
        inband: bool,
        emacs: bool,
        manifest_path: Option<&std::path::Path>,
    ) -> Self {
        Self::start_with_geometry_manifest(
            case,
            explicit_root,
            inband,
            emacs,
            manifest_path,
            100,
            24,
        )
    }
    fn start_with_geometry_manifest(
        case: &str,
        explicit_root: Option<&std::path::Path>,
        inband: bool,
        emacs: bool,
        manifest_path: Option<&std::path::Path>,
        columns: u16,
        rows: u16,
    ) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let selected_manifest = manifest_path.map(std::path::Path::to_path_buf).or_else(|| {
            std::env::var_os("SHELLSPAN_TEST_NATIVE_PROTOCOL_MANIFEST").map(PathBuf::from)
        });
        let manifest_path = selected_manifest.as_deref();
        if let Some(path) = manifest_path {
            assert!(
                path.is_absolute(),
                "Explicit producer manifest must be absolute"
            );
            let metadata = fs::symlink_metadata(path).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
            assert!(metadata.len() <= 1_048_576);
        }
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(
                manifest_path
                    .map(std::path::Path::to_path_buf)
                    .unwrap_or_else(|| {
                        root.join(
                            ".artifacts/tests/native-input-p0/p1-protocol-build/manifest.json",
                        )
                    }),
            )
            .expect("run the NIP source builder"),
        )
        .unwrap();
        use sha2::{Digest, Sha256};
        for (name, expected) in manifest["sources"].as_object().unwrap() {
            assert_eq!(
                hex::encode(Sha256::digest(fs::read(root.join(name)).unwrap())),
                expected.as_str().unwrap(),
                "producer source changed after build: {name}"
            );
        }
        for (name, expected) in manifest["artifacts"].as_object().unwrap() {
            assert_eq!(
                hex::encode(Sha256::digest(fs::read(name).unwrap())),
                expected.as_str().unwrap(),
                "producer artifact changed after build: {name}"
            );
        }
        let profile = crate::terminal_command::registration::VerifiedNativeProfile::verify_local(
            manifest["profile"].as_str().unwrap(),
            std::path::Path::new(manifest["shell"].as_str().unwrap()),
            manifest["artifacts"][manifest["shell"].as_str().unwrap()]
                .as_str()
                .unwrap(),
            std::path::Path::new(manifest["bridge"].as_str().unwrap()),
            manifest["artifacts"][manifest["bridge"].as_str().unwrap()]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let crash_root = explicit_root
            .map(std::path::Path::to_path_buf)
            .or_else(|| std::env::var_os("SHELLSPAN_P1_NATIVE_CRASH_ROOT").map(PathBuf::from));
        let home = tempfile::Builder::new()
            .prefix("ss-nip-")
            .tempdir_in(
                crash_root
                    .as_deref()
                    .unwrap_or(std::path::Path::new("/tmp")),
            )
            .unwrap();
        let evidence = crash_root
            .as_ref()
            .map(|root| root.join("evidence"))
            .unwrap_or_else(|| {
                root.join(if manifest_path.is_some() {
                    ".artifacts/tests/native-input-p2/capture-evidence"
                } else {
                    ".artifacts/tests/native-input-p0/p1-evidence"
                })
            })
            .join(case);
        fs::create_dir_all(&evidence).unwrap();
        let socket = home.path().join("control");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::write(home.path().join(".inputrc"),format!("set editing-mode {}\nset bell-style none\nset convert-meta off\nset input-meta on\n",if emacs {"emacs"} else {"vi"})).unwrap();
        let quote = |value: &str| shlex::try_quote(value).unwrap().into_owned();
        let rc=format!("PS1='NIP> '\nPS2='CONT> '\nHISTFILE=\"$HOME/history\"\nenable -f {} ss_native_input ss_native_input_status ss_native_input_begin ss_native_input_child_closed\nbuiltin ss_native_input {} \"$(trap -p INT)\" \"$BASH_VERSION\"\nPROMPT_COMMAND='builtin ss_native_input_status \"$?\" \"$PWD\"'\ncd \"$HOME\"\n",quote(manifest["bridge"].as_str().unwrap()),quote(socket.to_str().unwrap()));
        let rc = if manifest_path.is_some() {
            format!(
                "{}\ncd \"$HOME\"\n",
                crate::terminal_command::bash::bootstrap_source(
                    std::path::Path::new(manifest["bridge"].as_str().unwrap()),
                    &socket
                )
                .unwrap()
            )
        } else {
            format!("set -o {}\n{rc}", if emacs { "emacs" } else { "vi" })
        };
        fs::write(home.path().join("rc"), rc).unwrap();
        let restart_root = explicit_root.or_else(|| {
            std::env::var_os("SHELLSPAN_P1_NATIVE_CRASH_CUT").and(crash_root.as_deref())
        });
        let broker = if let Some(root) = restart_root {
            TerminalSessionBroker::phase3_with_journal_for_test(65536, &root.join("journal"))
        } else if crash_root.is_some() {
            // Redirecting ordinary test evidence does not turn independent
            // fixtures into the same persisted invocation. Only explicit
            // restart cases above share a journal across processes.
            TerminalSessionBroker::phase3_with_journal_for_test(65536, &home.path().join("journal"))
        } else {
            TerminalSessionBroker::phase3_enabled_for_test(65536)
        };
        broker
            .attach_transport_with_mode(
                "nip",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(columns as u32, rows as u32),
                InputMode::NativeInline,
            )
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut pty_writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new(manifest["shell"].as_str().unwrap());
        command.env_clear();
        command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        if manifest_path.is_some() {
            command.args([
                "--shellspan-native-init",
                home.path().join("rc").to_str().unwrap(),
                "-il",
            ]);
        } else {
            command.args([
                "--noprofile",
                "--rcfile",
                home.path().join("rc").to_str().unwrap(),
                "-i",
            ]);
        }
        command.env("HOME", home.path());
        command.env("TERM", "xterm-256color");
        command.env("LC_ALL", "en_US.UTF-8");
        command.env("SHELLSPAN_NATIVE_INPUT_PROTOCOL", "1");
        command.env("SHELLSPAN_P0_INBAND_REFLOW", if inband { "1" } else { "0" });
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let master = Arc::new(Mutex::new(pair.master));
        let raw = Arc::new(Mutex::new(Vec::new()));
        let reads = Arc::new(Mutex::new(Vec::new()));
        let recorded_reads = reads.clone();
        let read_started = Instant::now();
        let observed = raw.clone();
        let output_broker = broker.clone();
        let sync_each_read = manifest_path.is_none();
        let mut trace = fs::File::create(evidence.join("pty.bin")).unwrap();
        let output = thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                trace.write_all(&bytes[..count]).unwrap();
                if sync_each_read {
                    trace.sync_data().unwrap();
                }
                let mut raw = observed.lock().unwrap();
                let offset = raw.len();
                raw.extend_from_slice(&bytes[..count]);
                recorded_reads.lock().unwrap().push(serde_json::json!({
                    "offset": offset, "length": count,
                    "atMs": read_started.elapsed().as_millis() as u64,
                }));
                drop(raw);
                let _ = output_broker.observe_raw_output("nip", &bytes[..count]);
            }
            trace.sync_data().unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        let control = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "native module did not connect");
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
            }
        };
        control.set_nonblocking(false).unwrap();
        control
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        control
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut socket_writer = control.try_clone().unwrap();
        let (writer, queue) = crossbeam_channel::unbounded();
        let accept_keys = Arc::new(AtomicUsize::new(0));
        let keys = accept_keys.clone();
        let input = thread::spawn(move || {
            while let Ok(input) = queue.recv() {
                match input {
                    Input::Private(bytes) => socket_writer.write_all(&bytes).unwrap(),
                    Input::Pty(bytes) => {
                        pty_writer.write_all(&bytes).unwrap();
                        pty_writer.flush().unwrap();
                        if bytes == b"\x18a" {
                            keys.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Input::Stop => break,
                }
            }
        });
        Self {
            home,
            broker,
            control,
            writer,
            child,
            workers: vec![input, output],
            raw,
            reads,
            received: Vec::new(),
            evidence,
            decoder: nip::Decoder::default(),
            accept_keys,
            master,
            control_id: None,
            profile: Some(profile),
            expected_profile_id: manifest["profile"].as_str().unwrap().to_string(),
        }
    }
    fn send(&self, bytes: &[u8]) {
        self.writer.send(Input::Private(bytes.to_vec())).unwrap();
    }
    fn key(&self, bytes: &[u8]) {
        self.writer.send(Input::Pty(bytes.to_vec())).unwrap();
    }
    fn read(&mut self) -> Vec<u8> {
        let mut bytes = [0; 4096];
        match self.control.read(&mut bytes) {
            Ok(0) => panic!("native control EOF"),
            Ok(count) => {
                self.record_control(&bytes[..count]);
                bytes[..count].to_vec()
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Vec::new()
            }
            Err(error) => panic!("{error}"),
        }
    }
    fn record_control(&mut self, bytes: &[u8]) {
        self.received.extend_from_slice(bytes);
        let mut trace = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.evidence.join("control.bin"))
            .unwrap();
        trace.write_all(bytes).unwrap();
        trace.sync_data().unwrap();
    }
    fn arm(&mut self, coordinator: &mut impl_native::Coordinator) {
        let sender = self.writer.clone();
        coordinator
            .arm_commit(|bytes| {
                sender
                    .send(Input::Private(bytes.to_vec()))
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !coordinator.commit_armed().unwrap() {
            assert!(Instant::now() < deadline);
            let bytes = self.read();
            self.deliver(coordinator, &bytes);
        }
    }
    fn submit(&mut self, coordinator: &impl_native::Coordinator) {
        let sender = self.writer.clone();
        let broker = self.broker.clone();
        coordinator
            .submit(
                || {
                    let caps = broker.execution_capabilities("nip")?;
                    if caps.open && !caps.input_recovery_required {
                        Ok(())
                    } else {
                        Err("native target not ready".into())
                    }
                },
                |key| {
                    sender
                        .send(Input::Pty(key.to_vec()))
                        .map_err(|error| error.to_string())
                },
            )
            .unwrap();
    }
    fn bootstrap(&mut self) {
        if self
            .broker
            .snapshot(Some("nip"))
            .unwrap()
            .session
            .unwrap()
            .integration_state
            != crate::terminal_broker::TerminalIntegrationState::Initializing
        {
            return;
        }
        let request = self
            .broker
            .register_native_channel("nip", self.profile.take().unwrap())
            .unwrap();
        self.control_id = Some(request.connection.control_id.clone());
        self.send(&request.encode().unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < deadline, "native capability timeout");
            let bytes = self.read();
            if let Some(message) = self.decoder.push(&bytes).unwrap().into_iter().next() {
                let Message::Connection(message) = message else {
                    panic!("operation message before any operation was registered");
                };
                self.broker
                    .accept_native_capabilities("nip", &message)
                    .unwrap();
                return;
            }
        }
    }
    fn command(&mut self, source: &str) -> impl_native::Coordinator {
        self.command_as(source, "native-operation")
    }
    fn command_as(&mut self, source: &str, operation: &str) -> impl_native::Coordinator {
        self.command_with_plan(source, operation, &nip::native_bash_plan(source).unwrap())
    }
    fn command_with_plan(
        &mut self,
        source: &str,
        operation: &str,
        plan: &str,
    ) -> impl_native::Coordinator {
        fs::write(self.evidence.join("source.txt"), source).unwrap();
        fs::write(
            self.evidence.join(format!("source-{operation}.txt")),
            source,
        )
        .unwrap();
        self.bootstrap();
        self.broker
            .acquire_agent_lease("nip", "native-agent", "native-task", operation)
            .unwrap();
        self.broker
            .begin_command_with_submission("nip", operation, source, Some(plan))
            .unwrap();
        let coordinator = self
            .broker
            .native_input_coordinator("nip", operation)
            .unwrap();
        assert!(coordinator.capabilities_confirmed().unwrap());
        coordinator
    }
    fn deliver(&mut self, coordinator: &mut impl_native::Coordinator, bytes: &[u8]) {
        for chunk in bytes.chunks(7) {
            for message in self.decoder.push(chunk).unwrap() {
                let message = match message {
                    Message::Connection(message) => {
                        if matches!(
                            message.payload,
                            nip::ConnectionPayload::JobObservation { .. }
                                | nip::ConnectionPayload::Directory { .. }
                        ) {
                            self.broker
                                .accept_native_observation("nip", &message)
                                .unwrap();
                        } else {
                            self.broker
                                .accept_native_readiness("nip", &message)
                                .unwrap();
                        }
                        continue;
                    }
                    Message::Operation(message) => message,
                };
                let current = message.identity == coordinator.identity().unwrap();
                let result = coordinator.receive_envelope(message);
                if current {
                    result.unwrap();
                } else {
                    assert!(result.unwrap_err().contains("IDENTITY_MISMATCH"));
                }
            }
        }
    }
    fn wait(
        &mut self,
        coordinator: &mut impl_native::Coordinator,
        predicate: impl Fn(&crate::terminal_broker::TerminalCommandObservation) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = self.broker.snapshot(Some("nip")).unwrap().session.unwrap();
            if predicate(snapshot.input_observation.active_command.as_ref().unwrap()) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "native lifecycle timeout: {:?}",
                snapshot.input_observation.active_command
            );
            let bytes = self.read();
            self.deliver(coordinator, &bytes);
        }
    }
}
fn production_bash_profiles(
    root: &std::path::Path,
    target: &str,
) -> Vec<crate::terminal_command::artifacts::NativeArtifact> {
    let resources = root.join(".artifacts/tests/native-input-p2/resources/native-input");
    let profiles = crate::terminal_command::artifacts::read_catalogue(&resources, target).unwrap();
    assert!(!profiles.is_empty(), "No native Bash profiles for {target}");
    profiles
}

#[test]
#[ignore = "set SHELLSPAN_NATIVE_BUILD_ROOT=.artifacts/tests and run python3 scripts/native-input-p2/build.py"]
fn native_production_private_widget_restores_real_stream_after_signal_and_control_eof() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let run = uuid::Uuid::new_v4().to_string();
    for artifact in production_bash_profiles(&root, "macos-arm64") {
        let version = artifact.bash_version;
        let manifest = root
            .join(".artifacts/tests/native-input-p2/producers")
            .join(&artifact.id)
            .join("manifest.json");
        for fault in ["normal", "interrupt", "control-eof"] {
            let mut shell = NativeShell::start_with_manifest(
                &format!("{run}/{version}-widget-{fault}"),
                None,
                true,
                true,
                Some(&manifest),
            );
            shell.bootstrap();
            let target = crate::agent_runtime::AgentToolTargetNative::Local {
                target_id: "native-test".into(),
                session_id: "nip".into(),
                cwd: None,
            };
            let source="for ((i=0;i<200;i++)); do printf 'BG_PACKET\\n'; printf 'BG_ERROR\\n' >&2; sleep 0.05; done";
            let job = shell
                .broker
                .prepare_shell_job(
                    "nip",
                    &target,
                    "native-agent",
                    "native-task",
                    "launch",
                    source,
                )
                .unwrap();
            let plan = shell
                .broker
                .native_job_plan("nip", "launch", source, &job.submitted_command_line)
                .unwrap();
            let mut launch = shell.command_with_plan(source, "launch", &plan);
            let sender = shell.writer.clone();
            shell.key(b"\x18\x1e");
            launch
                .prepare(Duration::from_secs(5), true, |bytes| {
                    sender
                        .send(Input::Private(bytes.into()))
                        .map_err(|error| error.to_string())
                })
                .unwrap();
            shell.wait(&mut launch, |view| view.full_input_confirmed);
            shell.arm(&mut launch);
            shell.submit(&launch);
            shell.wait(&mut launch, |view| {
                view.legacy_state == TerminalCommandState::Completed
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !shell
                .broker
                .execution_capabilities("nip")
                .unwrap()
                .prompt_ready
            {
                assert!(Instant::now() < deadline);
                let bytes = shell.read();
                shell.deliver(&mut launch, &bytes);
            }
            assert!(shell
                .broker
                .release_agent_lease("nip", "native-agent", "native-task", "launch")
                .unwrap());
            shell
                .broker
                .retire_command("nip", &launch.operation.command_id().unwrap())
                .unwrap();
            let fresh = shell
                .broker
                .shell_job(
                    &job.process_handle,
                    "native-test",
                    "native-agent",
                    "native-task",
                )
                .unwrap();
            assert_eq!(fresh.native_active, Some(true));
            let line = shell
                .broker
                .prepare_shell_job_control(&fresh, "query", false)
                .unwrap();
            let plan = shell
                .broker
                .native_job_plan("nip", "query", &line, &line)
                .unwrap();
            let mut control = shell.command_with_plan(&line, "query", &plan);
            let sender = shell.writer.clone();
            shell.key(b"\x18\x1e");
            control
                .prepare(Duration::from_secs(5), true, |bytes| {
                    sender
                        .send(Input::Private(bytes.into()))
                        .map_err(|error| error.to_string())
                })
                .unwrap();
            shell.wait(&mut control, |view| view.full_input_confirmed);
            let fifo = shell
                .home
                .path()
                .join(format!("control.job.{}.running", job.process_handle));
            let mut fifo_guard = None;
            if fault != "normal" {
                use std::os::unix::ffi::OsStrExt;
                use std::os::unix::fs::OpenOptionsExt;
                if fifo.exists() {
                    fs::remove_file(&fifo).unwrap();
                }
                let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
                assert_eq!(
                    unsafe { libc::mkfifo(path.as_ptr(), 0o600) },
                    0,
                    "{}",
                    std::io::Error::last_os_error()
                );
                // Keep a real writer alive: jobs emits its PID normally, then
                // the read builtin blocks awaiting EOF. Ctrl-C exercises the
                // real interrupt_immediately unwind, not a second FIFO open.
                fifo_guard = Some(
                    fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .custom_flags(libc::O_NONBLOCK)
                        .open(&fifo)
                        .unwrap(),
                );
            }
            shell.arm(&mut control);
            shell.submit(&control);
            shell.wait(&mut control, |view| {
                matches!(
                    view.phase,
                    crate::terminal_command::state::CommandPhase::Running
                        | crate::terminal_command::state::CommandPhase::Completed
                )
            });
            if fault == "normal" {
                shell.wait(&mut control, |view| {
                    view.legacy_state == TerminalCommandState::Completed
                });
                assert!(control
                    .operation
                    .wait_native_capture(Duration::from_secs(5))
                    .unwrap());
                // Concurrent program output remains real result data. Only
                // these actual packets may occur; no widget clear/redraw or
                // private command text is allowed in the captured region.
                assert!(control
                    .operation
                    .snapshot()
                    .unwrap()
                    .combined_output
                    .split_inclusive("\r\n")
                    .all(|line| matches!(line, "BG_PACKET\r\n" | "BG_ERROR\r\n")));
            } else {
                let before = shell.raw.lock().unwrap().len();
                // A real FIFO open holds the fixed helper inside bind-x. Its
                // already-running background process must remain audible.
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    let raw = shell.raw.lock().unwrap();
                    if raw[before..]
                        .windows(b"BG_PACKET\r\nBG_ERROR".len())
                        .any(|bytes| bytes == b"BG_PACKET\r\nBG_ERROR")
                    {
                        break;
                    }
                    drop(raw);
                    assert!(
                        Instant::now() < deadline,
                        "cookie sink muted real background stdout/stderr"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                assert_ne!(
                    control.operation.snapshot().unwrap().state,
                    TerminalCommandState::Completed
                );
                if fault == "control-eof" {
                    shell.control.shutdown(std::net::Shutdown::Both).unwrap();
                    control.control_closed().unwrap();
                }
                shell.key(b"\x03");
            }
            // These are physical PTY observations after a fault, not authority
            // to resume the recovery-gated backend operation. No receipt is
            // manufactured. The next real keystrokes must echo before Enter.
            let offset = shell.raw.lock().unwrap().len();
            shell.key(b"printf USER_RESTORED; printf USER_ERROR >&2; (/bin/echo CHILD_OUT; /bin/echo CHILD_ERR >&2); builtin kill %1");
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let raw = shell.raw.lock().unwrap();
                if raw[offset..]
                    .windows(b"kill %1".len())
                    .any(|bytes| bytes == b"kill %1")
                {
                    break;
                }
                drop(raw);
                if Instant::now() >= deadline {
                    let _ = std::process::Command::new("/usr/bin/sample")
                        .args([
                            &shell.child.process_id().unwrap().to_string(),
                            "1",
                            "1",
                            "-file",
                            shell
                                .evidence
                                .join("blocked-shell.sample.txt")
                                .to_str()
                                .unwrap(),
                        ])
                        .output();
                    let metadata = std::process::Command::new("/bin/ps")
                        .args([
                            "-o",
                            "pid,pgid,tpgid,state,wchan,command",
                            "-p",
                            &shell.child.process_id().unwrap().to_string(),
                        ])
                        .output()
                        .unwrap();
                    fs::write(
                        shell.evidence.join("blocked-shell-process.txt"),
                        metadata.stdout,
                    )
                    .unwrap();
                }
                assert!(
                    Instant::now() < deadline,
                    "next real user keystrokes lost their echo after {version}/{fault}"
                );
                thread::sleep(Duration::from_millis(5));
            }
            let output_offset = shell.raw.lock().unwrap().len();
            shell.key(b"\r");
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let raw = shell.raw.lock().unwrap();
                let visible = String::from_utf8_lossy(&raw[output_offset..]);
                let mut remaining = visible.as_ref();
                let mut complete = true;
                for token in [
                    "USER_RESTORED",
                    "USER_ERROR",
                    "CHILD_OUT\r\n",
                    "CHILD_ERR\r\n",
                ] {
                    if let Some(at) = remaining.find(token) {
                        remaining = &remaining[at + token.len()..];
                    } else {
                        complete = false;
                        break;
                    }
                }
                if complete {
                    break;
                }
                drop(raw);
                assert!(
                    Instant::now() < deadline,
                    "real parent/child stdout/stderr missing after {version}/{fault}"
                );
                thread::sleep(Duration::from_millis(5));
            }
            if fault != "normal" {
                drop(fifo_guard);
                fs::remove_file(fifo).unwrap();
            }
            let foreground_offset = shell.raw.lock().unwrap().len();
            shell.key(b"printf '%s%s\\n' FOREGROUND_ STARTED; /bin/sleep 30\r");
            let deadline = Instant::now() + Duration::from_secs(5);
            let parent_pid = shell.child.process_id().unwrap() as libc::pid_t;
            loop {
                let fd = shell.master.lock().unwrap().as_raw_fd().unwrap();
                let foreground = unsafe { libc::tcgetpgrp(fd) };
                let output = shell.raw.lock().unwrap();
                if foreground > 0
                    && foreground != parent_pid
                    && output[foreground_offset..]
                        .windows(b"FOREGROUND_STARTED\r\n".len())
                        .any(|bytes| bytes == b"FOREGROUND_STARTED\r\n")
                {
                    break;
                }
                drop(output);
                assert!(
                    Instant::now() < deadline,
                    "real foreground program did not acquire the terminal"
                );
                thread::sleep(Duration::from_millis(5));
            }
            shell.key(b"\x03");
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let fd = shell.master.lock().unwrap().as_raw_fd().unwrap();
                if unsafe { libc::tcgetpgrp(fd) } == parent_pid {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "subsequent foreground Ctrl-C was broken by widget signal restoration"
                );
                thread::sleep(Duration::from_millis(5));
            }
            let status_offset = shell.raw.lock().unwrap().len();
            shell.key(b"printf 'FOLLOWING_STATUS=%s\\n' \"$?\"; builtin trap -p INT; printf '%s%s\\n' DEFAULT_INT_ RESTORED\r");
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let raw = shell.raw.lock().unwrap();
                let output = String::from_utf8_lossy(&raw[status_offset..]);
                if output.contains("FOLLOWING_STATUS=130\r\n")
                    && output.contains("DEFAULT_INT_RESTORED\r\n")
                {
                    assert!(
                        !output.contains("trap --"),
                        "widget changed the user's default INT trap"
                    );
                    break;
                }
                drop(raw);
                assert!(
                    Instant::now() < deadline,
                    "subsequent real SIGINT status/echo was not preserved after {version}/{fault}"
                );
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}
// The type is private to the Broker module; this alias exposes no new writer.
#[test]
#[ignore = "set SHELLSPAN_NATIVE_BUILD_ROOT=.artifacts/tests and run python3 scripts/native-input-p2/build.py"]
fn native_production_geometry_unicode_and_real_resize() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let run = uuid::Uuid::new_v4().to_string();
    let mut entries = Vec::new();
    for artifact in production_bash_profiles(&root, "macos-arm64") {
        let version = artifact.bash_version;
        let manifest = root
            .join(".artifacts/tests/native-input-p2/producers")
            .join(&artifact.id)
            .join("manifest.json");
        for columns in [32, 40, 100, 180] {
            for (size, repeats) in [("normal", 6), ("oversize", 200)] {
                let case = format!("{run}/{version}-{columns}-{size}");
                let mut shell = NativeShell::start_with_geometry_manifest(
                    &case,
                    None,
                    true,
                    true,
                    Some(&manifest),
                    columns,
                    12,
                );
                let background = size == "oversize"
                    && std::env::var_os("SHELLSPAN_P2_GEOMETRY_BACKGROUND").is_some();
                let background_line = "P2-RESIZE-BG:中文 é 👩‍💻";
                if background {
                    shell.bootstrap();
                    let command = concat!(
                        "( : > \"$HOME/geometry-bg-ready\"; ",
                        "for ((i=0;i<300;i++)); do [[ -f $HOME/geometry-bg-print ]] && break; sleep 0.02; done; ",
                        "if [[ -f $HOME/geometry-bg-print ]]; then printf '%s%s\\n' 'P2-RESIZE-' 'BG:中文 é 👩‍💻'; fi; ",
                        "for ((i=0;i<300;i++)); do [[ -f $HOME/geometry-bg-stop ]] && break; sleep 0.02; done; ",
                        ": > \"$HOME/geometry-bg-stopped\" ) &\r"
                    );
                    shell.key(command.as_bytes());
                    let deadline = Instant::now() + Duration::from_secs(3);
                    while !shell.home.path().join("geometry-bg-ready").exists() {
                        assert!(
                            Instant::now() < deadline,
                            "actual background process did not start"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                }
                let history_end = (columns == 100
                    && size == "oversize"
                    && std::env::var_os("SHELLSPAN_P2_GEOMETRY_HISTORY").is_some())
                .then(|| {
                    shell.bootstrap();
                    shell.key(b"for ((n=1;n<=80;n++)); do printf '%s%02d %s\\n' BASH_HISTORY_ \"$n\" 'retained output'; done\r");
                    let marker = b"BASH_HISTORY_80 retained output\r\n";
                    let deadline = Instant::now() + Duration::from_secs(3);
                    loop {
                        let raw = shell.raw.lock().unwrap();
                        if let Some(start) = raw.windows(marker.len()).position(|bytes| bytes == marker) {
                            break start + marker.len();
                        }
                        drop(raw);
                        assert!(Instant::now() < deadline, "actual Bash history did not arrive");
                        thread::sleep(Duration::from_millis(5));
                    }
                });
                let resize = |shell: &NativeShell, cols, rows| {
                    let master = shell.master.lock().unwrap();
                    master
                        .resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        })
                        .unwrap();
                    let observed = master.get_size().unwrap();
                    assert_eq!((observed.cols, observed.rows), (cols, rows));
                };
                let source = format!("printf '%s\\n' '{}'", "中文 é 👩‍💻 width ".repeat(repeats));
                let mut coordinator = shell.command(&source);
                let sender = shell.writer.clone();
                shell.key(b"\x18\x1e");
                coordinator
                    .prepare(Duration::from_secs(5), false, |bytes| {
                        sender
                            .send(Input::Private(bytes.into()))
                            .map_err(|error| error.to_string())
                    })
                    .unwrap();
                let wait_progress = |shell: &mut NativeShell,
                                     coordinator: &mut impl_native::Coordinator,
                                     previous| {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    loop {
                        let bytes = shell.read();
                        shell.deliver(coordinator, &bytes);
                        let raw = shell.raw.lock().unwrap();
                        let on = b"\x1b]1337;SetUserVar=ShellSpanNativeInput=MQ==\x07";
                        if let Some(at) = raw.windows(on.len()).position(|window| window == on) {
                            let prefix = &raw[at + on.len()..];
                            let applied = std::str::from_utf8(prefix)
                                .map_or_else(|error| error.valid_up_to(), str::len);
                            if applied > previous && applied < source.len() {
                                assert!(
                                    source.as_bytes().starts_with(&prefix[..applied]),
                                    "actual source append changed before complete proof"
                                );
                                return (applied, raw.len());
                            }
                        }
                        drop(raw);
                        assert!(Instant::now() < deadline, "native partial progress missing");
                    }
                };
                // This conservative byte threshold exceeds several physical
                // rows for the frozen mixed-width sequence. The browser also
                // proves its actual public selection already crosses wrapped
                // rows before applying this recorded resize boundary.
                let threshold = if size == "oversize" {
                    columns as usize * 8
                } else {
                    0
                };
                let (before, first_offset) = wait_progress(&mut shell, &mut coordinator, threshold);
                let narrow = if columns == 32 { 40 } else { 32 };
                resize(&shell, narrow, 8);
                let (after, mut second_offset) =
                    wait_progress(&mut shell, &mut coordinator, before);
                assert!(
                    after > before && second_offset > first_offset,
                    "input did not advance at the changed PTY size"
                );
                let mut background_offset = None;
                if background {
                    let packet = format!("{background_line}\r\n");
                    fs::write(shell.home.path().join("geometry-bg-print"), []).unwrap();
                    let deadline = Instant::now() + Duration::from_secs(2);
                    loop {
                        let raw = shell.raw.lock().unwrap();
                        if let Some(offset) = raw[second_offset..]
                            .windows(packet.len())
                            .position(|bytes| bytes == packet.as_bytes())
                        {
                            background_offset = Some(second_offset + offset);
                            second_offset = raw.len();
                            break;
                        }
                        drop(raw);
                        assert!(
                            Instant::now() < deadline,
                            "actual background output did not arrive during resize"
                        );
                        let bytes = shell.read();
                        shell.deliver(&mut coordinator, &bytes);
                        let session = shell.broker.snapshot(Some("nip")).unwrap().session.unwrap();
                        assert!(
                            !session
                                .input_observation
                                .active_command
                                .unwrap()
                                .full_input_confirmed,
                            "input finished before the actual background output"
                        );
                    }
                }
                resize(&shell, columns, 12);
                shell.wait(&mut coordinator, |view| view.full_input_confirmed);
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    if shell
                        .raw
                        .lock()
                        .unwrap()
                        .ends_with(&source.as_bytes()[source.len() - 32..])
                    {
                        break;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "PTY source display did not finish"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                fs::write(
                    shell.evidence.join("typed-pty.bin"),
                    &*shell.raw.lock().unwrap(),
                )
                .unwrap();
                let metadata = serde_json::json!({"version":version,"columns":columns,"rows":12,"size":size,"source":source,"directory":shell.evidence,"actualResize":true,"fullInputConfirmed":true,"prefixBeforeFirstResize":&source[..before],"background":background_offset.map(|offset| serde_json::json!({"offset":offset,"line":background_line})),"historyEnd":history_end,"readEvents":shell.reads.lock().unwrap().clone(),"resizeEvents":[{"offset":first_offset,"columns":narrow,"rows":8,"appliedUtf8Bytes":before},{"offset":second_offset,"columns":columns,"rows":12,"appliedUtf8Bytes":after}]});
                fs::write(
                    shell.evidence.join("geometry.json"),
                    serde_json::to_vec_pretty(&metadata).unwrap(),
                )
                .unwrap();
                entries.push(metadata);
                shell.arm(&mut coordinator);
                shell.submit(&coordinator);
                shell.wait(&mut coordinator, |view| {
                    view.legacy_state == TerminalCommandState::Completed
                });
                assert!(coordinator
                    .operation
                    .wait_native_capture(Duration::from_secs(5))
                    .unwrap());
                assert_eq!(
                    coordinator.operation.snapshot().unwrap().combined_output,
                    format!("{}\r\n", "中文 é 👩‍💻 width ".repeat(repeats))
                );
                assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 1);
                if background {
                    fs::write(shell.home.path().join("geometry-bg-stop"), []).unwrap();
                    let deadline = Instant::now() + Duration::from_secs(2);
                    while !shell.home.path().join("geometry-bg-stopped").exists() {
                        assert!(
                            Instant::now() < deadline,
                            "actual background process did not terminate"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        }
        let mut shell = NativeShell::start_with_manifest(
            &format!("{run}/{version}-special"),
            None,
            true,
            true,
            Some(&manifest),
        );
        let source = concat!(
            "printf '%s\\n' 'tab\tcarriage\rbang! \"quote\" 中é👩‍💻'\n",
            "printf '%s\\n' SECOND_LINE\n",
            "/bin/cat <<'SHELLSPAN_HERE'\n",
            "BASH-HERE:$HOME ! 中é👩‍💻\n",
            "SHELLSPAN_HERE"
        );
        let mut coordinator = shell.command(source);
        let sender = shell.writer.clone();
        shell.key(b"\x18\x1e");
        coordinator
            .prepare(Duration::from_secs(5), false, |bytes| {
                sender
                    .send(Input::Private(bytes.into()))
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        shell.wait(&mut coordinator, |view| view.full_input_confirmed);
        shell.arm(&mut coordinator);
        shell.submit(&coordinator);
        shell.wait(&mut coordinator, |view| {
            view.legacy_state == TerminalCommandState::Completed
        });
        assert!(coordinator
            .operation
            .wait_native_capture(Duration::from_secs(5))
            .unwrap());
        assert_eq!(
            coordinator.operation.snapshot().unwrap().combined_output,
            "tab\tcarriage\rbang! \"quote\" 中é👩‍💻\r\nSECOND_LINE\r\nBASH-HERE:$HOME ! 中é👩‍💻\r\n"
        );
    }
    let summary = root
        .join(".artifacts/tests/native-input-p2/capture-evidence")
        .join(run)
        .join("geometry-summary.json");
    fs::write(&summary, serde_json::to_vec_pretty(&entries).unwrap()).unwrap();
    fs::write(
        root.join(".artifacts/tests/native-input-p2/latest-geometry.json"),
        serde_json::to_vec(&serde_json::json!({"summary":summary})).unwrap(),
    )
    .unwrap();
}
mod impl_native {
    pub(super) type Coordinator = crate::terminal_broker::NativeInputCoordinator;
}

#[test]
#[ignore = "exports typed production inputs for the owned Linux PTY geometry harness"]
fn native_linux_geometry_inputs() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let artifacts = production_bash_profiles(&root, "linux-aarch64-glibc-2.36");
    let run = uuid::Uuid::new_v4().to_string();
    let output = root
        .join(".artifacts/tests/native-input-p2/linux-geometry")
        .join(&run);
    fs::create_dir_all(&output).unwrap();
    let mut entries = Vec::new();
    for artifact in artifacts {
        for columns in [32, 40, 100, 180] {
            let case = format!("{}-{columns}-oversize", artifact.bash_version);
            let host = output.join(&case);
            let linux =
                format!("/work/.artifacts/tests/native-input-p2/linux-geometry/{run}/{case}");
            fs::create_dir_all(&host).unwrap();
            let socket = format!(
                "/tmp/ss-lg-{}/control",
                &uuid::Uuid::new_v4().simple().to_string()[..16]
            );
            let module = format!(
                "/work/.artifacts/tests/native-input-p2/resources/native-input/{}",
                artifact.module
            );
            let bootstrap = crate::terminal_command::bash::bootstrap_source(
                std::path::Path::new(&module),
                std::path::Path::new(&socket),
            )
            .unwrap();
            fs::write(host.join("native-init"), bootstrap).unwrap();
            let opaque = uuid::Uuid::new_v4().simple().to_string();
            let identity = nip::Identity {
                terminal_session_id: format!("linux-{opaque}"),
                terminal_generation: 1,
                lease_id: format!("lease-{opaque}"),
                lease_generation: 1,
                agent_session_id: format!("component-{opaque}"),
                task_id: format!("geometry-{opaque}"),
                operation_id: format!("operation-{opaque}"),
                command_id: format!("command-{opaque}"),
                source_revision: 1,
            };
            let connection = nip::ConnectionIdentity {
                terminal_session_id: identity.terminal_session_id.clone(),
                terminal_generation: 1,
                control_id: format!("control-{opaque}"),
            };
            let probe = nip::ConnectionEnvelope {
                protocol: nip::PROTOCOL.into(),
                request_id: format!("probe-{opaque}"),
                connection,
                payload: nip::ConnectionPayload::Probe,
            };
            let source = format!("printf '%s\\n' '{}'", "中文 é 👩‍💻 width ".repeat(200));
            let plan = nip::native_bash_plan(&source).unwrap();
            let plan_digest = nip::bound_plan_digest(&nip::sha(&source), &plan);
            let prepare = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                identity: identity.clone(),
                request_id: format!("prepare-{opaque}"),
                payload: nip::Payload::PrepareInput {
                    job: None,
                    source: source.clone(),
                    source_digest: nip::sha(&source),
                    plan: plan.clone(),
                    plan_digest: plan_digest.clone(),
                    budget_ms: 5000,
                    reduced_motion: false,
                },
            };
            let arm = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                identity,
                request_id: format!("commit-{opaque}"),
                payload: nip::Payload::Commit {
                    source_digest: nip::sha(&source),
                    plan_digest,
                },
            };
            probe.validate().unwrap();
            prepare.validate().unwrap();
            arm.validate().unwrap();
            entries.push(serde_json::json!({"version":artifact.bash_version,"profile":artifact.id,"columns":columns,"rows":12,"hostDirectory":host,"linuxDirectory":linux,"socket":socket,"module":module,"moduleSha256":artifact.module_sha256,"shell":artifact.build_shell,"shellSha256":artifact.shell_sha256,"source":source,"probe":probe,"prepare":prepare,"arm":arm}));
        }
    }
    let inputs = output.join("inputs.json");
    let mut widgets = Vec::new();
    for entry in entries.iter().filter(|entry| entry["columns"] == 100) {
        let mut widget = entry.clone();
        let host = PathBuf::from(format!(
            "{}-widget",
            entry["hostDirectory"].as_str().unwrap()
        ));
        let linux = format!("{}-widget", entry["linuxDirectory"].as_str().unwrap());
        fs::create_dir_all(&host).unwrap();
        let socket = format!(
            "/tmp/ss-lw-{}/control",
            &uuid::Uuid::new_v4().simple().to_string()[..16]
        );
        fs::write(
            host.join("native-init"),
            crate::terminal_command::bash::bootstrap_source(
                std::path::Path::new(entry["module"].as_str().unwrap()),
                std::path::Path::new(&socket),
            )
            .unwrap(),
        )
        .unwrap();
        let mut probe: nip::ConnectionEnvelope =
            serde_json::from_value(entry["probe"].clone()).unwrap();
        probe.connection.terminal_session_id.push_str("-widget");
        probe.connection.control_id.push_str("-widget");
        probe.request_id.push_str("-widget");
        let template: nip::Envelope = serde_json::from_value(entry["prepare"].clone()).unwrap();
        let handle = format!("job-{}", uuid::Uuid::new_v4().simple());
        let launch="for ((i=0;i<200;i++)); do printf 'BG_PACKET\\n'; printf 'BG_ERROR\\n' >&2; sleep 0.05; done";
        widget["source"] = serde_json::json!(launch);
        let packets = |step: &str, source: &str, job: nip::JobExecution, generation: u64| {
            let mut identity = template.identity.clone();
            identity.terminal_session_id = probe.connection.terminal_session_id.clone();
            identity.lease_generation = generation;
            identity.operation_id.push_str(step);
            identity.command_id.push_str(step);
            let plan = nip::native_bash_job_plan(source, &job).unwrap();
            let digest = nip::bound_plan_digest(&nip::sha(source), &plan);
            let prepare = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                identity: identity.clone(),
                request_id: format!("prepare-{step}-{}", uuid::Uuid::new_v4().simple()),
                payload: nip::Payload::PrepareInput {
                    job: Some(job),
                    source: source.into(),
                    source_digest: nip::sha(source),
                    plan: plan.clone(),
                    plan_digest: digest.clone(),
                    budget_ms: 5000,
                    reduced_motion: true,
                },
            };
            let arm = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                identity,
                request_id: format!("commit-{step}-{}", uuid::Uuid::new_v4().simple()),
                payload: nip::Payload::Commit {
                    source_digest: nip::sha(source),
                    plan_digest: digest,
                },
            };
            prepare.validate().unwrap();
            arm.validate().unwrap();
            serde_json::json!({"prepare":prepare,"arm":arm})
        };
        let launched = packets(
            "launch",
            launch,
            nip::JobExecution::Launch {
                handle: handle.clone(),
            },
            1,
        );
        let line = crate::terminal_jobs::control_submission(
            &handle,
            crate::terminal_integration::TerminalShellKind::Bash,
            false,
        )
        .unwrap();
        let normal = packets(
            "normal",
            &line,
            nip::JobExecution::Control {
                handle: handle.clone(),
                stop: false,
                nonce: uuid::Uuid::new_v4().simple().to_string(),
            },
            2,
        );
        let fault = packets(
            "fault",
            &line,
            nip::JobExecution::Control {
                handle: handle.clone(),
                stop: false,
                nonce: uuid::Uuid::new_v4().simple().to_string(),
            },
            3,
        );
        widget["hostDirectory"] = serde_json::json!(host);
        widget["linuxDirectory"] = serde_json::json!(linux);
        widget["socket"] = serde_json::json!(socket);
        widget["probe"] = serde_json::json!(probe);
        widget["prepare"] = launched["prepare"].clone();
        widget["arm"] = launched["arm"].clone();
        widget["normal"] = normal.clone();
        widget["fault"] = fault.clone();
        widget["handle"] = serde_json::json!(handle);
        widget["validIdentities"] = serde_json::json!([
            launched["prepare"]["identity"],
            normal["prepare"]["identity"],
            fault["prepare"]["identity"]
        ]);
        widgets.push(widget);
    }
    fs::write(
        output.join("widget-inputs.json"),
        serde_json::to_vec_pretty(&widgets).unwrap(),
    )
    .unwrap();
    fs::write(&inputs, serde_json::to_vec_pretty(&entries).unwrap()).unwrap();
    fs::write(root.join(".artifacts/tests/native-input-p2/linux-geometry-inputs.json"),serde_json::to_vec(&serde_json::json!({"inputs":inputs,"linuxInputs":format!("/work/.artifacts/tests/native-input-p2/linux-geometry/{run}/inputs.json")})).unwrap()).unwrap();
}

#[test]
#[ignore = "set SHELLSPAN_NATIVE_BUILD_ROOT=.artifacts/tests and run python3 scripts/native-input-p2/build.py"]
fn native_production_capture_preserves_real_output_and_bounds_osc_across_all_splits() {
    use crate::terminal_command::capture::CaptureFence;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let mut summary = Vec::new();
    let run_id = uuid::Uuid::new_v4().to_string();
    for artifact in production_bash_profiles(&root, "macos-arm64") {
        let version = artifact.bash_version;
        let profile = artifact.id;
        let manifest = root
            .join(".artifacts/tests/native-input-p2/producers")
            .join(&profile)
            .join("manifest.json");
        let ordinary = b"x\xe4\xb8\xad\x1b]133;C\x07ss_native_input_begin NIP> ";
        let ordinary_source = "printf 'x中\\033]133;C\\007ss_native_input_begin NIP> '";
        for (case, source, expected) in [
            ("empty", ":", Vec::new()),
            ("short", ordinary_source, ordinary.to_vec()),
            (
                "large-osc",
                "printf '\\033]1337;'; printf '%1500000s' X; printf '\\007END'",
                {
                    let mut bytes = b"\x1b]1337;".to_vec();
                    bytes.extend(std::iter::repeat_n(b' ', 1499999));
                    bytes.extend_from_slice(b"X\x07END");
                    bytes
                },
            ),
            (
                "unfinished-osc",
                "printf '\\033]1337;'; printf '%1500000s' X",
                {
                    let mut bytes = b"\x1b]1337;".to_vec();
                    bytes.extend(std::iter::repeat_n(b' ', 1499999));
                    bytes.push(b'X');
                    bytes
                },
            ),
        ] {
            let mut shell = NativeShell::start_with_manifest(
                &format!("{run_id}/{version}-{case}"),
                None,
                true,
                true,
                Some(&manifest),
            );
            let mut coordinator = shell.command(source);
            let sender = shell.writer.clone();
            let mut request_id = String::new();
            shell.key(b"\x18\x1e");
            coordinator
                .prepare(Duration::from_secs(5), true, |bytes| {
                    let message: nip::Envelope = serde_json::from_slice(bytes).unwrap();
                    request_id = message.request_id;
                    sender
                        .send(Input::Private(bytes.into()))
                        .map_err(|error| error.to_string())
                })
                .unwrap();
            shell.wait(&mut coordinator, |view| view.full_input_confirmed);
            shell.arm(&mut coordinator);
            shell.submit(&coordinator);
            shell.wait(&mut coordinator, |view| {
                view.legacy_state == TerminalCommandState::Completed
            });
            assert!(
                coordinator
                    .operation
                    .wait_native_capture(Duration::from_secs(5))
                    .unwrap(),
                "{version}/{case}: PTY fence did not arrive after the independent private receipt"
            );
            let snapshot = coordinator.operation.snapshot().unwrap();
            assert_eq!(
                snapshot.combined_output.as_bytes(),
                &expected[..expected.len().min(65536)],
                "{version}/{case}"
            );
            assert_eq!(snapshot.capture_truncated, expected.len() > 65536);
            assert_eq!(snapshot.exit_code, Some(0));
            let raw = shell.raw.lock().unwrap().clone();
            for chunk_size in [1, 2, 3, 7, 31, 97, 4096, 65536, raw.len()] {
                let mut capture = CaptureFence::new(&request_id);
                let mut output = Vec::new();
                for chunk in raw.chunks(chunk_size) {
                    output.extend(capture.push(chunk));
                }
                assert!(capture.complete(), "{version}/{case}/{chunk_size}");
                assert_eq!(
                    output, expected,
                    "real raw replay at {version}/{case}/{chunk_size}"
                );
            }
            // Exercise every EOF byte of the real end marker, including short
            // stdout still held in the bounded lookbehind. No control receipt
            // or PTY output is fabricated for this result-parser replay.
            let end = nip::capture_marker(&request_id, true);
            let end_at = raw
                .windows(end.len())
                .position(|window| window == end)
                .unwrap();
            for cut in 0..end.len() {
                let mut capture = CaptureFence::new(&request_id);
                let mut output = capture.push(&raw[..end_at + cut]);
                output.extend(capture.finish_incomplete());
                let mut observed = expected.clone();
                observed.extend_from_slice(&end[..cut]);
                assert_eq!(
                    output, observed,
                    "incomplete end must preserve observed bytes: {version}/{case}/{cut}"
                );
                assert!(!capture.complete());
            }
            summary.push(serde_json::json!({"profile":profile,"case":case,"rawBytes":raw.len(),"outputBytes":expected.len(),"resultTruncated":snapshot.capture_truncated,"parserStackBytes":std::mem::size_of::<CaptureFence>()}));
            assert!(
                std::mem::size_of::<CaptureFence>() < 8192,
                "parser must use fixed capacity OSC storage"
            );
        }
        let mut shell = NativeShell::start_with_manifest(
            &format!("{run_id}/{version}-exec-eof"),
            None,
            true,
            true,
            Some(&manifest),
        );
        let mut coordinator = shell.command("exec /bin/sh -c 'printf z; exit 7'");
        let sender = shell.writer.clone();
        shell.key(b"\x18\x1e");
        coordinator
            .prepare(Duration::from_secs(5), true, |bytes| {
                sender
                    .send(Input::Private(bytes.into()))
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        shell.wait(&mut coordinator, |view| view.full_input_confirmed);
        shell.arm(&mut coordinator);
        shell.submit(&coordinator);
        let deadline = Instant::now() + Duration::from_secs(5);
        while shell.child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        shell.workers.remove(1).join().unwrap();
        shell
            .broker
            .close_transport(
                "nip",
                crate::terminal_broker::TerminalGenerationCloseReason::RemoteExit,
            )
            .unwrap();
        let snapshot = coordinator.operation.snapshot().unwrap();
        assert_eq!(
            snapshot.combined_output, "z",
            "exec/EOF lost real short output"
        );
        assert!(snapshot.capture_truncated && snapshot.no_auto_replay);
        assert_eq!(snapshot.state, TerminalCommandState::Uncertain);
    }
    fs::write(
        root.join(".artifacts/tests/native-input-p2/capture-evidence")
            .join(&run_id)
            .join("summary.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )
    .unwrap();
}
impl Drop for NativeShell {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = self.writer.send(Input::Stop);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
        fs::write(self.evidence.join("pty.bin"), &*self.raw.lock().unwrap()).unwrap();
        fs::write(self.evidence.join("control.bin"), &self.received).unwrap();
    }
}

#[test]
#[ignore = "requires the pinned NIP native producer; run pnpm test:terminal-input:p1"]
fn native_protocol_real_bash_commit_and_duplicate_fence() {
    let mut shell = NativeShell::start("commit");
    assert_eq!(
        shell
            .broker
            .register_integration_channel(
                "nip",
                "legacy-control",
                crate::terminal_integration::TerminalShellKind::Bash
            )
            .unwrap_err(),
        "TERMINAL_NATIVE_MODE_NOT_LEGACY"
    );
    let source = "printf 'NIP_OUTPUT\\n'\nprintf ONCE >> \"$HOME/effect\"\n: '中文🙂'";
    let mut coordinator = shell.command(source);
    let initial = shell.broker.snapshot(Some("nip")).unwrap().session.unwrap();
    assert_eq!(initial.input_mode, InputMode::NativeInline);
    let accepted = initial
        .native_peer_profile
        .expect("accepted private peer profile missing from read-only snapshot");
    assert_eq!(accepted.shell, nip::ShellFamily::Bash);
    assert_eq!(
        accepted.verified_profile_id.as_deref(),
        Some(shell.expected_profile_id.as_str())
    );
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    shell
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows: 24,
            cols: 32,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    shell
        .broker
        .resize("nip", TerminalGeometry::new(32, 24))
        .unwrap();
    shell.arm(&mut coordinator);
    shell.submit(&coordinator);
    shell.wait(&mut coordinator, |view| {
        view.legacy_state == TerminalCommandState::Completed
    });
    assert_eq!(fs::read(shell.home.path().join("effect")).unwrap(), b"ONCE");
    assert!(coordinator
        .submit(
            || panic!("duplicate submission reached final preflight"),
            |_| panic!("duplicate executable enqueue")
        )
        .is_err());
    assert!(shell.broker.unresolved_submissions().unwrap().is_empty());
    thread::sleep(Duration::from_millis(50));
    let raw = shell.raw.lock().unwrap();
    assert!(!raw
        .windows(b"p0_begin".len())
        .any(|window| window == b"p0_begin"));
    assert!(raw
        .windows(nip::DISPLAY_ENTER.len())
        .any(|window| window == nip::DISPLAY_ENTER.as_bytes()));
    assert!(raw
        .windows(nip::DISPLAY_EXIT.len())
        .any(|window| window == nip::DISPLAY_EXIT.as_bytes()));
    assert!(!raw
        .windows(b"ss_native_input_begin".len())
        .any(|window| window == b"ss_native_input_begin"));
}

#[test]
#[ignore = "requires the pinned NIP native producer; run pnpm test:terminal-input:p1"]
fn native_protocol_real_queries_do_not_exhaust_cancellation() {
    let mut shell = NativeShell::start("queries-cancel");
    let source = "printf forbidden >> \"$HOME/effect\"; : 'owned draft 中文'";
    let mut coordinator = shell.command(source);
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    let mut replies = nip::Decoder::default();
    for _ in 0..12 {
        let mut batch = Vec::new();
        for _ in 0..25 {
            batch.extend(coordinator.query().unwrap());
        }
        shell.send(&batch);
        let mut count = 0;
        let deadline = Instant::now() + Duration::from_secs(2);
        while count < 25 {
            assert!(Instant::now() < deadline, "native query batch stalled");
            let bytes = shell.read();
            for message in replies
                .push(&bytes)
                .unwrap()
                .into_iter()
                .filter_map(Message::into_operation)
            {
                if matches!(message.payload, Payload::Snapshot { .. }) {
                    count += 1;
                }
            }
            shell.deliver(&mut coordinator, &bytes);
        }
    }
    let sender = shell.writer.clone();
    coordinator
        .cancel_draft(|bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| {
        view.legacy_state == TerminalCommandState::Cancelled
    });
    assert!(!shell.home.path().join("effect").exists());
    let snapshot = shell.broker.snapshot(Some("nip")).unwrap().session.unwrap();
    assert!(!snapshot.input_observation.command_input_pending);
    assert!(coordinator
        .submit(
            || panic!("cancelled preflight"),
            |_| panic!("cancelled operation submitted")
        )
        .is_err());
}

#[test]
#[ignore = "subprocess entry for native submission SIGKILL probes"]
fn native_protocol_crash_child() {
    let root = PathBuf::from(
        std::env::var_os("SHELLSPAN_P1_NATIVE_CRASH_ROOT").expect("native crash root"),
    );
    let cut = std::env::var("SHELLSPAN_P1_NATIVE_CRASH_CUT").unwrap();
    assert!(matches!(cut.as_str(), "intent" | "accepted"));
    let mut shell = NativeShell::start(&format!("crash-{cut}"));
    let source = "printf ONCE >> \"$HOME/effect\"; while :; do :; done";
    let mut coordinator = shell.command(source);
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    coordinator.persist_submission_intent().unwrap();
    assert!(!coordinator
        .operation
        .submission_may_have_occurred()
        .unwrap());
    if cut == "accepted" {
        shell.arm(&mut coordinator);
        shell.submit(&coordinator);
        shell.wait(&mut coordinator, |view| {
            view.phase == crate::terminal_command::state::CommandPhase::Running
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !shell.home.path().join("effect").exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(fs::read(shell.home.path().join("effect")).unwrap(), b"ONCE");
    }
    let pid = shell.child.process_id().unwrap();
    let metadata = serde_json::json!({"home":shell.home.path(),"pid":pid,"processGroup":unsafe {libc::getpgid(pid as i32)},
        "identity":coordinator.identity().unwrap(),"phase":coordinator.operation.snapshot().unwrap().phase,
        "mayHaveSubmitted":coordinator.operation.submission_may_have_occurred().unwrap(),"acceptKeys":shell.accept_keys.load(Ordering::Relaxed)});
    let mut file = fs::File::create(root.join("driver.json")).unwrap();
    serde_json::to_writer(&mut file, &metadata).unwrap();
    file.sync_all().unwrap();
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
    panic!("native driver SIGKILL returned");
}

#[test]
#[ignore = "requires the rebuilt native producer; run pnpm test:terminal-input:p1"]
fn native_protocol_real_process_crash_recovery_never_reinputs_or_reaccepts() {
    use std::os::unix::process::ExitStatusExt;
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    for cut in ["intent", "accepted"] {
        let root = tempfile::Builder::new()
            .prefix("ss-nip-crash-")
            .tempdir_in("/tmp")
            .unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "terminal_native_protocol::native_protocol_crash_child",
            ])
            .env("SHELLSPAN_P1_NATIVE_CRASH_ROOT", root.path())
            .env("SHELLSPAN_P1_NATIVE_CRASH_CUT", cut)
            .output()
            .unwrap();
        assert_eq!(
            result.status.signal(),
            Some(libc::SIGKILL),
            "{cut}: native probe did not reach SIGKILL: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(root.path().join("driver.json")).unwrap()).unwrap();
        let pid = metadata["pid"].as_i64().unwrap() as i32;
        let group = metadata["processGroup"].as_i64().unwrap() as i32;
        unsafe {
            if group > 0 && group != libc::getpgrp() && libc::getsid(pid) == pid {
                libc::kill(-group, libc::SIGKILL);
            }
        }
        let home = PathBuf::from(metadata["home"].as_str().unwrap());
        let effect = fs::read(home.join("effect")).unwrap_or_default();
        assert_eq!(
            effect,
            if cut == "accepted" {
                b"ONCE".as_slice()
            } else {
                b"".as_slice()
            }
        );
        assert_eq!(
            metadata["acceptKeys"].as_u64().unwrap(),
            u64::from(cut == "accepted")
        );
        assert_eq!(metadata["mayHaveSubmitted"], cut == "accepted");
        let mut restored = NativeShell::start_for_root("restored", Some(root.path()));
        assert_eq!(
            restored
                .broker
                .recovered_submissions_for_agent("native-agent")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            restored
                .broker
                .submission_recovery_for_agent("native-agent")
                .unwrap()
                .len(),
            1
        );
        restored.bootstrap();
        restored
            .broker
            .acquire_agent_lease("nip", "native-agent", "native-task", "native-operation")
            .unwrap();
        let error = restored
            .broker
            .begin_command_with_submission(
                "nip",
                "native-operation",
                "printf must-not-be-replayed",
                Some(&nip::native_bash_plan("printf must-not-be-replayed").unwrap()),
            )
            .unwrap_err();
        assert_eq!(error, "TERMINAL_SUBMISSION_ALREADY_RECORDED");
        thread::sleep(Duration::from_millis(100));
        assert_eq!(restored.accept_keys.load(Ordering::Relaxed), 0);
        assert!(!restored.home.path().join("effect").exists());
        assert!(!String::from_utf8_lossy(&restored.raw.lock().unwrap())
            .contains("must-not-be-replayed"));
        assert_eq!(
            fs::read(home.join("effect")).unwrap_or_default(),
            effect,
            "recovery/query repeated an earlier side effect"
        );
        drop(restored);
        let destination = repository
            .join(".artifacts/tests/native-input-p0/p1-evidence")
            .join(format!("sigkill-{cut}"));
        fs::create_dir_all(&destination).unwrap();
        fs::copy(
            root.path().join("driver.json"),
            destination.join("driver.json"),
        )
        .unwrap();
        for case in [format!("crash-{cut}"), "restored".into()] {
            let to = destination.join(&case);
            fs::create_dir_all(&to).unwrap();
            for file in fs::read_dir(root.path().join("evidence").join(&case)).unwrap() {
                let file = file.unwrap();
                if file.file_type().unwrap().is_file() {
                    fs::copy(file.path(), to.join(file.file_name())).unwrap();
                }
            }
        }
        let control = fs::read(destination.join(format!("crash-{cut}/control.bin"))).unwrap();
        let mut decoder = nip::Decoder::default();
        let messages = decoder
            .push(&control)
            .unwrap()
            .into_iter()
            .filter_map(Message::into_operation)
            .collect::<Vec<_>>();
        assert!(messages
            .iter()
            .any(|message| matches!(message.payload, Payload::InputConfirmed { .. })));
        assert_eq!(
            messages
                .iter()
                .filter(|message| matches!(message.payload, Payload::SubmissionAccepted))
                .count(),
            usize::from(cut == "accepted")
        );
        assert!(!messages
            .iter()
            .any(|message| matches!(message.payload, Payload::Settled { .. })));
    }
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_syntax_refusal_precedes_input_and_user_enter() {
    for (case, suffix) in [("if", "if"), ("quote", "printf 'unterminated")] {
        let mut shell = NativeShell::start(&format!("syntax-refusal-{case}"));
        let source = format!("printf forbidden >> \"$HOME/effect\"\n{suffix}");
        let mut coordinator = shell.command(&source);
        let sender = shell.writer.clone();
        shell.key(b"\x18\x1e");
        coordinator
            .prepare(Duration::from_secs(5), true, |bytes| {
                sender
                    .send(Input::Private(bytes.to_vec()))
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !coordinator.editor_ready_confirmed().unwrap() {
            assert!(
                Instant::now() < deadline,
                "{case}: refusal did not return real readiness"
            );
            let bytes = shell.read();
            shell.deliver(&mut coordinator, &bytes);
        }
        let view = coordinator.operation.snapshot().unwrap();
        assert_eq!(
            view.phase,
            crate::terminal_command::state::CommandPhase::Failed
        );
        assert!(!view.may_have_submitted);
        assert!(view.input_rejection.unwrap().contains("BINDING"));
        assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
        assert!(!shell.home.path().join("effect").exists());
        let mut decoder = nip::Decoder::default();
        let messages = decoder.push(&shell.received).unwrap();
        assert!(messages.iter().any(|message| matches!(message,
            Message::Operation(message) if matches!(message.payload,
                Payload::Rejected { code: nip::ErrorCode::Binding }))));
        assert!(!messages.iter().any(|message| matches!(message,
            Message::Operation(message) if matches!(message.payload,
                Payload::InputProgress { .. } | Payload::InputConfirmed { .. }
                | Payload::CommitArmed | Payload::SubmissionAccepted | Payload::Started))));
        assert!(coordinator
            .arm_commit(|_| panic!("syntax refusal armed commit"))
            .is_err());
        assert!(shell
            .broker
            .release_agent_lease("nip", "native-agent", "native-task", "native-operation")
            .unwrap());
        shell.key(b"\r");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                Instant::now() < deadline,
                "{case}: Enter did not return an empty editor"
            );
            let bytes = shell.read();
            let messages = shell.decoder.push(&bytes).unwrap();
            if messages.iter().any(|message| matches!(message,
                Message::Connection(message) if matches!(message.payload,
                    ConnectionPayload::EditorReady { editor_empty: true, owned_draft_absent: true, .. }))) {
                break;
            }
        }
        assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
        assert!(
            !shell.home.path().join("effect").exists(),
            "{case}: Enter executed a rejected prefix"
        );
    }
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_parse_only_never_runs_expansions_or_traps() {
    let mut shell = NativeShell::start("parse-only-effects");
    shell.bootstrap();
    shell.key(b"set -T; trap 'printf T >> \"$HOME/trap-effect\"' DEBUG RETURN ERR EXIT\r");
    let deadline = Instant::now() + Duration::from_secs(5);
    'ready: loop {
        assert!(
            Instant::now() < deadline,
            "trap setup did not reach the real editor"
        );
        let bytes = shell.read();
        for message in shell.decoder.push(&bytes).unwrap() {
            if let Message::Connection(message) = message {
                let ready = matches!(
                    message.payload,
                    ConnectionPayload::EditorReady {
                        editor_empty: true,
                        owned_draft_absent: true,
                        ..
                    }
                );
                shell
                    .broker
                    .accept_native_readiness("nip", &message)
                    .unwrap();
                if ready {
                    break 'ready;
                }
            }
        }
    }
    let before = fs::read(shell.home.path().join("trap-effect")).unwrap();
    assert!(
        !before.is_empty(),
        "the actual Shell did not install the trap"
    );
    let source = ": \"$(printf forbidden >> \"$HOME/effect\")\"";
    let mut coordinator = shell.command(source);
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    assert!(
        !shell.home.path().join("effect").exists(),
        "parse-only validation ran a command substitution"
    );
    assert_eq!(
        fs::read(shell.home.path().join("trap-effect")).unwrap(),
        before,
        "parse-only validation ran an inherited trap"
    );
    assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
    let sender = shell.writer.clone();
    coordinator
        .cancel_draft(|bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.draft_cleared);
    assert!(!shell.home.path().join("effect").exists());
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_preparing_and_typing_cannot_submit() {
    let mut shell = NativeShell::start("pre-confirmation");
    let source = format!(
        "printf forbidden >> \"$HOME/effect\"; : '{}'",
        "中文-draft-".repeat(80)
    );
    let mut coordinator = shell.command(&source);
    assert!(coordinator
        .arm_commit(|_| panic!("Preparing armed a native commit"))
        .is_err());
    assert!(coordinator
        .submit(
            || panic!("Preparing reached final preflight"),
            |_| panic!("Preparing enqueued an accept key")
        )
        .is_err());
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), false, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| {
        view.phase == crate::terminal_command::state::CommandPhase::Typing
    });
    assert!(
        !coordinator
            .operation
            .observation_for_test()
            .unwrap()
            .full_input_confirmed
    );
    assert!(coordinator
        .arm_commit(|_| panic!("Typing armed a native commit"))
        .is_err());
    assert!(coordinator
        .submit(
            || panic!("Typing preflight"),
            |_| panic!("Typing accept key")
        )
        .is_err());
    let sender = shell.writer.clone();
    coordinator
        .cancel_draft(|bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    let pending = coordinator.operation.snapshot().unwrap();
    assert_eq!(
        pending.phase,
        crate::terminal_command::state::CommandPhase::CancelRequested
    );
    assert!(
        !coordinator
            .operation
            .observation_for_test()
            .unwrap()
            .draft_cleared
    );
    shell.wait(&mut coordinator, |view| {
        view.phase == crate::terminal_command::state::CommandPhase::Cancelled
    });
    assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
    assert!(!shell.home.path().join("effect").exists());
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_fragmented_late_confirmation_preserves_cancel_and_handoff() {
    let mut shell = NativeShell::start("late-confirm-cancel");
    let source = "printf forbidden >> \"$HOME/effect\"; : '真实分片确认🙂'";
    let mut coordinator = shell.command(source);
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    let mut held = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    'prepared: loop {
        assert!(Instant::now() < deadline);
        let bytes = shell.read();
        for (index, byte) in bytes.iter().enumerate() {
            for message in shell.decoder.push(std::slice::from_ref(byte)).unwrap() {
                let message = match message {
                    Message::Operation(message) => message,
                    Message::Connection(message) => {
                        shell
                            .broker
                            .accept_native_readiness("nip", &message)
                            .unwrap();
                        continue;
                    }
                };
                let prepared = matches!(message.payload, Payload::Prepared { .. });
                coordinator.receive_envelope(message).unwrap();
                if prepared {
                    held.extend_from_slice(&bytes[index + 1..]);
                    break 'prepared;
                }
            }
        }
    }
    assert!(
        !coordinator
            .operation
            .observation_for_test()
            .unwrap()
            .full_input_confirmed
    );
    // Hold a real, complete target-side confirmation before cancellation. The
    // parser now adds a separate preparation boundary, so Prepared no longer
    // implies that InputConfirmed has already reached this socket read.
    let mut proof_decoder = nip::Decoder::default();
    let has_confirmation = |messages: Vec<Message>| {
        messages.into_iter().any(|message| {
            matches!(message, Message::Operation(message) if matches!(message.payload, Payload::InputConfirmed { .. }))
        })
    };
    let mut observed_confirmation = has_confirmation(proof_decoder.push(&shell.received).unwrap());
    while !observed_confirmation {
        assert!(
            Instant::now() < deadline,
            "target did not produce the confirmation held for cancellation"
        );
        let bytes = shell.read();
        observed_confirmation = has_confirmation(proof_decoder.push(&bytes).unwrap());
        held.extend_from_slice(&bytes);
    }
    let sender = shell.writer.clone();
    coordinator
        .cancel_draft(|bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    let pending = coordinator.operation.observation_for_test().unwrap();
    assert_eq!(
        pending.phase,
        crate::terminal_command::state::CommandPhase::CancelRequested
    );
    assert!(!pending.draft_cleared);
    shell
        .broker
        .release_agent_lease("nip", "native-agent", "native-task", "native-operation")
        .unwrap();
    assert!(shell
        .broker
        .admit_terminal_input(
            "nip",
            crate::terminal_broker::TerminalBrokerInputSource::User,
            crate::terminal_broker::TerminalInputKind::Text,
            b"\n",
            || panic!("lease release exposed an uncleared native draft")
        )
        .is_err());
    shell.deliver(&mut coordinator, &held);
    shell.wait(&mut coordinator, |view| {
        view.phase == crate::terminal_command::state::CommandPhase::Cancelled
    });
    let snapshot = shell.broker.snapshot(Some("nip")).unwrap().session.unwrap();
    assert!(!snapshot.input_observation.native_recovery_required);
    assert!(!snapshot.input_observation.command_input_pending);
    coordinator
        .cancel_draft_for(
            crate::terminal_broker::TerminalCommandRequestedSettlement::Cancelled,
            |_| panic!("a repeated stop after actual DraftCleared must not enqueue another clear"),
        )
        .unwrap();
    let mut decoder = nip::Decoder::default();
    let messages = decoder.push(&shell.received).unwrap();
    let confirmation = messages
        .into_iter()
        .filter_map(Message::into_operation)
        .find(|message| matches!(message.payload, Payload::InputConfirmed { .. }))
        .unwrap();
    coordinator.receive_envelope(confirmation.clone()).unwrap();
    assert_eq!(
        coordinator.operation.snapshot().unwrap().phase,
        crate::terminal_command::state::CommandPhase::Cancelled
    );
    let sender = shell.writer.clone();
    shell
        .broker
        .admit_terminal_input(
            "nip",
            crate::terminal_broker::TerminalBrokerInputSource::User,
            crate::terminal_broker::TerminalInputKind::Text,
            b"\n",
            || {
                sender
                    .send(Input::Pty(b"\n".to_vec()))
                    .map_err(|error| error.to_string())
            },
        )
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(!shell.home.path().join("effect").exists());
    assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
    let command_id = coordinator.operation.command_id().unwrap();
    shell.broker.retire_command("nip", &command_id).unwrap();
    shell
        .broker
        .close_transport(
            "nip",
            crate::terminal_broker::TerminalGenerationCloseReason::Replaced,
        )
        .unwrap();
    shell
        .broker
        .attach_transport(
            "replacement",
            Some("nip"),
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(100, 24),
        )
        .unwrap();
    assert!(coordinator.receive_envelope(confirmation).is_err());
    let replacement = shell
        .broker
        .snapshot(Some("replacement"))
        .unwrap()
        .session
        .unwrap();
    assert_eq!(replacement.input_mode, InputMode::Raw);
    assert!(!replacement.input_observation.native_recovery_required);
    assert!(replacement.input_observation.active_command.is_none());
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_invalid_utf8_editor_change_never_becomes_replacement_character_proof() {
    let mut shell = NativeShell::start("invalid-utf8");
    let source = "printf forbidden >> \"$HOME/effect\"; : '�'";
    let mut coordinator = shell.command(source);
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    shell.key(b"\x7f\x7f\x16\xff'");
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut invalid = false;
    let mut observer = nip::Decoder::default();
    while !invalid {
        assert!(
            Instant::now() < deadline,
            "the real editor did not retain invalid UTF-8"
        );
        shell.send(&coordinator.query().unwrap());
        let bytes = shell.read();
        for message in observer
            .push(&bytes)
            .unwrap()
            .into_iter()
            .filter_map(Message::into_operation)
        {
            if matches!(
                message.payload,
                Payload::Snapshot {
                    editor_utf8_valid: false,
                    ..
                }
            ) {
                invalid = true;
            }
        }
        shell.deliver(&mut coordinator, &bytes);
    }
    let sender = shell.writer.clone();
    coordinator
        .arm_commit(|bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut rejected = false;
    while !rejected {
        assert!(Instant::now() < deadline);
        let bytes = shell.read();
        for message in shell
            .decoder
            .push(&bytes)
            .unwrap()
            .into_iter()
            .filter_map(Message::into_operation)
        {
            rejected = coordinator.receive_envelope(message).is_err() || rejected;
        }
    }
    assert_eq!(
        coordinator.operation.snapshot().unwrap().phase,
        crate::terminal_command::state::CommandPhase::RecoveryRequired
    );
    assert!(coordinator
        .submit(
            || panic!("invalid UTF-8 preflight"),
            |_| panic!("invalid UTF-8 accept key")
        )
        .is_err());
    shell.control.shutdown(std::net::Shutdown::Both).unwrap();
    assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
    assert!(!shell.home.path().join("effect").exists());
    assert!(
        shell
            .broker
            .snapshot(Some("nip"))
            .unwrap()
            .session
            .unwrap()
            .input_observation
            .native_recovery_required
    );
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_post_intent_deadline_and_lease_revocation_fence_the_accept_key() {
    for revoke in [false, true] {
        let mut shell = NativeShell::start(if revoke {
            "intent-revoked"
        } else {
            "intent-expired"
        });
        let source = "printf forbidden >> \"$HOME/effect\"";
        let mut coordinator = shell.command(source);
        let sender = shell.writer.clone();
        shell.key(b"\x18\x1e");
        coordinator
            .prepare(
                Duration::from_millis(if revoke { 5000 } else { 800 }),
                true,
                |bytes| {
                    sender
                        .send(Input::Private(bytes.to_vec()))
                        .map_err(|error| error.to_string())
                },
            )
            .unwrap();
        shell.wait(&mut coordinator, |view| view.full_input_confirmed);
        coordinator.persist_submission_intent().unwrap();
        assert_eq!(shell.broker.unresolved_submissions().unwrap().len(), 1);
        if revoke {
            shell
                .broker
                .release_agent_lease("nip", "native-agent", "native-task", "native-operation")
                .unwrap();
        } else {
            thread::sleep(Duration::from_millis(850));
        }
        assert!(coordinator
            .arm_commit(|_| panic!("post-intent expiry/revocation enqueued a commit"))
            .is_err());
        shell.control.shutdown(std::net::Shutdown::Both).unwrap();
        coordinator
            .connection_closed(shell.decoder.finish().is_err())
            .unwrap();
        shell
            .broker
            .release_agent_lease("nip", "native-agent", "native-task", "native-operation")
            .unwrap();
        assert!(shell
            .broker
            .admit_terminal_input(
                "nip",
                crate::terminal_broker::TerminalBrokerInputSource::User,
                crate::terminal_broker::TerminalInputKind::Text,
                b"\n",
                || panic!("unconfirmed clear returned executable input")
            )
            .is_err());
        assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
        assert!(!shell.home.path().join("effect").exists());
    }
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_takeover_fences_armed_admission_before_clear() {
    use crate::terminal_broker::{
        TerminalBrokerInputSource, TerminalCommandRequestedSettlement, TerminalInputKind,
    };

    let mut shell = NativeShell::start("armed-takeover-fence");
    let mut coordinator = shell.command("printf forbidden >> \"$HOME/effect\"");
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    shell.arm(&mut coordinator);
    let identity = coordinator.identity().unwrap();
    coordinator.operation.fence_takeover().unwrap();
    assert!(!coordinator
        .operation
        .takeover_settled_before_submission()
        .unwrap());
    assert_eq!(
        coordinator
            .submit(
                || panic!("takeover reached executable preflight"),
                |_| panic!("takeover enqueued an executable key"),
            )
            .unwrap_err(),
        "TERMINAL_LEASE_TAKEN_OVER"
    );
    assert_eq!(
        shell
            .broker
            .admit_terminal_input(
                "nip",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: identity.agent_session_id.clone(),
                    task_id: identity.task_id.clone(),
                    operation_id: identity.operation_id.clone(),
                },
                TerminalInputKind::Executable,
                b"\x18a",
                || panic!("final admission enqueued a key after takeover"),
            )
            .unwrap_err(),
        "TERMINAL_LEASE_TAKEN_OVER"
    );
    assert!(shell
        .broker
        .admit_terminal_input(
            "nip",
            TerminalBrokerInputSource::User,
            TerminalInputKind::Text,
            b"\r",
            || panic!("takeover returned unconfirmed editing"),
        )
        .is_err());
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .cancel_draft_for(TerminalCommandRequestedSettlement::Cancelled, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(!coordinator
        .operation
        .takeover_settled_before_submission()
        .unwrap());
    shell.wait(&mut coordinator, |view| view.draft_cleared);
    let settled = coordinator.operation.snapshot().unwrap();
    assert_eq!(settled.state, TerminalCommandState::TakenOver);
    assert!(!settled.may_have_submitted);
    assert!(coordinator
        .operation
        .takeover_settled_before_submission()
        .unwrap());
    assert!(shell.broker.unresolved_submissions().unwrap().is_empty());
    assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
    assert!(!shell.home.path().join("effect").exists());
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_unavailable_journal_never_arms_or_accepts() {
    let root = tempfile::tempdir().unwrap();
    let mut shell = NativeShell::start_for_root("journal-unavailable", Some(root.path()));
    let mut coordinator = shell.command("printf forbidden >> \"$HOME/effect\"");
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    // An actual filesystem outage after proof, with no replacement database.
    fs::rename(
        root.path().join("journal"),
        root.path().join("journal-unavailable"),
    )
    .unwrap();
    assert!(coordinator.persist_submission_intent().is_err());
    assert!(coordinator
        .arm_commit(|_| panic!("unavailable journal armed native commit"))
        .is_err());
    assert!(coordinator
        .submit(
            || panic!("unavailable journal passed preflight"),
            |_| panic!("unavailable journal enqueued accept")
        )
        .is_err());
    assert!(!coordinator.operation.snapshot().unwrap().may_have_submitted);
    assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
    assert!(!shell.home.path().join("effect").exists());
    shell.control.shutdown(std::net::Shutdown::Both).unwrap();
    // persist_submission_intent already quarantined this connection on the
    // real storage error. A second close cannot revalidate revoked capability.
    assert!(
        shell
            .broker
            .snapshot(Some("nip"))
            .unwrap()
            .session
            .unwrap()
            .input_observation
            .native_recovery_required
    );
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_running_stop_preserves_submission_and_private_end_status() {
    let mut shell = NativeShell::start("running-stop");
    let source = "printf ONCE >> \"$HOME/effect\"; while :; do :; done";
    let mut coordinator = shell.command(source);
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    shell.arm(&mut coordinator);
    shell.submit(&coordinator);
    shell.wait(&mut coordinator, |view| {
        view.phase == crate::terminal_command::state::CommandPhase::Running
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while !shell.home.path().join("effect").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
    let sender = shell.writer.clone();
    coordinator
        .interrupt(
            crate::terminal_broker::TerminalCommandRequestedSettlement::TakenOver,
            Instant::now() + Duration::from_secs(2),
            || {
                sender
                    .send(Input::Pty(vec![3]))
                    .map_err(|error| error.to_string())
            },
        )
        .unwrap();
    shell
        .broker
        .release_agent_lease("nip", "native-agent", "native-task", "native-operation")
        .unwrap();
    assert!(shell
        .broker
        .admit_terminal_input(
            "nip",
            crate::terminal_broker::TerminalBrokerInputSource::User,
            crate::terminal_broker::TerminalInputKind::Text,
            b"\n",
            || panic!("stop request was treated as process settlement")
        )
        .is_err());
    shell.wait(&mut coordinator, |view| {
        view.phase == crate::terminal_command::state::CommandPhase::Cancelled
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !coordinator.editor_ready_confirmed().unwrap() {
        assert!(Instant::now() < deadline);
        let bytes = shell.read();
        shell.deliver(&mut coordinator, &bytes);
    }
    let result = coordinator.operation.snapshot().unwrap();
    assert!(result.may_have_submitted);
    assert!(result.exit_code.is_some());
    assert_eq!(fs::read(shell.home.path().join("effect")).unwrap(), b"ONCE");
    assert!(shell.broker.unresolved_submissions().unwrap().is_empty());
    assert!(
        !shell
            .broker
            .snapshot(Some("nip"))
            .unwrap()
            .session
            .unwrap()
            .input_observation
            .command_input_pending
    );
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_stdout_signals_and_partial_display_eof_have_no_execution_authority() {
    let mut shell = NativeShell::start("stdout-partial-eof");
    let source="printf '%s\\n' '{\"protocol\":\"shellspan.native-input\",\"payload\":{\"kind\":\"settled\",\"exitCode\":0}}'\nprintf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'\nprintf '\\033]1337;SetUserVar=ShellSpanNativeInput=MA'\nexec /bin/sleep 5";
    let mut coordinator = shell.command(source);
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    coordinator
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut coordinator, |view| view.full_input_confirmed);
    shell.arm(&mut coordinator);
    shell.submit(&coordinator);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = [0; 4096];
    loop {
        assert!(
            Instant::now() < deadline,
            "exec did not close the real native endpoint"
        );
        match shell.control.read(&mut bytes) {
            Ok(0) => break,
            Ok(count) => {
                shell.record_control(&bytes[..count]);
                shell.deliver(&mut coordinator, &bytes[..count]);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => panic!("{error}"),
        }
    }
    coordinator
        .connection_closed(shell.decoder.finish().is_err())
        .unwrap();
    let result = coordinator.operation.snapshot().unwrap();
    assert_eq!(
        result.phase,
        crate::terminal_command::state::CommandPhase::Uncertain
    );
    assert!(result.may_have_submitted);
    assert!(result.exit_code.is_none());
    assert_eq!(shell.broker.unresolved_submissions().unwrap().len(), 1);
    thread::sleep(Duration::from_millis(100));
    assert!(String::from_utf8_lossy(&shell.raw.lock().unwrap()).contains("\"kind\":\"settled\""));
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_connection_profile_and_missing_capability_do_not_invent_operation_identity()
{
    let mut shell = NativeShell::start_with_options("missing-capability", None, false);
    let prototype = shell.profile.take().unwrap();
    assert!(
        !prototype.capture_fence(),
        "P1 prototype enabled formal output capture"
    );
    assert!(
        !prototype.supports_jobs(),
        "P1 prototype enabled native background jobs"
    );
    let request = shell
        .broker
        .register_native_channel("nip", prototype)
        .unwrap();
    let encoded = serde_json::to_value(&request).unwrap();
    assert!(encoded.get("identity").is_none());
    assert!(encoded["connection"].get("agentSessionId").is_none());
    shell.send(&request.encode().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(Instant::now() < deadline);
        let bytes = shell.read();
        if let Some(message) = shell.decoder.push(&bytes).unwrap().into_iter().next() {
            let Message::Connection(message) = message else {
                panic!("operation record before an operation exists");
            };
            let ConnectionPayload::Capabilities {
                profile,
                inband_display,
                ..
            } = &message.payload
            else {
                panic!("expected real producer capabilities");
            };
            assert!(!inband_display);
            assert_eq!(
                profile.verified_profile_id.as_deref(),
                Some(shell.expected_profile_id.as_str())
            );
            assert_eq!(profile.editor_numeric_version, 0x0803);
            assert!(profile.shell_version.as_ref().unwrap().starts_with("5.3."));
            assert_eq!(
                shell
                    .broker
                    .accept_native_capabilities("nip", &message)
                    .unwrap_err(),
                "TERMINAL_NATIVE_CAPABILITY_UNAVAILABLE"
            );
            let snapshot = shell.broker.snapshot(Some("nip")).unwrap().session.unwrap();
            assert_eq!(
                snapshot.integration_state,
                crate::terminal_broker::TerminalIntegrationState::Unavailable
            );
            assert!(snapshot.native_display_binding.is_none());
            assert!(snapshot.input_observation.active_command.is_none());
            assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
            return;
        }
    }
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_second_operation_keeps_parent_environment_and_connection_framing() {
    let mut shell = NativeShell::start("successive-operations");
    fs::create_dir(shell.home.path().join("parent-directory")).unwrap();
    let mut first = shell.command_as(
        "cd \"$HOME/parent-directory\"; export P1_PARENT_VALUE='parent-value'; p1_parent_value() { printf '%s' \"$P1_PARENT_VALUE\"; }; (exit 7)",
        "native-first",
    );
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    first
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut first, |view| view.full_input_confirmed);
    shell.arm(&mut first);
    shell.submit(&first);
    shell.wait(&mut first, |view| {
        view.phase == crate::terminal_command::state::CommandPhase::Completed
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !first.editor_ready_confirmed().unwrap() {
        assert!(Instant::now() < deadline);
        let bytes = shell.read();
        shell.deliver(&mut first, &bytes);
    }
    let mut captured = nip::Decoder::default();
    let old = captured
        .push(&shell.received)
        .unwrap()
        .into_iter()
        .filter_map(Message::into_operation)
        .find(|message| matches!(message.payload, Payload::InputConfirmed { .. }))
        .unwrap();
    let old_bytes = old.encode().unwrap();
    let middle = old_bytes.len() / 2;
    assert!(shell.decoder.push(&old_bytes[..middle]).unwrap().is_empty());
    shell
        .broker
        .release_agent_lease("nip", "native-agent", "native-task", "native-first")
        .unwrap();
    shell
        .broker
        .retire_command("nip", &first.operation.command_id().unwrap())
        .unwrap();
    let mut second = shell.command_as(
        "[[ $? == 7 && $PWD == \"$HOME/parent-directory\" ]] && p1_parent_value > \"$HOME/second\"",
        "native-second",
    );
    for message in shell
        .decoder
        .push(&old_bytes[middle..])
        .unwrap()
        .into_iter()
        .filter_map(Message::into_operation)
    {
        assert!(second
            .receive_envelope(message)
            .unwrap_err()
            .contains("IDENTITY_MISMATCH"));
    }
    assert!(
        !shell
            .broker
            .snapshot(Some("nip"))
            .unwrap()
            .session
            .unwrap()
            .input_observation
            .native_recovery_required
    );
    assert!(
        shell
            .broker
            .native_input_coordinator("nip", "native-second")
            .is_err(),
        "a second protocol writer claimed the same operation"
    );
    let sender = shell.writer.clone();
    shell.key(b"\x18\x1e");
    second
        .prepare(Duration::from_secs(5), true, |bytes| {
            sender
                .send(Input::Private(bytes.to_vec()))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    shell.wait(&mut second, |view| view.full_input_confirmed);
    shell.arm(&mut second);
    shell.submit(&second);
    shell.wait(&mut second, |view| {
        view.phase == crate::terminal_command::state::CommandPhase::Completed
    });
    assert_eq!(
        fs::read(shell.home.path().join("second")).unwrap(),
        b"parent-value"
    );
    assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 2);
}

#[test]
#[ignore = "requires the rebuilt native producer"]
fn native_protocol_real_unverified_vi_mode_does_not_negotiate_from_versions_alone() {
    let mut shell = NativeShell::start_with_editor("unsupported-vi", None, true, false);
    let request = shell
        .broker
        .register_native_channel("nip", shell.profile.take().unwrap())
        .unwrap();
    shell.send(&request.encode().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(
            Instant::now() < deadline,
            "real vi-mode negotiation did not return"
        );
        let bytes = shell.read();
        if let Some(message) = shell.decoder.push(&bytes).unwrap().into_iter().next() {
            let Message::Connection(message) = message else {
                panic!("operation before any operation exists");
            };
            let ConnectionPayload::Capabilities {
                profile,
                native_inline,
                ..
            } = &message.payload
            else {
                panic!("expected real capabilities");
            };
            assert_eq!(
                profile.verified_profile_id.as_deref(),
                Some(shell.expected_profile_id.as_str())
            );
            assert!(
                !native_inline,
                "matching shell/module versions advertised an unverified editor mode"
            );
            assert_eq!(
                shell
                    .broker
                    .accept_native_capabilities("nip", &message)
                    .unwrap_err(),
                "TERMINAL_NATIVE_CAPABILITY_UNAVAILABLE"
            );
            assert!(shell
                .broker
                .snapshot(Some("nip"))
                .unwrap()
                .session
                .unwrap()
                .native_display_binding
                .is_none());
            assert_eq!(shell.accept_keys.load(Ordering::Relaxed), 0);
            return;
        }
    }
}
