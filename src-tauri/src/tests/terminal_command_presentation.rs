use super::*;
use portable_pty::{native_pty_system, PtySize};
use std::sync::{mpsc, Mutex};

fn capture_command_presentation(shell_path: &str, shell: TerminalShellKind, columns: u16) {
    let home = tempfile::tempdir().unwrap();
    let integration = PreparedLocalShellIntegration::prepare(shell, home.path()).unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let mut command = CommandBuilder::new(shell_path);
    command.env("HOME", home.path());
    command.env("TERM", "xterm-256color");
    command.cwd(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap());
    integration.configure_command(&mut command).unwrap();
    writeln!(
        File::options()
            .append(true)
            .open(&integration.bootstrap_path)
            .unwrap(),
        "\nPS1='presentation> '"
    )
    .unwrap();
    let (events_tx, events_rx) = mpsc::channel();
    let mut control = integration.start_reader(
        move |event| {
            let _ = events_tx.send(event);
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
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let wait_prompt = |expected_boundaries: usize| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let event = events_rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if matches!(event, TerminalIntegrationControlEvent::PromptEnd) {
                break;
            }
        }
        loop {
            let bytes = output.lock().unwrap().clone();
            let mut parser = vt100::Parser::new(24, columns, 0);
            parser.process(&bytes);
            let boundaries = bytes
                .windows(b"\x1b]133;C\x07".len())
                .filter(|part| *part == b"\x1b]133;C\x07")
                .count();
            if boundaries >= expected_boundaries
                && parser
                    .screen()
                    .contents()
                    .trim_end()
                    .ends_with("presentation>")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "PTY prompt was not rendered: {}",
                parser.screen().contents()
            );
            thread::sleep(Duration::from_millis(5));
        }
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_prompt(0);
        let startup = output.lock().unwrap().clone();
        let mut executions = Vec::new();
        for (index, source) in [
            "git ls-files src/components/terminal/registry; git log -1 --format=%s",
            "git diff --numstat -- src/components/terminal/registry",
        ]
        .into_iter()
        .enumerate()
        {
            let start = output.lock().unwrap().len();
            writer.write_all(source.as_bytes()).unwrap();
            writer.write_all(b"\r").unwrap();
            writer.flush().unwrap();
            wait_prompt(index + 1);
            let bytes = output.lock().unwrap()[start..].to_vec();
            let boundary = b"\x1b]133;C\x07";
            assert_eq!(
                bytes
                    .windows(boundary.len())
                    .filter(|part| *part == boundary)
                    .count(),
                1,
                "one display boundary per real shell command"
            );
            let boundary_at = bytes
                .windows(boundary.len())
                .position(|part| part == boundary)
                .unwrap();
            let display = String::from_utf8_lossy(&bytes);
            assert!(
                boundary_at > 0,
                "command echo must precede output boundary: {display}"
            );
            assert!(bytes[boundary_at + boundary.len()..].len() > b"presentation> ".len());
            executions.push(serde_json::json!({ "command": source, "trace": display }));
        }
        if let Ok(directory) = std::env::var("SHELLSPAN_COMMAND_PRESENTATION_DIR") {
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                Path::new(&directory).join(format!("{}-{columns}.json", shell.protocol_name())),
                serde_json::to_vec(&serde_json::json!({
                    "startup": String::from_utf8_lossy(&startup),
                    "executions": executions,
                    "columns": columns,
                    "rows": 24,
                }))
                .unwrap(),
            )
            .unwrap();
        }
    }));
    let _ = child.kill();
    let _ = child.wait();
    drop(writer);
    drop(pair.master);
    output_thread.join().unwrap();
    control.stop();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
