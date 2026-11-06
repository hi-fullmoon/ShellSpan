use super::*;

struct Host<'a> {
    control: &'a mut fs::File,
    writer: &'a Arc<Mutex<Box<dyn Write + Send>>>,
    messages: &'a Arc<Mutex<Vec<nip::Message>>>,
    raw: &'a Arc<Mutex<Vec<u8>>>,
    profile: &'a nip::PeerProfile,
    connection: &'a str,
    evidence: &'a std::path::Path,
    next: u64,
    transactions: Vec<serde_json::Value>,
}

impl Host<'_> {
    fn transact(&mut self, source: String, job: nip::JobExecution) -> Vec<serde_json::Value> {
        self.next += 1;
        let index = self.next;
        let start = self.messages.lock().unwrap().len();
        let is_control = matches!(job, nip::JobExecution::Control { .. });
        if !is_control {
            fs::write(
                self.evidence.join(format!("job-source-{index}.txt")),
                source.as_bytes(),
            )
            .unwrap();
        }
        let plan = nip::native_shell_job_plan(&source, self.profile.shell, &job).unwrap();
        let digest = nip::sha(&source);
        let plan_digest = nip::bound_plan_digest(&digest, &plan);
        let identity = nip::Identity {
            terminal_session_id: self.connection.into(),
            terminal_generation: 1,
            lease_id: format!("jobs-lease-{index}"),
            lease_generation: index,
            agent_session_id: "jobs-agent".into(),
            task_id: "jobs-task".into(),
            operation_id: format!("jobs-operation-{index}"),
            command_id: format!("jobs-command-{index}"),
            source_revision: 1,
        };
        let prepare = nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: format!("jobs-prepare-{index}"),
            identity: identity.clone(),
            payload: nip::Payload::PrepareInput {
                source: source.clone(),
                source_digest: digest.clone(),
                plan,
                plan_digest: plan_digest.clone(),
                budget_ms: 5000,
                reduced_motion: true,
                job: Some(job),
            },
        };
        self.control.write_all(&prepare.encode().unwrap()).unwrap();
        write(self.writer, b"\x18\x02");
        let proof = if is_control {
            "controlInputConfirmed"
        } else {
            "inputConfirmed"
        };
        wait(
            || {
                has(self.messages, &prepare.request_id, proof)
                    || has(self.messages, &prepare.request_id, "rejected")
            },
            self.raw,
        );
        assert!(
            has(self.messages, &prepare.request_id, proof),
            "Actual job input rejected at operation {index}"
        );
        if is_control {
            assert!(self.messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Operation(reply) if reply.request_id==prepare.request_id&&matches!(&reply.payload,nip::Payload::ControlInputConfirmed{plan_digest:actual,editor_empty:true} if actual==&plan_digest))));
        } else {
            assert!(self.messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Operation(reply) if reply.request_id==prepare.request_id&&matches!(&reply.payload,nip::Payload::InputConfirmed{source_digest,plan_digest:actual,utf8_bytes,cursor_utf8_bytes,end_utf8_bytes} if source_digest==&digest&&actual==&plan_digest&&*utf8_bytes==source.len()&&*cursor_utf8_bytes==source.len()&&*end_utf8_bytes==source.len()))));
        }
        let commit = nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: format!("jobs-commit-{index}"),
            identity: identity.clone(),
            payload: nip::Payload::Commit {
                source_digest: digest,
                plan_digest,
            },
        };
        self.control.write_all(&commit.encode().unwrap()).unwrap();
        write(self.writer, b"\x18\x02");
        wait(
            || has(self.messages, &commit.request_id, "commitArmed"),
            self.raw,
        );
        write(self.writer, b"\x18a");
        wait(
            || has(self.messages, &commit.request_id, "submissionAccepted"),
            self.raw,
        );
        wait(
            || {
                has(self.messages, &prepare.request_id, "started")
                    && has(self.messages, &prepare.request_id, "settled")
            },
            self.raw,
        );
        let own = self.messages.lock().unwrap()[start..]
            .iter()
            .filter_map(|value| match value {
                nip::Message::Operation(reply) if reply.identity == identity => {
                    Some(reply.payload.clone())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            own.iter()
                .filter(|payload| matches!(payload, nip::Payload::SubmissionAccepted))
                .count(),
            1
        );
        assert_eq!(
            own.iter()
                .filter(|payload| matches!(payload, nip::Payload::Started))
                .count(),
            1
        );
        assert!(
            own.iter()
                .any(|payload| matches!(payload, nip::Payload::Settled { exit_code: 0 })),
            "Management transaction exit must be separate from background exit"
        );
        let observations = self.messages.lock().unwrap()[start..]
            .iter()
            .filter_map(|value| match value {
                nip::Message::Connection(reply) => match &reply.payload {
                    nip::ConnectionPayload::JobObservation { .. } => {
                        Some(serde_json::to_value(&reply.payload).unwrap())
                    }
                    _ => None,
                },
                _ => None,
            })
            .collect::<Vec<_>>();
        self.transactions.push(serde_json::json!({"operation":index,"control":is_control,"sourceSha256":nip::sha(&source),"submissionAccepted":1,"started":1,"managementExitCode":0,"observations":observations}));
        observations
    }

    fn control(&mut self, handle: &str, stop: bool) -> Vec<serde_json::Value> {
        let source=format!("& $__shellspanModule {{ param($h,$a) & ${{function:Invoke-ShellSpanNativeJobControl}} $h $a }} '{handle}' '{}'",if stop{"stop"}else{"poll"});
        let nonce = format!("{:032x}", 0xabc0000000_u128 + self.next as u128);
        self.transact(
            source,
            nip::JobExecution::Control {
                handle: handle.into(),
                stop,
                nonce,
            },
        )
    }
}

