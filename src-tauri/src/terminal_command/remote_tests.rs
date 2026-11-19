//! Real production SSH preparation, SFTP verification, relay and remote ZLE.
//! Credentials are read only from an ephemeral pipe supplied by the fixture's
//! OS-keychain owner; all receipts come from the actual remote editor.
use super::*;
use std::{
    fs, io,
    net::TcpStream,
    path::PathBuf,
    time::{Duration, Instant},
};
thread_local! {static LIVE_PTY:std::cell::RefCell<Option<fs::File>>=const{std::cell::RefCell::new(None)};}
fn capture_pty(raw: &mut Vec<u8>, bytes: &[u8]) {
    raw.extend_from_slice(bytes);
    LIVE_PTY.with(|file| {
        if let Some(file) = file.borrow_mut().as_mut() {
            file.write_all(bytes).unwrap();
            file.flush().unwrap();
        }
    });
}
fn publish(path: &Path, value: &serde_json::Value) {
    let pending = path.with_extension("pending");
    fs::write(&pending, serde_json::to_vec(value).unwrap()).unwrap();
    fs::rename(pending, path).unwrap();
}

#[test]
#[ignore = "requires an owned Linux x86_64 OpenSSH fixture and rebuilt production resources"]
fn real_ssh_bash_startup_fallback_preserves_predecessor_until_attachment() {
    use crate::models::{
        ManagedSession, SessionCommandSender, SessionIdentity, SessionTerminalKind,
    };
    use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};

    let fixture: serde_json::Value = serde_json::from_slice(
        &fs::read(
            std::env::var("SHELLSPAN_SSH_STARTUP_FIXTURE")
                .expect("Explicit owned fixture required"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(fixture["host"], "127.0.0.1");
    assert_eq!(fixture["username"], "native53");
    let port = u16::try_from(fixture["port"].as_u64().unwrap()).unwrap();
    let mut password = String::new();
    io::stdin().read_line(&mut password).unwrap();
    assert!(!password.trim_end().is_empty());
    let connect = || {
        let mut session = Session::new().unwrap();
        session.set_tcp_stream(TcpStream::connect(("127.0.0.1", port)).unwrap());
        session.set_timeout(8_000);
        session.handshake().unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(session.host_key().unwrap().0)),
            fixture["hostKeySha256"].as_str().unwrap()
        );
        session
            .userauth_password("native53", password.trim_end())
            .unwrap();
        session
    };

    let fixture_session = connect();
    let sftp = fixture_session.sftp().unwrap();
    let set_profile = |source: &str| {
        upload(
            &sftp,
            "/home/native53/.bash_profile",
            source.as_bytes(),
            0o600,
        )
        .unwrap()
    };
    upload(
        &sftp,
        "/home/native53/.bashrc",
        b"builtin printf 'USER_RC_WITHOUT_NEWLINE'\n",
        0o600,
    )
    .unwrap();
    let ready_profile = "export LC_ALL=en_US.UTF-8\nPS1='shellspan-ssh-regression> '\n";
    set_profile(ready_profile);
    let resources = std::env::var_os("SHELLSPAN_SSH_STARTUP_RESOURCES")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../artifacts/tests/native-input/integration/resources/native-input")
        });
    let broker = TerminalSessionBroker::phase5_enabled_for_test(65_536);
    let sessions = SessionManager::default();

    let start = |transport: &str, predecessor: Option<&str>| {
        let request = SessionCreateRequest {
            native_input_protocol: Some(nip::PROTOCOL.into()),
            initial_directory: None,
            operation_id: None,
            name: "Owned SSH startup regression".into(),
            host: "127.0.0.1".into(),
            port,
            username: "native53".into(),
            auth_method: crate::models::AuthMethod::Password,
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            terminal_cols: 100,
            terminal_rows: 30,
            jump_host: None,
            replaces_session_id: predecessor.map(str::to_owned),
        };
        let session = connect();
        let (sender, receiver) = std::sync::mpsc::channel();
        sessions
            .insert(
                transport.into(),
                ManagedSession {
                    sender: SessionCommandSender::Standard(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: transport.into(),
                        status: SessionStatus::Connecting,
                        message: None,
                    },
                    output_ready: Arc::default(),
                    output_paused: Arc::default(),
                    terminal_kind: SessionTerminalKind::Remote,
                    identity: SessionIdentity {
                        title: request.name.clone(),
                        host: request.host.clone(),
                        port,
                        username: request.username.clone(),
                    },
                },
            )
            .unwrap();
        let mut native = RemoteNativeBash::prepare(
            &session,
            "native53",
            &resources,
            &mut SftpStartupTimings::default(),
        )
        .unwrap();
        assert!(native.as_ref().unwrap().uses_private_bash());
        let root = native.as_ref().unwrap().root.clone();
        let mut pty = open_remote_pty_channel(&session, &request, transport).unwrap();
        let mut output = Vec::new();
        let result = start_ssh_native_or_fallback(
            &session,
            &mut pty,
            &mut native,
            &broker,
            &request,
            transport,
            &mut output,
            None,
        );
        if native.is_none() {
            assert!(
                sftp.stat(Path::new(&root)).is_err(),
                "Private fallback directory was not removed"
            );
        }
        (request, session, native, pty, output, result, receiver)
    };
    let expect_output =
        |session: &Session, channel: &mut Channel, output: &mut Vec<u8>, line: &str| {
            let deadline = Instant::now() + Duration::from_secs(5);
            let expected = format!("{line}\r\n");
            while !String::from_utf8_lossy(output).contains(&expected) {
                read_startup_pty(channel, output).unwrap();
                assert!(
                    Instant::now() < deadline,
                    "Missing output from real PTY: {line}"
                );
                wait_for_session_socket(session, Duration::from_millis(20)).unwrap();
            }
        };

    let (request, old_session, old_native, mut old_pty, mut old_output, startup, old_input) =
        start("ssh-old", None);
    let (event, messages) =
        attach_started_ssh_terminal(&broker, &sessions, &request, "ssh-old", startup.unwrap())
            .unwrap();
    assert_eq!(event.status, SessionStatus::Connected);
    assert!(messages.is_some());
    let old = broker.attachment_for_transport("ssh-old").unwrap().unwrap();
    let snapshot = broker.snapshot(Some("ssh-old")).unwrap().session.unwrap();
    assert_eq!(snapshot.input_mode, nip::InputMode::NativeInline);
    assert!(snapshot.prompt_ready);

    set_profile("if [[ $BASH != /bin/bash ]]; then printf 'PRIVATE_EXIT\\n'; exit 47; fi\nprintf 'PLAIN_EXIT\\n'; exit 48\n");
    let (_, _, _, _, refused_output, refused, _) = start("ssh-refused", Some("ssh-old"));
    assert!(
        matches!(refused, Err(ConnectionError::Other { message }) if message == "remote shell closed during initialization")
    );
    assert!(String::from_utf8_lossy(&refused_output).contains("PLAIN_EXIT"));
    assert_eq!(
        sessions.status("ssh-old").unwrap().status,
        SessionStatus::Connected
    );
    assert_eq!(
        broker.attachment_for_transport("ssh-old").unwrap(),
        Some(old.clone())
    );
    assert!(broker
        .attachment_for_transport("ssh-refused")
        .unwrap()
        .is_none());
    let input = "printf 'OLD_%s\\n' SSH_READY\r";
    broker
        .admit_terminal_input(
            "ssh-old",
            TerminalBrokerInputSource::User,
            TerminalInputKind::Text,
            input.as_bytes(),
            || sessions.write_session_input("ssh-old", input.to_owned()),
        )
        .unwrap();
    let SessionCommand::Write(input) = old_input.recv_timeout(Duration::from_secs(1)).unwrap()
    else {
        panic!("Expected the original session to accept input");
    };
    write_all_nonblocking(&old_session, &mut old_pty, input.as_bytes()).unwrap();
    expect_output(&old_session, &mut old_pty, &mut old_output, "OLD_SSH_READY");

    set_profile(ready_profile);
    let (
        request,
        cancelled_session,
        cancelled_native,
        mut cancelled_pty,
        _,
        startup,
        _cancelled_input,
    ) = start("ssh-cancelled", Some("ssh-old"));
    let startup = startup.unwrap();
    assert!(startup.as_ref().unwrap().messages.is_some());
    sessions.close("ssh-cancelled").unwrap();
    assert!(matches!(
        attach_started_ssh_terminal(&broker, &sessions, &request, "ssh-cancelled", startup),
        Err(message) if message == "SSH connection cancelled"
    ));
    assert_eq!(
        broker.attachment_for_transport("ssh-old").unwrap(),
        Some(old.clone())
    );
    graceful_shutdown(&mut cancelled_pty);
    cancelled_native.unwrap().close(&cancelled_session);

    set_profile(&format!("if [[ $BASH != /bin/bash ]]; then printf 'PRIVATE_EXIT\\n'; exit 47; fi\nprintf 'PLAIN_READY\\n'\n{ready_profile}"));
    let (request, raw_session, _, mut raw_pty, mut raw_output, fallback, _raw_input) =
        start("ssh-fallback", Some("ssh-old"));
    assert!(fallback.unwrap().is_none());
    assert_eq!(
        broker.attachment_for_transport("ssh-old").unwrap(),
        Some(old.clone())
    );
    assert!(!String::from_utf8_lossy(&raw_output).contains("PRIVATE_EXIT"));
    let (event, _) =
        attach_started_ssh_terminal(&broker, &sessions, &request, "ssh-fallback", None).unwrap();
    assert_eq!(event.status, SessionStatus::Connected);
    let raw = broker
        .snapshot(Some("ssh-fallback"))
        .unwrap()
        .session
        .unwrap();
    assert_eq!(raw.input_mode, nip::InputMode::Raw);
    assert_eq!(raw.terminal_session_id, old.terminal_session_id);
    assert_eq!(raw.terminal_generation, old.terminal_generation + 1);
    assert!(broker
        .attachment_for_transport("ssh-old")
        .unwrap()
        .is_none());
    expect_output(&raw_session, &mut raw_pty, &mut raw_output, "PLAIN_READY");
    write_all_nonblocking(
        &raw_session,
        &mut raw_pty,
        b"printf 'SHELL_%s\\n' \"$BASH\"\r",
    )
    .unwrap();
    expect_output(
        &raw_session,
        &mut raw_pty,
        &mut raw_output,
        "SHELL_/bin/bash",
    );

    set_profile(ready_profile);
    let (request, next_session, next_native, mut next_pty, _, startup, _next_input) =
        start("ssh-next", Some("ssh-fallback"));
    assert!(broker
        .attachment_for_transport("ssh-fallback")
        .unwrap()
        .is_some());
    assert!(attach_started_ssh_terminal(
        &broker,
        &sessions,
        &request,
        "ssh-next",
        startup.unwrap()
    )
    .unwrap()
    .1
    .is_some());
    let next = broker.snapshot(Some("ssh-next")).unwrap().session.unwrap();
    assert_eq!(next.terminal_session_id, old.terminal_session_id);
    assert_eq!(next.terminal_generation, old.terminal_generation + 2);
    assert_eq!(next.input_mode, nip::InputMode::NativeInline);
    assert!(next.prompt_ready);
    let capabilities = broker.execution_capabilities("ssh-next").unwrap();
    assert!(!capabilities.input_recovery_required);
    assert!(capabilities
        .integration_capabilities
        .contains(&"nativeScriptInput"));

    graceful_shutdown(&mut next_pty);
    next_native.unwrap().close(&next_session);
    graceful_shutdown(&mut raw_pty);
    graceful_shutdown(&mut old_pty);
    old_native.unwrap().close(&old_session);
}
fn drain_tick(
    native: &mut RemoteNativeBash,
    pty: &mut Channel,
    raw: &mut Vec<u8>,
) -> Vec<nip::Message> {
    let mut bytes = [0; 8192];
    match pty.read(&mut bytes) {
        Ok(n) => capture_pty(raw, &bytes[..n]),
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
        Err(e) => panic!("Actual SSH PTY read failed: {e}"),
    }
    match native.control.read(&mut bytes) {
        Ok(0) if native.control.eof() => panic!("Actual private SSH channel closed"),
        Ok(n) => native.decode_control_bytes(&bytes[..n]).unwrap(),
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => Vec::new(),
        Err(e) => panic!("Actual private SSH read failed: {e}"),
    }
}