fn bash_command_presentation_boundary_precedes_real_output() {
    for columns in [40, 100] {
        capture_command_presentation("/bin/bash", TerminalShellKind::Bash, columns);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_command_presentation_boundary_precedes_real_output() {
    for columns in [40, 100] {
        capture_command_presentation("/bin/zsh", TerminalShellKind::Zsh, columns);
    }
}

#[test]
fn native_private_controls_preserve_command_presentation() {
    use crate::agent_runtime::{
        AgentToolTargetNative, TerminalExecuteRegistry, TerminalLeaseEventState,
        TerminalLeaseManager,
    };
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
        SessionStatus, SessionTerminalKind, StatusEvent,
    };
    use crate::terminal_broker::{
        TerminalCommandState, TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
    };
    use std::collections::HashMap;

    let (shell_path, shell) = if cfg!(target_os = "macos") {
        ("/bin/zsh", TerminalShellKind::Zsh)
    } else {
        ("/bin/bash", TerminalShellKind::Bash)
    };
    let transport = "presentation-private";
    let broker = TerminalSessionBroker::phase3_enabled_for_test(4096);
    broker
        .attach_transport(
            transport,
            None,
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(100, 30),
        )
        .unwrap();
    let (_fixture, integration) = prepare_test_integration(shell);
    broker
        .register_integration_channel(transport, integration.integration_id(), shell)
        .unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = crate::local_terminal_input::take_writer(pair.master.as_ref(), shell).unwrap();
    let home = tempfile::tempdir().unwrap();
    let mut command = CommandBuilder::new(shell_path);
    command.env("HOME", home.path());
    command.env("TERM", "xterm-256color");
    command.cwd(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap());
    integration.configure_command(&mut command).unwrap();
    let control_broker = broker.clone();
    let integration_id = integration.integration_id().to_string();
    let mut control = integration.start_reader(
        move |event| control_broker.accept_integration_event(transport, &integration_id, event),
        |_| {},
    );
    let display = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&display);
    let output_broker = broker.clone();
    let output_thread = thread::spawn(move || {
        let mut bytes = [0; 4096];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 {
                break;
            }
            output_broker
                .observe_raw_output(transport, &bytes[..count])
                .unwrap();
            captured.lock().unwrap().extend_from_slice(&bytes[..count]);
        }
    });
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let sessions = SessionManager::default();
    let (sender, receiver) = crossbeam_channel::unbounded();
    sessions
        .insert(
            transport.into(),
            ManagedSession {
                sender: SessionCommandSender::Event(sender),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: transport.into(),
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
    let input_thread = thread::spawn(move || {
        while let Ok(input) = receiver.recv() {
            match input {
                SessionCommand::Write(data) => writer.write_all(data.as_bytes()).unwrap(),
                SessionCommand::WriteBytes(bytes) => writer.write_all(&bytes).unwrap(),
                SessionCommand::Close => break,
                _ => panic!("unexpected resize in fixed-geometry native presentation capture"),
            }
            writer.flush().unwrap();
        }
    });
    let leases = TerminalLeaseManager::new(broker.clone());
    let acknowledger = leases.clone();
    let acquisitions = Arc::new(Mutex::new(HashMap::new()));
    let acquired = Arc::clone(&acquisitions);
    let running_events = Arc::new(Mutex::new(HashMap::new()));
    let running = Arc::clone(&running_events);
    leases
        .set_publisher(Arc::new(move |event| {
            if event.command_phase == Some(crate::agent_runtime::TerminalCommandPhase::Running) {
                running
                    .lock()
                    .unwrap()
                    .insert(event.operation_id.clone(), event.clone());
            }
            if event.state != TerminalLeaseEventState::Acquired {
                return;
            }
            acquired
                .lock()
                .unwrap()
                .insert(event.operation_id.clone(), event.clone());
            acknowledger
                .set_reduced_motion(
                    &event.session_id,
                    &event.agent_session_id,
                    &event.operation_id,
                    true,
                )
                .unwrap();
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
        }))
        .unwrap();
    let registry = TerminalExecuteRegistry::new(leases.clone(), broker.clone());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_for_prompt(&broker, transport);
        let run = |id: &str, source: &str, submitted: Option<&str>| {
            let operation = registry
                .start_native_submission(
                    &sessions,
                    transport,
                    "presentation-agent",
                    "presentation-task",
                    id,
                    source,
                    shell.enter(),
                    submitted,
                    |_| Ok(()),
                )
                .unwrap();
            let result = registry
                .wait(&sessions, transport, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
            assert_eq!(result.exit_code, Some(0));
            wait_for_prompt(&broker, transport);
            leases.release_turn("presentation-agent").unwrap();
            result
        };
        let target = AgentToolTargetNative::Local {
            target_id: "presentation-owner".into(),
            session_id: transport.into(),
            cwd: None,
        };
        let job = broker
            .prepare_shell_job(
                transport,
                &target,
                "presentation-agent",
                "presentation-task",
                "presentation-launch",
                "sleep 3",
            )
            .unwrap();
        run(
            "presentation-launch",
            "sleep 3",
            Some(&job.submitted_command_line),
        );
        let cycle = b"\x1b]133;C\x07\x1b]133;A\x07";
        let mut private_display = None;
        let mut private_events = Vec::new();
        let mut private_running = Vec::new();
        for index in 0..3 {
            let id = format!("presentation-control-{index}");
            let current = broker
                .shell_job(
                    &job.process_handle,
                    "presentation-owner",
                    "presentation-agent",
                    "presentation-task",
                )
                .unwrap();
            let source = broker
                .prepare_shell_job_control(&current, &id, false)
                .unwrap();
            let start = display.lock().unwrap().len();
            run(&id, &source, Some(&source));
            wait_until(Duration::from_secs(3), || {
                display.lock().unwrap()[start..]
                    .windows(cycle.len())
                    .any(|part| part == cycle)
            });
            let event = acquisitions.lock().unwrap().remove(&id).unwrap();
            assert_eq!(event.command_execution, Some(false));
            assert!(event.command_display.is_none());
            private_events.push(event);
            private_running.push(running_events.lock().unwrap().remove(&id).unwrap());
            let bytes = display.lock().unwrap();
            let offset = bytes[start..]
                .windows(cycle.len())
                .position(|part| part == cycle)
                .unwrap()
                + start;
            private_display =
                Some(String::from_utf8_lossy(&bytes[offset..offset + cycle.len()]).into_owned());
        }
        let source = "cat <<'SHELLSPAN_END'\nquoted '\"' and\tliteral Tab\nSHELLSPAN_END\npwd";
        let start = display.lock().unwrap().len();
        let completed = run("presentation-script", source, None);
        assert!(completed.combined_output.contains("literal Tab"));
        let event = acquisitions
            .lock()
            .unwrap()
            .remove("presentation-script")
            .unwrap();
        assert_eq!(event.command_execution, Some(true));
        assert!(event.command_display.is_none());
        if let Some(path) = std::env::var_os("SHELLSPAN_NATIVE_SCRIPT_TRACE_PATH")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("SHELLSPAN_COMMAND_PRESENTATION_DIR")
                    .map(|directory| PathBuf::from(directory).join("native-script.bin"))
            })
        {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, &display.lock().unwrap()[start..]).unwrap();
            fs::write(
                format!("{}.json", path.display()),
                serde_json::to_vec(&serde_json::json!({
                    "columns": 100, "rows": 30, "leaseEvent": event,
                    "privateLeaseEvents": private_events, "privateRunningEvents": private_running,
                    "privateDisplay": private_display.unwrap(),
                }))
                .unwrap(),
            )
            .unwrap();
        }
        registry
            .cleanup_shell_jobs(&sessions, Some("presentation-task"))
            .unwrap();
    }));
    let _ = child.kill();
    let _ = child.wait();
    sessions.remove(transport).unwrap();
    input_thread.join().unwrap();
    drop(pair.master);
    output_thread.join().unwrap();
    control.stop();
    leases.set_publisher(Arc::new(|_| {})).unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
