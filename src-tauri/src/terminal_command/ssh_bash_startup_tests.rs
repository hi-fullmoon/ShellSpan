//! Real OpenSSH startup and fallback against an isolated Linux x86_64 account.
use super::*;
use std::{
    fs, io,
    net::TcpStream,
    path::PathBuf,
    time::{Duration, Instant},
};

#[test]
#[ignore = "requires an owned Linux x86_64 OpenSSH fixture and rebuilt production resources"]
fn real_ssh_bash_startup_fallback_preserves_predecessor_until_attachment() {
    use crate::models::{
        ManagedSession, SessionCommandSender, SessionIdentity, SessionTerminalKind,
    };
    use crate::terminal_broker::{
        TerminalBrokerInputSource, TerminalInputKind, TerminalVisibleCommandRoute,
    };

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
    assert!(
        messages.is_some(),
        "Private Bash fell back before its handshake"
    );
    let old = broker.attachment_for_transport("ssh-old").unwrap().unwrap();
    let snapshot = broker.snapshot(Some("ssh-old")).unwrap().session.unwrap();
    assert_eq!(snapshot.input_mode, nip::InputMode::NativeInline);
    assert!(snapshot.prompt_ready);
    assert_eq!(
        broker.remote_visible_command_route("ssh-old").unwrap(),
        TerminalVisibleCommandRoute::TerminalExecute
    );

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