fn pump(
    native: &mut RemoteNativeBash,
    pty: &mut Channel,
    records: &mut Vec<nip::Message>,
    raw: &mut Vec<u8>,
    mut predicate: impl FnMut(&nip::Message) -> bool,
) {
    if records.iter().any(&mut predicate) {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let mut found = false;
        for message in drain_tick(native, pty, raw) {
            found |= predicate(&message);
            records.push(message);
        }
        if found {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Actual remote editor boundary missing"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn remote_early_core_preserved(session: &Session, owner: &Path, evidence: &Path) {
    // This account belongs exclusively to the explicit disposable fixture.
    // Real user startup files load the system Core before native is considered.
    session.set_blocking(true);
    let sftp = session.sftp().unwrap();
    upload(&sftp,"/home/nativeZle/.zshenv",b"P3_ENV_COUNT=$(( ${P3_ENV_COUNT:-0}+1 ))\ntypeset -g P3_EARLY_DATA=USER_KEEP\nzmodload zsh/zle\np3_early_widget() { builtin printf '%s' EARLY_WIDGET > $HOME/early-widget; }\nzle -N p3_early_widget\nbindkey '^Xy' p3_early_widget\n",0o600).unwrap();
    upload(
        &sftp,
        "/home/nativeZle/.zprofile",
        b"P3_PROFILE_COUNT=$(( ${P3_PROFILE_COUNT:-0}+1 ))\n",
        0o600,
    )
    .unwrap();
    upload(
        &sftp,
        "/home/nativeZle/.zlogin",
        b"P3_LOGIN_COUNT=$(( ${P3_LOGIN_COUNT:-0}+1 ))\n",
        0o600,
    )
    .unwrap();
    let mut native = RemoteNativeBash::prepare(
        session,
        "nativeZle",
        &owner.join("artifacts/tests/native-input/integration/resources/native-input"),
        &mut SftpStartupTimings::default(),
    )
    .unwrap()
    .unwrap();
    let mut pty = session.channel_session().unwrap();
    pty.request_pty("xterm-256color", None, Some((100, 30, 0, 0)))
        .unwrap();
    native.start_shell(&mut pty).unwrap();
    session.set_blocking(false);
    let mut raw = Vec::new();
    let mut records = Vec::new();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let mut bytes = [0; 8192];
            match pty.read(&mut bytes) {
                Ok(n) => raw.extend_from_slice(&bytes[..n]),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => panic!("Early user Core PTY read failed: {e}"),
            }
            match native.control.read(&mut bytes) {
                Ok(n) => records.extend(native.decode_control_bytes(&bytes[..n]).unwrap()),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => panic!("Early user Core control read failed: {e}"),
            }
            if String::from_utf8_lossy(&raw).contains("P3-SSH>") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Declining native skipped ordinary startup"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert!(String::from_utf8_lossy(&raw).contains("TERMINAL_NATIVE_SCOPED_CORE_CONFLICT"));
        assert!(!records.iter().any(|m|matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::Capabilities{native_inline:true,..}))));
        write_all_nonblocking(session, &mut pty, b"\x18y").unwrap();
        let user=b"[[ $P3_EARLY_DATA == USER_KEEP && $P3_ENV_COUNT == 1 && $P3_PROFILE_COUNT == 1 && $P3_LOGIN_COUNT == 1 && ${+functions[__shellspan_nip_preexec]} == 0 && ${+functions[__shellspan_nip_initialize]} == 0 && ${+parameters[ZLE_NATIVE_APPEND]} == 0 ]] && command cat /proc/$$/maps > $HOME/early-core-map && builtin printf '%s' PRESERVED > $HOME/early-core-result\r";
        write_all_nonblocking(session, &mut pty, user).unwrap();
        session.set_blocking(true);
        let sftp = session.sftp().unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Ok(mut file) = sftp.open(Path::new("/home/nativeZle/early-core-result")) {
                let mut value = String::new();
                file.read_to_string(&mut value).unwrap();
                if value == "PRESERVED" {
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "Original env/profile/login, parser or widget state changed"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let mut value = String::new();
        sftp.open(Path::new("/home/nativeZle/early-widget"))
            .unwrap()
            .read_to_string(&mut value)
            .unwrap();
        assert_eq!(value, "EARLY_WIDGET");
        let mut mapped = String::new();
        sftp.open(Path::new("/home/nativeZle/early-core-map"))
            .unwrap()
            .read_to_string(&mut mapped)
            .unwrap();
        assert!(mapped.contains("/zsh/5.9/zsh/zle.so"));
        assert!(!mapped.contains("/scoped/zsh/zle.so"));
        fs::write(evidence.join("early-user-core-mapped-files.txt"), mapped).unwrap();
    }));
    session.set_blocking(true);
    let _ = pty.close();
    drop(pty);
    native.close(session);
    fs::write(evidence.join("early-user-core-raw.bin"), raw).unwrap();
    fs::write(evidence.join("early-user-core-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":outcome.is_ok(),"originalEnvironmentSourcedOnce":outcome.is_ok(),"profileAndLoginLoadedOnce":outcome.is_ok(),"originalCoreAndWidgetPreserved":outcome.is_ok(),"nativeDeclined":outcome.is_ok(),"nativeAcceptance":false})).unwrap()).unwrap();
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "requires the owned live Linux SSH fixture, rebuilt artifacts and OS-keychain credential pipe"]
fn production_remote_zle_parent_parser_and_background() {
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let fixture: serde_json::Value = serde_json::from_slice(
        &fs::read(
            std::env::var("SHELLSPAN_P3_SSH_FIXTURE").expect("Explicit owned fixture required"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(fixture["host"], "127.0.0.1");
    let port = u16::try_from(fixture["port"].as_u64().unwrap()).unwrap();
    let username = fixture["username"].as_str().unwrap();
    assert_eq!(username, "nativeZle");
    let evidence = owner
        .join("artifacts/tests/native-input/acceptance/production-ssh-zle")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    let columns = std::env::var("SHELLSPAN_P3_TEST_COLUMNS")
        .map(|value| value.parse::<u32>().unwrap())
        .unwrap_or(100);
    assert!([32, 40, 100, 180].contains(&columns));
    let live = std::env::var_os("SHELLSPAN_P3_LIVE_GEOMETRY").is_some();
    if live {
        LIVE_PTY.with(|file| {
            *file.borrow_mut() = Some(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(evidence.join("raw-live.bin"))
                    .unwrap(),
            )
        });
    }
    let mut resize_events = Vec::new();
    let mut geometry_source = String::new();
    let mut password = String::new();
    io::stdin().read_line(&mut password).unwrap();
    assert!(!password.trim_end().is_empty());
    let mut session = Session::new().unwrap();
    session.set_tcp_stream(TcpStream::connect(("127.0.0.1", port)).unwrap());
    session.set_timeout(8000);
    session.handshake().unwrap();
    let (key, _) = session.host_key().unwrap();
    assert_eq!(
        hex::encode(Sha256::digest(key)),
        fixture["hostKeySha256"].as_str().unwrap(),
        "Pinned owned SSH host key changed"
    );
    session
        .userauth_password(username, password.trim_end())
        .expect("Owned OS-keychain authentication failed");
    assert!(session.authenticated());
    // Give the independent startup guard its own pinned authenticated transport;
    // closing a real interactive PTY must not be its connection prerequisite.
    let mut early_session = Session::new().unwrap();
    early_session.set_tcp_stream(TcpStream::connect(("127.0.0.1", port)).unwrap());
    early_session.set_timeout(8000);
    early_session.handshake().unwrap();
    let (early_key, _) = early_session.host_key().unwrap();
    assert_eq!(
        hex::encode(Sha256::digest(early_key)),
        fixture["hostKeySha256"].as_str().unwrap()
    );
    early_session
        .userauth_password(username, password.trim_end())
        .expect("Owned startup-guard authentication failed");
    password.clear();
    assert!(early_session.authenticated());
    let mut native = RemoteNativeBash::prepare(
        &session,
        username,
        &owner.join("artifacts/tests/native-input/integration/resources/native-input"),
        &mut SftpStartupTimings::default(),
    )
    .unwrap()
    .expect("Actual remote profile absent");
    let display_binding = native.profile.display_binding();
    assert_eq!(display_binding.owned_reflow_cursor_line, Some(true));
    assert_eq!(
        display_binding.unicode_version,
        Some(nip::DisplayUnicodeVersion::Unicode11)
    );
    fs::write(
        evidence.join("verified-display-binding.json"),
        serde_json::to_vec_pretty(&display_binding).unwrap(),
    )
    .unwrap();
    assert!(matches!(native.startup, RemoteShellStartup::Zle));
    assert_eq!(native.profile.shell(), TerminalShellKind::Zsh);
    let mut pty = session.channel_session().unwrap();
    pty.request_pty("xterm-256color", None, Some((columns, 30, 0, 0)))
        .unwrap();
    native.start_shell(&mut pty).unwrap();
    session.set_blocking(false);
    let connection = nip::ConnectionIdentity {
        terminal_session_id: "p3-ssh-zle".into(),
        terminal_generation: 1,
        control_id: "p3-ssh-control".into(),
    };
    native
        .send(
            &session,
            &nip::ConnectionEnvelope {
                protocol: nip::PROTOCOL.into(),
                request_id: "probe".into(),
                connection,
                payload: nip::ConnectionPayload::Probe,
            }
            .encode()
            .unwrap(),
        )
        .unwrap();
    let mut records = Vec::new();
    let mut raw = Vec::new();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pump(
            &mut native,
            &mut pty,
            &mut records,
            &mut raw,
            |m| matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::Capabilities{native_inline:true,..})),
        );
        pump(
            &mut native,
            &mut pty,
            &mut records,
            &mut raw,
            |m| matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::EditorReady{editor_empty:true,..})),
        );
        native.send(&session, b"TTY-RECOVERY 47 2\n").unwrap();
        let handle = "job-3123456789abcdef0123456789abcdef";
        let pid_file = format!("p3-ssh-group-{}.pid", Uuid::new_v4());
        let group_check=format!("import os\nfrom pathlib import Path\npid=int((Path.home()/{pid_file:?}).read_text())\nassert pid>1\ntry:\n os.killpg(pid,0)\nexcept ProcessLookupError:\n print('P3-SSH-GROUP-GONE')\nelse:\n raise AssertionError('actual stopped group still exists')");
        let background =
            std::env::var("SHELLSPAN_P3_GEOMETRY_BACKGROUND_OUTPUT").as_deref() != Ok("0");
        let mut initial_source="typeset P3_SSH_PARENT='父Shell-é-👩🏽‍💻'; command cat /proc/$$/maps > \"$HOME/p3-core-map\"; printf '%s%s\\n' P3-SSH- INITIALIZED".to_string();
        initial_source.push_str("; [[ -f \"$__shellspan_control_path.tty-reply-47-2\" ]] && printf '%s%s\\n' P3-SSH- TTY-REPLY");
        if std::env::var_os("SHELLSPAN_P3_HISTORY_PREFILL").is_some() {
            initial_source.push_str(
                "; for n in {1..60}; do builtin printf 'P3_HISTORY_%02d\\n' \"$n\"; done",
            );
        }
        let sources=[(initial_source,None),
            ("[[ $P3_SSH_PARENT == '父Shell-é-👩🏽‍💻' ]] && printf '%s%s\\n' P3-SSH- PERSISTED".into(),None),
            (format!("zmodload zsh/system; builtin printf '%s' \"$sysparams[pid]\" > \"$HOME/{pid_file}\"; {}",if background{"for n in {1..200}; do printf 'P3-SSH-BG-%s:%s\\n' \"$n\" \"$P3_SSH_PARENT\"; sleep 0.1; done"}else{"sleep 30"}),Some(nip::JobExecution::Launch{handle:handle.into()})),
            (format!("typeset P3_SSH_LONG='{}{}'; printf '%s%s\\n' P3-SSH- LONG", "0123456789abcdef".repeat(25),"长输入-é-👩🏽‍💻".repeat(40)),None),
            (format!("__shellspan_job_control {handle} poll"),Some(nip::JobExecution::Control{handle:handle.into(),stop:false,nonce:"3123456789abcdef0123456789abcdef".into()})),
            (format!("__shellspan_job_control {handle} stop"),Some(nip::JobExecution::Control{handle:handle.into(),stop:true,nonce:"4123456789abcdef0123456789abcdef".into()})),
            (format!("__shellspan_job_control {handle} poll"),Some(nip::JobExecution::Control{handle:handle.into(),stop:false,nonce:"5123456789abcdef0123456789abcdef".into()})),
            (format!("python3 -c {}",shlex::try_quote(&group_check).unwrap()),None),
            ("typeset P3_SSH_TABS=$'A\tB'; [[ $P3_SSH_TABS == $'A\tB' ]] && printf '%s%s\\n' P3-SSH- TABS".into(),None)];
        for (index, (source, job)) in sources.into_iter().enumerate() {
            let identity = nip::Identity {
                terminal_session_id: "p3-ssh-zle".into(),
                terminal_generation: 1,
                lease_id: format!("lease-{index}"),
                lease_generation: index as u64 + 1,
                agent_session_id: "p3-agent".into(),
                task_id: "p3-task".into(),
                operation_id: format!("p3-ssh-{index}"),
                command_id: format!("p3-command-{index}"),
                source_revision: 1,
            };
            let plan = match &job {
                Some(job) => {
                    nip::native_shell_job_plan(&source, nip::ShellFamily::Zsh, job).unwrap()
                }
                None => nip::native_foreground_plan(&source, nip::ShellFamily::Zsh).unwrap(),
            };
            let digest = nip::sha(&source);
            let bound = nip::bound_plan_digest(&digest, &plan);
            if index == 3 {
                geometry_source = source.clone();
                publish(
                    &evidence.join("geometry-live.json"),
                    &serde_json::json!({"source":source,"sourceSha256":digest,"columns":columns,"rows":30,"prefixBeforeFirstResize":source.get(..columns as usize+40)}),
                );
            }
            let prepare = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: format!("prepare-{index}"),
                identity: identity.clone(),
                payload: nip::Payload::PrepareInput {
                    source,
                    source_digest: digest.clone(),
                    plan,
                    plan_digest: bound.clone(),
                    budget_ms: 5000,
                    reduced_motion: index == 8,
                    job,
                },
            };
            native.send(&session, &prepare.encode().unwrap()).unwrap();
            if index == 3 {
                pump(
                    &mut native,
                    &mut pty,
                    &mut records,
                    &mut raw,
                    |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputProgress{applied_utf8_bytes}if applied_utf8_bytes>160)),
                );
                if live {
                    if !background {
                        let deadline = Instant::now() + Duration::from_secs(2);
                        while !evidence.join("wrapped-ready.json").exists() {
                            records.extend(drain_tick(&mut native, &mut pty, &mut raw));
                            assert!(!records.iter().any(|m|matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputConfirmed{..}))),"Actual input finished before live SSH wrap gate");
                            assert!(
                                Instant::now() < deadline,
                                "Live SSH public buffer did not observe wrapped source"
                            );
                            thread::sleep(Duration::from_millis(5));
                        }
                        let wrapped: serde_json::Value = serde_json::from_slice(
                            &fs::read(evidence.join("wrapped-ready.json")).unwrap(),
                        )
                        .unwrap();
                        assert_eq!(wrapped["sourceSha256"], digest);
                        assert_eq!(wrapped["columns"], columns);
                        assert_eq!(wrapped["wrapped"], true);
                    }
                    let query = nip::Envelope {
                        protocol: nip::PROTOCOL.into(),
                        request_id: "wrap-query-3".into(),
                        identity: identity.clone(),
                        payload: nip::Payload::Query,
                    };
                    native.send(&session, &query.encode().unwrap()).unwrap();
                    pump(
                        &mut native,
                        &mut pty,
                        &mut records,
                        &mut raw,
                        |m| matches!(m,nip::Message::Operation(e)if e.request_id==query.request_id&&matches!(&e.payload,nip::Payload::Snapshot{phase,may_have_submitted:false,..}if phase=="typing")),
                    );
                    for cols in [32, 180, 40, 100, 32, 180, 40] {
                        assert!(!records.iter().any(|m|matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputConfirmed{..}))),"Actual SSH input finished before a requested input-time resize");
                        session.set_blocking(true);
                        pty.request_pty_size(cols, 30, None, None).unwrap();
                        session.set_blocking(false);
                        resize_events.push(serde_json::json!({"offset":raw.len(),"columns":cols}));
                        publish(
                            &evidence.join("geometry-events.json"),
                            &serde_json::json!(resize_events),
                        );
                        let until = Instant::now() + Duration::from_millis(25);
                        while Instant::now() < until {
                            records.extend(drain_tick(&mut native, &mut pty, &mut raw));
                            thread::sleep(Duration::from_millis(2));
                        }
                    }
                } else {
                    session.set_blocking(true);
                    pty.request_pty_size(32, 30, None, None).unwrap();
                    session.set_blocking(false);
                }
            }
            pump(
                &mut native,
                &mut pty,
                &mut records,
                &mut raw,
                |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputConfirmed{..}|nip::Payload::ControlInputConfirmed{editor_empty:true,..})),
            );
            if index == 3 && std::env::var_os("SHELLSPAN_P3_OBSERVE_FULL_INPUT").is_some() {
                publish(
                    &evidence.join("full-input-observation.json"),
                    &serde_json::json!({"sourceDigest":digest,"holdMillis":250,"noAcceptKeyYet":true}),
                );
                let until = Instant::now() + Duration::from_millis(250);
                while Instant::now() < until {
                    records.extend(drain_tick(&mut native, &mut pty, &mut raw));
                    thread::sleep(Duration::from_millis(2));
                }
                publish(
                    &evidence.join("full-input-observation-finished.json"),
                    &serde_json::json!({"sourceDigest":digest,"noAcceptKeyYet":true}),
                );
            }
            let commit = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: format!("commit-{index}"),
                identity,
                payload: nip::Payload::Commit {
                    source_digest: digest,
                    plan_digest: bound,
                },
            };
            native.send(&session, &commit.encode().unwrap()).unwrap();
            pump(
                &mut native,
                &mut pty,
                &mut records,
                &mut raw,
                |m| matches!(m,nip::Message::Operation(e)if e.request_id==commit.request_id&&matches!(e.payload,nip::Payload::CommitArmed)),
            );
            write_all_nonblocking(
                &session,
                &mut pty,
                crate::terminal_command::editors::ZLE_ACCEPT_KEY,
            )
            .unwrap();
            pump(
                &mut native,
                &mut pty,
                &mut records,
                &mut raw,
                |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::Settled{exit_code:0})),
            );
            pump(
                &mut native,
                &mut pty,
                &mut records,
                &mut raw,
                |m| matches!(m,nip::Message::Connection(e)if matches!(&e.payload,nip::ConnectionPayload::EditorReady{after_command:Some(last),editor_empty:true,..}if last==&prepare.identity)),
            );
        }
        let text = String::from_utf8(raw.clone()).unwrap();
        assert!(text.contains("P3-SSH-INITIALIZED"));
        assert!(text.contains("P3-SSH-PERSISTED"));
        assert!(text.contains("P3-SSH-TTY-REPLY"));
        assert!(text.contains("P3-SSH-LONG"));
        assert!(records.iter().any(|m|matches!(m,nip::Message::Connection(e)if matches!(&e.payload,nip::ConnectionPayload::JobObservation{state,..}if state=="stopRequested"))));
        assert!(records.iter().any(|m|matches!(m,nip::Message::Connection(e)if matches!(&e.payload,nip::ConnectionPayload::JobObservation{handle:h,state,exit_code:Some(143)}if h==handle&&state=="finished"))));
        assert!(
            text.contains("P3-SSH-GROUP-GONE"),
            "Actual remote process API did not confirm ESRCH after stop"
        );
        let late_file = format!("p3-ssh-eof-late-{}", Uuid::new_v4());
        let source = format!("printf '%s' '{}' > \"$HOME/{late_file}\"", "x".repeat(3000));
        let digest = nip::sha(&source);
        let plan = nip::native_foreground_plan(&source, nip::ShellFamily::Zsh).unwrap();
        let bound = nip::bound_plan_digest(&digest, &plan);
        assert!(text.contains("P3-SSH-TABS"));
        let identity = nip::Identity {
            terminal_session_id: "p3-ssh-zle".into(),
            terminal_generation: 1,
            lease_id: "lease-eof".into(),
            lease_generation: 10,
            agent_session_id: "p3-agent".into(),
            task_id: "p3-task".into(),
            operation_id: "p3-ssh-eof".into(),
            command_id: "p3-command-eof".into(),
            source_revision: 1,
        };
        let prepare = nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: "prepare-eof".into(),
            identity,
            payload: nip::Payload::PrepareInput {
                source,
                source_digest: digest,
                plan,
                plan_digest: bound,
                budget_ms: 5000,
                reduced_motion: false,
                job: None,
            },
        };
        let eof_input_start = raw.len();
        native.send(&session, &prepare.encode().unwrap()).unwrap();
        pump(
            &mut native,
            &mut pty,
            &mut records,
            &mut raw,
            |m| matches!(m,nip::Message::Operation(e)if e.request_id=="prepare-eof"&&matches!(e.payload,nip::Payload::InputProgress{applied_utf8_bytes}if applied_utf8_bytes>0&&applied_utf8_bytes<3000)),
        );
        assert!(!records.iter().any(|m|matches!(m,nip::Message::Operation(e)if e.request_id=="prepare-eof"&&matches!(e.payload,nip::Payload::SubmissionAccepted|nip::Payload::Started))));
        session.set_blocking(true);
        native.control.send_eof().unwrap();
        native.control.close().unwrap();
        session.set_blocking(false);
        let enter = format!("\x1b]1337;{}\x07", nip::DISPLAY_ENTER).into_bytes();
        let leave = format!("\x1b]1337;{}\x07", nip::DISPLAY_EXIT).into_bytes();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let mut bytes = [0; 8192];
            match pty.read(&mut bytes) {
                Ok(0) if pty.eof() => panic!("The user's SSH PTY closed with its private channel"),
                Ok(n) => capture_pty(&mut raw, &bytes[..n]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("Actual EOF display boundary read failed: {error}"),
            }
            let interval = &raw[eof_input_start..];
            if let Some(start) = interval
                .windows(enter.len())
                .rposition(|value| value == enter)
            {
                if interval
                    .windows(leave.len())
                    .rposition(|value| value == leave)
                    .is_some_and(|end| end > start)
                {
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "The actual remote owned display interval did not close after private EOF"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let user=format!("[[ ${{+functions[__shellspan_nip_preexec]}} == 0 && ${{+functions[__shellspan_nip_precmd]}} == 0 && ! -e \"$HOME/{late_file}\" ]] && builtin printf '%s%s\\n' P3-SSH- USER-AFTER-EOF\r");
        write_all_nonblocking(&session, &mut pty, b"\x18z").unwrap();
        write_all_nonblocking(&session, &mut pty, user.as_bytes()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let mut bytes = [0; 8192];
            match pty.read(&mut bytes) {
                Ok(0) if pty.eof() => panic!("The user's SSH PTY closed with its private channel"),
                Ok(n) => capture_pty(&mut raw, &bytes[..n]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("Actual ordinary SSH recovery read failed: {error}"),
            }
            if String::from_utf8_lossy(&raw).contains("P3-SSH-USER-AFTER-EOF") {
                break;
            }
            assert!(Instant::now()<deadline,"Actual remote EOF did not clear only the owned prefix and restore the user's parent parser");
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            String::from_utf8_lossy(&raw).contains("\x1b]0;P3_CORE_BUDGET_0\x07"),
            "The actual new Core budget did not return to zero in ordinary SSH editing"
        );
        session.set_blocking(true);
        let sftp = session.sftp().unwrap();
        let mut file = sftp.open(Path::new("/home/nativeZle/p3-core-map")).unwrap();
        let mut mapped = String::new();
        file.read_to_string(&mut mapped).unwrap();
        assert!(
            mapped.contains(&format!("{}/scoped/zsh/zle.so", native.root)),
            "The reviewed private remote Core was not actually mapped"
        );
        fs::write(evidence.join("actual-remote-mapped-files.txt"), mapped).unwrap();
        session.set_blocking(false);
    }));
    LIVE_PTY.with(|file| drop(file.borrow_mut().take()));
    publish(
        &evidence.join("geometry.json"),
        &serde_json::json!({"source":geometry_source,"sourceSha256":nip::sha(&geometry_source),"columns":columns,"rows":30,"resizeEvents":resize_events,"kind":"actual-SSH-PTY-capture"}),
    );
    session.set_blocking(true);
    let _ = pty.close();
    drop(pty);
    native.close(&session);
    let early_outcome = if outcome.is_ok() {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            remote_early_core_preserved(&early_session, &owner, &evidence)
        }))
    } else {
        Ok(())
    };
    fs::write(evidence.join("raw.bin"), raw).unwrap();
    let mut wire = Vec::new();
    for message in records {
        wire.extend(
            match message {
                nip::Message::Connection(v) => v.encode(),
                nip::Message::Operation(v) => v.encode(),
            }
            .unwrap(),
        );
    }
    fs::write(evidence.join("control.jsonl"), wire).unwrap();
    fs::write(evidence.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":outcome.is_ok()&&early_outcome.is_ok(),"plannedOperations":10,"completedOperations":9,"actualProductionPreparation":true,"controlledScopedCore":true,"nativeAcceptance":false,"productionBindingChanged":false,"finalStopExit143AndGroupEsrch":outcome.is_ok(),"remoteEofOwnedPrefixAndOrdinaryRecovery":outcome.is_ok(),"coreScopeZeroAndMapped":outcome.is_ok(),"earlyUserCorePreserved":outcome.is_ok()&&early_outcome.is_ok(),"noSubmissionJournalProofClaimed":true,"hostKeySha256":fixture["hostKeySha256"]})).unwrap()).unwrap();
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
    if let Err(error) = early_outcome {
        std::panic::resume_unwind(error);
    }
}
