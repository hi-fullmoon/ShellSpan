//! Actual production startup and ZLE callbacks; no manufactured receipts.
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
fn require_macos_arm64() {
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    panic!("Native ZLE acceptance requires actual macOS arm64");
}

fn verified_test_shell(owner: &std::path::Path) -> PathBuf {
    if let Some(shell) = std::env::var_os("SHELLSPAN_P3_TEST_ZSH") {
        return shell.into();
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        super::editors::local_zle_shell(
            &owner.join(".artifacts/tests/native-input-p2/resources/native-input"),
        )
        .expect("Build the pinned private main/Core and explicitly select validation resources")
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let _ = owner;
        panic!("Actual macOS arm64 ZLE resources required")
    }
}

fn publish(path: &std::path::Path, value: &serde_json::Value) {
    let pending = path.with_extension("pending");
    fs::write(&pending, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    fs::rename(pending, path).unwrap();
}
fn scoped_observers(home: &std::path::Path) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(home.join(".zshrc"))
        .unwrap();
    file.write_all(b"\nautoload -Uz add-zle-hook-widget\np3_scope_observe() { builtin printf '{\"budget\":%d,\"cursor\":%d,\"columns\":%d,\"rows\":%d}\\n' \"$ZLE_NATIVE_APPEND\" \"$CURSOR\" \"$COLUMNS\" \"$LINES\" >> $HOME/scope-widget-observations.jsonl; }\np3_scope_snapshot() { builtin printf '{\"budget\":%d,\"cursor\":%d,\"columns\":%d,\"rows\":%d}\\n' \"$ZLE_NATIVE_APPEND\" \"$CURSOR\" \"$COLUMNS\" \"$LINES\" > $HOME/scope-last.json; }\nzle -N p3_scope_observe\nzle -N p3_scope_snapshot\nadd-zle-hook-widget line-pre-redraw p3_scope_observe\nbindkey '^Xz' p3_scope_snapshot\n").unwrap();
    file.write_all(b"bindkey -M viins '^Xz' p3_scope_snapshot\n")
        .unwrap();
}
fn scope_snapshot(writer: &mut dyn Write, home: &std::path::Path) -> serde_json::Value {
    if home.join("scope-last.json").exists() {
        fs::rename(
            home.join("scope-last.json"),
            home.join(format!("scope-prior-{}.json", uuid::Uuid::new_v4())),
        )
        .unwrap();
    }
    writer.write_all(b"\x18z").unwrap();
    writer.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(bytes) = fs::read(home.join("scope-last.json")) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                return value;
            }
        }
        assert!(
            Instant::now() < deadline,
            "Actual public Core scope widget did not respond"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn read_public_zle_history(directory: &std::path::Path) -> serde_json::Value {
    assert_eq!(
        fs::read_to_string(directory.join("ready")).unwrap(),
        "complete"
    );
    let mut entries = std::collections::BTreeMap::new();
    let mut configuration = std::collections::BTreeMap::new();
    for entry in fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        if let Some(index) = name.strip_prefix("entry-") {
            entries.insert(
                index.parse::<u64>().unwrap(),
                fs::read_to_string(entry.path()).unwrap(),
            );
        } else if name != "ready" {
            configuration.insert(name, fs::read_to_string(entry.path()).unwrap());
        }
    }
    serde_json::json!({"entries":entries.into_values().collect::<Vec<_>>(),"configuration":configuration})
}

fn public_zle_history_snapshot(
    writer: &mut dyn Write,
    home: &std::path::Path,
) -> serde_json::Value {
    let directory = home.join(format!("history-observation-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    fs::write(
        home.join("history-observation-target"),
        directory.to_str().unwrap(),
    )
    .unwrap();
    writer.write_all(b"\x18h").unwrap();
    writer.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !directory.join("ready").exists() {
        assert!(
            Instant::now() < deadline,
            "Actual public ZLE history widget did not respond"
        );
        thread::sleep(Duration::from_millis(5));
    }
    read_public_zle_history(&directory)
}

fn wait(
    messages: &mpsc::Receiver<nip::Message>,
    records: &mut Vec<nip::Message>,
    mut predicate: impl FnMut(&nip::Message) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let value = messages
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("actual ZLE private boundary missing");
        let found = predicate(&value);
        records.push(value);
        if found {
            return;
        }
    }
}

#[test]
#[ignore = "requires the actual macOS Zsh and its production native module"]
fn native_zle_private_namespace_guards_preserve_user_definitions() {
    require_macos_arm64();
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for kind in [
        "function",
        "alias",
        "global-alias",
        "widget",
        "chord",
        "scope-previous",
        "scope-applied",
        "metadata-lines",
        "metadata-rows",
        "metadata-cols",
        "early-core",
    ] {
        let run = uuid::Uuid::new_v4().to_string();
        let evidence = owner
            .join(".artifacts/tests/native-input-p3/zle-guards")
            .join(format!("{kind}-{run}"));
        let home = evidence.join("home");
        fs::create_dir_all(&home).unwrap();
        let definition=match kind {
            "function"=>"__shellspan_nip_precmd() { builtin printf '%s' USER_FUNCTION; }; builtin print -r -- $functions[__shellspan_nip_precmd] > $HOME/before-definition",
            "alias"=>"alias __shellspan_nip_dispatch=p3_user_snapshot; builtin alias __shellspan_nip_dispatch > $HOME/before-definition",
            "global-alias"=>"alias -g __shellspan_nip_dispatch=p3_user_snapshot; builtin alias -g '__shellspan_nip_dispatch' > $HOME/before-definition",
            "widget"=>"zle -N __shellspan_nip_dispatch p3_user_snapshot; builtin zle -lL __shellspan_nip_dispatch > $HOME/before-definition",
            "chord"=>"builtin bindkey '^Xa' p3_user_snapshot; builtin bindkey '^Xa' > $HOME/before-definition",
            "scope-previous"=>"typeset -g __shellspan_nip_scope_previous=USER_KEEP; builtin typeset -p __shellspan_nip_scope_previous > $HOME/before-definition",
            "scope-applied"=>"typeset -g __shellspan_nip_scope_applied=USER_KEEP; builtin typeset -p __shellspan_nip_scope_applied > $HOME/before-definition",
            "metadata-lines"=>"typeset -g SS_NIP_DISPLAY_LINES=USER_KEEP; builtin typeset -p SS_NIP_DISPLAY_LINES > $HOME/before-definition",
            "metadata-rows"=>"typeset -g SS_NIP_KERNEL_ROWS=USER_KEEP; builtin typeset -p SS_NIP_KERNEL_ROWS > $HOME/before-definition",
            "metadata-cols"=>"typeset -g SS_NIP_KERNEL_COLS=USER_KEEP; builtin typeset -p SS_NIP_KERNEL_COLS > $HOME/before-definition",
            "early-core"=>"builtin typeset -p P3_EARLY_DATA > $HOME/before-definition",
            _=>unreachable!(),
        };
        fs::write(home.join(".zshrc"),format!("PROMPT='P3-GUARD> '\np3_user_snapshot() {{ builtin printf '%s' USER_WIDGET > $HOME/user-widget; }}\nzle -N p3_user_snapshot\nbindkey '^Xg' p3_user_snapshot\n{definition}\n")).unwrap();
        if kind == "early-core" {
            fs::write(home.join(".zshenv"),"P3_ENV_COUNT=$(( ${P3_ENV_COUNT:-0}+1 ))\nbuiltin printf '%s' \"$P3_ENV_COUNT\" > $HOME/env-count\ntypeset -g P3_EARLY_DATA=USER_KEEP\nzmodload zsh/zle\np3_early_widget() { builtin printf '%s' EARLY_WIDGET > $HOME/early-widget; }\nzle -N p3_early_widget\nbindkey '^Xy' p3_early_widget\n").unwrap();
            fs::write(
                home.join(".zprofile"),
                "builtin printf 1 > $HOME/profile-loaded\n",
            )
            .unwrap();
            fs::write(
                home.join(".zlogin"),
                "builtin printf 1 > $HOME/login-loaded\n",
            )
            .unwrap();
        }
        let shell = verified_test_shell(&owner);
        let prepared = PreparedNativeBash::prepare(
            &shell,
            &owner.join(".artifacts/tests/native-input-p2/resources/native-input"),
        )
        .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(&shell);
        command.env("HOME", &home);
        command.env("LC_ALL", "en_US.UTF-8");
        command.env("TERM", "xterm-256color");
        command.cwd(&home);
        prepared.configure(&mut command).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
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
        let (closed_tx, closed_rx) = mpsc::channel();
        let control = prepared.start(
            nip::ConnectionEnvelope {
                protocol: nip::PROTOCOL.into(),
                request_id: "probe".into(),
                connection: nip::ConnectionIdentity {
                    terminal_session_id: run.clone(),
                    terminal_generation: 1,
                    control_id: run,
                },
                payload: nip::ConnectionPayload::Probe,
            },
            move |message| tx.send(message).map_err(|_| "guard fixture ended".into()),
            move || {
                let _ = closed_tx.send(());
            },
        );
        let mut records = Vec::new();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            closed_rx.recv_timeout(Duration::from_secs(8)).expect("A real reserved user definition or early Core was overwritten instead of refusing the private binding");
            records.extend(rx.try_iter());
            assert!(!records.iter().any(|m|matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::Capabilities{native_inline:true,..}))));
            let deadline = Instant::now() + Duration::from_secs(3);
            while !raw
                .lock()
                .unwrap()
                .windows(8)
                .any(|value| value == b"\x1b[?2004h")
            {
                assert!(
                    Instant::now() < deadline,
                    "Refused provider prevented the ordinary native editor"
                );
                thread::sleep(Duration::from_millis(5));
            }
            writer.write_all(b"\x18g").unwrap();
            writer.flush().unwrap();
            let inspect = match kind {
                "function" => "builtin print -r -- $functions[__shellspan_nip_precmd]",
                "alias" => "builtin alias __shellspan_nip_dispatch",
                "global-alias" => "builtin alias -g '__shellspan_nip_dispatch'",
                "widget" => "builtin zle -lL __shellspan_nip_dispatch",
                "chord" => "builtin bindkey '^Xa'",
                "scope-previous" => "builtin typeset -p __shellspan_nip_scope_previous",
                "scope-applied" => "builtin typeset -p __shellspan_nip_scope_applied",
                "metadata-lines" => "builtin typeset -p SS_NIP_DISPLAY_LINES",
                "metadata-rows" => "builtin typeset -p SS_NIP_KERNEL_ROWS",
                "metadata-cols" => "builtin typeset -p SS_NIP_KERNEL_COLS",
                "early-core" => "builtin typeset -p P3_EARLY_DATA",
                _ => unreachable!(),
            };
            writer.write_all(format!("{inspect} > $HOME/after-definition; builtin printf '%s%s' USER_ PARSER > $HOME/user-parser\r").as_bytes()).unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !home.join("user-parser").exists() {
                assert!(
                    Instant::now() < deadline,
                    "Ordinary user parser did not survive the native guard refusal"
                );
                thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(fs::read(home.join("user-widget")).unwrap(), b"USER_WIDGET");
            assert_eq!(fs::read(home.join("user-parser")).unwrap(), b"USER_PARSER");
            let original = fs::read(home.join("before-definition")).unwrap();
            assert!(
                !original.is_empty(),
                "The actual user's {kind} definition was not captured"
            );
            assert_eq!(
                original,
                fs::read(home.join("after-definition")).unwrap(),
                "The user's real {kind} definition changed"
            );
            if kind == "early-core" {
                writer.write_all(b"\x18y").unwrap();
                writer.flush().unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while !home.join("early-widget").exists() {
                    assert!(
                        Instant::now() < deadline,
                        "Existing early widget was lost when native declined"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                assert_eq!(
                    fs::read(home.join("early-widget")).unwrap(),
                    b"EARLY_WIDGET"
                );
                for name in ["env-count", "profile-loaded", "login-loaded"] {
                    assert_eq!(
                        fs::read(home.join(name)).unwrap(),
                        b"1",
                        "Original user startup order/count changed for {name}"
                    );
                }
            }
        }));
        drop(control);
        let _ = child.kill();
        let _ = child.wait();
        drop(writer);
        drop(pair.master);
        let _ = output.join();
        fs::write(evidence.join("raw.bin"), &*raw.lock().unwrap()).unwrap();
        let wire: Vec<_> = records
            .into_iter()
            .flat_map(|m| match m {
                nip::Message::Connection(v) => v.encode().unwrap(),
                nip::Message::Operation(v) => v.encode().unwrap(),
            })
            .collect();
        fs::write(evidence.join("control.jsonl"), wire).unwrap();
        publish(
            &evidence.join("result.json"),
            &serde_json::json!({"ok":outcome.is_ok(),"kind":kind,"realUnsupportedBinding":true,"noModel":true,"noNativeInputProofClaimed":true}),
        );
        if let Err(error) = outcome {
            std::panic::resume_unwind(error);
        }
    }
}