fn observed(values: &[serde_json::Value], handle: &str, state: &str, status: Option<i32>) -> bool {
    values.iter().any(|value| {
        value["handle"] == handle
            && value["state"] == state
            && value["exitCode"] == serde_json::json!(status)
    })
}

pub(super) fn verify(
    control: &mut fs::File,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    messages: &Arc<Mutex<Vec<nip::Message>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    profile: &nip::PeerProfile,
    connection_id: &str,
    evidence: &PathBuf,
    terminal: &Arc<Mutex<vt100::Parser>>,
) {
    wait(
        || {
            messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Connection(reply) if matches!(reply.payload,nip::ConnectionPayload::EditorOptions{native_jobs:true,..})))
        },
        raw,
    );
    let quote =
        |path: &std::path::Path| format!("'{}'", path.to_string_lossy().replace('\'', "''"));
    let release = evidence.join("finite-release");
    assert!(!release.exists(), "Do not reuse a submitted job batch");
    let parent_value="父Shell-é-👩🏽‍💻";
    let parent_units=parent_value.encode_utf16().map(|unit|unit.to_string()).collect::<Vec<_>>().join(",");
    let parent_record=evidence.join("actual-parent-value.txt");
    // Seed a known Unicode value through an ASCII-only ordinary setup command;
    // raw keyboard Unicode handling is a separate acceptance boundary. Read
    // the actual parent value before testing native background inheritance.
    let parent=format!("$global:AcceptanceNativeJobValue=([char[]]@({parent_units}) -join ''); function global:Get-AcceptanceNativeJobValue {{ $global:AcceptanceNativeJobValue }}; Set-Location -LiteralPath {}; [IO.File]::WriteAllText({},$global:AcceptanceNativeJobValue,[Text.UTF8Encoding]::new($false)); cmd.exe /d /c exit 9; $global:AcceptanceNativeJobErrors=$Error.Count; [Console]::WriteLine('JOBS_PARENT_'+'READY')\r",quote(evidence),quote(&parent_record));
    write(writer, parent.as_bytes());
    wait(
        || terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("JOBS_PARENT_READY"),
        raw,
    );
    assert_eq!(fs::read_to_string(&parent_record).unwrap(),parent_value,"Actual parent setup must preserve the expected Unicode before job launch");
    let mut host = Host {
        control,
        writer,
        messages,
        raw,
        profile,
        connection: connection_id,
        evidence,
        next: 0,
        transactions: Vec::new(),
    };
    let first = format!("job-{:032x}", (std::process::id() as u128) * 16 + 1);
    let second = format!("job-{:032x}", (std::process::id() as u128) * 16 + 2);
    let unknown = format!("job-{:032x}", (std::process::id() as u128) * 16 + 3);
    let source=format!("[IO.File]::WriteAllText({},[string]$PID); if ((Get-AcceptanceNativeJobValue) -cne '父Shell-é-👩🏽‍💻') {{ throw 'Inherited variable/function changed' }}; if ((Get-Location).ProviderPath -cne {}) {{ throw 'Inherited cwd changed' }}; [Console]::WriteLine('JOB_FINITE_'+'FIRST'); $gate=[Diagnostics.Stopwatch]::StartNew(); while (-not [IO.File]::Exists({})) {{ if($gate.ElapsedMilliseconds -gt 15000) {{ throw 'Fixture gate expired' }}; Start-Sleep -Milliseconds 20 }}; [Console]::WriteLine('JOB_FINITE_'+'TAIL'); [Console]::WriteLine(\"COPY_HARD_A`nCOPY_HARD_B\"); [Console]::WriteLine(\"COPY_TAB`tEND  \"); cmd.exe /d /c exit 7",quote(&evidence.join("finite-pid.txt")),quote(evidence),quote(&release));
    let launched = host.transact(
        source,
        nip::JobExecution::Launch {
            handle: first.clone(),
        },
    );
    assert!(
        observed(&launched, &first, "running", None),
        "Actual native background launch did not report running"
    );
    wait(
        || terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("JOB_FINITE_FIRST"),
        raw,
    );
    assert!(observed(
        &host.control(&first, false),
        &first,
        "running",
        None
    ));
    assert!(observed(
        &host.control(&unknown, false),
        &unknown,
        "uncertain",
        None
    ));
    assert!(
        observed(&host.control(&first, false), &first, "running", None),
        "Unknown handle affected an unrelated running job"
    );
    fs::write(&release, b"release").unwrap();
    wait(
        || terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("JOB_FINITE_TAIL"),
        raw,
    );
    let mut finished = false;
    let finish_deadline=Instant::now()+Duration::from_secs(10);
    while Instant::now()<finish_deadline {
        let result = host.control(&first, false);
        if observed(&result, &first, "finished", Some(7))
            && observed(&result, &first, "settled", None)
        {
            finished = true;
            break;
        }
        assert!(
            observed(&result, &first, "running", None),
            "Unexpected actual completion status"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        finished,
        "Actual background exit7 was not observed separately from management exit0"
    );
    assert!(
        observed(&host.control(&first, false), &first, "uncertain", None),
        "A retired handle was reused"
    );
    let stop_source=format!("[IO.File]::WriteAllText({},[string]$PID); [Console]::WriteLine('JOB_STOP_'+'FIRST'); $gate=[Diagnostics.Stopwatch]::StartNew(); while($gate.ElapsedMilliseconds -lt 20000) {{ Start-Sleep -Milliseconds 20 }}; [Console]::WriteLine('JOB_STOP_'+'LATE')",quote(&evidence.join("stop-pid.txt")));
    assert!(observed(
        &host.transact(
            stop_source,
            nip::JobExecution::Launch {
                handle: second.clone()
            }
        ),
        &second,
        "running",
        None
    ));
    wait(
        || terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("JOB_STOP_FIRST"),
        raw,
    );
    assert!(observed(
        &host.control(&second, true),
        &second,
        "stopRequested",
        None
    ));
    let mut terminated = false;
    for _ in 0..5 {
        let result = host.control(&second, false);
        if observed(&result, &second, "terminated", None) {
            terminated = true;
            break;
        }
        assert!(
            observed(&result, &second, "running", None),
            "Unexpected actual stop status"
        );
    }
    assert!(
        terminated,
        "Actual process group termination was not observed"
    );
    write(writer, b"if($LASTEXITCODE -ne 9 -or $Error.Count -ne $global:AcceptanceNativeJobErrors) { throw 'Parent status or errors changed' }; [Console]::WriteLine('JOBS_PARENT_'+'RESTORED')\r");
    wait(
        || String::from_utf8_lossy(&raw.lock().unwrap()).contains("JOBS_PARENT_RESTORED"),
        raw,
    );
    let text = String::from_utf8_lossy(&raw.lock().unwrap()).to_string();
    assert!(!text.contains("JOB_STOP_LATE"));
    wait(
        || {
            terminal
                .lock()
                .unwrap()
                .screen()
                .contents()
                .replace(['\r', '\n'], "")
                .contains("JOBS_PARENT_RESTORED")
        },
        raw,
    );
    let screen_text = {
        let mut parser = terminal.lock().unwrap();
        captured_cells(&mut parser)
    };
    fs::write(evidence.join("observed-vt-screen.txt"), &screen_text).unwrap();
    let visible = screen_text.replace(['\r', '\n'], "");
    for marker in ["JOB_FINITE_FIRST", "JOB_FINITE_TAIL", "JOB_STOP_FIRST"] {
        assert_eq!(visible.matches(marker).count(),1,"Actual terminal output missing or repeated: {marker}");
    }
    assert!(!visible.contains("JOB_STOP_LATE"));
    for marker in [
        "JOB_FINITE_FIRST",
        "JOB_FINITE_TAIL",
        "JOB_STOP_FIRST",
        "JOBS_PARENT_RESTORED",
    ] {
        assert!(
            visible.contains(marker),
            "Actual terminal cells lost background output: {marker}"
        );
    }
    let history = fs::read_to_string(evidence.join("history.txt"))
        .expect("Actual history file must be readable");
    assert!(
        history.contains("AcceptanceNativeJobValue") && history.contains("JOB_FINITE_"),
        "The actual history path did not record ordinary/native source"
    );
    for management in [
        "Invoke-ShellSpanNativeJobControl",
        &first,
        &second,
        &unknown,
    ] {
        assert!(
            !text.contains(management) && !history.contains(management),
            "Private management leaked into visible/history source"
        );
    }
    fs::write(evidence.join("jobs-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"selectedScenarios":5,"finite":{"handle":first,"inheritedCwdAndFunctionAndUnicodeVariable":true,"firstAndTailObservedOnce":true,"jobExitCode":7,"managementExitCode":0},"unknownHandleDidNotAffectRunningJob":true,"retiredHandleUncertain":true,"stopped":{"handle":second,"stopRequested":true,"terminated":true,"lateOutputObserved":false,"numericJobExitInvented":false},"managementSourceNotDisplayedOrSaved":true,"ordinaryEditingRestored":true,"transactions":host.transactions,"scope":"Actual PSReadLine/provider/native job process component; not backend opaque handle authorization, model, lease/FULL intent or complete App B06"})).unwrap()).unwrap();
}

fn captured_cells(parser: &mut vt100::Parser) -> String {
    parser.screen_mut().set_scrollback(10000);
    let maximum = parser.screen().scrollback();
    let mut text = String::new();
    // Visit every actual cell once, including overlapping partial pages.
    for line in 0..maximum + 30 {
        parser.screen_mut().set_scrollback(maximum.saturating_sub(line));
        let row = line.saturating_sub(maximum) as u16;
        for column in 0..100 {
            if let Some(cell) = parser.screen().cell(row, column) {
                let contents = cell.contents();
                if contents.is_empty() { text.push(' '); } else { text.push_str(&contents); }
            }
        }
        text.push('\n');
    }
    parser.screen_mut().set_scrollback(0);
    text
}

pub(super) fn verify_startup_timeout(
    control: &mut fs::File,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    messages: &Arc<Mutex<Vec<nip::Message>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    profile: &nip::PeerProfile,
    connection: &str,
    evidence: &PathBuf,
    terminal: &Arc<Mutex<vt100::Parser>>,
) {
    let quote=|path:&std::path::Path|format!("'{}'",path.to_string_lossy().replace('\'',"''"));
    let worker_pid=evidence.join("startup-worker-pid.txt");
    let effect=evidence.join("must-not-execute.txt");
    let packet_limit=evidence.join("packet-limit.json");
    let limit_command=format!("try {{ $null=[ShellSpanProcessJob]::new('powershell.exe',[Environment]::CurrentDirectory,('x'*16777217)); throw 'Oversized packet accepted' }} catch {{ $__shellspanLimit=$_.Exception; for($__shellspanDepth=0;$__shellspanDepth-lt 8 -and -not $__shellspanLimit.Data.Contains('NativeWorkerSourceMayHaveStarted') -and $null-ne $__shellspanLimit.InnerException;$__shellspanDepth++){{$__shellspanLimit=$__shellspanLimit.InnerException}}; $__shellspanLimitRecord=@{{hasStartFact=$__shellspanLimit.Data.Contains('NativeWorkerSourceMayHaveStarted');mayHaveStarted=$__shellspanLimit.Data['NativeWorkerSourceMayHaveStarted'];cleanupConfirmed=$__shellspanLimit.Data['NativeWorkerCleanupConfirmed']}}; [IO.File]::WriteAllText({},($__shellspanLimitRecord|ConvertTo-Json -Compress)) }}; [Console]::WriteLine('PACKET_LIMIT_'+'CHECKED')\r",quote(&packet_limit));
    write(writer,limit_command.as_bytes());
    wait(||terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("PACKET_LIMIT_CHECKED"),raw);
    let limit:serde_json::Value=serde_json::from_slice(&fs::read(packet_limit).unwrap()).unwrap();
    assert_eq!(limit["hasStartFact"],true,"Pre-process packet rejection must preserve known no-start facts");
    assert_eq!(limit["mayHaveStarted"],false);assert_eq!(limit["cleanupConfirmed"],true);
    let prelude=format!("[IO.File]::WriteAllText({},[string]$PID); Start-Sleep -Seconds 6;",quote(&worker_pid));
    let command=format!("& $global:__shellspanModule {{param($prefix) $script:NativeJobWorker=$script:NativeJobWorker.Replace('param($Packet,$Pipe)',('param($Packet,$Pipe)'+[Environment]::NewLine+$prefix))}} '{}'; [Console]::WriteLine('STARTUP_FAULT_'+'READY')\r",prelude.replace('\'',"''"));
    write(writer,command.as_bytes());
    wait(||terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("STARTUP_FAULT_READY"),raw);
    let mut host=Host{control,writer,messages,raw,profile,connection,evidence,next:0,transactions:Vec::new()};
    let handle=format!("job-{:032x}",(std::process::id() as u128)*16+1);
    let source=format!("[IO.File]::WriteAllText({},'executed')",quote(&effect));
    let observations=host.transact(source,nip::JobExecution::Launch{handle:handle.clone()});
    assert!(observed(&observations,&handle,"rejected",None),"A cleaned worker that never received start permission must be rejected, not uncertain: {observations:?}");
    assert!(worker_pid.exists(),"Actual worker never entered the injected pre-start delay");
    assert!(!effect.exists(),"Worker ran source before its startup commit");
    write(writer,b"\r[Console]::WriteLine('STARTUP_FAULT_'+'RECOVERED')\r");
    wait(||terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("STARTUP_FAULT_RECOVERED"),raw);
    assert!(!effect.exists(),"Late Enter executed the rejected background source");
    fs::write(evidence.join("startup-timeout-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"workerPid":fs::read_to_string(worker_pid).unwrap().trim(),"observations":observations,"sourceEffectObserved":false,"ordinaryEditingRestored":true,"scope":"Actual NIP management and worker startup fault; not a synthetic control receipt or complete App acceptance"})).unwrap()).unwrap();
}

pub(super) fn verify_result_eof(
    control: &mut fs::File,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    messages: &Arc<Mutex<Vec<nip::Message>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    profile: &nip::PeerProfile,
    connection: &str,
    evidence: &PathBuf,
    terminal: &Arc<Mutex<vt100::Parser>>,
) {
    let command="& $global:__shellspanModule { $old='$Writer.Write([int]$Bytes.Length);$Writer.Write($Bytes);$Writer.Flush()'; if(-not $script:NativeJobWorker.Contains($old)){throw 'Result fault target missing'}; $script:NativeJobWorker=$script:NativeJobWorker.Replace($old,'# controlled loss of the actual worker result') }; [Console]::WriteLine('RESULT_FAULT_'+'READY')\r";
    write(writer,command.as_bytes());
    wait(||terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("RESULT_FAULT_READY"),raw);
    let quote=|path:&std::path::Path|format!("'{}'",path.to_string_lossy().replace('\'',"''"));
    let effect=evidence.join("executed-once.txt");
    let pid=evidence.join("result-worker-pid.txt");
    let source=format!("[IO.File]::WriteAllText({},[string]$PID); [IO.File]::AppendAllText({},'once')",quote(&pid),quote(&effect));
    let handle=format!("job-{:032x}",(std::process::id() as u128)*16+1);
    let mut host=Host{control,writer,messages,raw,profile,connection,evidence,next:0,transactions:Vec::new()};
    let launch=host.transact(source,nip::JobExecution::Launch{handle:handle.clone()});
    assert!(observed(&launch,&handle,"running",None));
    wait(||effect.exists(),raw);
    let mut unknown=false;
    for _ in 0..5 {
        let observations=host.control(&handle,false);
        assert!(!observations.iter().any(|value|value["state"]=="settled"||value["state"]=="finished"||value["exitCode"].is_number()),"Missing result invented a job settlement");
        if observed(&observations,&handle,"uncertain",None){unknown=true;break;}
    }
    assert!(unknown,"Lost actual worker result did not remain uncertain");
    write(writer,b"\r[Console]::WriteLine('RESULT_FAULT_'+'RECOVERED')\r");
    wait(||terminal.lock().unwrap().screen().contents().replace(['\r','\n'],"").contains("RESULT_FAULT_RECOVERED"),raw);
    assert_eq!(fs::read_to_string(&effect).unwrap(),"once","Unknown job was replayed");
    fs::write(evidence.join("result-eof-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"workerPid":fs::read_to_string(pid).unwrap().trim(),"sourceEffects":1,"state":"uncertain","jobExitCode":null,"replayed":false,"scope":"Actual worker executed once, result pipe EOF retained uncertainty; management settlements do not settle the background job"})).unwrap()).unwrap();
}

#[cfg(test)]
mod cell_capture_tests {
    use super::captured_cells;

    #[test]
    fn split_conpty_output_is_counted_from_cells_once() {
        // Actual batch115 sequence and cursor position before JOB_.
        let raw = b"\x1b[30;97HJOB_\r\n\x1b[29;100H_STOP_FIRST\r\n";
        assert!(!String::from_utf8_lossy(raw).contains("JOB_STOP_FIRST"));
        let mut parser = vt100::Parser::new(30, 100, 10000);
        parser.process(raw);
        let text = captured_cells(&mut parser).replace(['\r', '\n'], "");
        assert_eq!(text.matches("JOB_STOP_FIRST").count(), 1);
        assert_eq!(parser.screen().scrollback(), 0);
    }

    #[test]
    fn partial_oldest_page_does_not_duplicate_output() {
        let mut parser = vt100::Parser::new(30, 100, 10000);
        parser.process(b"ONLY_ONCE\r\n");
        for _ in 0..80 { parser.process(b"another row\r\n"); }
        let text = captured_cells(&mut parser);
        assert_eq!(text.matches("ONLY_ONCE").count(), 1);
    }
}
