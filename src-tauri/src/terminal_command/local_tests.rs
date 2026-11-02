//! Real PreparedNativeBash startup/duplex regression, not a second listener.
use super::{local::PreparedNativeBash, protocol as nip};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

fn wait(
    rx: &mpsc::Receiver<nip::Message>,
    records: &mut Vec<nip::Message>,
    mut predicate: impl FnMut(&nip::Message) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let message = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("Actual PreparedNativeBash boundary missing");
        let found = predicate(&message);
        records.push(message);
        if found {
            return;
        }
    }
}

#[test]
#[ignore = "requires actual rebuilt Bash profiles and full frozen validation source"]
fn prepared_bash_real_submit_draft_cancel_and_running_interrupt() {
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let resources = owner.join(".artifacts/tests/native-input-p2/resources/native-input");
    let run = uuid::Uuid::new_v4().to_string();
    let evidence = owner.join(".artifacts/tests/native-input-p3/prepared-bash").join(&run);
    fs::create_dir_all(&evidence).unwrap();
    let home = evidence.join("home");
    fs::create_dir(&home).unwrap();
    fs::write(home.join(".bash_profile"), "source \"$HOME/.bashrc\"\n").unwrap();
    fs::write(
        home.join(".bashrc"),
        "PS1='\\[\\e[34m\\]P3-NATIVE> \\[\\e[0m\\]'\nPROMPT_COMMAND=\n",
    )
    .unwrap();
    fs::write(
        home.join(".inputrc"),
        "set editing-mode emacs\nset bell-style none\n",
    )
    .unwrap();
    let version = std::env::var("SHELLSPAN_P3_TEST_BASH_VERSION").unwrap_or_else(|_| "5.3".into());
    let readline = match version.as_str() {
        "4.1" => "6.0",
        "4.4" => "7.0",
        "5.3" => "8.3.6",
        _ => panic!("Unsupported actual Bash test profile"),
    };
    let target = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-arm64"
    } else if cfg!(all(
        target_os = "linux",
        target_arch = "aarch64",
        target_env = "gnu"
    )) {
        "linux-aarch64-glibc-2.36"
    } else {
        panic!("Unsupported actual Bash test target");
    };
    let profile = format!("gnu-bash-{version}-readline-{readline}-{target}-native");
    let shell = resources.join(&profile).join("bash");
    let prepared = PreparedNativeBash::prepare(&shell, &resources).unwrap();
    fs::write(
        evidence.join("verified-display-binding.json"),
        serde_json::to_vec_pretty(&prepared.profile.display_binding()).unwrap(),
    )
    .unwrap();
    assert!(prepared.profile.display_binding().unicode_version.is_none());
    assert!(prepared
        .profile
        .display_binding()
        .owned_reflow_cursor_line
        .is_none());
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 40,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(&shell);
    command.env("HOME", &home);
    command.env("TERM", "xterm-256color");
    command.env("LC_ALL", "en_US.UTF-8");
    command.cwd(&home);
    prepared.configure(&mut command).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let shell_pid = child.process_id().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let raw = Arc::new(Mutex::new(Vec::new()));
    let captured = raw.clone();
    let output = thread::spawn(move || {
        let mut bytes = [0; 8192];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 {
                break;
            }
            captured.lock().unwrap().extend_from_slice(&bytes[..n]);
        }
    });
    let (tx, rx) = mpsc::channel();
    let closed = tx.clone();
    let session_id = format!("p3-bash-{run}");
    let control = prepared.start(
        nip::ConnectionEnvelope {
            protocol: nip::PROTOCOL.into(),
            request_id: "probe".into(),
            connection: nip::ConnectionIdentity {
                terminal_session_id: session_id.clone(),
                terminal_generation: 1,
                control_id: format!("control-{run}"),
            },
            payload: nip::ConnectionPayload::Probe,
        },
        move |message| tx.send(message).map_err(|_| "Bash fixture closed".into()),
        move || drop(closed),
    );
    let mut records = Vec::new();
    let mut actual_group = None;
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait(
            &rx,
            &mut records,
            |m| matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::Capabilities{native_inline:true,editor_empty:true,..})),
        );
        // Bash reports initial emptiness in capabilities; a separate initial
        // EditorReady packet is a ZLE-specific startup requirement.
        let tab_source="P3_TABS=$'01234567890A\tB'; [[ $P3_TABS == $'01234567890A\tB' ]] && P3_BASH_PARENT='父Shell'; printf '%s%s\\n' P3-BASH- SUBMITTED".to_string();
        fs::write(evidence.join("tab-boundary.json"),serde_json::to_vec_pretty(&serde_json::json!({"source":tab_source,"sourceSha256":nip::sha(&tab_source),"columns":40,"rows":30,"prompt":"P3-NATIVE> ","prefix":"P3_TABS=$'01234567890A","tail":"B';"})).unwrap()).unwrap();
        let sources=[tab_source,format!("printf X > \"$HOME/must-not-execute\" #{}","x".repeat(3000)),"sleep 30".into(),"[[ $P3_BASH_PARENT == '父Shell' && ! -e $HOME/must-not-execute ]] && printf '%s%s\\n' P3-BASH- RESTORED".into()];
        for (index, source) in sources.into_iter().enumerate() {
            let id = nip::Identity {
                terminal_session_id: session_id.clone(),
                terminal_generation: 1,
                lease_id: format!("lease-{index}"),
                lease_generation: index as u64 + 1,
                agent_session_id: "prepared-bash-agent".into(),
                task_id: "prepared-bash-task".into(),
                operation_id: format!("operation-{index}"),
                command_id: format!("command-{index}"),
                source_revision: 1,
            };
            let digest = nip::sha(&source);
            let plan = nip::native_bash_plan(&source).unwrap();
            let bound = nip::bound_plan_digest(&digest, &plan);
            let prepare = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: format!("prepare-{index}"),
                identity: id.clone(),
                payload: nip::Payload::PrepareInput {
                    source,
                    source_digest: digest.clone(),
                    plan,
                    plan_digest: bound.clone(),
                    budget_ms: 5000,
                    reduced_motion: false,
                    job: None,
                },
            };
            control.write(&prepare.encode().unwrap()).unwrap();
            // Match SessionCommand::NativeControl(wake_editor=true): wake the
            // real Readline service widget after the ordered private frame.
            writer.write_all(b"\x18\x1e").unwrap();
            writer.flush().unwrap();
            if index == 1 {
                wait(
                    &rx,
                    &mut records,
                    |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputProgress{applied_utf8_bytes}if applied_utf8_bytes>0)||e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputConfirmed{..})),
                );
                let cancel = nip::Envelope {
                    protocol: nip::PROTOCOL.into(),
                    request_id: "cancel-draft".into(),
                    identity: id,
                    payload: nip::Payload::CancelDraft,
                };
                control.write(&cancel.encode().unwrap()).unwrap();
                wait(
                    &rx,
                    &mut records,
                    |m| matches!(m,nip::Message::Operation(e)if e.request_id==cancel.request_id&&matches!(e.payload,nip::Payload::DraftCleared{editor_empty:true})),
                );
                assert!(!home.join("must-not-execute").exists());
                continue;
            }
            wait(
                &rx,
                &mut records,
                |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputConfirmed{..})),
            );
            let commit = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: format!("commit-{index}"),
                identity: id,
                payload: nip::Payload::Commit {
                    source_digest: digest,
                    plan_digest: bound,
                },
            };
            control.write(&commit.encode().unwrap()).unwrap();
            wait(
                &rx,
                &mut records,
                |m| matches!(m,nip::Message::Operation(e)if e.request_id==commit.request_id&&matches!(e.payload,nip::Payload::CommitArmed)),
            );
            writer.write_all(b"\x18a").unwrap();
            writer.flush().unwrap();
            if index == 2 {
                wait(
                    &rx,
                    &mut records,
                    |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::Started)),
                );
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    let group = pair.master.process_group_leader().unwrap();
                    if group > 1 && group != shell_pid as i32 {
                        actual_group = Some(group);
                        break;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "Actual Bash child never owned the foreground"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                writer.write_all(b"\x03").unwrap();
                writer.flush().unwrap();
            }
            wait(
                &rx,
                &mut records,
                |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::Settled{exit_code}if exit_code==if index==2{130}else{0})),
            );
        }
        let group = actual_group.unwrap();
        assert_eq!(unsafe { libc::kill(-group, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        assert!(!home.join("must-not-execute").exists());
    }));
    child.kill().unwrap();
    child.wait().unwrap();
    drop(control);
    output.join().unwrap();
    fs::write(evidence.join("raw.bin"), &*raw.lock().unwrap()).unwrap();
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
    fs::write(evidence.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":outcome.is_ok(),"shell":shell,"shellPid":shell_pid,"actualInterruptedGroup":actual_group,"sharedPreparedStartupAndTransport":true,"realDraftCancel":outcome.is_ok(),"realForegroundInterrupt":outcome.is_ok(),"noModelOrGuiClaim":true})).unwrap()).unwrap();
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}
