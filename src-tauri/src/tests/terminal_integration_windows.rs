    #[cfg(target_os = "windows")]
    fn windows_screen_cells(
        screen: &vt100::Screen,
        rows: std::ops::Range<u16>,
    ) -> (String, Vec<(usize, u16, u16)>) {
        let mut text = String::new();
        let mut positions = Vec::new();
        for row in rows {
            for column in 0..screen.size().1 {
                positions.push((text.len(), row, column));
                let cell = screen.cell(row, column).unwrap().contents();
                if cell.is_empty() {
                    text.push(' ');
                } else {
                    text.push_str(&cell);
                }
            }
        }
        (text, positions)
    }

    #[cfg(target_os = "windows")]
    fn windows_terminal_cells(parser: &mut vt100::Parser) -> String {
        parser.screen_mut().set_scrollback(usize::MAX);
        let history = parser.screen().scrollback();
        let rows = parser.screen().size().0;
        let mut text = String::new();
        // Each physical row exactly once, oldest first, including scrollback.
        for offset in (0..=history).rev() {
            parser.screen_mut().set_scrollback(offset);
            text.push_str(
                &windows_screen_cells(parser.screen(), 0..if offset == 0 { rows } else { 1 }).0,
            );
        }
        text
    }

    #[cfg(target_os = "windows")]
    fn verify_powershell_native_jobs(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        leases: &crate::agent_runtime::TerminalLeaseManager,
        registry: &crate::agent_runtime::TerminalExecuteRegistry,
        sessions: &crate::models::SessionManager,
        transport: &str,
        shell: TerminalShellKind,
        display: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        reader_diagnostic: bool,
    ) {
        use crate::agent_runtime::AgentToolTargetNative;
        use crate::terminal_broker::TerminalCommandState;
        let columns = u16::try_from(
            broker
                .snapshot(Some(transport))
                .unwrap()
                .session
                .unwrap()
                .geometry
                .columns,
        )
        .unwrap();
        let rendered_cells = |bytes: &[u8]| {
            let mut terminal = vt100::Parser::new(30, columns, 20_000);
            terminal.process(bytes);
            windows_terminal_cells(&mut terminal)
        };
        let target = AgentToolTargetNative::Local {
            target_id: "windows-job-owner".into(),
            session_id: transport.into(),
            cwd: None,
        };
        let run = |source: &str| {
            let id = format!("windows-job-front-{}", Uuid::new_v4());
            let operation = registry
                .start(
                    sessions,
                    transport,
                    "native-agent",
                    "native-task",
                    &id,
                    source,
                    shell.enter(),
                )
                .unwrap_or_else(|error| {
                    panic!("Windows source admission failed for {source:?}: {error}")
                });
            let result = registry
                .wait(sessions, transport, &operation, Duration::from_secs(10))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
            wait_for_prompt(broker, transport);
            result
        };
        if reader_diagnostic {
            assert_eq!(
                run("Set-PSReadLineOption -EnableScreenReaderMode").exit_code,
                Some(0)
            );
        }
        let native_jobs_available = broker
            .snapshot(Some(transport))
            .unwrap()
            .session
            .unwrap()
            .integration_capabilities
            .contains(&"nativeJobControl");
        if !native_jobs_available {
            let diagnostic = run("& $__shellspanModule { 'rollout=' + $script:NativeJobRollout; 'console=' + $script:ConsoleSignalReady; 'language=' + $ExecutionContext.SessionState.LanguageMode; 'engine=' + $PSVersionTable.PSVersion; try { Add-Type -TypeDefinition $script:NativeJobHostSource -ErrorAction Stop; 'host-ok'; 'capability=' + (Test-ShellSpanNativeJobs) } catch { $_ | Out-String } }");
            panic!(
                "Native job capability unavailable: {}",
                diagnostic.combined_output
            );
        }
        let launch_checked = |source: &str, expected_started: bool| {
            let id = format!("windows-job-{}", Uuid::new_v4());
            let job = broker
                .prepare_shell_job(
                    transport,
                    &target,
                    "native-agent",
                    "native-task",
                    &id,
                    source,
                )
                .unwrap();
            let operation = registry
                .start_native_submission(
                    sessions,
                    transport,
                    "native-agent",
                    "native-task",
                    &id,
                    source,
                    shell.enter(),
                    Some(&job.submitted_command_line),
                    |_| Ok(()),
                )
                .unwrap_or_else(|error| {
                    let bytes = display.lock().unwrap().clone();
                    if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                        fs::write(format!("{prefix}.failed.raw.bin"), &bytes).unwrap();
                        fs::write(format!("{prefix}.failed.cells.txt"), rendered_cells(&bytes))
                            .unwrap();
                    }
                    panic!(
                        "{error}; native display tail={:?}",
                        String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(2400)..])
                    );
                });
            let result = registry
                .wait(sessions, transport, &operation, Duration::from_secs(10))
                .unwrap();
            assert_eq!(
                result.submitted_command_line,
                Some(job.submitted_command_line.clone())
            );
            assert_eq!(result.command_line, source);
            assert_eq!(result.exit_code, Some(0), "{result:?}");
            wait_for_prompt(broker, transport);
            let actual = broker
                .shell_job(
                    &job.process_handle,
                    "windows-job-owner",
                    "native-agent",
                    "native-task",
                )
                .unwrap();
            if actual.launch_confirmed != expected_started {
                let bytes = display.lock().unwrap();
                eprintln!(
                    "Native launch diagnostic tail: {:?}",
                    String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(6000)..])
                );
            }
            assert_eq!(
                broker
                    .shell_job(
                        &job.process_handle,
                        "windows-job-owner",
                        "native-agent",
                        "native-task"
                    )
                    .unwrap()
                    .launch_confirmed,
                expected_started,
                "native launch acknowledgement mismatch: {result:?}"
            );
            actual
        };
        let launch = |source: &str| launch_checked(source, true);
        let rejection_message_count = |reason: &str| {
            // Compare only diagnostic text across native warning wrapping;
            // source, editor buffer and ordinary output assertions stay exact.
            let cells = rendered_cells(&display.lock().unwrap());
            let compact = cells.split_whitespace().collect::<String>();
            compact
                .matches(&reason.split_whitespace().collect::<String>())
                .count()
        };
        let observe = |job: &crate::terminal_jobs::NativeShellJob, stop: bool| {
            let fresh = broker
                .shell_job(
                    &job.process_handle,
                    "windows-job-owner",
                    "native-agent",
                    "native-task",
                )
                .unwrap();
            if matches!(fresh.state.as_str(), "exited" | "uncertain" | "rejected") {
                return fresh;
            }
            let id = format!("windows-job-control-{}", Uuid::new_v4());
            let line = broker.prepare_shell_job_control(&fresh, &id, stop).unwrap();
            let start = display.lock().unwrap().len();
            let operation = registry
                .start_native_submission(
                    sessions,
                    transport,
                    "native-agent",
                    "native-task",
                    &id,
                    &line,
                    shell.enter(),
                    Some(&line),
                    |_| Ok(()),
                )
                .unwrap_or_else(|error| {
                    let before = broker.snapshot(Some(transport)).unwrap();
                    if !broker.native_input_enabled(transport).unwrap() {
                        panic!("Native job control failed: {error}; before={before:?}");
                    }
                    let diagnostic = run("& $__shellspanModule { 'K='+(Test-ShellSpanNativeJobs); Get-ChildItem Function: | Where-Object ModuleName | ForEach-Object { $_.Name+':'+$_.ModuleName } }");
                    panic!(
                        "Native job control failed: {error}; before={before:?}; {}",
                        diagnostic.combined_output
                    );
                });
            let result = registry
                .wait(sessions, transport, &operation, Duration::from_secs(10))
                .unwrap();
            assert_eq!(result.exit_code, Some(0), "{result:?}");
            wait_for_prompt(broker, transport);
            let bytes = display.lock().unwrap().clone();
            assert!(
                !String::from_utf8_lossy(&bytes[start..])
                    .contains("Invoke-ShellSpanNativeJobControl"),
                "private control source leaked into native output"
            );
            assert!(
                !rendered_cells(&bytes).contains("Invoke-ShellSpanNativeJobControl"),
                "private control source reached native cells"
            );
            broker
                .shell_job(
                    &job.process_handle,
                    "windows-job-owner",
                    "native-agent",
                    "native-task",
                )
                .unwrap()
        };
        let settle = |job: &crate::terminal_jobs::NativeShellJob| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let current = observe(job, false);
                if matches!(current.state.as_str(), "exited" | "uncertain" | "rejected") {
                    break current;
                }
                assert!(Instant::now() < deadline, "{current:?}");
                thread::sleep(Duration::from_millis(20));
            }
        };
        let fixture = tempfile::tempdir().unwrap();
        let effect = fixture.path().join("once.txt");
        let inherited = fixture.path().join("inherited.txt");
        let completion_gate = fixture.path().join("complete");
        let body_ready = fixture.path().join("body-ready");
        let tokens_path = fixture.path().join("tokens.json");
        let stream_tokens: Vec<String> = [
            "ps-output",
            "ps-error",
            "native-output",
            "native-error",
            "console-output",
        ]
        .iter()
        .map(|prefix| format!("{prefix}-{}", Uuid::new_v4()))
        .collect();
        let output_present = |cells: &str, index: usize| {
            // PowerShell's native error formatter inserts physical line
            // padding at narrow widths. Preserve every marker character;
            // ordinary stdout and raw Console output remain exact cells.
            if matches!(index, 1 | 3) {
                cells
                    .chars()
                    .filter(|value| !value.is_whitespace())
                    .collect::<String>()
                    .contains(&stream_tokens[index])
            } else {
                cells.contains(&stream_tokens[index])
            }
        };
        fs::write(&tokens_path, serde_json::to_vec(&stream_tokens).unwrap()).unwrap();
        let quote = |path: &Path| path.to_string_lossy().replace('\'', "''");
        assert_eq!(
            run("${global:SS_JOB_LITERAL?}='literal-kept'").exit_code,
            Some(0)
        );
        assert_eq!(run("$global:SS_JOB_VALUE='kept'; function global:ss_job_fn { 'function-kept' }; Set-Alias -Scope Global ss_job_alias Write-Output").exit_code,Some(0));
        assert_eq!(run(&format!("$tokens=[IO.File]::ReadAllText('{}') | ConvertFrom-Json; $env:SS_PS_OUTPUT=$tokens[0]; $env:SS_PS_ERROR=$tokens[1]; $env:SS_NATIVE_TOKEN=$tokens[2]; $env:SS_NATIVE_ERR=$tokens[3]; $env:SS_CONSOLE_TOKEN=$tokens[4]",quote(&tokens_path))).exit_code,Some(0));
        let source=format!("[IO.File]::WriteAllText('{}', ((ss_job_alias 'alias-kept')+(ss_job_fn)+$global:SS_JOB_VALUE+(Get-Location).ProviderPath)); Write-Output $env:SS_PS_OUTPUT; Write-Error $env:SS_PS_ERROR -ErrorAction Continue; cmd.exe /d /c 'echo %SS_NATIVE_TOKEN% & echo %SS_NATIVE_ERR% 1>&2'; [Console]::WriteLine($env:SS_CONSOLE_TOKEN); [Console]::Write($env:SS_CONSOLE_TOKEN+'-control'+[char]27+'[31m'+$env:SS_CONSOLE_TOKEN+'-ansi'+[char]27+\"[0m`n\"); [Console]::Write('INITIAL-LINE'+[char]13+$env:SS_CONSOLE_TOKEN+'-cr'+[char]9+$env:SS_CONSOLE_TOKEN+\"-tab`n\"); [IO.File]::WriteAllText('{}','ready'); while (-not [IO.File]::Exists('{}')) {{ Start-Sleep -Milliseconds 10 }}; [IO.File]::AppendAllText('{}',\"once`n\"); exit 7",quote(&inherited),quote(&body_ready),quote(&completion_gate),quote(&effect));
        let start = display.lock().unwrap().len();
        let display_start = display.lock().unwrap().len();
        let first = launch(&source);
        let accepted_display = display.lock().unwrap().clone();
        let accepted_cells = rendered_cells(&accepted_display);
        for private in [
            "Invoke-ShellSpanNativeJobStart",
            "__shellspan_saved_errors",
            "__shellspan_strict_probe",
        ] {
            assert!(
                !String::from_utf8_lossy(&accepted_display[display_start..]).contains(private),
                "private launch code leaked: {private}"
            );
            assert!(
                !accepted_cells.contains(private),
                "private launch code reached native cells: {private}"
            );
        }
        assert!(
            accepted_cells.contains(&first.process_handle),
            "native job marker is absent"
        );
        let early_deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let bytes = display.lock().unwrap();
            let text = String::from_utf8_lossy(&bytes[start..]);
            let cells = rendered_cells(&bytes);
            let ready = body_ready.exists()
                && (0..stream_tokens.len()).all(|index| output_present(&cells, index))
                && ["-control", "-ansi", "-cr", "-tab"]
                    .iter()
                    .all(|suffix| cells.contains(&format!("{}{suffix}", stream_tokens[4])));
            let failure = (!ready && Instant::now() >= early_deadline).then(|| {
                format!(
                    "ordinary/native stdout/stderr were not visible before job completion; inherited={}; effect={}; raw={text:?}",
                    inherited.exists(), effect.exists()
                )
            });
            drop(bytes);
            if ready {
                break;
            }
            if let Some(failure) = failure {
                panic!("{failure}");
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!effect.exists(), "output was delayed until completion");
        let early_bytes = display.lock().unwrap().clone();
        let mut terminal = vt100::Parser::new(30, columns, 0);
        terminal.process(&early_bytes);
        let (cells, coordinates) = windows_screen_cells(terminal.screen(), 0..30);
        let position = |marker: &str| {
            let offset = cells
                .find(marker)
                .unwrap_or_else(|| panic!("native marker missing from actual cells: {marker}"));
            let (_, row, column) = coordinates
                .iter()
                .find(|entry| entry.0 == offset)
                .copied()
                .unwrap();
            (row, column)
        };
        let ansi_marker = format!("{}-ansi", stream_tokens[4]);
        let (ansi_row, ansi_column) = position(&ansi_marker);
        assert_eq!(
            terminal
                .screen()
                .cell(ansi_row, ansi_column)
                .unwrap()
                .fgcolor(),
            vt100::Color::Idx(1)
        );
        let cr_marker = format!("{}-cr", stream_tokens[4]);
        let tab_marker = format!("{}-tab", stream_tokens[4]);
        let (cr_row, cr_column) = position(&cr_marker);
        let (tab_row, tab_column) = position(&tab_marker);
        assert_eq!(cr_column, 0, "CR did not return to column zero");
        assert_eq!(
            usize::from(tab_row - cr_row) * usize::from(columns) + usize::from(tab_column),
            (cr_marker.len() / 8 + 1) * 8,
            "Tab did not advance to the next native tab stop"
        );
        assert_eq!(observe(&first, false).native_active, Some(true));
        assert_eq!(
            run("Write-Output foreground-while-job-runs").exit_code,
            Some(0)
        );
        // Subsequent real PSReadLine submissions must not erase previously
        // rendered asynchronous output by reusing the old input origin.
        let retained_bytes = display.lock().unwrap().clone();
        let mut retained = vt100::Parser::new(30, columns, 2000);
        retained.process(&retained_bytes);
        let retained_cells = windows_terminal_cells(&mut retained);
        let retained_tokens = (0..stream_tokens.len())
            .map(|index| output_present(&retained_cells, index))
            .collect::<Vec<_>>();
        assert!(
            retained_tokens.iter().all(|found| *found),
            "native PSReadLine input erased prior background output: {retained_tokens:?}"
        );
        let continuous_gate = fixture.path().join("continuous-output-completion");
        let continuous_count = fixture.path().join("continuous-output-count");
        let continuous_source=format!("$i=0; try {{ while (-not [IO.File]::Exists('{}')) {{ $i++; [Console]::WriteLine($env:SS_CONSOLE_TOKEN+'-continuous-'+$i); Start-Sleep -Milliseconds 15 }} }} finally {{ [IO.File]::WriteAllText('{}',[string]$i) }}",quote(&continuous_gate),quote(&continuous_count));
        let continuous = launch(&continuous_source);
        let previous_directory = broker
            .snapshot(Some(transport))
            .unwrap()
            .session
            .unwrap()
            .current_directory
            .unwrap();
        let long_directory = fixture
            .path()
            .join(format!("native-long-prompt-{}", "p".repeat(80)));
        fs::create_dir(&long_directory).unwrap();
        assert_eq!(
            run(&format!(
                "Set-Location -LiteralPath '{}'",
                quote(&long_directory)
            ))
            .exit_code,
            Some(0)
        );
        let maximum_file = fixture.path().join("maximum-source.txt");
        let maximum_cwd = fixture.path().join("maximum-cwd.txt");
        let maximum_gate = fixture.path().join("maximum-completion");
        let head = "$Dense = @'\n";
        let tail = format!("\n'@\r\n$CR='left\rright'\r\n[IO.File]::WriteAllText('{}',$Dense+$CR)\r\n[IO.File]::WriteAllText('{}',(Get-Location).ProviderPath)\r\n[Console]::WriteLine($env:SS_CONSOLE_TOKEN+'-maximum-carrier')\r\nwhile (-not [IO.File]::Exists('{}')) {{ Start-Sleep -Milliseconds 15 }}\n#{}", quote(&maximum_file), quote(&maximum_cwd), quote(&maximum_gate), "字😀".repeat(12));
        let fragment = "'😀字\t";
        // Choose a real UTF-8 boundary with the production carrier encoder;
        // no candidate is submitted while constructing the input stimulus.
        let (maximum_source, maximum_text) = (0..32)
            .find_map(|padding| {
                let available = 8192 - head.len() - tail.len() - padding * 2;
                let text = format!(
                    "{}{}{}",
                    "x".repeat(padding),
                    fragment.repeat(available / fragment.len()),
                    "'".repeat(available % fragment.len())
                );
                let source = format!("{head}{text}{tail}{}", "x".repeat(padding));
                assert_eq!(source.len(), 8192);
                let line = crate::terminal_jobs::shell_submission(
                    &source,
                    "job-00000000000000000000000000000000",
                    shell,
                )
                .unwrap();
                let batches =
                    crate::agent_runtime::TerminalExecuteRegistry::native_editor_batches_for_test(
                        &line, shell,
                    );
                let first = batches.first().unwrap().1.len();
                let limit = 8192;
                (first < limit && line[first..].chars().next().unwrap().len_utf8() > limit - first)
                    .then_some((source, text))
            })
            .expect("maximum carrier must exercise a multi-byte UTF-8 batch boundary");
        let maximum = launch(&maximum_source);
        assert!(maximum.submitted_command_line.len() > 8192);
        assert_eq!(
            maximum.accepted_command_line.as_deref(),
            Some(maximum.submitted_command_line.as_str())
        );
        let batches = crate::agent_runtime::TerminalExecuteRegistry::native_editor_batches_for_test(
            &maximum.submitted_command_line,
            shell,
        );
        assert!(batches.len() >= 2);
        assert!(batches[0].1.len() < 8192);
        let maximum_marker = format!("{}-maximum-carrier", stream_tokens[4]);
        wait_until(Duration::from_secs(10), || {
            maximum_file.exists()
                && maximum_cwd.exists()
                && rendered_cells(&display.lock().unwrap()).contains(&maximum_marker)
        });
        assert_eq!(
            fs::read_to_string(&maximum_file).unwrap(),
            format!("{maximum_text}left\rright")
        );
        assert_eq!(
            Path::new(&fs::read_to_string(&maximum_cwd).unwrap())
                .canonicalize()
                .unwrap(),
            long_directory.canonicalize().unwrap()
        );
        assert!(!maximum_gate.exists());
        assert_eq!(observe(&maximum, false).native_active, Some(true));
        fs::write(&maximum_gate, "release").unwrap();
        let maximum_result = settle(&maximum);
        assert_eq!(maximum_result.exit_code, Some(0));
        assert_eq!(maximum_result.native_active, Some(false));
        assert!(!maximum_result.control_lost);
        if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
            fs::write(
                format!("{prefix}.{}.maximum-carrier.bin", shell.protocol_name()),
                &*display.lock().unwrap(),
            )
            .unwrap();
            fs::write(format!("{prefix}.{}.maximum-carrier.json", shell.protocol_name()), serde_json::to_vec_pretty(&serde_json::json!({
                "kind":"real-native-maximum-approved-source-and-multibatch-carrier", "sourceBytes":maximum_source.len(),
                "approvedSource":maximum_source,"acceptedCarrier":maximum.accepted_command_line,"submittedCarrier":maximum.submitted_command_line,
                "batchPrefixBytes":batches.iter().map(|batch|batch.1.len()).collect::<Vec<_>>(),
                "geometry":{"columns":columns,"rows":30},"cwd":long_directory,"nativeActiveBeforeGateRelease":true,
                "sourceExecuted":true,"fileBytesMatched":true,"exitCode":maximum_result.exit_code,
            })).unwrap()).unwrap();
        }
        let long_text = format!("{}\nreal\tTab", "native-editor-buffer-".repeat(180));
        let long_source=format!("$global:SS_NATIVE_LONG_BUFFER = @'\n{long_text}\n'@\nif ($global:SS_NATIVE_LONG_BUFFER.Length -ne {}) {{ throw 'native buffer changed' }}; Write-Output long-native-input-completed",long_text.len());
        let long_id = format!("windows-continuous-input-{}", Uuid::new_v4());
        let long_operation = registry
            .start_native_submission(
                sessions,
                transport,
                "native-agent",
                "native-task",
                &long_id,
                &long_source,
                shell.enter(),
                None,
                |_| Ok(()),
            )
            .unwrap();
        let long_result = registry
            .wait(
                sessions,
                transport,
                &long_operation,
                Duration::from_secs(20),
            )
            .unwrap();
        assert_eq!(
            long_result.state,
            TerminalCommandState::Completed,
            "{long_result:?}"
        );
        assert_eq!(long_result.exit_code, Some(0), "{long_result:?}");
        assert_eq!(long_result.command_line, long_source);
        wait_for_prompt(broker, transport);
        let during = display.lock().unwrap().clone();
        let continuous_marker = format!("{}-continuous", stream_tokens[4]);
        assert!(
            rendered_cells(&during).matches(&continuous_marker).count() >= 2,
            "real background output did not overlap long native input"
        );
        assert_eq!(observe(&continuous, false).native_active, Some(true));
        assert!(
            !continuous_gate.exists(),
            "continuous producer finished before native input validation"
        );
        fs::write(&continuous_gate, "release").unwrap();
        assert_eq!(settle(&continuous).exit_code, Some(0));
        let emitted: usize = fs::read_to_string(&continuous_count)
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            emitted >= 2,
            "real continuous producer did not emit multiple numbered lines"
        );
        let barrier = format!("native-display-barrier-{}", Uuid::new_v4());
        assert_eq!(
            run(&format!(
                "Write-Output ('native-display-'+'{}')",
                &barrier[15..]
            ))
            .exit_code,
            Some(0)
        );
        wait_until(Duration::from_secs(3), || {
            rendered_cells(&display.lock().unwrap()).contains(&barrier)
        });
        let continuous_bytes = display.lock().unwrap().clone();
        let mut continuous_screen = vt100::Parser::new(30, columns, 20_000);
        continuous_screen.process(&continuous_bytes);
        let contents = windows_terminal_cells(&mut continuous_screen);
        let mut preserved = std::collections::BTreeSet::new();
        let mut positions = Vec::new();
        let mut duplicate = Vec::new();
        for index in 1..=emitted {
            let marker = format!("{continuous_marker}-{index}");
            let matches = contents
                .match_indices(&marker)
                .filter(|(start, _)| {
                    !contents[start + marker.len()..].starts_with(|c: char| c.is_ascii_digit())
                })
                .map(|(start, _)| start)
                .collect::<Vec<_>>();
            if let Some(position) = matches.first() {
                preserved.insert(index);
                positions.push(*position);
            }
            if matches.len() > 1 {
                duplicate.push(index);
            }
        }
        let ordered = positions.windows(2).all(|pair| pair[0] < pair[1]);
        let missing: Vec<_> = (1..=emitted)
            .filter(|index| !preserved.contains(index))
            .collect();
        if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
            let raw = std::path::PathBuf::from(format!(
                "{prefix}.{}.continuous.bin",
                shell.protocol_name()
            ));
            let metadata = std::path::PathBuf::from(format!(
                "{prefix}.{}.continuous.json",
                shell.protocol_name()
            ));
            fs::write(&raw, &continuous_bytes).unwrap();
            fs::write(&metadata,serde_json::to_vec_pretty(&serde_json::json!({
                "kind":"real-native-continuous-output-rendering","geometry":{"columns":columns,"rows":30},
                "raw":raw,"marker":continuous_marker,"emitted":emitted,"preserved":preserved,"missing":missing,"duplicate":duplicate,"ordered":ordered,
                "source":long_result.command_line,"state":format!("{:?}",long_result.state),"exitCode":long_result.exit_code,
                "producerActiveBeforeRelease":true,"completionGate":continuous_gate,"completedCounter":continuous_count,
                "comparison":"adjacent actual ASCII cells across physical column boundaries, including scrollback"
            })).unwrap()).unwrap();
        }
        assert!(missing.is_empty(),"real native continuous output was overwritten during multiline input: emitted={emitted}, missing={missing:?}");
        assert!(
            duplicate.is_empty(),
            "native output appeared more than once: {duplicate:?}"
        );
        assert!(
            ordered,
            "native output sequence was reordered in actual cells"
        );
        assert_eq!(
            run(&format!(
                "Set-Location -LiteralPath '{}'",
                previous_directory.replace('\'', "''")
            ))
            .exit_code,
            Some(0)
        );
        fs::write(&completion_gate, "release").unwrap();
        assert_eq!(settle(&first).exit_code, Some(7));
        assert_eq!(fs::read_to_string(&effect).unwrap(), "once\n");
        assert!(fs::read_to_string(&inherited)
            .unwrap()
            .starts_with("alias-keptfunction-keptkept"));
        run("$global:SS_TYPED_STATE=@{ values=[int[]]@(3,7); flag=$true; option=[System.Management.Automation.ActionPreference]::Continue }; $global:SS_CASE_SENSITIVE=[hashtable]::new([StringComparer]::Ordinal); $global:SS_CASE_SENSITIVE.Add('key',1); $global:SS_CASE_SENSITIVE.Add('KEY',2); function global:ConvertFrom-ShellSpanJobValue { 'user-helper-kept' }; $global:LASTEXITCODE=23");
        let typed = launch("if ($global:SS_TYPED_STATE.values.GetType() -ne [int[]] -or $global:SS_TYPED_STATE.values[1] -ne 7 -or $global:SS_TYPED_STATE.option.GetType() -ne [System.Management.Automation.ActionPreference] -or -not $global:SS_TYPED_STATE.ContainsKey('VALUES') -or $global:SS_CASE_SENSITIVE.Count -ne 2 -or $global:SS_CASE_SENSITIVE['key'] -ne 1 -or $global:SS_CASE_SENSITIVE['KEY'] -ne 2 -or $global:SS_CASE_SENSITIVE.ContainsKey('Key') -or (ConvertFrom-ShellSpanJobValue) -cne 'user-helper-kept' -or $LASTEXITCODE -ne 23) { throw 'native state semantics lost' }; Write-Output typed-state-kept");
        assert_eq!(settle(&typed).exit_code, Some(0));
        run("Set-Item -LiteralPath Function:global:ss_job_fn -Value { 'function-kept' } -Options ReadOnly -Force; Set-Item -LiteralPath Function:global:ss_job_constant -Value { 'constant-kept' } -Options Constant; $global:PSDefaultParameterValues=@{'Get-ChildItem:Name'=$true;'Write-Output:NoEnumerate'=$true}");
        let option_facts = fixture.path().join("native-options.json");
        let options = launch(&format!("[IO.File]::WriteAllText('{}', (ConvertTo-Json -Compress -InputObject ([ordered]@{{readOnly=(Get-Item Function:ss_job_fn).Options.ToString();constant=(Get-Item Function:ss_job_constant).Options.ToString();function=(ss_job_constant);arrayCount=@(Write-Output ([int[]]@(1,2))).Count;decoder=(ConvertFrom-ShellSpanJobValue);defaultCount=$PSDefaultParameterValues.Count}}))); if (-not ((Get-Item Function:ss_job_fn).Options -band [System.Management.Automation.ScopedItemOptions]::ReadOnly) -or -not ((Get-Item Function:ss_job_constant).Options -band [System.Management.Automation.ScopedItemOptions]::Constant) -or (ss_job_constant) -cne 'constant-kept' -or @(Write-Output ([int[]]@(1,2))).Count -ne 1 -or (ConvertFrom-ShellSpanJobValue) -cne 'user-helper-kept') {{ throw 'native function options or default parameters lost' }}; Write-Output native-options-kept",quote(&option_facts)));
        assert_eq!(
            settle(&options).exit_code,
            Some(0),
            "native option facts={:?}",
            fs::read_to_string(&option_facts)
        );
        run("$global:PSDefaultParameterValues=@{}");
        for (source, code) in [
            ("Write-Error inherited-native-code -ErrorAction Continue", 1),
            ("throw 'inherited-native-code'", 1),
            ("cmd.exe /d /c exit 23", 23),
            (
                "Write-Error before-native -ErrorAction Continue; cmd.exe /d /c exit 23",
                23,
            ),
            (
                "cmd.exe /d /c exit 23; Write-Error after-native -ErrorAction Continue",
                1,
            ),
            ("cmd.exe /d /c exit 23 | Write-Output", 23),
        ] {
            assert_eq!(
                settle(&launch(source)).exit_code,
                Some(code),
                "native status lost or inherited LASTEXITCODE replaced source failure: {source}"
            );
        }
        run("$global:LASTEXITCODE=0");
        let rejected_state_effect = fixture.path().join("rejected-state.txt");
        assert_eq!(run("Add-Type 'public static class NativeSnapshotExtension { public static int InvocationCount; public static int Read(System.Management.Automation.PSObject value) { InvocationCount++; return 7; } public static object Invoke(System.Management.Automation.PSObject value) { InvocationCount++; return 7; } }'; if ([NativeSnapshotExtension]::InvocationCount -ne 0) { throw 'native member counter was not initialized to zero' }").exit_code, Some(0));
        for (state, reason) in [
            ("$global:SS_UNSUPPORTED_STATE=[Text.StringBuilder]::new('native-value')", "Unsupported native job variable type: System.Text.StringBuilder"),
            ("$global:SS_UNSUPPORTED_STATE=@{}; $global:SS_UNSUPPORTED_STATE.self=$global:SS_UNSUPPORTED_STATE", "Native job state cannot transfer cyclic or shared mutable references without identity loss"),
            ("$shared=@{value=1}; $global:SS_UNSUPPORTED_STATE=@($shared,$shared); Remove-Variable shared -Scope Global", "Native job state cannot transfer cyclic or shared mutable references without identity loss"),
            ("$global:SS_UNSUPPORTED_STATE=[pscustomobject]@{value=1}; Add-Member -InputObject $global:SS_UNSUPPORTED_STATE -MemberType ScriptMethod -Name hidden -Value { [NativeSnapshotExtension]::InvocationCount++; 7 }", "Native job state does not support custom executable members"),
            ("$global:SS_UNSUPPORTED_STATE=[pscustomobject]@{value=1}; Add-Member -InputObject $global:SS_UNSUPPORTED_STATE -MemberType ScriptProperty -Name hidden -Value { [NativeSnapshotExtension]::InvocationCount++; 7 }", "Native job state does not support custom executable members"),
            ("$global:SS_UNSUPPORTED_STATE=[pscustomobject]@{value=1}; Add-Member -InputObject $global:SS_UNSUPPORTED_STATE -MemberType CodeProperty -Name hidden -Value ([NativeSnapshotExtension].GetMethod('Read'))", "Native job state does not support custom executable members"),
            ("$global:SS_UNSUPPORTED_STATE=[pscustomobject]@{value=1}; Add-Member -InputObject $global:SS_UNSUPPORTED_STATE -MemberType CodeMethod -Name hidden -Value ([NativeSnapshotExtension].GetMethod('Invoke'))", "Native job state does not support custom executable members"),
            ("$global:SS_UNSUPPORTED_STATE=[pscustomobject]@{value=1}; Add-Member -InputObject $global:SS_UNSUPPORTED_STATE -MemberType AliasProperty -Name hidden -Value value", "Native job objects require ordinary note properties"),
            ("$global:SS_UNSUPPORTED_STATE=[int[]]@(1,2); Add-Member -InputObject $global:SS_UNSUPPORTED_STATE -MemberType NoteProperty -Name hidden -Value 'unsupported-collection-extension'", "Native job collections cannot carry custom note properties"),
            ("$culture=if([Globalization.CultureInfo]::CurrentCulture.Name -eq 'tr-TR'){'en-US'}else{'tr-TR'}; $global:SS_UNSUPPORTED_STATE=[hashtable]::new([StringComparer]::Create([Globalization.CultureInfo]::new($culture),$true)); Remove-Variable culture -Scope Global", "Native job state does not support custom hash comparers"),
        ] {
            assert_eq!(run(state).exit_code, Some(0));
            let reason_before = rejection_message_count(reason);
            let rejected=launch_checked(&format!("[IO.File]::WriteAllText('{}','forbidden')",quote(&rejected_state_effect)),false);
            assert_eq!(settle(&rejected).state,"rejected");
            assert!(!rejected_state_effect.exists());
            assert!(rejection_message_count(reason) > reason_before, "expected actual rejection reason: {reason}");
            assert_eq!(run("Remove-Variable SS_UNSUPPORTED_STATE -Scope Global").exit_code, Some(0));
            assert_eq!(run("if ([NativeSnapshotExtension]::InvocationCount -ne 0) { throw 'native capture evaluated an extended member' }").exit_code, Some(0));
        }
        let mut extended_engine_state = vec![
            ("Add-Member -InputObject $PSVersionTable -MemberType ScriptProperty -Name SS_SNAPSHOT_EXTENSION -Value { [NativeSnapshotExtension]::InvocationCount++; 7 }", "$PSVersionTable.PSObject.Properties.Remove('SS_SNAPSHOT_EXTENSION')", "Native version state has custom extended members"),
            ("Add-Member -InputObject ([Globalization.CultureInfo]::CurrentCulture.DateTimeFormat) -MemberType NoteProperty -Name SS_SNAPSHOT_EXTENSION -Value 'unsupported-culture-extension'", "[Globalization.CultureInfo]::CurrentCulture.DateTimeFormat.PSObject.Properties.Remove('SS_SNAPSHOT_EXTENSION')", "Native culture state has unsupported extensions"),
        ];
        if shell == TerminalShellKind::PowerShell7 {
            extended_engine_state.push(("Add-Member -InputObject $PSStyle -MemberType AliasProperty -Name SS_SNAPSHOT_EXTENSION -Value Reset", "$PSStyle.PSObject.Properties.Remove('SS_SNAPSHOT_EXTENSION')", "Native style state has custom extended members"));
        }
        for (setup, cleanup, reason) in extended_engine_state {
            assert_eq!(run(setup).exit_code, Some(0));
            let reason_before = rejection_message_count(reason);
            let rejected = launch_checked(
                &format!(
                    "[IO.File]::WriteAllText('{}','forbidden')",
                    quote(&rejected_state_effect)
                ),
                false,
            );
            assert_eq!(settle(&rejected).state, "rejected");
            assert!(!rejected_state_effect.exists());
            assert!(
                rejection_message_count(reason) > reason_before,
                "expected actual rejection reason: {reason}"
            );
            assert_eq!(run(cleanup).exit_code, Some(0));
            assert_eq!(run("if ([NativeSnapshotExtension]::InvocationCount -ne 0) { throw 'native capture evaluated extended engine state' }").exit_code, Some(0));
            assert_eq!(
                run("Write-Output foreground-after-state-rejection").exit_code,
                Some(0)
            );
        }
        for (source, code) in [
            (
                "if (-not [Console]::IsInputRedirected -or $null -ne [Console]::ReadLine()) { throw 'background console could read terminal stdin' }; Write-Output console-stdin-unavailable",
                0,
            ),
            (
                "if (${global:SS_JOB_LITERAL?} -cne 'literal-kept') { throw 'literal variable lost' }",
                0,
            ),
            ("Write-Output ordinary-success", 0),
            ("Write-Output before-return; return", 0),
            ("Write-Output success # trailing source comment", 0),
            ("param($value) Write-Output parameter-source", 0),
            ("@'\nhere-string boundary\n'@", 0),
            ("begin { Write-Output begin-source } end { Write-Output end-source }", 0),
            ("exit 0", 0),
            ("exit 7", 7),
            ("cmd.exe /d /c exit 7", 7),
            ("cmd.exe /d /c exit 7; Write-Output after-native-error", 0),
            ("throw 'native-job-throw'", 1),
            ("Write-Error expected -ErrorAction Continue", 1),
            (
                "Write-Error expected -ErrorAction Continue; Write-Output after-error",
                0,
            ),
        ] {
            let job = launch(source);
            assert_eq!(
                settle(&job).exit_code,
                Some(code),
                "PowerShell source status was replaced by formatting success: {source}"
            );
        }
        let unsupported_effect = fixture.path().join("unsupported.txt");
        let unsupported = launch_checked(
            &format!(
                "#requires -version 5.1\n[IO.File]::WriteAllText('{}','forbidden')",
                quote(&unsupported_effect)
            ),
            false,
        );
        assert_eq!(settle(&unsupported).state, "rejected");
        assert!(!unsupported_effect.exists());
        let undefined = format!("__shellspan_user_undefined_{}", Uuid::new_v4().simple());
        assert_eq!(
            run(&format!(
                "$null=${undefined}; Write-Output strict-off-baseline"
            ))
            .exit_code,
            Some(0)
        );
        let strict_survivor = launch("Start-Sleep -Seconds 60");
        run("Set-StrictMode -Version Latest");
        let strict_baseline = run(&format!("try {{ $null=${undefined}; throw 'StrictMode was not active' }} catch {{ if ($_.FullyQualifiedErrorId -notlike '*VariableIsUndefined*') {{ throw }}; Write-Output strict-on-baseline }}"));
        assert_eq!(strict_baseline.exit_code, Some(0));
        assert!(strict_baseline
            .combined_output
            .contains("strict-on-baseline"));
        run("$global:SS_STRICT_ERROR_COUNT=$Error.Count");
        let strict_job = launch_checked(
            &format!(
                "[IO.File]::WriteAllText('{}','forbidden')",
                quote(&unsupported_effect)
            ),
            false,
        );
        assert_eq!(settle(&strict_job).state, "rejected");
        assert!(!unsupported_effect.exists());
        let error_history = run("if ($Error.Count -ne $global:SS_STRICT_ERROR_COUNT) { throw ('StrictMode guard changed caller error history: before=' + $global:SS_STRICT_ERROR_COUNT + ' after=' + $Error.Count + ' newest=' + $Error[0].FullyQualifiedErrorId + ' command=' + $Error[0].CategoryInfo.TargetName) }");
        assert_eq!(error_history.exit_code, Some(0), "{error_history:?}");
        let strict_wait = crate::agent_runtime::NativeToolEngine::manage_registered_job_for_test(
            broker,
            leases,
            registry,
            sessions,
            &strict_survivor,
            false,
            1000,
        )
        .unwrap();
        assert_eq!(strict_wait.data.as_ref().unwrap()["waitTimedOut"], true);
        let strict_stop = crate::agent_runtime::NativeToolEngine::manage_registered_job_for_test(
            broker,
            leases,
            registry,
            sessions,
            &strict_survivor,
            true,
            10000,
        )
        .unwrap();
        assert_eq!(
            strict_stop.data.as_ref().unwrap()["job"]["nativeActive"],
            false
        );
        assert_eq!(
            strict_stop.data.as_ref().unwrap()["job"]["controlLost"],
            false
        );
        run("Set-StrictMode -Off");
        assert!(broker
            .shell_job(
                &first.process_handle,
                "windows-job-owner",
                "other-agent",
                "native-task"
            )
            .is_err());
        let survivor = launch("Start-Sleep -Seconds 60");
        let foreground_ready = fixture.path().join("foreground-interrupt-ready");
        let foreground_tail = fixture.path().join("foreground-interrupt-tail");
        let foreground = registry.start(sessions,transport,"native-agent","foreground-interrupt-task","foreground-interrupt",&format!("[IO.File]::WriteAllText('{}','ready'); Start-Sleep -Seconds 60; [IO.File]::WriteAllText('{}','forbidden')",quote(&foreground_ready),quote(&foreground_tail)),shell.enter()).unwrap();
        wait_until(Duration::from_secs(5), || foreground_ready.exists());
        registry
            .cancel_task(sessions, "foreground-interrupt-task")
            .unwrap();
        let cancelled = registry
            .wait(sessions, transport, &foreground, Duration::from_secs(10))
            .unwrap();
        assert_eq!(
            cancelled.state,
            TerminalCommandState::Cancelled,
            "{cancelled:?}"
        );
        wait_for_prompt(broker, transport);
        assert!(!foreground_tail.exists());
        assert_eq!(
            observe(&survivor, false).native_active,
            Some(true),
            "foreground Ctrl+C stopped an unrelated background job"
        );
        let bounded = crate::agent_runtime::NativeToolEngine::manage_registered_job_for_test(
            broker, leases, registry, sessions, &survivor, false, 1000,
        )
        .unwrap();
        assert_eq!(bounded.data.as_ref().unwrap()["waitTimedOut"], true);
        assert!(broker.native_input_enabled(transport).unwrap());
        let victim = launch(&format!(
            "Write-Output '{}'; Start-Sleep -Seconds 60",
            first.process_handle
        ));
        assert!(broker
            .prepare_shell_job_control(&settle(&first), "stale-windows-job", true)
            .is_err());
        let stopped = crate::agent_runtime::NativeToolEngine::manage_registered_job_for_test(
            broker, leases, registry, sessions, &victim, true, 10000,
        )
        .unwrap();
        assert_eq!(stopped.data.as_ref().unwrap()["job"]["nativeActive"], false);
        assert_eq!(stopped.data.as_ref().unwrap()["job"]["controlLost"], false);
        assert_eq!(settle(&victim).state, "exited");
        assert!(matches!(
            observe(&survivor, false).state.as_str(),
            "queued" | "running"
        ));
        registry
            .cleanup_shell_jobs(sessions, Some("native-task"))
            .unwrap();
        assert_eq!(
            broker
                .shell_job(
                    &survivor.process_handle,
                    "windows-job-owner",
                    "native-agent",
                    "native-task"
                )
                .unwrap()
                .state,
            "exited"
        );
        let forbidden = launch("Read-Host 'background input forbidden'");
        assert_eq!(
            settle(&forbidden).exit_code,
            Some(1),
            "native background host consumed input or invented success"
        );
        // Hold the real native command before its tail. A fixed-duration sleep
        // can finish while launch/control input is still being rendered.
        use windows_sys::Win32::Foundation::{
            CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        };
        struct NativeGate {
            directory: Option<TempDir>,
            handles: Vec<(u32, HANDLE)>,
        }
        impl Drop for NativeGate {
            fn drop(&mut self) {
                let directory = self.directory.take().unwrap();
                let _ = fs::write(directory.path().join("release"), "cleanup");
                let _ = fs::write(directory.path().join("release-child"), "cleanup");
                let _ = fs::write(directory.path().join("release-grandchild"), "cleanup");
                let mut all_exited = !self.handles.is_empty();
                for (_, handle) in self.handles.drain(..) {
                    unsafe {
                        all_exited &= WaitForSingleObject(handle, 5000) == WAIT_OBJECT_0;
                        CloseHandle(handle);
                    }
                }
                if !all_exited {
                    // Keep the release gate available if identity acquisition
                    // failed, so this fixture cannot leave an infinite waiter.
                    let retained = directory.keep();
                    eprintln!(
                        "Native fixture cleanup unconfirmed; release gate retained at {}",
                        retained.display()
                    );
                }
            }
        }
        let mut native = NativeGate {
            directory: Some(tempfile::tempdir().unwrap()),
            handles: Vec::new(),
        };
        let root = native.directory.as_ref().unwrap().path();
        let ready = root.join("ready");
        let gate = root.join("release");
        let tail = root.join("tail");
        let identities = root.join("processes.json");
        let child_script = root.join("child.ps1");
        let child_ready = root.join("child-ready");
        let grandchild_ready = root.join("grandchild-ready");
        let child_gate = root.join("release-child");
        let grandchild_gate = root.join("release-grandchild");
        let child_tail = root.join("child-tail");
        let native_sibling = launch("Start-Sleep -Seconds 60");
        let grandchild_command = format!("echo ready>\"{}\" & for /l %i in (1,0,2) do @if exist \"{}\" (exit /b 0) else @ping -n 2 127.0.0.1 >nul", grandchild_ready.display(), grandchild_gate.display());
        fs::write(&child_script,format!("[IO.File]::WriteAllText('{}','ready')\ncmd.exe /d /c '{}'\nwhile (-not [IO.File]::Exists('{}')) {{ Start-Sleep -Milliseconds 10 }}\n[IO.File]::WriteAllText('{}','forbidden')",quote(&child_ready),grandchild_command.replace('\'',"''"),quote(&child_gate),quote(&child_tail))).unwrap();
        let native_source = format!("echo ready>\"{}\" & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\" & for /l %i in (1,0,2) do @if exist \"{}\" (echo native-tail>\"{}\" & exit /b 0) else @ping -n 2 127.0.0.1 >nul", ready.display(), child_script.display(), gate.display(), tail.display());
        let external = launch(&format!(
            "cmd.exe /d /c '{}'",
            native_source.replace('\'', "''")
        ));
        wait_until(Duration::from_secs(15), || {
            ready.exists() && child_ready.exists() && grandchild_ready.exists()
        });
        assert!(!tail.exists(), "native tail ran before the release gate");
        let query = format!("$all=@(Get-CimInstance Win32_Process); $tree=[Collections.Generic.List[object]]::new(); $frontier=@($PID); while($frontier.Count -gt 0){{ $children=@($all | Where-Object {{$_.ParentProcessId -in $frontier}}); foreach($p in $children){{$tree.Add($p)}}; $frontier=@($children | ForEach-Object ProcessId) }}; $root=@($tree | Where-Object {{ $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.Contains('{}') }}); if ($root.Count -ne 1) {{ throw 'native fixture identity was not unique' }}; $records=[Collections.Generic.List[object]]::new(); $records.Add($root[0]); $frontier=@($root[0].ProcessId); while ($frontier.Count -gt 0) {{ $children=@($all | Where-Object {{ $_.ParentProcessId -in $frontier }}); foreach($p in $children) {{ $records.Add($p) }}; $frontier=@($children | ForEach-Object ProcessId) }}; $records=@($records | Select-Object ProcessId,ParentProcessId,Name,@{{Name='creation';Expression={{$_.CreationDate.ToFileTimeUtc().ToString()}}}}); [IO.File]::WriteAllText('{}',(ConvertTo-Json -InputObject $records -Compress))",quote(&child_script),quote(&identities));
        let identity_query = run(&query);
        assert_eq!(identity_query.exit_code, Some(0), "{identity_query:?}");
        let records: Vec<serde_json::Value> =
            serde_json::from_str(&fs::read_to_string(&identities).unwrap()).unwrap();
        assert!(!records.is_empty());
        assert!(
            records
                .iter()
                .filter(|r| matches!(r["Name"].as_str(), Some("cmd.exe" | "powershell.exe")))
                .count()
                >= 3,
            "native child/grandchild identities were not captured: {records:?}"
        );
        for (index, record) in records.iter().enumerate() {
            let pid = u32::try_from(record["ProcessId"].as_u64().unwrap()).unwrap();
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            let long_lived = matches!(record["Name"].as_str(), Some("cmd.exe" | "powershell.exe"));
            if handle.is_null() && index != 0 && !long_lived {
                continue;
            }
            assert!(!handle.is_null(), "native root exited before stop");
            native.handles.push((pid, handle));
            if long_lived {
                assert_eq!(
                    unsafe { WaitForSingleObject(handle, 0) },
                    WAIT_TIMEOUT,
                    "native gated process exited before stop: {record:?}"
                );
            }
            let mut creation: FILETIME = unsafe { std::mem::zeroed() };
            let mut exit = creation;
            let mut kernel = creation;
            let mut user = creation;
            assert_ne!(
                unsafe {
                    GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
                },
                0
            );
            let actual =
                (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
            let expected: u64 = record["creation"].as_str().unwrap().parse().unwrap();
            assert_eq!(
                actual / 10,
                expected / 10,
                "native process identity changed"
            );
        }
        assert_eq!(
            unsafe { WaitForSingleObject(native.handles[0].1, 0) },
            WAIT_TIMEOUT
        );
        assert!(
            !tail.exists(),
            "native tail existed before stop was requested"
        );
        let native_foreground_ready = root.join("native-foreground-ready");
        let native_foreground_tail = root.join("native-foreground-tail");
        let native_foreground=registry.start(sessions,transport,"native-agent","native-foreground-task","native-foreground",&format!("[IO.File]::WriteAllText('{}','ready'); Start-Sleep -Seconds 60; [IO.File]::WriteAllText('{}','forbidden')",quote(&native_foreground_ready),quote(&native_foreground_tail)),shell.enter()).unwrap();
        wait_until(Duration::from_secs(5), || native_foreground_ready.exists());
        registry
            .cancel_task(sessions, "native-foreground-task")
            .unwrap();
        assert_eq!(
            registry
                .wait(
                    sessions,
                    transport,
                    &native_foreground,
                    Duration::from_secs(10)
                )
                .unwrap()
                .state,
            TerminalCommandState::Cancelled
        );
        wait_for_prompt(broker, transport);
        assert!(!native_foreground_tail.exists());
        for (pid, handle) in &native.handles {
            if records.iter().any(|record| {
                record["ProcessId"].as_u64() == Some(u64::from(*pid))
                    && matches!(record["Name"].as_str(), Some("cmd.exe" | "powershell.exe"))
            }) {
                assert_eq!(
                    unsafe { WaitForSingleObject(*handle, 0) },
                    WAIT_TIMEOUT,
                    "foreground Ctrl+C stopped native background descendant {pid}"
                );
            }
        }
        observe(&external, true);
        let settled = settle(&external);
        let stop_deadline = Instant::now() + Duration::from_secs(5);
        let mut alive = Vec::new();
        for (pid, handle) in &native.handles {
            let remaining = u32::try_from(
                stop_deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis(),
            )
            .unwrap();
            if unsafe { WaitForSingleObject(*handle, remaining) } != WAIT_OBJECT_0 {
                alive.push(*pid);
            }
        }
        assert!(settled.state=="exited" && alive.is_empty(),"NATIVE_DESCENDANT_GATE_FAILED: state={}; nativeActive={:?}; alive={alive:?}; identities={records:?}; child_gate_closed={}; grandchild_gate_closed={}; child_tail={}; root_tail={}",settled.state,settled.native_active,!child_gate.exists(),!grandchild_gate.exists(),child_tail.exists(),tail.exists());
        assert_eq!(
            observe(&native_sibling, false).native_active,
            Some(true),
            "native group termination stopped another task"
        );
        observe(&native_sibling, true);
        assert_eq!(settle(&native_sibling).state, "exited");
        fs::write(&gate, "release").unwrap();
        thread::sleep(Duration::from_secs(4));
        assert!(
            !tail.exists(),
            "native external child survived native job cancellation"
        );
        if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
            let bytes = display.lock().unwrap().clone();
            fs::write(format!("{prefix}.raw.bin"), &bytes).unwrap();
            fs::write(format!("{prefix}.cells.txt"), rendered_cells(&bytes)).unwrap();
            fs::write(
                format!("{prefix}.json"),
                format!("{{\"columns\":{columns},\"rows\":30}}"),
            )
            .unwrap();
        }
    }

    #[cfg(target_os = "windows")]
    fn verify_powershell_native_input(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        transport_id: &str,
        shell: TerminalShellKind,
        display: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        native_jobs: bool,
        reader_diagnostic: bool,
    ) {
        use crate::agent_runtime::{
            TerminalExecuteRegistry, TerminalLeaseEventState, TerminalLeaseManager,
        };
        use crate::models::{
            ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
            SessionStatus, SessionTerminalKind, StatusEvent,
        };
        use crate::terminal_broker::TerminalCommandState;
        use std::sync::atomic::AtomicBool;
        use std::sync::{Arc, Mutex};

        assert!(
            broker.native_input_enabled(transport_id).unwrap(),
            "PSReadLine native bindings were not installed"
        );
        if std::env::var("SHELLSPAN_NATIVE_POWERSHELL_JOBS").as_deref() == Ok("0") {
            let snapshot = broker
                .snapshot(Some(transport_id))
                .unwrap()
                .session
                .unwrap();
            assert!(
                !snapshot
                    .integration_capabilities
                    .contains(&"nativeJobControl"),
                "Explicit rollback advertised native jobs"
            );
            let fixture = tempfile::tempdir().unwrap();
            let effect = fixture.path().join("rollback-must-not-execute");
            let source = format!(
                "[IO.File]::WriteAllText('{}','forbidden')",
                effect.to_string_lossy().replace('\'', "''")
            );
            let target = crate::agent_runtime::AgentToolTargetNative::Local {
                target_id: format!("terminal-{transport_id}"),
                session_id: transport_id.into(),
                cwd: None,
            };
            let rejected = broker
                .prepare_shell_job(
                    transport_id,
                    &target,
                    "rollback-agent",
                    "rollback-task",
                    "rollback-operation",
                    &source,
                )
                .unwrap_err();
            assert!(
                rejected.contains("UNSUPPORTED"),
                "Wrong explicit rollback refusal: {rejected}"
            );
            assert!(!effect.exists(), "Rollback request executed source");
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
                fs::write(format!("{prefix}.{}.rollback.json", shell.protocol_name()), serde_json::to_vec_pretty(&serde_json::json!({
                    "kind":"real-conpty-explicit-native-jobs-rollback","nativeScriptInput":true,"nativeJobControl":false,
                    "rejectedBeforeSource":true,"effectExists":effect.exists(),"error":rejected,"terminalSessionId":snapshot.terminal_session_id,
                    "generation":snapshot.terminal_generation
                })).unwrap()).unwrap();
            }
        }
        let leases = TerminalLeaseManager::new(broker.clone());
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == TerminalLeaseEventState::Acquired {
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
                }
            }))
            .unwrap();
        let registry = TerminalExecuteRegistry::new(leases.clone(), broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = crossbeam_channel::unbounded();
        sessions
            .insert(
                transport_id.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: transport_id.into(),
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
                        username: String::new(),
                    },
                },
            )
            .unwrap();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&writes);
        let transport_writer = Arc::clone(writer);
        let worker = thread::spawn(move || {
            while let Ok(SessionCommand::Write(input)) = receiver.recv() {
                let mut writer = transport_writer.lock().unwrap();
                writer.write_all(input.as_bytes()).unwrap();
                writer.flush().unwrap();
                observed.lock().unwrap().push(input);
            }
        });
        let baseline_fixture = tempfile::tempdir().unwrap();
        let baseline_ready = baseline_fixture.path().join("ready");
        let baseline_mode = baseline_fixture.path().join("input-mode");
        let baseline_tail = baseline_fixture.path().join("tail");
        let baseline=registry.start(&sessions,transport_id,"native-agent","foreground-baseline","foreground-baseline",&format!("[IO.File]::WriteAllText('{}',[Console]::TreatControlCAsInput.ToString()); [IO.File]::WriteAllText('{}','ready'); Start-Sleep -Seconds 60; [IO.File]::WriteAllText('{}','forbidden')",baseline_mode.to_string_lossy().replace('\'',"''"),baseline_ready.to_string_lossy().replace('\'',"''"),baseline_tail.to_string_lossy().replace('\'',"''")),shell.enter()).unwrap();
        wait_until(Duration::from_secs(5), || baseline_ready.exists());
        registry
            .cancel_task(&sessions, "foreground-baseline")
            .unwrap();
        let baseline_cancelled = registry
            .wait(&sessions, transport_id, &baseline, Duration::from_secs(10))
            .unwrap();
        assert_eq!(
            baseline_cancelled.state,
            TerminalCommandState::Cancelled,
            "baseline input mode={:?}; result={baseline_cancelled:?}",
            fs::read_to_string(&baseline_mode)
        );
        wait_for_prompt(broker, transport_id);
        assert!(!baseline_tail.exists());
        if native_jobs {
            verify_powershell_native_jobs(
                broker,
                &leases,
                &registry,
                &sessions,
                transport_id,
                shell,
                display,
                reader_diagnostic,
            );
        }
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("effect.txt");
        let quoted = path.to_string_lossy().replace('\'', "''");
        let script = format!("$env:SHELLSPAN_NATIVE_PS='kept'\n$NativeStageTwo = @'\nquoted '\"' with\tliteral Tab\n'@\n& {{ ss_phase3_alias alias-native; ss_phase3_function }}\n[Console]::Write($NativeStageTwo)\nSet-Content -LiteralPath '{quoted}' -Value ($env:SHELLSPAN_NATIVE_PS + ':' + $NativeStageTwo)\n[Console]::Write('native-end')");
        let operation = registry
            .start(
                &sessions,
                transport_id,
                "native-agent",
                "native-task",
                "native-script",
                &script,
                shell.enter(),
            )
            .unwrap();
        let result = registry
            .wait(&sessions, transport_id, &operation, Duration::from_secs(8))
            .unwrap();
        assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
        assert_eq!(result.command_line, script);
        assert_eq!(result.exit_code, Some(0), "{result:?}");
        assert!(result.combined_output.contains("native-end"), "{result:?}");
        assert_eq!(
            fs::read_to_string(&path).unwrap().trim(),
            "kept:quoted '\"' with\tliteral Tab"
        );
        wait_for_prompt(broker, transport_id);
        leases.release_turn("native-agent").unwrap();
        fs::remove_file(&path).unwrap();
        let prefix = format!("[IO.File]::WriteAllText('{quoted}',@'\n");
        let suffix = "\n'@)";
        let data_bytes = 8192 - prefix.len() - suffix.len();
        let text = format!(
            "{}{}",
            "字".repeat(data_bytes / 3),
            "x".repeat(data_bytes % 3)
        );
        let full_source = format!("{prefix}{text}{suffix}");
        assert_eq!(full_source.len(), 8192);
        let operation = registry
            .start(
                &sessions,
                transport_id,
                "native-agent",
                "native-task",
                "native-full-source-boundary",
                &full_source,
                shell.enter(),
            )
            .unwrap();
        let result = registry
            .wait(&sessions, transport_id, &operation, Duration::from_secs(8))
            .unwrap();
        assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
        assert_eq!(result.command_line, full_source);
        assert_eq!(result.exit_code, Some(0), "{result:?}");
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        wait_for_prompt(broker, transport_id);
        leases.release_turn("native-agent").unwrap();
        fs::remove_file(&path).unwrap();
        for (index, (source, expected)) in [
            (
                format!("[IO.File]::WriteAllText('{quoted}','single-line')"),
                "single-line",
            ),
            (
                format!("[IO.File]::WriteAllText('{quoted}','left\rright')\r\n[Console]::Write('native-cr-end')"),
                "left\rright",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let operation = registry
                .start(
                    &sessions,
                    transport_id,
                    "native-agent",
                    "native-task",
                    &format!("native-source-boundary-{index}"),
                    &source,
                    shell.enter(),
                )
                .unwrap();
            let result = registry
                .wait(&sessions, transport_id, &operation, Duration::from_secs(8))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Completed, "{result:?}");
            assert_eq!(result.command_line, source);
            assert_eq!(result.exit_code, Some(0), "{result:?}");
            assert_eq!(fs::read_to_string(&path).unwrap(), expected);
            wait_for_prompt(broker, transport_id);
            leases.release_turn("native-agent").unwrap();
            fs::remove_file(&path).unwrap();
        }
        for tail in ["$x = @'\nunfinished", "Start-Sleep 10 &"] {
            let script = format!("Set-Content -LiteralPath '{quoted}' -Value forbidden\n{tail}");
            let operation = registry
                .start(
                    &sessions,
                    transport_id,
                    "native-agent",
                    "native-task",
                    "native-rejection",
                    &script,
                    shell.enter(),
                )
                .unwrap();
            let result = registry
                .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(result.state, TerminalCommandState::Failed, "{result:?}");
            let error = result.input_rejection.unwrap();
            assert!(error.contains("UNSUPPORTED"), "{error}");
            wait_for_prompt(broker, transport_id);
            leases.release_turn("native-agent").unwrap();
            leases
                .write(
                    &sessions,
                    transport_id,
                    shell.enter().into(),
                    crate::agent_runtime::TerminalInputSource::User,
                )
                .unwrap();
            thread::sleep(Duration::from_millis(100));
            wait_for_prompt(broker, transport_id);
            assert!(!path.exists(), "rejected script executed its prefix");
        }
        for mode in ["native-cancel", "native-takeover"] {
            writes.lock().unwrap().clear();
            let script = format!("Set-Content -LiteralPath '{quoted}' -Value forbidden\n[Console]::Write('must-not-run')");
            let operation = thread::scope(|scope| {
                let start = scope.spawn(|| {
                    registry.start(
                        &sessions,
                        transport_id,
                        "native-agent",
                        "native-task",
                        mode,
                        &script,
                        shell.enter(),
                    )
                });
                wait_until(Duration::from_secs(5), || {
                    writes.lock().unwrap().iter().any(|input| {
                        input == &crate::agent_runtime::native_editor_final_chunk(&script, shell)
                    }) && registry
                        .editor_batch_pending_for_test(transport_id, mode)
                        .is_ok_and(|pending| !pending)
                });
                if mode == "native-cancel" {
                    registry.cancel_task(&sessions, "native-task").unwrap();
                } else {
                    registry
                        .takeover(&sessions, transport_id, "native-agent", mode)
                        .unwrap();
                }
                start.join().unwrap().unwrap()
            });
            let result = registry
                .wait(&sessions, transport_id, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(
                result.state,
                if mode == "native-cancel" {
                    TerminalCommandState::Cancelled
                } else {
                    TerminalCommandState::TakenOver
                }
            );
            wait_for_prompt(broker, transport_id);
            leases.release_turn("native-agent").unwrap();
            leases
                .write(
                    &sessions,
                    transport_id,
                    shell.enter().into(),
                    crate::agent_runtime::TerminalInputSource::User,
                )
                .unwrap();
            thread::sleep(Duration::from_millis(100));
            wait_for_prompt(broker, transport_id);
            assert!(!path.exists(), "cancelled script remained in the editor");
        }
        sessions.remove(transport_id).unwrap();
        worker.join().unwrap();
    }

    #[cfg(target_os = "windows")]
    fn run_windows_visible_command_acceptance(
        executable: &str,
        shell: TerminalShellKind,
        native_jobs: bool,
        reader_diagnostic: bool,
    ) {
        use crate::terminal_broker::{
            TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
        };
        use portable_pty::{native_pty_system, PtySize};
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        use std::time::Instant;
        let columns: u16 = if std::env::var("SHELLSPAN_NATIVE_SCRIPT_NARROW").as_deref() == Ok("1")
        {
            32
        } else {
            180
        };

        let broker = TerminalSessionBroker::phase3_enabled_for_test(4_096);
        let transport_id = format!("native-{}", shell.protocol_name());
        broker
            .attach_transport(
                &transport_id,
                None,
                TerminalTransportKind::WindowsConPty,
                TerminalGeometry::new(columns.into(), 30),
            )
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(
            crate::local_terminal_input::take_writer(pair.master.as_ref(), shell).unwrap(),
        ));
        let (_fixture, integration) = prepare_test_integration(shell);
        let _history_fixture = {
            let root = tempfile::tempdir().unwrap();
            let history_path = root.path().join("history.txt");
            fs::write(
                &history_path,
                if shell == TerminalShellKind::WindowsPowerShell {
                    "Write-Output 'saved-history-only'\n"
                } else {
                    ""
                },
            )
            .unwrap();
            let bootstrap = fs::read_to_string(&integration.bootstrap_path).unwrap();
            let history_setting = format!(
                "Import-Module PSReadLine\n    Set-PSReadLineOption -HistorySavePath '{}'\n    Set-PSReadLineOption -AddToHistoryHandler {{ param($Line) $Line -eq \"Write-Output 'history-allowed-only'\" }}",
                history_path.to_string_lossy().replace('\'', "''")
            );
            let seeded = bootstrap.replacen("Import-Module PSReadLine", &history_setting, 1);
            fs::write(&integration.bootstrap_path, seeded).unwrap();
            root
        };
        let native_input_diagnostic = _history_fixture
            .path()
            .join("native-input-installation.json");
        if std::env::var("SHELLSPAN_NATIVE_INPUT_DIAGNOSTIC").as_deref() == Ok("1") {
            let helper = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/fixtures/windows-native-input-diagnostic.ps1");
            assert!(std::process::Command::new(executable)
                .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
                .arg(helper)
                .arg("-Bootstrap")
                .arg(&integration.bootstrap_path)
                .arg("-Report")
                .arg(&native_input_diagnostic)
                .status()
                .unwrap()
                .success());
        }
        let bundled_powershell_modules = integration.bundled_powershell_modules.clone();
        let integration_id = integration.integration_id().to_string();
        broker
            .register_integration_channel(&transport_id, &integration_id, shell)
            .unwrap();
        let mut command = CommandBuilder::new(executable);
        command.env(
            "SHELLSPAN_NATIVE_POWERSHELL_JOBS",
            if native_jobs { "1" } else { "0" },
        );
        // portable-pty refreshes Windows base variables from the registry.
        // Preserve the fixture's explicit, process-scoped module installation.
        if let Some(module_path) = std::env::var_os("PSModulePath") {
            command.env("PSModulePath", module_path);
        }
        command.env("TERM", "xterm-256color");
        integration.configure_command(&mut command).unwrap();
        let startup_clock = Instant::now();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let control_broker = broker.clone();
        let control_transport = transport_id.clone();
        let control_integration = integration_id.clone();
        let closed_broker = broker.clone();
        let closed_transport = transport_id.clone();
        let lifecycle = Arc::new(Mutex::new(Vec::<String>::new()));
        let control_lifecycle = Arc::clone(&lifecycle);
        let lifecycle_timings = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let control_timings = Arc::clone(&lifecycle_timings);
        let _integration_control = integration.start_reader(
            move |event| {
                let label = match &event {
                    TerminalIntegrationControlEvent::Ready { .. } => "R".to_string(),
                    TerminalIntegrationControlEvent::NativePrivateReady => "W".to_string(),
                    TerminalIntegrationControlEvent::NativeCheckpoint { buffer } => {
                        let digest = <sha2::Sha256 as sha2::Digest>::digest(buffer.as_bytes());
                        format!("A:{}:{}", buffer.len(), hex::encode(digest))
                    }
                    TerminalIntegrationControlEvent::CommandStart { .. } => "S".to_string(),
                    TerminalIntegrationControlEvent::CommandEnd { exit_code, .. } => {
                        format!("E:{exit_code}")
                    }
                    TerminalIntegrationControlEvent::PromptStart { .. } => "P".to_string(),
                    TerminalIntegrationControlEvent::PromptEnd => "Q".to_string(),
                    TerminalIntegrationControlEvent::NativeInput { enabled } => {
                        format!("I:{enabled}")
                    }
                    TerminalIntegrationControlEvent::NativeCheckpointMode { enabled } => {
                        format!("H:{enabled}")
                    }
                    TerminalIntegrationControlEvent::NativeJobs { enabled } => {
                        format!("K:{enabled}")
                    }
                    _ => String::new(),
                };
                if !label.is_empty() {
                    control_timings.lock().unwrap().push(serde_json::json!({
                        "elapsedMs": startup_clock.elapsed().as_millis(), "frame": label,
                    }));
                    control_lifecycle.lock().unwrap().push(label);
                }
                control_broker.accept_integration_event(
                    &control_transport,
                    &control_integration,
                    event,
                )
            },
            move |error| {
                if error.is_some() {
                    let _ = closed_broker.integration_channel_closed(
                        &closed_transport,
                        &integration_id,
                        "controlChannelFailed",
                    );
                }
            },
        );
        let display = Arc::new(Mutex::new(Vec::<u8>::new()));
        let display_reader = Arc::clone(&display);
        let output_broker = broker.clone();
        let output_transport = transport_id.clone();
        let output_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        display_reader
                            .lock()
                            .unwrap()
                            .extend_from_slice(&buffer[..count]);
                        output_broker
                            .observe_raw_output(&output_transport, &buffer[..count])
                            .unwrap();
                    }
                }
            }
        });

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Both foreground and job shells compile the real native console
            // receiver via Add-Type before R/Q. Job shells additionally compile
            // PSHost. Cold startup has its own bounded budget; data reception,
            // command execution and later prompt deadlines remain unchanged.
            let startup_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                wait_for_prompt_with_timeout(&broker, &transport_id, Duration::from_secs(30));
            }));
            if let Err(error) = startup_result {
                if std::env::var("SHELLSPAN_STARTUP_DIAGNOSTIC").as_deref() == Ok("1") {
                    // Observe a late real startup without sending any input or
                    // changing the original verdict/deadline. Always rethrow
                    // the initial failure, even if Q subsequently arrives.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        wait_for_prompt_with_timeout(
                            &broker,
                            &transport_id,
                            Duration::from_secs(25),
                        );
                    }));
                }
                std::panic::resume_unwind(error);
            }
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE") {
                fs::write(
                    format!("{prefix}.{}.startup.json", shell.protocol_name()),
                    serde_json::to_vec_pretty(&serde_json::json!({
                        "kind":"actual-native-conpty-startup-before-any-input",
                        "startupBudgetMs":30_000,
                        "readyAfterMs":startup_clock.elapsed().as_millis(),
                        "lifecycleTimings":&*lifecycle_timings.lock().unwrap(),
                    }))
                    .unwrap(),
                )
                .unwrap();
            }
            let editor_metadata = _history_fixture.path().join("native-editor.json");
            let editor_metadata_literal = editor_metadata.to_string_lossy().replace('\'', "''");
            let editor_probe = format!("& {{ $m=Microsoft.PowerShell.Core\\Get-Module -Name PSReadLine; $o=PSReadLine\\Get-PSReadLineOption; [IO.File]::WriteAllText('{editor_metadata_literal}',(Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress -InputObject @{{version=$m.Version.ToString();path=$m.Path;prediction=[string]$o.PredictionSource}}),[Text.UTF8Encoding]::new($false)) }}");
            let observed_editor =
                execute_visible(&broker, &writer, &transport_id, shell, &editor_probe);
            assert_eq!(observed_editor.exit_code, Some(0));
            let editor: serde_json::Value =
                serde_json::from_slice(&fs::read(&editor_metadata).unwrap()).unwrap();
            if shell == TerminalShellKind::WindowsPowerShell {
                assert_eq!(editor["version"], "2.4.5");
                assert!(Path::new(editor["path"].as_str().unwrap())
                    .starts_with(bundled_powershell_modules.as_ref().unwrap()));
            }
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_DISPLAY_TRACE") {
                fs::write(
                    format!("{prefix}.editor.json"),
                    serde_json::to_vec_pretty(&editor).unwrap(),
                )
                .unwrap();
            }
            let cwd = tempfile::tempdir().unwrap();
            let path = cwd.path().to_string_lossy().replace('\'', "''");
            let changed = execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                &format!("Set-Location -LiteralPath '{path}'"),
            );
            let reported_cwd = std::path::Path::new(changed.cwd.as_deref().unwrap())
                .canonicalize()
                .unwrap();
            assert_eq!(reported_cwd, cwd.path().canonicalize().unwrap());
            execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "$env:SHELLSPAN_PHASE3_VALUE='终端值'",
            );
            let environment = execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "[Console]::Write($env:SHELLSPAN_PHASE3_VALUE)",
            );
            assert!(environment.combined_output.contains("终端值"));
            execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "Set-Alias -Name ss_phase3_alias -Value Write-Output",
            );
            let alias = execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "ss_phase3_alias alias-ok",
            );
            assert!(alias.combined_output.contains("alias-ok"));
            execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "function ss_phase3_function { [Console]::Write('function-ok') }",
            );
            let function =
                execute_visible(&broker, &writer, &transport_id, shell, "ss_phase3_function");
            assert!(function.combined_output.contains("function-ok"));
            execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "$ErrorActionPreference='Continue'",
            );
            let rich = execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "[Console]::Write(\"`e[31m终端`e[0m\")",
            );
            assert_eq!(rich.exit_code, Some(0));
            assert!(rich.combined_output.contains("终端"));
            let native_failure = execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "cmd.exe /d /c exit 7",
            );
            assert_eq!(native_failure.exit_code, Some(7));
            let cmdlet_failure = execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "$global:LASTEXITCODE=0; Write-Error expected",
            );
            assert_eq!(cmdlet_failure.exit_code, Some(1));
            let before_large = display.lock().unwrap().len();
            let large = execute_visible_with_timeout(
                &broker,
                &writer,
                &transport_id,
                shell,
                "1..12000 | ForEach-Object { [Console]::Write('x') }",
                Duration::from_secs(30),
            );
            assert!(large.capture_truncated);
            wait_until(Duration::from_secs(3), || {
                display.lock().unwrap().len() >= before_large + 12_000
            });

            let allowed_history = execute_visible(
                &broker,
                &writer,
                &transport_id,
                shell,
                "Write-Output 'history-allowed-only'",
            );
            assert_eq!(allowed_history.exit_code, Some(0));
            verify_powershell_native_input(
                &broker,
                &writer,
                &transport_id,
                shell,
                &display,
                native_jobs,
                reader_diagnostic,
            );
        }));
        if result.is_err() {
            if let Ok(prefix) = std::env::var("SHELLSPAN_JOB_FAILURE_TRACE")
                .or_else(|_| std::env::var("SHELLSPAN_JOB_ACCEPT_TRACE"))
            {
                fs::write(
                    format!("{prefix}.{}.native-failure.bin", shell.protocol_name()),
                    &*display.lock().unwrap(),
                )
                .unwrap();
                fs::write(format!("{prefix}.{}.native-failure.json", shell.protocol_name()), serde_json::to_vec_pretty(&serde_json::json!({
                    "kind":"actual-native-conpty-failure-before-cleanup", "shell":shell,
                    "geometry":{"columns":columns,"rows":30}, "lifecycle":&*lifecycle.lock().unwrap(),
                    "lifecycleTimings":&*lifecycle_timings.lock().unwrap(),
                    "startupBudgetMs":30_000,
                    "observedForMs":startup_clock.elapsed().as_millis(),
                    "nativeInputInstallationError":fs::read_to_string(&native_input_diagnostic).ok(),
                    "nativeStateCaptureRejection":fs::read_to_string(native_input_diagnostic.with_extension("json.state-capture.json")).ok(),
                    "nativeInputInstrumentation":fs::read_to_string(native_input_diagnostic.with_extension("json.instrumentation.json")).ok(),
                    "editorPromptOrigin":fs::read_to_string(native_input_diagnostic.with_extension("json.prompt-origin.json")).ok(),
                    "broker":broker.snapshot(Some(&transport_id)).unwrap(),
                })).unwrap()).unwrap();
            }
        }
        if result.is_ok() {
            writer.lock().unwrap().write_all(b"exit\r").unwrap();
            writer.lock().unwrap().flush().unwrap();
        } else {
            child.kill().unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        child.wait().unwrap();
        drop(writer);
        drop(pair.master);
        output_thread.join().unwrap();
        if result.is_ok() {
            let saved_history =
                fs::read_to_string(_history_fixture.path().join("history.txt")).unwrap();
            let expected = if shell == TerminalShellKind::WindowsPowerShell {
                "Write-Output 'saved-history-only'\nWrite-Output 'history-allowed-only'\n"
            } else {
                "Write-Output 'history-allowed-only'\n"
            };
            assert_eq!(
                saved_history.lines().collect::<Vec<_>>(),
                expected.lines().collect::<Vec<_>>(),
                "original history delegate's skip policy was not preserved"
            );
        }
        if let Err(error) = result {
            eprintln!(
                "Windows integration sequence: {:?}; final={:?}",
                lifecycle.lock().unwrap(),
                broker.snapshot(Some(&transport_id)).unwrap()
            );
            std::panic::resume_unwind(error);
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires native Windows PowerShell 5.1 and ConPTY"]
    fn windows_powershell_5_1_visible_command_integration() {
        run_windows_visible_command_acceptance(
            "powershell.exe",
            TerminalShellKind::WindowsPowerShell,
            false,
            false,
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires native PowerShell 7 and ConPTY"]
    fn windows_powershell_7_visible_command_integration() {
        run_windows_visible_command_acceptance(
            "pwsh.exe",
            TerminalShellKind::PowerShell7,
            false,
            false,
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires native Windows PowerShell 5.1, console workers, Job Objects and ConPTY"]
    fn windows_powershell_5_1_native_shell_jobs() {
        run_windows_visible_command_acceptance(
            "powershell.exe",
            TerminalShellKind::WindowsPowerShell,
            true,
            false,
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires native PowerShell 7, console workers, Job Objects and ConPTY"]
    fn windows_powershell_7_native_shell_jobs() {
        run_windows_visible_command_acceptance(
            "pwsh.exe",
            TerminalShellKind::PowerShell7,
            true,
            false,
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "diagnostic only: real PSReadLine 2.4.5 simplified renderer comparison, not product acceptance"]
    fn windows_powershell_7_simplified_renderer_diagnostic() {
        run_windows_visible_command_acceptance(
            "pwsh.exe",
            TerminalShellKind::PowerShell7,
            true,
            true,
        );
    }
