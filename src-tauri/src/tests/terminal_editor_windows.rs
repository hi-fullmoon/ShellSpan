    #[cfg(windows)]
    fn verify_windows_editor_interruptions(executable: &str, shell: TerminalShellKind) {
        use crate::agent_runtime::{
            TerminalExecuteRegistry, TerminalInputSource, TerminalLeaseEventState,
            TerminalLeaseManager,
        };
        use crate::models::{
            ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
            SessionStatus, SessionTerminalKind, StatusEvent,
        };
        use crate::terminal_broker::{
            TerminalGenerationCloseReason, TerminalGeometry, TerminalSessionBroker,
            TerminalTransportKind,
        };
        use portable_pty::{native_pty_system, PtySize};
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::{Arc, Mutex};
        use std::time::Instant;

        let broker = TerminalSessionBroker::phase3_enabled_for_test(64 * 1024);
        let leases = TerminalLeaseManager::new(broker.clone());
        let ready = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == TerminalLeaseEventState::Acquired {
                    ready
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
                }
            }))
            .unwrap();
        let registry = TerminalExecuteRegistry::new(leases.clone(), broker.clone());
        let mut predecessor: Option<String> = None;
        let mut original_identity = None;
        let mut evidence = Vec::new();
        for (round, mode) in ["cancel", "takeover", "timeout", "ctrl-c", "recovered"]
            .into_iter()
            .enumerate()
        {
            let fixture = tempfile::tempdir().unwrap();
            let transport = format!("native-data-{}-{round}", Uuid::new_v4());
            let attachment = broker
                .attach_transport(
                    &transport,
                    predecessor.as_deref(),
                    TerminalTransportKind::WindowsConPty,
                    TerminalGeometry::new(80, 25),
                )
                .unwrap()
                .unwrap();
            if let Some(identity) = &original_identity {
                assert_eq!(&attachment.terminal_session_id, identity);
            } else {
                original_identity = Some(attachment.terminal_session_id.clone());
            }
            assert_eq!(attachment.terminal_generation, round as u64 + 1);
            if let Some(old) = &predecessor {
                assert!(leases
                    .write(
                        &SessionManager::default(),
                        old,
                        "\r".into(),
                        TerminalInputSource::User
                    )
                    .is_err());
            }
            let integration =
                PreparedLocalShellIntegration::prepare(shell, fixture.path()).unwrap();
            let bootstrap = fs::read_to_string(&integration.bootstrap_path).unwrap();
            fs::write(
                &integration.bootstrap_path,
                format!(
                    "{}\n{bootstrap}",
                    powershell_history_redirect(&fixture.path().join("history.txt"))
                ),
            )
            .unwrap();
            let integration_id = integration.integration_id().to_string();
            broker
                .register_integration_channel(&transport, &integration_id, shell)
                .unwrap();
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 25,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let mut reader = pair.master.try_clone_reader().unwrap();
            let writer = Arc::new(Mutex::new(
                crate::local_terminal_input::take_writer(pair.master.as_ref(), shell).unwrap(),
            ));
            let mut command = CommandBuilder::new(executable);
            command.arg("-NoProfile");
            command.env("TERM", "xterm-256color");
            command.env("SHELLSPAN_NATIVE_POWERSHELL_JOBS", "0");
            integration.configure_command(&mut command).unwrap();
            let mut child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let epoch = Arc::new(AtomicU64::new(0));
            let buffers = Arc::new(Mutex::new(Vec::<String>::new()));
            let control_epoch = Arc::clone(&epoch);
            let control_buffers = Arc::clone(&buffers);
            let control_broker = broker.clone();
            let control_transport = transport.clone();
            let control_id = integration_id.clone();
            let _control = integration.start_reader(
                move |event| {
                    if let TerminalIntegrationControlEvent::NativeCheckpoint { buffer } = &event {
                        control_buffers.lock().unwrap().push(buffer.clone());
                    }
                    if matches!(&event, TerminalIntegrationControlEvent::PromptEnd) {
                        control_epoch.fetch_add(1, Ordering::Release);
                    }
                    control_broker.accept_integration_event(&control_transport, &control_id, event)
                },
                |_| {},
            );
            let output_broker = broker.clone();
            let output_transport = transport.clone();
            let raw_output = Arc::new(Mutex::new(Vec::new()));
            let recorded_output = Arc::clone(&raw_output);
            let output = thread::spawn(move || {
                let mut bytes = [0; 4096];
                while let Ok(count) = reader.read(&mut bytes) {
                    if count == 0 {
                        break;
                    }
                    recorded_output
                        .lock()
                        .unwrap()
                        .extend_from_slice(&bytes[..count]);
                    let _ = output_broker.observe_raw_output(&output_transport, &bytes[..count]);
                }
            });
            let sessions = SessionManager::default();
            let (sender, receiver) = crossbeam_channel::unbounded();
            sessions
                .insert(
                    transport.clone(),
                    ManagedSession {
                        sender: SessionCommandSender::Event(sender),
                        waker: None,
                        output_state_sender: None,
                        status: StatusEvent {
                            session_id: transport.clone(),
                            status: SessionStatus::Connected,
                            message: None,
                        },
                        output_ready: Arc::new(AtomicBool::new(true)),
                        output_paused: Arc::new(AtomicBool::new(false)),
                        terminal_kind: SessionTerminalKind::Local,
                        identity: SessionIdentity {
                            title: mode.into(),
                            host: "local".into(),
                            port: 0,
                            username: String::new(),
                        },
                    },
                )
                .unwrap();
            let (partial_tx, partial_rx) = crossbeam_channel::bounded::<()>(1);
            let (release_tx, release_rx) = crossbeam_channel::bounded::<()>(1);
            let armed = Arc::new(AtomicBool::new(false));
            let gate = Arc::clone(&armed);
            let input_writer = Arc::clone(&writer);
            let clear_before_probe = Arc::new(AtomicBool::new(false));
            let pending_user_clear = Arc::clone(&clear_before_probe);
            let resize_before_payload = Arc::new(AtomicBool::new(false));
            let pending_resize = Arc::clone(&resize_before_payload);
            let writes = Arc::new(Mutex::new(Vec::<String>::new()));
            let recorded = Arc::clone(&writes);
            let input = thread::spawn(move || {
                while let Ok(SessionCommand::Write(data)) = receiver.recv() {
                    if data == "\u{18}\u{2}" && pending_user_clear.swap(false, Ordering::AcqRel) {
                        // Deliver a real, previously queued user ClearScreen
                        // after initial A and before the Agent's data-readiness
                        // probe, while no source payload has been enqueued.
                        let mut writer = input_writer.lock().unwrap();
                        writer.write_all(b"\x0c").unwrap();
                        writer.flush().unwrap();
                        recorded.lock().unwrap().push("\x0c".into());
                    }
                    if data.ends_with("\u{18}\u{6}") && pending_resize.swap(false, Ordering::AcqRel)
                    {
                        partial_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    }
                    if data.ends_with("\u{18}\u{6}") && gate.swap(false, Ordering::AcqRel) {
                        let half = data.len() / 2;
                        {
                            let mut writer = input_writer.lock().unwrap();
                            writer.write_all(&data.as_bytes()[..half]).unwrap();
                            writer.flush().unwrap();
                        }
                        partial_tx.send(()).unwrap();
                        let _ = release_rx.recv_timeout(Duration::from_secs(5));
                        {
                            let mut writer = input_writer.lock().unwrap();
                            writer.write_all(&data.as_bytes()[half..]).unwrap();
                            writer.flush().unwrap();
                        }
                    } else {
                        let mut writer = input_writer.lock().unwrap();
                        writer.write_all(data.as_bytes()).unwrap();
                        writer.flush().unwrap();
                    }
                    recorded.lock().unwrap().push(data);
                }
            });
            let mut stage = "startup";
            let mut settled = None;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                wait_for_prompt_with_timeout(&broker, &transport, Duration::from_secs(15));
                if mode == "recovered" {
                    stage = "running-takeover-before-user-clear";
                    let ready = fixture.path().join("takeover-running");
                    let forbidden = fixture.path().join("takeover-must-not-finish");
                    let source = format!("[IO.File]::WriteAllText('{}','running'); Start-Sleep -Seconds 60; [IO.File]::WriteAllText('{}','forbidden')", ready.to_string_lossy().replace('\'', "''"), forbidden.to_string_lossy().replace('\'', "''"));
                    let running = registry
                        .start(
                            &sessions,
                            &transport,
                            "native-agent",
                            "running-takeover",
                            "running-takeover",
                            &source,
                            shell.enter(),
                        )
                        .unwrap();
                    wait_until(Duration::from_secs(5), || ready.exists());
                    registry
                        .takeover(&sessions, &transport, "native-agent", "running-takeover")
                        .unwrap();
                    let stopped = registry
                        .wait(&sessions, &transport, &running, Duration::from_secs(5))
                        .unwrap();
                    assert_eq!(
                        stopped.state,
                        crate::terminal_broker::TerminalCommandState::TakenOver
                    );
                    wait_for_prompt(&broker, &transport);
                    assert!(!forbidden.exists());
                    leases.release_turn("native-agent").unwrap();
                    clear_before_probe.store(true, Ordering::Release);
                }
                stage = "fresh-generation-command";
                let before_fresh_prompt = epoch.load(Ordering::Acquire);
                let recovered = fixture.path().join("fresh-generation");
                let quoted = recovered.to_string_lossy().replace('\'', "''");
                let fresh_source = format!(
                    "[IO.File]::WriteAllText('{quoted}','fresh'){}",
                    if mode == "recovered" {
                        format!("; # {}", "resize-origin-".repeat(25))
                    } else {
                        String::new()
                    }
                );
                let start_fresh = || {
                    registry.start(
                        &sessions,
                        &transport,
                        "native-agent",
                        "fresh",
                        "fresh",
                        &fresh_source,
                        shell.enter(),
                    )
                };
                let operation = if mode == "recovered" {
                    resize_before_payload.store(true, Ordering::Release);
                    thread::scope(|scope| {
                        let pending = scope.spawn(start_fresh);
                        partial_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                        assert!(registry
                            .editor_batch_pending_for_test(&transport, "fresh")
                            .unwrap());
                        pair.master
                            .resize(PtySize {
                                rows: 49,
                                cols: 145,
                                pixel_width: 0,
                                pixel_height: 0,
                            })
                            .unwrap();
                        broker
                            .resize(&transport, TerminalGeometry::new(145, 49))
                            .unwrap();
                        release_tx.send(()).unwrap();
                        pending.join().unwrap()
                    })
                } else {
                    start_fresh()
                }
                .unwrap();
                assert_eq!(
                    registry
                        .wait(&sessions, &transport, &operation, Duration::from_secs(5))
                        .unwrap()
                        .exit_code,
                    Some(0)
                );
                assert_eq!(fs::read_to_string(&recovered).unwrap(), "fresh");
                wait_for_prompt(&broker, &transport);
                if mode == "recovered" {
                    assert!(!clear_before_probe.load(Ordering::Acquire));
                    assert!(writes.lock().unwrap().iter().any(|wire| wire == "\x0c"));
                    assert_eq!(
                        epoch.load(Ordering::Acquire),
                        before_fresh_prompt + 1,
                        "Native ClearScreen emitted an extra host prompt lifecycle"
                    );
                    use base64::Engine;
                    stage = "native-fence-preserves-following-user-keys";
                    let source = "# exact data 字😀\r\n# trailing user keys: ";
                    let tail = "user-tail-字😀";
                    let before = buffers.lock().unwrap().len();
                    {
                        let mut writer = writer.lock().unwrap();
                        writer.write_all(b"\x18\x01").unwrap();
                        writer.flush().unwrap();
                    }
                    wait_until(Duration::from_secs(3), || {
                        buffers.lock().unwrap().len() > before
                    });
                    assert!(buffers.lock().unwrap().last().unwrap().is_empty());
                    {
                        let mut writer = writer.lock().unwrap();
                        writer.write_all(b"\x18\x02").unwrap();
                        writer.flush().unwrap();
                    }
                    wait_until(Duration::from_secs(3), || {
                        buffers.lock().unwrap().len() >= before + 2
                    });
                    assert!(buffers.lock().unwrap().last().unwrap().is_empty());
                    {
                        let wire = format!(
                            "{}\u{18}\u{6}{tail}\u{18}\u{1}",
                            base64::engine::general_purpose::STANDARD.encode(source)
                        );
                        let mut writer = writer.lock().unwrap();
                        writer.write_all(wire.as_bytes()).unwrap();
                        writer.flush().unwrap();
                    }
                    wait_until(Duration::from_secs(3), || {
                        buffers.lock().unwrap().len() >= before + 4
                    });
                    let expected = format!("{source}{tail}");
                    assert_eq!(
                        buffers.lock().unwrap().last().unwrap(),
                        &expected,
                        "Receiver consumed or changed real keys following its private fence"
                    );
                    stage = "existing-user-buffer-rejects-agent-source";
                    let forbidden = fixture.path().join("existing-user-buffer-must-not-execute");
                    let attempted = format!(
                        "[IO.File]::WriteAllText('{}','forbidden')\n# unchanged user draft",
                        forbidden.to_string_lossy().replace('\'', "''")
                    );
                    let before_writes = writes.lock().unwrap().len();
                    let error = registry
                        .start_native_submission(
                            &sessions,
                            &transport,
                            "native-agent",
                            "nonempty-user-draft",
                            "nonempty-user-draft",
                            &attempted,
                            shell.enter(),
                            None,
                            |_| Ok(()),
                        )
                        .unwrap_err();
                    assert!(
                        error.contains("PENDING_INPUT"),
                        "Existing user input was not rejected: {error}"
                    );
                    assert!(!forbidden.exists());
                    assert!(
                        writes.lock().unwrap()[before_writes..]
                            .iter()
                            .all(|wire| wire == "\u{18}\u{1}"),
                        "Agent wrote source or a clearing key into the user's existing buffer"
                    );
                    let before = buffers.lock().unwrap().len();
                    {
                        let mut writer = writer.lock().unwrap();
                        writer.write_all(b"\x18\x01").unwrap();
                        writer.flush().unwrap();
                    }
                    wait_until(Duration::from_secs(3), || {
                        buffers.lock().unwrap().len() > before
                    });
                    assert_eq!(buffers.lock().unwrap().last().unwrap(), &expected);
                    evidence.push(serde_json::json!({"mode":mode,"generation":attachment.terminal_generation,"terminalSessionId":attachment.terminal_session_id,"freshCommandExecuted":true,"exitCode":0,"runningTakeoverThenUserClearThenNextCommand":true,"followingUserKeysPreserved":true,"existingUserBufferPreserved":true,"agentSourceExecuted":false,"initialDraftError":error}));
                    return;
                }
                let effect = fixture.path().join("must-not-execute");
                let escaped = effect.to_string_lossy().replace('\'', "''");
                let source=format!("[IO.File]::WriteAllText('{escaped}','forbidden')\nWrite-Output must-not-execute");
                let before_epoch = epoch.load(Ordering::Acquire);
                armed.store(true, Ordering::Release);
                let mut physical_interrupt_written = false;
                let request = thread::scope(|scope| {
                    let deadline =
                        (mode == "timeout").then(|| Instant::now() + Duration::from_millis(750));
                    let registry_ref = &registry;
                    let sessions_ref = &sessions;
                    let transport_ref = &transport;
                    let source_ref = &source;
                    let start = scope.spawn(move || {
                        registry_ref.start_native_submission_until(
                            sessions_ref,
                            transport_ref,
                            "native-agent",
                            "fault",
                            mode,
                            source_ref,
                            shell.enter(),
                            None,
                            deadline,
                            |_| {
                                if deadline.is_some_and(|value| Instant::now() >= value) {
                                    Err("TERMINAL_JOB_WAIT_DEADLINE".into())
                                } else {
                                    Ok(())
                                }
                            },
                        )
                    });
                    stage = "partial-payload-delivery";
                    partial_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    assert!(registry
                        .editor_batch_pending_for_test(&transport, mode)
                        .unwrap());
                    if mode == "timeout" {
                        let outcome = start.join().unwrap();
                        release_tx.send(()).unwrap();
                        outcome
                    } else {
                        if mode == "cancel" {
                            registry.cancel_task(&sessions, "fault").unwrap();
                        } else if mode == "takeover" {
                            registry
                                .takeover(&sessions, &transport, "native-agent", mode)
                                .unwrap();
                        } else {
                            let mut writer = writer.lock().unwrap();
                            writer.write_all(b"\x03").unwrap();
                            writer.flush().unwrap();
                            physical_interrupt_written = true;
                        }
                        release_tx.send(()).unwrap();
                        start.join().unwrap()
                    }
                });
                let outcome = request.as_ref().ok().map(|operation| {
                    registry
                        .wait(&sessions, &transport, operation, Duration::ZERO)
                        .unwrap()
                });
                settled = outcome.clone();
                let expected = match mode {
                    "cancel" => crate::terminal_broker::TerminalCommandState::Cancelled,
                    "takeover" => crate::terminal_broker::TerminalCommandState::TakenOver,
                    "timeout" => crate::terminal_broker::TerminalCommandState::TimedOut,
                    _ => crate::terminal_broker::TerminalCommandState::Uncertain,
                };
                if let Some(snapshot) = &outcome {
                    assert_eq!(
                        snapshot.state, expected,
                        "{mode}: settlement reason changed: {snapshot:?}"
                    );
                }
                let interruption_error = request.as_ref().err().cloned();
                if let Some(error) = &interruption_error {
                    let expected_error = match mode {
                        "timeout" => {
                            error.contains("DEADLINE") || error.contains("RECOVERY_REQUIRED")
                        }
                        "ctrl-c" => {
                            error.contains("RECOVERY_REQUIRED")
                                || error.contains("NATIVE_EDIT_INTERRUPTED")
                        }
                        _ => error.contains("INTERRUPTED") || error.contains("RECOVERY_REQUIRED"),
                    };
                    assert!(
                        expected_error,
                        "{mode}: unexpected interruption error: {error}"
                    );
                }
                stage = "native-cancel-and-control-write";
                wait_until(Duration::from_secs(6), || {
                    // Physical Ctrl-C can stop the PowerShell key-handler
                    // pipeline without a trusted prompt lifecycle. Require
                    // its real native CancelLine output, then independently
                    // prove the full empty BUFFER and sticky input gate below.
                    let native_cancel = mode == "ctrl-c"
                        && raw_output
                            .lock()
                            .unwrap()
                            .windows(2)
                            .any(|bytes| bytes == b"^C");
                    (epoch.load(Ordering::Acquire) > before_epoch || native_cancel)
                        && (physical_interrupt_written
                            || writes.lock().unwrap().iter().any(|data| data == "\x03"))
                });
                assert!(
                    !effect.exists(),
                    "interrupted encoded data or its source executed"
                );
                assert!(
                    !broker.native_input_enabled(&transport).unwrap(),
                    "unconfirmed editor data was falsely declared recovered"
                );
                stage = "released-turn-input-recovery-gate";
                leases.release_turn("native-agent").unwrap();
                let input_error = leases
                    .write(
                        &sessions,
                        &transport,
                        "\r".into(),
                        TerminalInputSource::User,
                    )
                    .unwrap_err();
                assert!(
                    input_error.contains("RECOVERY_REQUIRED"),
                    "{mode}: wrong input gate after settlement: {input_error}"
                );
                stage = "read-only-complete-buffer-probe";
                let before = buffers.lock().unwrap().len();
                {
                    let mut writer = writer.lock().unwrap();
                    writer.write_all(b"\x18\x01").unwrap();
                    writer.flush().unwrap();
                }
                wait_until(Duration::from_secs(3), || {
                    buffers.lock().unwrap().len() > before
                });
                let actual = buffers.lock().unwrap().last().unwrap().clone();
                assert!(
                    actual.is_empty(),
                    "native editor retained data after interruption; reconnect remains required"
                );
                if mode == "ctrl-c" {
                    use base64::Engine;
                    stage = "interrupted-fence-preserves-following-user-keys";
                    let before = buffers.lock().unwrap().len();
                    {
                        let mut writer = writer.lock().unwrap();
                        writer.write_all(b"\x18\x02").unwrap();
                        writer.flush().unwrap();
                    }
                    wait_until(Duration::from_secs(3), || {
                        buffers.lock().unwrap().len() > before
                    });
                    assert!(buffers.lock().unwrap().last().unwrap().is_empty());
                    let tail = "after-interrupt-user-字😀";
                    {
                        let wire = format!(
                            "{}\u{3}\u{18}\u{6}{tail}\u{18}\u{1}",
                            base64::engine::general_purpose::STANDARD
                                .encode("# interrupted editor data 字😀")
                        );
                        let mut writer = writer.lock().unwrap();
                        writer.write_all(wire.as_bytes()).unwrap();
                        writer.flush().unwrap();
                    }
                    wait_until(Duration::from_secs(3), || {
                        buffers.lock().unwrap().len() >= before + 3
                    });
                    assert_eq!(
                        buffers.lock().unwrap().last().unwrap(),
                        tail,
                        "Interrupted receiver consumed real keys after its private fence"
                    );
                    assert!(!broker.native_input_enabled(&transport).unwrap());
                    evidence.push(serde_json::json!({"mode":"ctrl-c-following-user-keys","generation":attachment.terminal_generation,"terminalSessionId":attachment.terminal_session_id,"followingUserKeysPreserved":true,"recoveryRequired":true,"sourceExecuted":effect.exists()}));
                }
                let no_enter = writes
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|data| data.ends_with("\u{18}\u{6}"))
                    .all(|data| !data.contains(['\r', '\n']));
                assert!(no_enter, "encoded input transport included an Enter");
                evidence.push(serde_json::json!({"mode":mode,"generation":attachment.terminal_generation,"terminalSessionId":attachment.terminal_session_id,"bufferBytes":actual.len(),"sourceExecuted":effect.exists(),"recoveryRequired":true,"noEnterInPayload":no_enter,"outcome":outcome,"interruptionError":interruption_error}));
            }));
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
                fs::write(
                    format!("{prefix}.{}.{mode}.bin", shell.protocol_name()),
                    &*raw_output.lock().unwrap(),
                )
                .unwrap();
                fs::write(
                    format!("{prefix}.{}.progress.json", shell.protocol_name()),
                    serde_json::to_vec_pretty(&evidence).unwrap(),
                )
                .unwrap();
            }
            if result.is_err() {
                let last = buffers.lock().unwrap().last().cloned().unwrap_or_default();
                let digest = <sha2::Sha256 as sha2::Digest>::digest(last.as_bytes());
                let (write_lengths, interrupt_written) = {
                    let values = writes.lock().unwrap();
                    (
                        values.iter().map(String::len).collect::<Vec<_>>(),
                        values.iter().any(|data| data == "\x03"),
                    )
                };
                let diagnostic = serde_json::json!({"mode":mode,"stage":stage,"operation":settled,
                    "promptEpoch":epoch.load(Ordering::Acquire),"bufferBytes":last.len(),"bufferSha256":hex::encode(digest),
                    "writeLengths":write_lengths,"interruptWritten":interrupt_written,"broker":broker.snapshot(Some(&transport)).unwrap()});
                eprintln!("Native editor interruption diagnostic: {diagnostic}");
                if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
                    fs::write(
                        format!("{prefix}.{}.{mode}.failure.json", shell.protocol_name()),
                        serde_json::to_vec_pretty(&diagnostic).unwrap(),
                    )
                    .unwrap();
                }
            }
            let _ = release_tx.try_send(());
            sessions.remove(&transport).unwrap();
            input.join().unwrap();
            let _ = child.kill();
            child.wait().unwrap();
            drop(writer);
            drop(pair.master);
            output.join().unwrap();
            broker
                .close_transport(&transport, TerminalGenerationCloseReason::UserClosed)
                .unwrap();
            predecessor = Some(transport);
            if let Err(error) = result {
                std::panic::resume_unwind(error);
            }
        }
        if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
            fs::write(
                format!("{prefix}.{}.interruptions.json", shell.protocol_name()),
                serde_json::to_vec_pretty(&evidence).unwrap(),
            )
            .unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires native Windows PowerShell 5.1 and real ConPTY interruption/reconnect"]
    fn windows_powershell_5_1_editor_data_interruptions() {
        verify_windows_editor_interruptions("powershell.exe", TerminalShellKind::WindowsPowerShell);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires native PowerShell 7 and real ConPTY interruption/reconnect"]
    fn windows_powershell_7_editor_data_interruptions() {
        verify_windows_editor_interruptions("pwsh.exe", TerminalShellKind::PowerShell7);
    }