#[test]
#[ignore = "requires the actual macOS system Zsh and rebuilt native module"]
fn native_zle_private_eof_preserves_ordinary_input_and_user_hooks() {
    require_macos_arm64();
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for phase in [
        "idle",
        "typing",
        "malformed-control",
        "partial-eof",
        "armed",
        "returned",
        "duplicate-control",
        "accepted-before-parent",
        "race-key-before-eof",
        "race-key-after-eof",
        "user-changed",
        "user-map",
        "user-draft",
        "changed-draft",
    ] {
        let run = uuid::Uuid::new_v4().to_string();
        let evidence = owner
            .join(".artifacts/tests/native-input-p3/zle-eof")
            .join(format!("{phase}-{run}"));
        fs::create_dir_all(&evidence).unwrap();
        let home = evidence.join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join(".zshrc"), "PROMPT='P3-EOF> '\nHISTFILE=$HOME/history\nHISTSIZE=100\nSAVEHIST=100\np3_user_precmd() { :; }\nprecmd_functions+=(p3_user_precmd)\np3_user_snapshot() { builtin print -rn -- \"$BUFFER\" > $HOME/actual-draft; if builtin ss_nip pending-handoff; then builtin printf 1 > $HOME/pending-handoff; else builtin printf 0 > $HOME/pending-handoff; fi; }\nzle -N p3_user_snapshot\nbindkey '^Xg' p3_user_snapshot\n").unwrap();
        let mut startup = fs::OpenOptions::new()
            .append(true)
            .open(home.join(".zshrc"))
            .unwrap();
        startup.write_all(b"autoload -Uz add-zle-hook-widget\np3_user_finish_gate() {\n [[ -f $HOME/hold-handoff && ${P3_GATE_USED-0} == 0 ]] || return 0\n P3_GATE_USED=1\n builtin print -rn -- \"$BUFFER\" > $HOME/gate-buffer\n builtin print -rn -- \"$CURSOR\" > $HOME/gate-cursor\n if builtin ss_nip pending-handoff; then builtin printf 1 > $HOME/gate-accepted; else builtin printf 0 > $HOME/gate-accepted; fi\n local gate_value\n IFS= read -r gate_value < $HOME/handoff.fifo\n}\nzle -N p3_user_finish_gate\nadd-zle-hook-widget line-finish p3_user_finish_gate\n").unwrap();
        startup.write_all(b"p3_user_edit() { BUFFER+=' #USER_MOD'; CURSOR=${#BUFFER}; }\nzle -N p3_user_edit\nbindkey '^Xh' p3_user_edit\n").unwrap();
        drop(startup);
        scoped_observers(&home);
        let shell = verified_test_shell(&owner);
        let prepared = PreparedNativeBash::prepare(
            &shell,
            &owner.join(".artifacts/tests/native-input-p2/resources/native-input"),
        )
        .unwrap();
        let eof_display_binding = prepared.profile.display_binding();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(&shell);
        command.env("HOME", &home);
        command.env("LC_ALL", "en_US.UTF-8");
        command.env("TERM", "xterm-256color");
        command.cwd(&home);
        prepared.configure(&mut command).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
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
        let control = prepared.start(
            nip::ConnectionEnvelope {
                protocol: nip::PROTOCOL.into(),
                request_id: "probe".into(),
                connection: nip::ConnectionIdentity {
                    terminal_session_id: run.clone(),
                    terminal_generation: 1,
                    control_id: run.clone(),
                },
                payload: nip::ConnectionPayload::Probe,
            },
            move |message| tx.send(message).map_err(|_| "fixture ended".into()),
            || {},
        );
        let mut records = Vec::new();
        let mut local_accepted_pending_observed = false;
        let mut changed_draft: Option<Vec<u8>> = None;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait(
                &rx,
                &mut records,
                |m| matches!(m, nip::Message::Connection(e) if matches!(e.payload, nip::ConnectionPayload::EditorReady { editor_empty: true, .. })),
            );
            publish(
                &evidence.join("verified-display-binding.json"),
                &serde_json::to_value(&eof_display_binding).unwrap(),
            );
            let raw_deadline = Instant::now() + Duration::from_secs(2);
            while pair.master.get_termios().unwrap().local_flags.bits() & libc::ICANON != 0 {
                assert!(
                    Instant::now() < raw_deadline,
                    "The real editor did not enter its native terminal mode"
                );
                thread::sleep(Duration::from_millis(5));
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            while !raw
                .lock()
                .unwrap()
                .windows(8)
                .any(|bytes| bytes == b"\x1b[?2004h")
            {
                assert!(
                    Instant::now() < deadline,
                    "Actual editor activation output missing before the user's widget"
                );
                thread::sleep(Duration::from_millis(5));
            }
            writer.write_all(b"\x18g").unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !home.join("actual-draft").exists() {
                assert!(
                    Instant::now() < deadline,
                    "The user's observation widget was unavailable before EOF"
                );
                thread::sleep(Duration::from_millis(5));
            }
            fs::rename(
                home.join("actual-draft"),
                evidence.join("before-eof-draft.bin"),
            )
            .unwrap();
            assert_eq!(
                scope_snapshot(&mut *writer, &home)["budget"],
                0,
                "Ordinary initial editor inherited an Agent paint budget"
            );
            if phase == "changed-draft" {
                let source = format!("printf '%s' '{}' > late-effect", "x".repeat(3000));
                let plan = nip::native_foreground_plan(&source, nip::ShellFamily::Zsh).unwrap();
                let digest = nip::sha(&source);
                let bound = nip::bound_plan_digest(&digest, &plan);
                let identity = nip::Identity {
                    terminal_session_id: run.clone(),
                    terminal_generation: 1,
                    lease_id: run.clone(),
                    lease_generation: 1,
                    agent_session_id: run.clone(),
                    task_id: run.clone(),
                    operation_id: run.clone(),
                    command_id: run.clone(),
                    source_revision: 1,
                };
                control
                    .write(
                        &nip::Envelope {
                            protocol: nip::PROTOCOL.into(),
                            request_id: "prepare-changed".into(),
                            identity,
                            payload: nip::Payload::PrepareInput {
                                source: source.clone(),
                                source_digest: digest,
                                plan,
                                plan_digest: bound,
                                budget_ms: 5000,
                                reduced_motion: false,
                                job: None,
                            },
                        }
                        .encode()
                        .unwrap(),
                    )
                    .unwrap();
                wait(
                    &rx,
                    &mut records,
                    |m| matches!(m,nip::Message::Operation(e)if e.request_id=="prepare-changed"&&matches!(e.payload,nip::Payload::InputConfirmed{..})),
                );
                writer.write_all(b"\x18h\x18g").unwrap();
                writer.flush().unwrap();
                let expected = format!("{source} #USER_MOD").into_bytes();
                let deadline = Instant::now() + Duration::from_secs(3);
                while fs::read(home.join("actual-draft")).ok().as_deref()
                    != Some(expected.as_slice())
                {
                    assert!(
                        Instant::now() < deadline,
                        "The actual user's native edit was not observed before EOF"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                fs::rename(
                    home.join("actual-draft"),
                    evidence.join("user-edit-before-eof.bin"),
                )
                .unwrap();
                changed_draft = Some(expected);
            }
            if matches!(
                phase,
                "typing"
                    | "malformed-control"
                    | "partial-eof"
                    | "armed"
                    | "returned"
                    | "duplicate-control"
                    | "accepted-before-parent"
                    | "race-key-before-eof"
                    | "race-key-after-eof"
            ) {
                let source = if matches!(phase, "typing" | "malformed-control" | "partial-eof") {
                    format!("printf '%s' '{}' > late-effect", "x".repeat(3000))
                } else if phase == "armed" {
                    "printf '%s' P3_ARMED > late-effect".into()
                } else if phase.starts_with("race-")
                    || matches!(phase, "accepted-before-parent" | "duplicate-control")
                {
                    "printf X >> possible-effect".into()
                } else {
                    "printf '%s%s\\n' P3-EOF- RETURNED".into()
                };
                let actual_source = source.clone();
                let plan = nip::native_foreground_plan(&source, nip::ShellFamily::Zsh).unwrap();
                let source_digest = nip::sha(&source);
                let plan_digest = nip::bound_plan_digest(&source_digest, &plan);
                let id = nip::Identity {
                    terminal_session_id: run.clone(),
                    terminal_generation: 1,
                    lease_id: run.clone(),
                    lease_generation: 1,
                    agent_session_id: run.clone(),
                    task_id: run.clone(),
                    operation_id: run.clone(),
                    command_id: run.clone(),
                    source_revision: 1,
                };
                let prepare = nip::Envelope {
                    protocol: nip::PROTOCOL.into(),
                    request_id: "prepare".into(),
                    identity: id.clone(),
                    payload: nip::Payload::PrepareInput {
                        source,
                        source_digest: source_digest.clone(),
                        plan,
                        plan_digest: plan_digest.clone(),
                        budget_ms: 5000,
                        reduced_motion: false,
                        job: None,
                    },
                };
                control.write(&prepare.encode().unwrap()).unwrap();
                if matches!(phase, "typing" | "malformed-control" | "partial-eof") {
                    wait(
                        &rx,
                        &mut records,
                        |m| matches!(m, nip::Message::Operation(e) if matches!(e.payload, nip::Payload::InputProgress { applied_utf8_bytes } if applied_utf8_bytes > 0 && applied_utf8_bytes < 3000)),
                    );
                    if phase != "typing" {
                        let bytes: &[u8] = if phase == "malformed-control" {
                            b"\xff\n"
                        } else {
                            b"{\"protocol\":"
                        };
                        fs::write(evidence.join("injected-control-request.bin"), bytes).unwrap();
                        control.write(bytes).unwrap();
                    }
                } else {
                    wait(
                        &rx,
                        &mut records,
                        |m| matches!(m, nip::Message::Operation(e) if matches!(e.payload, nip::Payload::InputConfirmed { .. })),
                    );
                    let commit = nip::Envelope {
                        protocol: nip::PROTOCOL.into(),
                        request_id: "commit".into(),
                        identity: id,
                        payload: nip::Payload::Commit {
                            source_digest,
                            plan_digest,
                        },
                    }
                    .encode()
                    .unwrap();
                    control.write(&commit).unwrap();
                    wait(
                        &rx,
                        &mut records,
                        |m| matches!(m, nip::Message::Operation(e) if matches!(e.payload, nip::Payload::CommitArmed)),
                    );
                    if phase == "returned" || phase == "duplicate-control" {
                        writer.write_all(b"\x18a").unwrap();
                        writer.flush().unwrap();
                        wait(
                            &rx,
                            &mut records,
                            |m| matches!(m, nip::Message::Operation(e) if matches!(e.payload, nip::Payload::Settled { exit_code: 0 })),
                        );
                        wait(
                            &rx,
                            &mut records,
                            |m| matches!(m, nip::Message::Connection(e) if matches!(e.payload, nip::ConnectionPayload::EditorReady { editor_empty: true, .. })),
                        );
                    }
                    if phase == "duplicate-control" {
                        control.write(&commit).unwrap();
                        wait(
                            &rx,
                            &mut records,
                            |m| matches!(m,nip::Message::Operation(e)if e.request_id=="commit"&&matches!(e.payload,nip::Payload::Rejected{code:nip::ErrorCode::DuplicateRequest})),
                        );
                        writer.write_all(b"\x18a").unwrap();
                        writer.flush().unwrap();
                    }
                    if phase == "race-key-before-eof" {
                        writer.write_all(b"\x18a").unwrap();
                        writer.flush().unwrap();
                    }
                    if phase == "accepted-before-parent" {
                        let fifo =
                            std::ffi::CString::new(home.join("handoff.fifo").to_str().unwrap())
                                .unwrap();
                        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
                        fs::write(
                            home.join("hold-handoff"),
                            b"one-use public user line-finish gate",
                        )
                        .unwrap();
                        writer.write_all(b"\x18a").unwrap();
                        writer.flush().unwrap();
                        wait(
                            &rx,
                            &mut records,
                            |m| matches!(m, nip::Message::Operation(e) if matches!(e.payload, nip::Payload::SubmissionAccepted)),
                        );
                        let deadline = Instant::now() + Duration::from_secs(3);
                        while fs::read(home.join("gate-accepted")).ok().as_deref() != Some(b"1")
                            || fs::read(home.join("gate-buffer")).ok().as_deref()
                                != Some(actual_source.as_bytes())
                        {
                            assert!(Instant::now() < deadline, "Actual accepted source did not reach the public user line-finish gate");
                            thread::sleep(Duration::from_millis(5));
                        }
                        assert_eq!(
                            fs::read_to_string(home.join("gate-cursor"))
                                .unwrap()
                                .parse::<usize>()
                                .unwrap(),
                            actual_source.chars().count()
                        );
                        assert!(
                            !home.join("possible-effect").exists(),
                            "Source executed before its actual parent handoff"
                        );
                        local_accepted_pending_observed = true;
                    }
                }
            }
            if phase == "user-changed" {
                let before = raw.lock().unwrap().len();
                writer.write_all(b"__shellspan_nip_precmd() { p3_user_precmd; }; builtin bindkey '^Xa' backward-char\r").unwrap();
                writer.flush().unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while !raw.lock().unwrap()[before..]
                    .windows(8)
                    .any(|bytes| bytes == b"\x1b[?2004h")
                {
                    assert!(
                        Instant::now() < deadline,
                        "User hook/key changes did not return to the real editor"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
            }
            if phase == "user-map" {
                let before = raw.lock().unwrap().len();
                writer
                    .write_all(
                        b"builtin bindkey -M viins '^Xg' p3_user_snapshot; builtin bindkey -v\r",
                    )
                    .unwrap();
                writer.flush().unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while !raw.lock().unwrap()[before..]
                    .windows(8)
                    .any(|bytes| bytes == b"\x1b[?2004h")
                {
                    assert!(
                        Instant::now() < deadline,
                        "The user's new main keymap did not become active"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
            }
            let user_draft = "printf '%s' '用户自己的草稿'";
            if phase == "user-draft" {
                writer.write_all(user_draft.as_bytes()).unwrap();
                writer.write_all(b"\x18g").unwrap();
                writer.flush().unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while fs::read(home.join("actual-draft")).ok().as_deref()
                    != Some(user_draft.as_bytes())
                {
                    assert!(
                        Instant::now() < deadline,
                        "The actual user's complete draft was not observed before EOF"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                fs::rename(
                    home.join("actual-draft"),
                    evidence.join("user-draft-before-eof.bin"),
                )
                .unwrap();
            }
            drop(control);
            records.extend(rx.try_iter());
            if phase == "accepted-before-parent" {
                use std::os::unix::fs::OpenOptionsExt;
                let deadline = Instant::now() + Duration::from_secs(2);
                let mut release = loop {
                    match fs::OpenOptions::new()
                        .write(true)
                        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                        .open(home.join("handoff.fifo"))
                    {
                        Ok(file) => break file,
                        Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                            assert!(
                                Instant::now() < deadline,
                                "Actual user gate did not open its FIFO reader"
                            );
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("Actual owned FIFO open failed: {error}"),
                    }
                };
                release.write_all(b"continue\n").unwrap();
            }
            if phase == "race-key-after-eof" {
                writer.write_all(b"\x18a").unwrap();
                writer.flush().unwrap();
            }
            // The private FD's real EOF callback runs before this normal user
            // observation widget; no protocol receipt is supplied by the test.
            thread::sleep(Duration::from_millis(100));
            writer.write_all(b"\x18g").unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            let expected_draft = if phase == "user-draft" {
                user_draft.as_bytes()
            } else {
                changed_draft.as_deref().unwrap_or(b"")
            };
            while fs::read(home.join("actual-draft")).ok().as_deref() != Some(expected_draft) {
                assert!(Instant::now() < deadline, "The user widget, exact owned-prefix cleanup or user's draft preservation failed after actual EOF");
                thread::sleep(Duration::from_millis(5));
            }
            let draft = fs::read(home.join("actual-draft")).unwrap();
            fs::write(evidence.join("observed-draft.bin"), &draft).unwrap();
            assert_eq!(draft, expected_draft);
            if phase == "user-draft" || phase == "changed-draft" {
                fs::rename(
                    home.join("actual-draft"),
                    evidence.join("user-draft-after-eof.bin"),
                )
                .unwrap();
                let before = raw.lock().unwrap().len();
                writer.write_all(b"\x03").unwrap();
                writer.flush().unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while !raw.lock().unwrap()[before..]
                    .windows(8)
                    .any(|bytes| bytes == b"\x1b[?2004h")
                {
                    assert!(
                        Instant::now() < deadline,
                        "User Ctrl+C did not return to the actual editor"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                writer.write_all(b"\x18g").unwrap();
                writer.flush().unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while fs::read(home.join("actual-draft")).ok().as_deref() != Some(b"") {
                    assert!(
                        Instant::now() < deadline,
                        "User Ctrl+C did not clear the user's own draft normally"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
            }
            let inspect = "builtin print -r -- ${+functions[__shellspan_nip_preexec]} ${+functions[__shellspan_nip_precmd]} ${widgets[__shellspan_nip_line_init]-missing} ${widgets[__shellspan_nip_line_finish]-missing} ${precmd_functions[(I)p3_user_precmd]} > actual-hooks; builtin bindkey '^Xa' >> actual-hooks; builtin bindkey '^Xg' >> actual-hooks; builtin printf '%s%s\\n' P3-ORDINARY- AFTER-EOF > ordinary-result\r";
            writer.write_all(inspect.as_bytes()).unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !home.join("ordinary-result").exists() {
                assert!(
                    Instant::now() < deadline,
                    "The normal parent parser did not execute after EOF"
                );
                thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                fs::read_to_string(home.join("ordinary-result")).unwrap(),
                "P3-ORDINARY-AFTER-EOF\n"
            );
            let hooks = fs::read_to_string(home.join("actual-hooks")).unwrap();
            assert!(
                hooks.starts_with(if phase == "user-changed" {
                    "0 1 missing missing "
                } else {
                    "0 0 missing missing "
                }),
                "Owned hooks remain or the user's redefined hook was removed: {hooks}"
            );
            assert!(
                !hooks.lines().next().unwrap().ends_with(" 0"),
                "The user's existing precmd hook was removed"
            );
            assert!(
                hooks.contains(if phase == "user-changed" {
                    "backward-char"
                } else {
                    "undefined-key"
                }) && hooks.contains("p3_user_snapshot")
            );
            if phase == "user-map" {
                writer.write_all(b"builtin bindkey -M emacs '^Xa' > old-map; builtin bindkey -lL main >> old-map; builtin bindkey -M viins '^Xg' >> old-map\r").unwrap();
                writer.flush().unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while fs::read_to_string(home.join("old-map"))
                    .ok()
                    .is_none_or(|value| !value.contains("p3_user_snapshot"))
                {
                    assert!(
                        Instant::now() < deadline,
                        "Actual keymap cleanup inspection did not finish"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                let maps = fs::read_to_string(home.join("old-map")).unwrap();
                assert!(
                    maps.contains("undefined-key")
                        && maps.contains("bindkey -A viins main")
                        && !maps.contains("__shellspan_nip_accept"),
                    "Old owned mapping or user's main alias changed: {maps}"
                );
            }
            assert!(!home.join("late-effect").exists());
            assert_eq!(
                scope_snapshot(&mut *writer, &home)["budget"],
                0,
                "Failed or completed Agent scope leaked its Core budget into ordinary editing"
            );
            if phase == "accepted-before-parent" {
                assert!(!home.join("possible-effect").exists());
                assert_eq!(fs::read(home.join("pending-handoff")).unwrap(), b"0");
            }
            if phase == "duplicate-control" {
                assert_eq!(
                    fs::read(home.join("possible-effect")).unwrap(),
                    b"X",
                    "The repeated real commit/key executed the source twice"
                );
                assert_eq!(records.iter().filter(|m|matches!(m,nip::Message::Operation(e)if matches!(e.payload,nip::Payload::SubmissionAccepted))).count(),1);
            }
            if phase.starts_with("race-") {
                let effect = fs::read(home.join("possible-effect")).unwrap_or_else(|error| {
                    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
                    Vec::new()
                });
                assert!(
                    effect.is_empty() || effect == b"X",
                    "Actual side effect occurred more than once: {effect:?}"
                );
                assert!(records.iter().filter(|m| matches!(m, nip::Message::Operation(e) if matches!(e.payload, nip::Payload::SubmissionAccepted))).count() <= 1);
            }
            let bytes = raw.lock().unwrap();
            let enter = b"\x1b]1337;SetUserVar=ShellSpanNativeInput=MQ==\x07";
            let leave = b"\x1b]1337;SetUserVar=ShellSpanNativeInput=MA==\x07";
            if let Some(last_enter) = bytes.windows(enter.len()).rposition(|value| value == enter) {
                assert!(
                    bytes
                        .windows(leave.len())
                        .rposition(|value| value == leave)
                        .is_some_and(|last_leave| last_leave > last_enter),
                    "Actual native display interval did not end after EOF cleanup"
                );
            }
        }));
        fs::write(
            evidence.join("shell-before-cleanup.txt"),
            format!("{:?}", child.try_wait()),
        )
        .unwrap();
        let actual = std::process::Command::new("/bin/ps")
            .args([
                "-p",
                &child.process_id().unwrap().to_string(),
                "-o",
                "pid,ppid,pgid,blocked,pending,stat,wchan,comm",
            ])
            .output()
            .unwrap();
        fs::write(
            evidence.join("actual-process-before-cleanup.txt"),
            actual.stdout,
        )
        .unwrap();
        let _ = child.kill();
        let _ = child.wait();
        drop(writer);
        drop(pair.master);
        let _ = output.join();
        fs::write(evidence.join("raw.bin"), &*raw.lock().unwrap()).unwrap();
        let accepted_observed = records.iter().any(|m| matches!(m, nip::Message::Operation(e) if matches!(e.payload, nip::Payload::SubmissionAccepted)));
        let wire: Vec<_> = records
            .into_iter()
            .flat_map(|message| match message {
                nip::Message::Connection(v) => v.encode().unwrap(),
                nip::Message::Operation(v) => v.encode().unwrap(),
            })
            .collect();
        fs::write(evidence.join("control.jsonl"), wire).unwrap();
        publish(
            &evidence.join("result.json"),
            &serde_json::json!({"ok":outcome.is_ok(),"phase":phase,"realPrivateEof":true,"noModel":true,"noSubmissionJournalProofClaimed":true,"physicalAcceptKeyWrites":if phase=="duplicate-control"{2}else if phase=="returned"||phase.starts_with("race-")||phase=="accepted-before-parent"{1}else{0},"repeatInjectedByFixture":phase=="duplicate-control","controlFailure":if phase=="malformed-control"{"malformed-frame"}else if phase=="partial-eof"{"partial-frame-eof"}else{"eof"},"submissionAcceptedObserved":accepted_observed,"localAcceptedPendingObserved":local_accepted_pending_observed,"publicUserProgramGate":phase=="accepted-before-parent","agentOperationAtDisconnect":if phase=="returned"||phase=="duplicate-control"{"settled"}else if phase.starts_with("race-")||phase=="accepted-before-parent"{"possiblySubmitted"}else if matches!(phase,"typing"|"malformed-control"|"partial-eof"|"armed"|"changed-draft"){"notAccepted"}else{"absent"},"actualEffectBytes":fs::read(home.join("possible-effect")).ok().map(|bytes|bytes.len())}),
        );
        if let Err(error) = outcome {
            std::panic::resume_unwind(error);
        }
    }
}
#[test]
#[ignore = "requires actual macOS ZLE, rebuilt resource and the real Broker/private channel"]
fn native_editor_default_admission_is_closed() {
    assert!(std::env::var_os("SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT").is_none());
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let resources = owner.join(".artifacts/tests/native-input-p2/resources/native-input");
    let evidence = owner
        .join(".artifacts/tests/native-input-p3/editor-admission")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    let catalogue = super::editors::read_catalogue(&resources, "macos-arm64").err();
    assert_eq!(
        catalogue.as_deref(),
        Some("TERMINAL_NATIVE_PROFILE_NOT_ACCEPTED")
    );
    let prepare = PreparedNativeBash::prepare(std::path::Path::new("/bin/zsh"), &resources).err();
    assert_eq!(
        prepare.as_deref(),
        Some("TERMINAL_NATIVE_PROFILE_NOT_ACCEPTED")
    );
    publish(
        &evidence.join("result.json"),
        &serde_json::json!({"ok":true,"realSourceMatchingCatalogueRejectedWithoutValidation":true,"prepareRejectedBeforeArtifactCopy":true,"catalogueError":catalogue,"prepareError":prepare,"noNativeExecutionClaim":true,"nativeAcceptance":false}),
    );
}

#[test]
#[ignore = "requires the real rebuilt pinned macOS private Zsh executable"]
fn native_zle_private_main_resources_reject_invalid_paths_and_bytes() {
    require_macos_arm64();
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let resources = owner.join(".artifacts/tests/native-input-p2/resources/native-input");
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(resources.join("editors-macos-arm64.json")).unwrap())
            .unwrap();
    let id = original["profiles"][0]["profile"]["verifiedProfileId"]
        .as_str()
        .unwrap();
    let source = resources.join(original["profiles"][0]["shell"].as_str().unwrap());
    let evidence = owner
        .join(".artifacts/tests/native-input-p3/private-main-admission")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    let mut cases = Vec::new();
    for kind in [
        "traversal",
        "absolute",
        "other-profile",
        "missing",
        "tampered",
        "symlink",
        "missing-macos-refresh-source",
        "unselected-valid",
    ] {
        let root = evidence.join(kind);
        fs::create_dir(&root).unwrap();
        let mut catalogue = original.clone();
        let relative = format!("{id}/zsh");
        let destination = root.join(&relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let expected = match kind {
            "traversal" => {
                catalogue["profiles"][0]["shell"] = "../zsh".into();
                "TERMINAL_NATIVE_MANIFEST_INVALID"
            }
            "absolute" => {
                catalogue["profiles"][0]["shell"] = source.to_str().unwrap().into();
                "TERMINAL_NATIVE_MANIFEST_INVALID"
            }
            "other-profile" => {
                catalogue["profiles"][0]["shell"] = "other/zsh".into();
                "TERMINAL_NATIVE_MANIFEST_INVALID"
            }
            "missing" => "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE",
            "tampered" => {
                let mut bytes = fs::read(&source).unwrap();
                bytes[0] ^= 1;
                fs::write(&destination, bytes).unwrap();
                "TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH"
            }
            "symlink" => {
                let retained = root.join("original-zsh");
                fs::copy(&source, &retained).unwrap();
                std::os::unix::fs::symlink(&retained, &destination).unwrap();
                "TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH"
            }
            "missing-macos-refresh-source" => {
                catalogue["sources"]
                    .as_object_mut()
                    .unwrap()
                    .remove("scripts/dependency-builds/zsh/native-macos-refresh.patch");
                fs::copy(&source, &destination).unwrap();
                "TERMINAL_NATIVE_MANIFEST_INVALID"
            }
            "unselected-valid" => {
                fs::copy(&source, &destination).unwrap();
                "TERMINAL_NATIVE_PROFILE_NOT_ACCEPTED"
            }
            _ => unreachable!(),
        };
        fs::write(
            root.join("editors-macos-arm64.json"),
            serde_json::to_vec_pretty(&catalogue).unwrap(),
        )
        .unwrap();
        let error = super::editors::read_catalogue(&root, "macos-arm64").err();
        assert_eq!(
            error.as_deref(),
            Some(expected),
            "Incorrect rejection for {kind}"
        );
        assert_eq!(
            PreparedNativeBash::prepare(&source, &root).err().as_deref(),
            Some(expected)
        );
        cases.push(serde_json::json!({"kind":kind,"error":error}));
    }
    publish(
        &evidence.join("result.json"),
        &serde_json::json!({"ok":true,"cases":cases,"realPrivateMainBytes":true,"executions":0,"nativeAcceptance":false}),
    );
}

#[test]
#[ignore = "requires actual macOS ZLE, rebuilt resource and the real Broker/private channel"]
fn native_zle_manifest_paths_reject_before_prepare() {
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let resources = owner.join(".artifacts/tests/native-input-p2/resources/native-input");
    let target = "macos-arm64";
    let actual = super::editors::read_catalogue(&resources, target).unwrap();
    assert!(!actual.is_empty());
    let evidence = owner
        .join(".artifacts/tests/native-input-p3/manifest-paths")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    let original: serde_json::Value = serde_json::from_slice(
        &fs::read(resources.join(format!("editors-{target}.json"))).unwrap(),
    )
    .unwrap();
    let good = original["profiles"][0]["profile"]["verifiedProfileId"]
        .as_str()
        .unwrap();
    let invalid = [
        format!("../{good}"),
        format!("/tmp/{good}"),
        format!("prefix/{good}"),
        format!("prefix/../{good}"),
        format!("prefix\\{good}"),
        format!("C:\\{good}"),
    ];
    let mut errors = Vec::new();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for (index, id) in invalid.iter().enumerate() {
            let directory = evidence.join(index.to_string());
            fs::create_dir(&directory).unwrap();
            let mut value = original.clone();
            value["profiles"][0]["profile"]["verifiedProfileId"] = id.clone().into();
            value["profiles"][0]["module"] = format!("{id}/ss_nip.so").into();
            value["profiles"][0]["core"] = format!("{id}/zle.so").into();
            value["profiles"][0]["coreLicense"] = format!("{id}/LICENCE.zsh").into();
            fs::write(
                directory.join(format!("editors-{target}.json")),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
            let catalogue_error = super::editors::read_catalogue(&directory, target).err();
            assert_eq!(
                catalogue_error.as_deref(),
                Some("TERMINAL_NATIVE_MANIFEST_INVALID")
            );
            let prepare_error =
                PreparedNativeBash::prepare(std::path::Path::new("/bin/zsh"), &directory).err();
            assert_eq!(
                prepare_error.as_deref(),
                Some("TERMINAL_NATIVE_MANIFEST_INVALID")
            );
            errors.push(serde_json::json!({"id":id,"catalogueError":catalogue_error,"prepareError":prepare_error}));
        }
    }));
    publish(
        &evidence.join("result.json"),
        &serde_json::json!({"ok":outcome.is_ok(),"realNormalCatalogueAccepted":true,"invalidCases":errors,"noNativeExecutionClaim":true,"nativeAcceptance":false}),
    );
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "requires actual macOS ZLE, rebuilt resource and the real Broker/private channel"]
fn native_zle_actual_broker_display_binding() {
    use crate::terminal_broker::{
        TerminalGenerationCloseReason, TerminalGeometry, TerminalSessionBroker,
        TerminalTransportKind,
    };
    require_macos_arm64();
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let evidence = owner
        .join(".artifacts/tests/native-input-p3/broker-display-binding")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    let home = evidence.join("home");
    fs::create_dir(&home).unwrap();
    fs::write(home.join(".zshrc"), "PROMPT='P3-BINDING> '\n").unwrap();
    let resources = super::editors::validation_resource_root()
        .unwrap()
        .unwrap_or_else(|| owner.join(".artifacts/tests/native-input-p2/resources/native-input"));
    let owned_shell = verified_test_shell(&owner);
    let shell = owned_shell.as_path();
    fs::write(
        evidence.join("actual-resource-root.txt"),
        resources.to_str().unwrap(),
    )
    .unwrap();
    let prepared = PreparedNativeBash::prepare(shell, &resources).unwrap();
    let broker =
        TerminalSessionBroker::phase3_with_journal_for_test(65536, &evidence.join("journal"));
    let transport = "p3-real-display-binding";
    broker
        .attach_transport_with_mode(
            transport,
            None,
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(100, 30),
            nip::InputMode::NativeInline,
        )
        .unwrap()
        .unwrap();
    let probe = broker
        .register_native_channel(transport, prepared.profile.clone())
        .unwrap();
    assert!(
        broker
            .wait_native_initialization(transport, Duration::ZERO)
            .unwrap()
            .is_none(),
        "A prepared Core bypassed actual peer negotiation"
    );
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(shell);
    command.env("HOME", &home);
    command.env("LC_ALL", "en_US.UTF-8");
    command.env("TERM", "xterm-256color");
    command.cwd(&home);
    prepared.configure(&mut command).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let pid = child.process_id().unwrap() as i32;
    let group = unsafe { libc::getpgid(pid) };
    assert!(group > 1);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let raw = Arc::new(Mutex::new(Vec::new()));
    let observed = raw.clone();
    let output_broker = broker.clone();
    let output = thread::spawn(move || {
        let mut bytes = [0; 8192];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 {
                break;
            }
            observed.lock().unwrap().extend_from_slice(&bytes[..n]);
            output_broker
                .observe_raw_output(transport, &bytes[..n])
                .unwrap();
        }
    });
    let (tx, rx) = mpsc::channel();
    let closed = tx.clone();
    let control = prepared.start(
        probe,
        move |message| {
            tx.send(message)
                .map_err(|_| "binding fixture closed".into())
        },
        move || drop(closed),
    );
    let mut records = Vec::new();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait(
            &rx,
            &mut records,
            |m| matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::Capabilities{native_inline:true,..})),
        );
        wait(
            &rx,
            &mut records,
            |m| matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::EditorReady{editor_empty:true,..})),
        );
        for message in &records {
            let nip::Message::Connection(message) = message else {
                panic!("Operation receipt before any operation exists")
            };
            match &message.payload {
                nip::ConnectionPayload::Capabilities { .. } => broker
                    .accept_native_capabilities(transport, message)
                    .unwrap(),
                nip::ConnectionPayload::EditorReady { .. } => {
                    broker.accept_native_readiness(transport, message).unwrap()
                }
                _ => broker
                    .accept_native_observation(transport, message)
                    .unwrap(),
            }
        }
        let binding = broker
            .wait_native_initialization(transport, Duration::from_secs(1))
            .unwrap()
            .unwrap();
        let snapshot = broker.snapshot(Some(transport)).unwrap().session.unwrap();
        assert_eq!(snapshot.native_display_binding, Some(binding.clone()));
        assert_eq!(binding.owned_reflow_cursor_line, Some(true));
        assert_eq!(
            binding.unicode_version,
            Some(nip::DisplayUnicodeVersion::Unicode11)
        );
        assert_eq!(
            binding.unicode_scope,
            Some(nip::DisplayUnicodeScope::Session)
        );
        let mut pty = crate::models::SessionPtyInfo::local();
        pty.input_mode = Some(snapshot.input_mode);
        pty.native_display_binding = Some(binding);
        let dto = serde_json::to_value(&pty).unwrap();
        assert_eq!(dto["nativeDisplayBinding"]["unicodeVersion"], "11");
        assert_eq!(dto["nativeDisplayBinding"]["unicodeScope"], "session");
        assert_eq!(dto["nativeDisplayBinding"]["ownedReflowCursorLine"], true);
        assert_eq!(
            broker
                .native_input_coordinator(transport, "no-operation-exists")
                .err()
                .as_deref(),
            Some("TERMINAL_COMMAND_NOT_FOUND"),
            "Display negotiation granted an operation"
        );
        assert!(broker.unresolved_submissions().unwrap().is_empty());
        let mapped = std::process::Command::new("/usr/sbin/lsof")
            .args(["-p", &pid.to_string(), "-Fn"])
            .output()
            .unwrap();
        assert!(mapped.status.success());
        assert!(String::from_utf8_lossy(&mapped.stdout).contains("/scoped/zsh/zle.so"));
        fs::write(evidence.join("actual-mapped-files.txt"), mapped.stdout).unwrap();
        fs::write(
            evidence.join("session-pty-info.json"),
            serde_json::to_vec_pretty(&pty).unwrap(),
        )
        .unwrap();
        fs::write(
            evidence.join("broker-snapshot.json"),
            serde_json::to_vec_pretty(&snapshot).unwrap(),
        )
        .unwrap();
    }));
    child.kill().unwrap();
    child.wait().unwrap();
    drop(control);
    output.join().unwrap();
    for target in [pid, -group] {
        assert_eq!(unsafe { libc::kill(target, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    broker
        .close_transport(transport, TerminalGenerationCloseReason::UserClosed)
        .unwrap();
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
    publish(
        &evidence.join("result.json"),
        &serde_json::json!({"ok":outcome.is_ok(),"actualPrivateCapabilities":true,"snapshotAndLocalSessionWaitAgree":outcome.is_ok(),"actualSessionPtyDto":outcome.is_ok(),"noOperationOrSubmissionCreated":outcome.is_ok(),"actualPid":pid,"actualGroup":group,"pidAndGroupEsrch":true,"nativeAcceptance":false,"noAppOrRegistryRuntimeClaim":true}),
    );
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "requires rebuilt P3 module and the actual macOS arm64 system Zsh"]
fn native_zle_production_startup_parent_parser_and_jobs() {
    require_macos_arm64();
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let run = uuid::Uuid::new_v4().to_string();
    let session_id = format!("p3-zle-{run}");
    let evidence = owner
        .join(".artifacts/tests/native-input-p3/production-zle")
        .join(&run);
    fs::create_dir_all(&evidence).unwrap();
    let home = evidence.join("home");
    fs::create_dir(&home).unwrap();
    let handoff_interrupt =
        std::env::var("SHELLSPAN_P3_INTERRUPT_STAGE").is_ok_and(|value| value == "handoff");
    let gated_handoff = std::env::var_os("SHELLSPAN_P3_HANDOFF_GATE").is_some();
    assert!(
        !gated_handoff || handoff_interrupt,
        "The real preexec gate is only for the explicit handoff interrupt case"
    );
    let handoff_baseline = gated_handoff.then(|| {
        let path = PathBuf::from(
            std::env::var_os("SHELLSPAN_P3_HANDOFF_BASELINE")
                .expect("A gated user-hook interrupt requires its actual ordinary Shell baseline"),
        );
        assert!(path.is_absolute());
        assert!(!fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(path.canonicalize().unwrap().starts_with(
            owner
                .canonicalize()
                .unwrap()
                .join(".artifacts/tests/native-input-p3/handoff-baseline")
        ));
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.len() <= 65_536);
        let baseline: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(baseline["kind"], "actual-ordinary-zle-handoff-baseline");
        assert_eq!(
            baseline["mainSha256"].as_str().unwrap(),
            super::registration::mac_zle_pin("privateMainSha256").unwrap()
        );
        assert_eq!(
            baseline["coreSha256"].as_str().unwrap(),
            super::registration::mac_zle_pin("privateCoreSha256").unwrap()
        );
        assert_eq!(
            baseline["userGateSha256"].as_str().unwrap(),
            nip::sha(
                &fs::read_to_string(owner.join("scripts/native-input-p3/zle-handoff-gate.zsh"))
                    .unwrap()
            )
        );
        let folder = path.parent().unwrap();
        for name in [
            "raw.bin",
            "actual-mapped-files.txt",
            "result.json",
            "actual-source.bin",
        ] {
            let file = folder.join(name);
            assert!(!fs::symlink_metadata(&file)
                .unwrap()
                .file_type()
                .is_symlink());
            assert!(fs::metadata(&file).unwrap().len() <= 2_097_152);
            assert_eq!(
                nip::sha(&fs::read_to_string(file).unwrap()),
                baseline["files"][name].as_str().unwrap()
            );
        }
        let ordinary: serde_json::Value =
            serde_json::from_slice(&fs::read(folder.join("result.json")).unwrap()).unwrap();
        assert_eq!(ordinary["kind"], "ordinary-zsh-user-preexec-interrupt");
        assert_eq!(ordinary["nativeModuleLoaded"], false);
        assert_eq!(ordinary["returnedToPrompt"], true);
        assert_eq!(ordinary["normalExit"], true);
        assert_eq!(ordinary["actualExitCode"], 0);
        assert_eq!(
            ordinary["pid"],
            ordinary["foregroundGroupImmediatelyBeforeCtrlC"]
        );
        let status = ordinary["observedParentStatus"].as_i64().unwrap();
        assert!((0..=255).contains(&status));
        assert_eq!(ordinary["nextOrdinarySourceConfirmedStatus"], status);
        let mapped = fs::read_to_string(folder.join("actual-mapped-files.txt")).unwrap();
        assert!(mapped.contains("/scoped/zsh/zle.so") && !mapped.contains("ss_nip.so"));
        assert!(fs::read_to_string(folder.join("raw.bin"))
            .unwrap()
            .contains(&format!("REFERENCE_STATUS={status}\r\n")));
        (baseline, status as i32)
    });
    let candidate_shell = std::env::var_os("SHELLSPAN_P3_TEST_ZSH").map(PathBuf::from);
    let owned_shell = verified_test_shell(&owner);
    let shell = owned_shell.as_path();
    let mut zshenv = "P3_STARTUP_ORDER=env\n".to_string();
    if let Some(modules) = std::env::var_os("SHELLSPAN_P3_TEST_ZSH_MODULE_PATH") {
        assert!(
            candidate_shell.is_some(),
            "A different ZLE module requires its explicitly selected matching main"
        );
        zshenv.push_str(&format!(
            "module_path=({} \"${{module_path[@]}}\")\n",
            shlex::try_quote(modules.to_str().unwrap()).unwrap()
        ));
    }
    fs::write(home.join(".zshenv"), zshenv).unwrap();
    fs::write(home.join(".zprofile"), "P3_STARTUP_ORDER+=:profile\n").unwrap();
    let mut zshrc="P3_STARTUP_ORDER+=:rc\nPROMPT='%F{blue}P3-NATIVE>%f '\nHISTFILE=$HOME/history\nHISTSIZE=100\nSAVEHIST=100\nsetopt interactivecomments\n".to_string();
    let history_mode = std::env::var("SHELLSPAN_P3_HISTORY_MODE").ok();
    let history_path = home.join(if history_mode.as_deref() == Some("custom") {
        "历史 custom/history.txt"
    } else {
        "history"
    });
    let history_seeds = [
        "builtin print -r -- P3_EXISTING_1",
        "builtin print -r -- P3_EXISTING_2",
    ];
    let observer = owner.join("scripts/native-input-p3/zle-history-observer.zsh");
    if let Some(mode) = &history_mode {
        assert!(matches!(
            mode.as_str(),
            "default" | "small" | "custom" | "empty" | "unset" | "incremental" | "shared"
        ));
        fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        fs::write(&history_path, format!("{}\n", history_seeds.join("\n"))).unwrap();
        match mode.as_str() {
            "small" => zshrc.push_str("HISTSIZE=3\nSAVEHIST=3\n"),
            "custom" => zshrc.push_str(&format!(
                "HISTFILE={}\nreadonly HISTFILE\n",
                shlex::try_quote(history_path.to_str().unwrap()).unwrap()
            )),
            "empty" => zshrc.push_str("HISTFILE=''\n"),
            "unset" => zshrc.push_str("unset HISTFILE\n"),
            "incremental" => zshrc.push_str("setopt inc_append_history\n"),
            "shared" => zshrc.push_str("setopt share_history\n"),
            "default" => {}
            _ => unreachable!(),
        }
        zshrc.push_str(&format!("zmodload zsh/parameter\nsource {}\np3_history_snapshot() {{ local p3_previous=$?; p3_history_export \"$(<$HOME/history-observation-target)\"; return $p3_previous; }}\nzle -N p3_history_snapshot\nbindkey '^Xh' p3_history_snapshot\n", shlex::try_quote(observer.to_str().unwrap()).unwrap()));
    }
    if std::env::var_os("SHELLSPAN_P3_TEST_COMBINING_CHARS").is_some() {
        assert!(candidate_shell.is_some());
        zshrc.push_str("setopt combining_chars\n");
    }
    let theme = std::env::var("SHELLSPAN_P3_TEST_PROMPT_THEME").ok();
    let theme_sources = theme.as_ref().map(|theme| {
        assert!(matches!(theme.as_str(), "walters" | "adam1"));
        zshrc.push_str(&format!(
            "autoload -Uz promptinit\npromptinit\nprompt {theme}\n"
        ));
        ["promptinit".to_string(), format!("prompt_{theme}_setup")]
            .into_iter()
            .map(|name| {
                let path = PathBuf::from("/usr/share/zsh/5.9/functions").join(name);
                let digest = nip::sha(&fs::read_to_string(&path).unwrap());
                (path, digest)
            })
            .collect::<Vec<_>>()
    });
    let _handoff_gate_keepalive = if gated_handoff {
        use std::os::unix::fs::OpenOptionsExt;
        let fifo = home.join("handoff-gate.fifo");
        let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        zshrc.push_str(&format!(
            "source {}\n",
            shlex::try_quote(
                owner
                    .join("scripts/native-input-p3/zle-handoff-gate.zsh")
                    .to_str()
                    .unwrap()
            )
            .unwrap()
        ));
        Some(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(fifo)
                .unwrap(),
        )
    } else {
        None
    };
    fs::write(home.join(".zshrc"), zshrc).unwrap();
    scoped_observers(&home);
    fs::write(home.join(".zlogin"), "P3_STARTUP_ORDER+=:login\n").unwrap();
    let prepared = PreparedNativeBash::prepare(
        shell,
        &owner.join(".artifacts/tests/native-input-p2/resources/native-input"),
    )
    .unwrap();
    let binding = prepared.profile.display_binding();
    assert_eq!(binding.owned_reflow_cursor_line, Some(true));
    publish(
        &evidence.join("verified-display-binding.json"),
        &serde_json::to_value(&binding).unwrap(),
    );
    assert_eq!(
        binding.unicode_version,
        Some(nip::DisplayUnicodeVersion::Unicode11),
        "The actual verified Core did not supply its typed presentation metadata"
    );
    assert!(
        prepared
            .profile
            .clone()
            .bind_scoped_zle_core(shell)
            .is_err(),
        "A real wrong executable was accepted as the reviewed Core"
    );
    let columns = std::env::var("SHELLSPAN_P3_TEST_COLUMNS")
        .map(|value| value.parse::<u16>().unwrap())
        .unwrap_or(100);
    assert!([32, 40, 100, 180].contains(&columns));
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(shell);
    command.env("HOME", &home);
    command.env("LC_ALL", "en_US.UTF-8");
    command.env("TERM", "xterm-256color");
    command.cwd(&home);
    prepared.configure(&mut command).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut writer = pair.master.take_writer().unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let raw = Arc::new(Mutex::new(Vec::new()));
    let capture = raw.clone();
    let trace_clock = Instant::now();
    let trace_schedule = std::env::var_os("SHELLSPAN_P3_TRACE_SCHEDULE").is_some();
    let mut pty_schedule = trace_schedule.then(|| {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(evidence.join("pty-live-events.jsonl"))
            .unwrap()
    });
    let mut live = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(evidence.join("raw-live.bin"))
        .unwrap();
    let output = thread::spawn(move || {
        let mut bytes = [0; 8192];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 {
                break;
            }
            let mut raw = capture.lock().unwrap();
            live.write_all(&bytes[..n]).unwrap();
            raw.extend_from_slice(&bytes[..n]);
            if let Some(file) = &mut pty_schedule {
                serde_json::to_writer(&mut *file, &serde_json::json!({"elapsedMicros":trace_clock.elapsed().as_micros(),"offset":raw.len(),"bytes":n})).unwrap();
                file.write_all(b"\n").unwrap();
            }
        }
    });
    let (tx, rx) = mpsc::channel();
    let closed = tx.clone();
    let probe = nip::ConnectionEnvelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "probe".into(),
        connection: nip::ConnectionIdentity {
            terminal_session_id: session_id.clone(),
            terminal_generation: 1,
            control_id: format!("p3-control-{run}"),
        },
        payload: nip::ConnectionPayload::Probe,
    };
    let mut receipt_schedule = trace_schedule.then(|| {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(evidence.join("control-live.jsonl"))
            .unwrap()
    });
    let control = prepared.start(
        probe,
        move |message| {
            if let Some(file) = &mut receipt_schedule {
                let encoded = match &message {
                    nip::Message::Connection(value) => value.encode(),
                    nip::Message::Operation(value) => value.encode(),
                }.unwrap();
                let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
                serde_json::to_writer(&mut *file, &serde_json::json!({"elapsedMicros":trace_clock.elapsed().as_micros(),"message":value})).unwrap();
                file.write_all(b"\n").unwrap();
            }
            tx.send(message).map_err(|_| "fixture closed".into())
        },
        move || drop(closed),
    );
    let mut records = Vec::new();
    let mut resize_events = Vec::new();
    let mut geometry_source = String::new();
    let background_output =
        std::env::var("SHELLSPAN_P3_GEOMETRY_BACKGROUND_OUTPUT").as_deref() != Ok("0");
    let job_pid_file = evidence.join("background.pid");
    let target_observation = evidence.join("signal-target.json");
    let mut source_corpus = Vec::new();
    let mut history_snapshots = Vec::new();
    let interrupt_source = std::env::var("SHELLSPAN_P3_SIGNAL_TARGET")
        .map(|program| {
            format!(
                "{} {}",
                shlex::try_quote(&program).unwrap(),
                shlex::try_quote(target_observation.to_str().unwrap()).unwrap()
            )
        })
        .unwrap_or_else(|_| "sleep 30".into());
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait(
            &rx,
            &mut records,
            |m| matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::Capabilities{native_inline:true,..})),
        );
        wait(
            &rx,
            &mut records,
            |m| matches!(m,nip::Message::Connection(e)if matches!(e.payload,nip::ConnectionPayload::EditorReady{editor_empty:true,..})),
        );
        let mapped = std::process::Command::new("/usr/sbin/lsof")
            .args(["-p", &child.process_id().unwrap().to_string(), "-Fn"])
            .output()
            .unwrap();
        assert!(mapped.status.success());
        fs::write(evidence.join("actual-mapped-files.txt"), &mapped.stdout).unwrap();
        assert!(
            String::from_utf8_lossy(&mapped.stdout).contains("/scoped/zsh/zle.so"),
            "The reviewed private Core was not actually mapped"
        );
        assert_eq!(scope_snapshot(&mut *writer, &home)["budget"], 0);
        if history_mode.is_some() {
            let initial = public_zle_history_snapshot(&mut *writer, &home);
            publish(&evidence.join("history-initial.json"), &initial);
            history_snapshots.push(initial);
        }
        let handle = "job-0123456789abcdef0123456789abcdef";
        let long_value = format!(
            "{}{}",
            "0123456789abcdef".repeat(24),
            "父Shell-é-👩🏽‍💻".repeat(50)
        );
        let background_body = if background_output {
            "for n in {1..200}; do printf 'P3-BACKGROUND-%s:%s\\n' \"$n\" \"$P3_PARENT\"; sleep 0.1; done"
        } else {
            "sleep 30"
        };
        let child_options = if history_mode.is_some() {
            "builtin print -rn -- $options[rcs] > $HOME/child-rcs; "
        } else {
            ""
        };
        let mut startup_source =
            "printf 'P3-STARTUP:%s\\n' \"$P3_STARTUP_ORDER\"; typeset P3_PARENT='父Shell-é-👩🏽‍💻'"
                .to_string();
        if std::env::var_os("SHELLSPAN_P3_HISTORY_PREFILL").is_some() {
            startup_source.push_str(
                "; for n in {1..60}; do builtin printf 'P3_HISTORY_%02d\\n' \"$n\"; done",
            );
        }
        let sources=[(startup_source,None),
            ("[[ $P3_PARENT == '父Shell-é-👩🏽‍💻' ]] && printf '%s%s\\n' P3-PARENT: \"$P3_PARENT\"".into(),None),
            (format!("zmodload zsh/system; builtin printf '%s' \"$sysparams[pid]\" > {}; {}{}",shlex::try_quote(job_pid_file.to_str().unwrap()).unwrap(),child_options,background_body),Some(nip::JobExecution::Launch{handle:handle.into()})),
            (format!("typeset P3_LONG='{}'; [[ ${{#P3_LONG}} == {} ]] && printf '%s%s\\n' P3-LONG- COMPLETE",long_value,long_value.chars().count()),None),
            (format!("__shellspan_job_control {handle} poll"),Some(nip::JobExecution::Control{handle:handle.into(),stop:false,nonce:"0123456789abcdef0123456789abcdef".into()})),
            (format!("__shellspan_job_control {handle} stop"),Some(nip::JobExecution::Control{handle:handle.into(),stop:true,nonce:"1123456789abcdef0123456789abcdef".into()})),
            (format!("__shellspan_job_control {handle} poll"),Some(nip::JobExecution::Control{handle:handle.into(),stop:false,nonce:"2123456789abcdef0123456789abcdef".into()})),
            (interrupt_source,None),
            ("[[ $P3_PARENT == '父Shell-é-👩🏽‍💻' ]] && printf '%s%s\\n' P3-AFTER- INTERRUPT".into(),None),
            ("false".into(),None),
            ("[[ $? == 1 ]] && typeset -g P3_MULTI=$'first\nsecond'; [[ $P3_MULTI == $'first\nsecond' ]] && printf '%s%s\\n' P3-MULTILINE- STATUS".into(),None),
            ("typeset -g P3_TABS=$'A\tB'; [[ $P3_TABS == $'A\tB' ]] && printf '%s%s\\n' P3-REDUCED- TABS".into(),None),
            ("typeset -g P3_CR=$'C\rD'; [[ $P3_CR == $'C\rD' ]] && typeset -g P3_BANG=\"literal!!\"; [[ $P3_BANG == 'literal!!' ]] && printf '%s%s\\n' P3-LITERAL- CR".into(),None)];
        if trace_schedule {
            publish(
                &evidence.join("baseline-prelude.json"),
                &serde_json::json!({
                    "ordinaryForegroundSources":[sources[0].0,sources[1].0],
                    "backgroundBody":background_body,
                    "nativeBackgroundSource":sources[2].0,
                    "nativeSourceIndex":3,
                    "ordinaryBackgroundDifference":"The same declared body runs as a normal Zsh background job; its pid file belongs to the new baseline HOME rather than the sealed native HOME."
                }),
            );
        }
        for (index, (source, job)) in sources.into_iter().enumerate() {
            if index == 6 {
                // stopRequested acknowledges signal delivery, not process exit.
                // Observe the real group before this fixture's one final poll;
                // do not assume the immediately preceding stop made it settled.
                let job_pid = fs::read_to_string(&job_pid_file)
                    .unwrap()
                    .parse::<i32>()
                    .unwrap();
                assert!(job_pid > 1);
                let started = Instant::now();
                let deadline = started + Duration::from_secs(8);
                loop {
                    let result = unsafe { libc::kill(-job_pid, 0) };
                    let error = (result == -1).then(std::io::Error::last_os_error);
                    if error
                        .as_ref()
                        .is_some_and(|error| error.raw_os_error() == Some(libc::ESRCH))
                    {
                        break;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "The actual stopped background group did not exit before the final poll: {error:?}"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                publish(
                    &evidence.join("job-stop-observation.json"),
                    &serde_json::json!({"processGroup":job_pid,"esrch":true,"elapsedMicros":started.elapsed().as_micros(),"beforeSourceIndex":index}),
                );
            }
            if index == 3 {
                geometry_source = source.clone();
                publish(
                    &evidence.join("geometry-live.json"),
                    &serde_json::json!({"source":source,"sourceSha256":nip::sha(&source),"prefixBeforeFirstResize":source.get(..usize::from(columns)+40),"columns":columns,"rows":30}),
                );
            }
            let id = nip::Identity {
                terminal_session_id: session_id.clone(),
                terminal_generation: 1,
                lease_id: format!("lease-{index}"),
                lease_generation: index as u64 + 1,
                agent_session_id: format!("p3-agent-{run}"),
                task_id: format!("p3-task-{run}"),
                operation_id: format!("p3-op-{index}"),
                command_id: format!("command-{index}"),
                source_revision: 1,
            };
            let plan = match &job {
                Some(job) => {
                    nip::native_shell_job_plan(&source, nip::ShellFamily::Zsh, job).unwrap()
                }
                None => nip::native_foreground_plan(&source, nip::ShellFamily::Zsh).unwrap(),
            };
            let source_digest = nip::sha(&source);
            let plan_digest = nip::bound_plan_digest(&source_digest, &plan);
            source_corpus.push(serde_json::json!({"index":index,"source":source,"sourceDigest":source_digest,"utf8Bytes":source.len(),"literalLf":source.chars().filter(|value|*value=='\n').count(),"literalTab":source.chars().filter(|value|*value=='\t').count(),"literalCr":source.chars().filter(|value|*value=='\r').count(),"reducedMotion":index>=11,"expectedRequestNotReceipt":true}));
            if gated_handoff && index == 7 {
                assert_eq!(
                    handoff_baseline.as_ref().unwrap().0["sourceDigest"],
                    source_digest
                );
                fs::write(home.join("handoff-gate-source"), &source).unwrap();
            }
            let prepare = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: format!("prepare-{index}"),
                identity: id.clone(),
                payload: nip::Payload::PrepareInput {
                    source,
                    source_digest: source_digest.clone(),
                    plan,
                    plan_digest: plan_digest.clone(),
                    budget_ms: 5000,
                    reduced_motion: index >= 11,
                    job,
                },
            };
            control.write(&prepare.encode().unwrap()).unwrap();
            if index == 3 {
                wait(
                    &rx,
                    &mut records,
                    |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputProgress{applied_utf8_bytes}if applied_utf8_bytes>280)),
                );
                if std::env::var_os("SHELLSPAN_P3_LIVE_GEOMETRY").is_some() {
                    let deadline = Instant::now() + Duration::from_secs(2);
                    while !evidence.join("wrapped-ready.json").exists() {
                        assert!(Instant::now()<deadline,"The live public xterm buffer did not observe wrapped source before resize");
                        thread::sleep(Duration::from_millis(5));
                    }
                    let observed: serde_json::Value = serde_json::from_slice(
                        &fs::read(evidence.join("wrapped-ready.json")).unwrap(),
                    )
                    .unwrap();
                    assert_eq!(observed["sourceSha256"], nip::sha(&geometry_source));
                    assert_eq!(observed["columns"], columns);
                    assert_eq!(observed["wrapped"], true);
                    let pending: Vec<_> = rx.try_iter().collect();
                    assert!(!pending.iter().any(|m|matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputConfirmed{..}))),"The actual editor finished input before the live wrap/resize gate");
                    records.extend(pending);
                    let query = nip::Envelope {
                        protocol: nip::PROTOCOL.into(),
                        request_id: "wrap-query-3".into(),
                        identity: id.clone(),
                        payload: nip::Payload::Query,
                    };
                    control.write(&query.encode().unwrap()).unwrap();
                    wait(
                        &rx,
                        &mut records,
                        |m| matches!(m,nip::Message::Operation(e)if e.request_id==query.request_id&&matches!(&e.payload,nip::Payload::Snapshot{phase,..}if phase=="typing")),
                    );
                }
                for cols in [32, 180, 40, 100, 32, 180, 40] {
                    let bytes = raw.lock().unwrap();
                    pair.master
                        .resize(PtySize {
                            rows: 30,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        })
                        .unwrap();
                    resize_events.push(serde_json::json!({"offset":bytes.len(),"columns":cols,"elapsedMicros":trace_clock.elapsed().as_micros()}));
                    publish(
                        &evidence.join("geometry-events.json"),
                        &serde_json::json!(resize_events),
                    );
                    drop(bytes);
                    thread::sleep(Duration::from_millis(25));
                }
            }
            wait(
                &rx,
                &mut records,
                |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::InputConfirmed{..}|nip::Payload::ControlInputConfirmed{editor_empty:true,..})),
            );
            if index == 3 && std::env::var_os("SHELLSPAN_P3_OBSERVE_FULL_INPUT").is_some() {
                // A declared prepare-only observation window, after the real
                // full proof and before any arm/accept. The original native
                // input budget and 1200ms animation remain unchanged.
                publish(
                    &evidence.join("full-input-observation.json"),
                    &serde_json::json!({"sourceDigest":source_digest,"holdMillis":250,"noAcceptKeyYet":true}),
                );
                thread::sleep(Duration::from_millis(250));
                publish(
                    &evidence.join("full-input-observation-finished.json"),
                    &serde_json::json!({"sourceDigest":source_digest,"noAcceptKeyYet":true}),
                );
            }
            let commit = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: format!("commit-{index}"),
                identity: id.clone(),
                payload: nip::Payload::Commit {
                    source_digest,
                    plan_digest,
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
            if index == 7 {
                wait(
                    &rx,
                    &mut records,
                    |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::Started)),
                );
                let deadline = Instant::now() + Duration::from_secs(2);
                if gated_handoff {
                    while !home.join("handoff-gate-entered").exists() {
                        assert!(
                            Instant::now() < deadline,
                            "Real user preexec gate did not follow native Started"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    assert_eq!(
                        fs::read_to_string(home.join("handoff-gate-actual-source")).unwrap(),
                        source_corpus[index]["source"].as_str().unwrap()
                    );
                    assert_eq!(
                        fs::read_to_string(home.join("handoff-gate-parent-pid")).unwrap(),
                        child.process_id().unwrap().to_string()
                    );
                    assert_eq!(
                        pair.master.process_group_leader().unwrap(),
                        child.process_id().unwrap() as i32,
                        "The blocked parent must still own the actual foreground group"
                    );
                }
                if !handoff_interrupt {
                    loop {
                        let group = pair.master.process_group_leader().unwrap();
                        let image = std::process::Command::new("/bin/ps")
                            .args(["-p", &group.to_string(), "-o", "comm="])
                            .output()
                            .unwrap();
                        let name = String::from_utf8(image.stdout).unwrap();
                        let name = std::path::Path::new(name.trim()).file_name();
                        if group != child.process_id().unwrap() as i32
                            && (if std::env::var_os("SHELLSPAN_P3_SIGNAL_TARGET").is_some() {
                                target_observation.exists()
                            } else {
                                name.is_some_and(|name| name == "sleep")
                            })
                        {
                            break;
                        }
                        assert!(
                            Instant::now() < deadline,
                            "The actual foreground command did not acquire its PTY process group"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                }
                let group = pair.master.process_group_leader().unwrap();
                let processes = std::process::Command::new("/bin/ps")
                    .args([
                        "-g",
                        &group.to_string(),
                        "-o",
                        "pid,ppid,pgid,blocked,pending,stat,comm",
                    ])
                    .output()
                    .unwrap();
                fs::write(
                    evidence.join("foreground-before-interrupt.txt"),
                    processes.stdout,
                )
                .unwrap();
                if let Some(helper) = std::env::var_os("SHELLSPAN_P3_SIGNAL_INSPECTOR") {
                    let signals = std::process::Command::new(helper)
                        .arg(group.to_string())
                        .output()
                        .unwrap();
                    assert!(signals.status.success());
                    fs::write(evidence.join("foreground-signals.json"), signals.stdout).unwrap();
                }
                let mode = pair.master.get_termios().unwrap();
                fs::write(evidence.join("interrupt-pty.json"),serde_json::to_vec_pretty(&serde_json::json!({"shellPid":child.process_id(),"foregroundGroup":group,"localFlags":mode.local_flags.bits(),"inputFlags":mode.input_flags.bits(),"interruptCharacter":mode.control_chars[libc::VINTR],"signalsEnabled":mode.local_flags.bits()&libc::ISIG!=0})).unwrap()).unwrap();
                if gated_handoff {
                    let immediate_group = pair.master.process_group_leader().unwrap();
                    assert_eq!(immediate_group, child.process_id().unwrap() as i32);
                    publish(
                        &evidence.join("handoff-gate-observation.json"),
                        &serde_json::json!({"parentPid":child.process_id(),"foregroundGroupImmediatelyBeforeCtrlC":immediate_group,"actualPreexecSourceSha256":nip::sha(&fs::read_to_string(home.join("handoff-gate-actual-source")).unwrap()),"expectedSourceSha256":source_corpus[index]["sourceDigest"].as_str().unwrap(),"gateHeldByEmptyRealFifo":true,"signalIgnoredOrTrapped":false}),
                    );
                }
                writer.write_all(b"\x03").unwrap();
                writer.flush().unwrap();
            }
            let expected_exit = if index == 7 {
                handoff_baseline.as_ref().map_or(130, |(_, status)| *status)
            } else if index == 9 {
                1
            } else {
                0
            };
            wait(
                &rx,
                &mut records,
                |m| matches!(m,nip::Message::Operation(e)if e.request_id==prepare.request_id&&matches!(e.payload,nip::Payload::Settled{exit_code}if exit_code==expected_exit)),
            );
            wait(
                &rx,
                &mut records,
                |m| matches!(m,nip::Message::Connection(e)if matches!(&e.payload,nip::ConnectionPayload::EditorReady{after_command:Some(last),editor_empty:true,..}if last==&id)),
            );
            if history_mode.is_some() {
                let snapshot = public_zle_history_snapshot(&mut *writer, &home);
                publish(
                    &evidence.join(format!("history-after-{index}.json")),
                    &snapshot,
                );
                history_snapshots.push(snapshot);
            }
        }
        let stream = String::from_utf8(raw.lock().unwrap().clone()).unwrap();
        assert!(stream.contains("P3-STARTUP:env:profile:rc:login"));
        assert!(stream.contains("P3-PARENT:父Shell-é-👩🏽‍💻"));
        assert!(stream.contains("P3-LONG-COMPLETE"));
        assert!(stream.contains("P3-AFTER-INTERRUPT"));
        assert!(stream.contains("P3-MULTILINE-STATUS"));
        assert!(stream.contains("P3-REDUCED-TABS"));
        assert!(stream.contains("P3-LITERAL-CR"));
        assert!(records.iter().any(|m|matches!(m,nip::Message::Connection(e)if matches!(&e.payload,nip::ConnectionPayload::JobObservation{handle:h,state,..}if h==handle&&state=="running"))));
        assert!(records.iter().any(|m|matches!(m,nip::Message::Connection(e)if matches!(&e.payload,nip::ConnectionPayload::JobObservation{handle:h,state,..}if h==handle&&state=="stopRequested"))));
        assert!(records.iter().any(|m|matches!(m,nip::Message::Connection(e)if matches!(&e.payload,nip::ConnectionPayload::JobObservation{handle:h,state,..}if h==handle&&state=="settled"))));
        assert!(records.iter().any(|m|matches!(m,nip::Message::Connection(e)if matches!(&e.payload,nip::ConnectionPayload::JobObservation{handle:h,state,exit_code:Some(143)}if h==handle&&state=="finished"))));
        let job_pid = fs::read_to_string(&job_pid_file)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        assert!(job_pid > 1);
        assert_eq!(
            unsafe { libc::kill(-job_pid, 0) },
            -1,
            "The actual stopped background process group still has a member"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        assert_eq!(
            scope_snapshot(&mut *writer, &home)["budget"],
            0,
            "Accepted source left a Core paint budget in the user's next edit"
        );
        let traces = fs::read_to_string(home.join("scope-widget-observations.jsonl")).unwrap();
        let observations: Vec<serde_json::Value> = traces
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(
            observations
                .iter()
                .any(|value| value["budget"].as_u64().is_some_and(|value| value == 1)),
            "No actual owned native render enabled the versioned append mode"
        );
        assert!(observations.iter().all(|value| value["rows"] == 30));
        if let Some(mode) = &history_mode {
            let persistent = !matches!(mode.as_str(), "empty" | "unset");
            assert_eq!(
                fs::read_to_string(home.join("child-rcs")).unwrap(),
                "on",
                "Native child changed the user's startup/history RCS option"
            );
            let initial: Vec<String> = if persistent {
                history_seeds
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect()
            } else {
                Vec::new()
            };
            // Collect every mismatch before asserting so the same independent
            // case can retain its real normal-exit and disk evidence as well.
            let mut differences = Vec::new();
            if history_snapshots[0]["entries"] != serde_json::json!(initial) {
                differences.push(serde_json::json!({"stage":"initial","expected":initial,"actual":history_snapshots[0]["entries"]}));
            }
            let configuration = &history_snapshots[0]["configuration"];
            let mut expected = initial;
            for (index, item) in source_corpus.iter().enumerate() {
                if ![4, 5, 6].contains(&index) {
                    expected.push(item["source"].as_str().unwrap().to_string());
                    if mode == "small" && expected.len() > 3 {
                        expected.remove(0);
                    }
                }
                if &history_snapshots[index + 1]["configuration"] != configuration {
                    differences.push(serde_json::json!({"stage":"configuration","operation":index,"expected":configuration,"actual":history_snapshots[index+1]["configuration"]}));
                }
                if history_snapshots[index + 1]["entries"] != serde_json::json!(expected) {
                    differences.push(serde_json::json!({"stage":"memory","operation":index,"expected":expected,"actual":history_snapshots[index+1]["entries"]}));
                }
            }
            writer.write_all(b"exit\r").unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(8);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                assert!(
                    Instant::now() < deadline,
                    "History Shell did not exit normally"
                );
                thread::sleep(Duration::from_millis(5));
            };
            assert!(
                status.success(),
                "History Shell normal exit failed: {status:?}"
            );
            let disk = evidence.join("history-disk-read");
            fs::create_dir(&disk).unwrap();
            let parsed = std::process::Command::new(shell)
                .args(["-f", "-c", "HISTSIZE=1000; zmodload zsh/parameter; source \"$1\"; fc -R \"$2\" || exit; print -s -- OWNED_READER_CURRENT_EVENT; p3_history_export \"$3\"", "owned-history-reader"])
                .arg(&observer).arg(&history_path).arg(&disk)
                .env("HOME", &home).env("ZDOTDIR", &home).env("LC_ALL", "en_US.UTF-8")
                .output().unwrap();
            assert!(
                parsed.status.success(),
                "Actual Zsh history reader failed: {}",
                String::from_utf8_lossy(&parsed.stderr)
            );
            let saved = read_public_zle_history(&disk);
            publish(&evidence.join("history-disk.json"), &saved);
            if persistent {
                expected.push("exit".into());
                if mode == "small" && expected.len() > 3 {
                    expected.remove(0);
                }
            } else {
                expected = history_seeds
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect();
            }
            if saved["entries"] != serde_json::json!(expected) {
                differences.push(serde_json::json!({"stage":"disk","expected":expected,"actual":saved["entries"]}));
            }
            let private_controls_excluded = [4, 5, 6].into_iter().all(|index| {
                history_snapshots[index + 1]["entries"] == history_snapshots[index]["entries"]
            });
            let configuration_preserved = history_snapshots
                .iter()
                .all(|snapshot| &snapshot["configuration"] == configuration);
            publish(
                &evidence.join("history-differences.json"),
                &serde_json::json!(differences),
            );
            publish(
                &evidence.join("history-result.json"),
                &serde_json::json!({"mode":mode,"ok":differences.is_empty(),"normalExit":true,"observations":history_snapshots.len(),"privateJobControlsExcluded":private_controls_excluded,"configurationPreserved":configuration_preserved,"diskReadByActualZsh":true,"scope":"Actual native module and PTY, not an App/model or multi-process shared-history proof"}),
            );
            assert!(
                differences.is_empty(),
                "Native history source/configuration differs; inspect history-differences.json"
            );
            assert!(
                private_controls_excluded,
                "Private management command entered history"
            );
        }
    }));
    if outcome.is_err() && child.try_wait().unwrap().is_none() {
        let ids = format!(
            "{},{}",
            child.process_id().unwrap(),
            pair.master.process_group_leader().unwrap_or_default()
        );
        let actual = std::process::Command::new("/bin/ps")
            .args([
                "-p",
                &ids,
                "-o",
                "pid,ppid,pgid,blocked,pending,stat,wchan,comm",
            ])
            .output()
            .unwrap();
        fs::write(evidence.join("failure-live-processes.txt"), actual.stdout).unwrap();
        if let Some(group) = pair.master.process_group_leader() {
            if Some(group) != child.process_id().map(|id| id as i32) {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
        }
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    drop(writer);
    drop(pair.master);
    drop(control);
    let _ = output.join();
    fs::write(evidence.join("raw.bin"), &*raw.lock().unwrap()).unwrap();
    for item in &mut source_corpus {
        let request = format!("prepare-{}", item["index"].as_u64().unwrap());
        item["actualFullInputProof"]=serde_json::Value::Bool(records.iter().any(|message|matches!(message,nip::Message::Operation(e)if e.request_id==request&&matches!(&e.payload,nip::Payload::InputConfirmed{source_digest,utf8_bytes,cursor_utf8_bytes,end_utf8_bytes,..}if source_digest==item["sourceDigest"].as_str().unwrap()&&Some(*utf8_bytes as u64)==item["utf8Bytes"].as_u64()&&cursor_utf8_bytes==end_utf8_bytes))));
    }
    fs::write(
        evidence.join("source-corpus.json"),
        serde_json::to_vec_pretty(&source_corpus).unwrap(),
    )
    .unwrap();
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
    if let Some(files) = &theme_sources {
        for (path, digest) in files {
            assert_eq!(&nip::sha(&fs::read_to_string(path).unwrap()), digest);
        }
        publish(
            &evidence.join("theme-sources.json"),
            &serde_json::json!({"theme":theme,"sources":files}),
        );
    }
    fs::write(evidence.join("geometry.json"),serde_json::to_vec_pretty(&serde_json::json!({"source":geometry_source,"prefixBeforeFirstResize":geometry_source.get(..usize::from(columns)+40),"sourceSha256":nip::sha(&geometry_source),"columns":columns,"rows":30,"resizeEvents":resize_events,"kind":"actual-production-pty-capture"})).unwrap()).unwrap();
    fs::write(evidence.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":outcome.is_ok(),"plannedOperations":13,"shortFalseAndPreviousStatus":outcome.is_ok(),"literalControlCharacters":outcome.is_ok(),"multilineAndReducedMotionTabs":outcome.is_ok(),"dynamicWidths":[columns,32,180,40],"foregroundInterrupt":if handoff_interrupt{"handoff"}else{"running"},"gatedParentHandoff":gated_handoff,"shell":shell,"candidateEditor":true,"backgroundOutput":background_output,"nativeAcceptance":false,"productionBindingChanged":false,"coreSha256":super::registration::mac_zle_pin("privateCoreSha256").unwrap()})).unwrap()).unwrap();
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}
