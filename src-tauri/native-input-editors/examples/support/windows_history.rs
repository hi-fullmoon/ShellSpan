use super::*;

pub(super) fn is_mode(mode: &str) -> bool {
    matches!(
        mode,
        "history-default"
            | "history-small"
            | "history-custom"
            | "history-empty"
            | "history-null"
            | "history-save-nothing"
            | "history-save-at-exit"
    )
}

pub(super) fn bootstrap(mode: &str, evidence: &std::path::Path) -> String {
    let quote =
        |path: &std::path::Path| format!("'{}'", path.to_string_lossy().replace('\'', "''"));
    let setup=match mode {
        "history-small"=>"Set-PSReadLineOption -MaximumHistoryCount 3 -ErrorAction Stop".to_string(),
        "history-custom"=>format!("Set-PSReadLineOption -MaximumHistoryCount 9 -HistorySavePath {} -ErrorAction Stop",quote(&evidence.join("history custom/命令 history.txt"))),
        "history-save-nothing"=>"Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction Stop".into(),
        "history-save-at-exit"=>"Set-PSReadLineOption -HistorySaveStyle SaveAtExit -ErrorAction Stop".into(),
        "history-empty"=>"try {Set-PSReadLineOption -HistorySavePath '' -ErrorAction Stop; throw 'Empty path unexpectedly accepted'} catch {if($_.Exception.GetBaseException().GetType().FullName-cne 'System.Management.Automation.ValidationMetadataException'){throw}; $script:__shellspanHistoryRejected=$true}".into(),
        "history-null"=>"try {Set-PSReadLineOption -HistorySavePath $null -ErrorAction Stop; throw 'Null path unexpectedly accepted'} catch {if($_.Exception.GetBaseException().GetType().FullName-cne 'System.Management.Automation.ValidationMetadataException'){throw}; $script:__shellspanHistoryRejected=$true}".into(),
        _=>String::new(),
    };
    format!(
        r#"$script:__shellspanHistoryRejected=$false
{setup}
$__shellspanHistoryOptions=Get-PSReadLineOption
$__shellspanHistoryPath=[IO.Path]::GetFullPath($__shellspanHistoryOptions.HistorySavePath)
$__shellspanHistoryRoot=[IO.Path]::GetFullPath({})+[IO.Path]::DirectorySeparatorChar
if(-not $__shellspanHistoryPath.StartsWith($__shellspanHistoryRoot,[StringComparison]::OrdinalIgnoreCase)){{throw 'History path escaped isolated evidence; reader not started'}}
if(Test-Path -LiteralPath $__shellspanHistoryPath){{throw 'Do not replay a history namespace'}}
if([string]$__shellspanHistoryOptions.HistorySaveStyle-cne 'SaveNothing'){{
  $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($__shellspanHistoryPath))
  [IO.File]::WriteAllText($__shellspanHistoryPath,"Write-Output 'HISTORY_SEED_A'`nWrite-Output 'HISTORY_SEED_B'`n",[Text.UTF8Encoding]::new($false))
}}
$__shellspanHistoryRecord=@{{mode='{mode}';path=$__shellspanHistoryPath;maximum=$__shellspanHistoryOptions.MaximumHistoryCount;style=[string]$__shellspanHistoryOptions.HistorySaveStyle;pathSettingRejected=$script:__shellspanHistoryRejected;pathIsolated=$true;seedsOnDisk=([string]$__shellspanHistoryOptions.HistorySaveStyle-cne 'SaveNothing')}}
[IO.File]::WriteAllText({},($__shellspanHistoryRecord|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
"#,
        quote(evidence),
        quote(&evidence.join("history-startup.json"))
    )
}

fn snapshot(
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    evidence: &std::path::Path,
    index: usize,
) -> serde_json::Value {
    let data = fault_input::read_actual_editor(writer, raw, evidence, index);
    assert_eq!(data["activeEditor"], true);
    assert_eq!(data["thread"], data["expectedThread"]);
    assert_eq!(data["text"], "");
    assert_eq!(data["cursorUtf16"], 0);
    data
}

pub(super) fn verify(
    control: &mut fs::File,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    messages: &Arc<Mutex<Vec<nip::Message>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    profile: &nip::PeerProfile,
    connection: &str,
    evidence: &PathBuf,
    mode: &str,
) {
    let before = snapshot(writer, raw, evidence, 1);
    if mode != "history-save-nothing" {
        let initial = before["history"].as_array().unwrap();
        for seed in [
            "Write-Output 'HISTORY_SEED_A'",
            "Write-Output 'HISTORY_SEED_B'",
        ] {
            assert!(
                initial.iter().any(|line| line == seed),
                "The isolated native reader did not load its existing history"
            );
        }
    }
    let mut sources = Vec::new();
    for index in 1..=6 {
        let cancelled = index == 6;
        let source = if cancelled {
            "[Console]::WriteLine('HISTORY_CANCEL_'+'SHOULD_NOT_RUN')".to_string()
        } else {
            format!("$global:HistoryAcceptanceValue={index}; [Console]::WriteLine('HISTORY_EXECUTED_'+'{index}')")
        };
        let plan = nip::native_foreground_plan(&source, profile.shell).unwrap();
        let digest = nip::sha(&source);
        let plan_digest = nip::bound_plan_digest(&digest, &plan);
        let identity = nip::Identity {
            terminal_session_id: connection.into(),
            terminal_generation: 1,
            lease_id: format!("history-lease-{index}"),
            lease_generation: index,
            agent_session_id: "history-agent".into(),
            task_id: "history-task".into(),
            operation_id: format!("history-operation-{index}"),
            command_id: format!("history-command-{index}"),
            source_revision: 1,
        };
        let prepare = nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: format!("history-prepare-{index}"),
            identity: identity.clone(),
            payload: nip::Payload::PrepareInput {
                source: source.clone(),
                source_digest: digest.clone(),
                plan,
                plan_digest: plan_digest.clone(),
                budget_ms: 5000,
                reduced_motion: true,
                job: None,
            },
        };
        control.write_all(&prepare.encode().unwrap()).unwrap();
        write(writer, b"\x18\x02");
        wait(|| has(messages, &prepare.request_id, "inputConfirmed"), raw);
        if cancelled {
            let cancel = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: "history-cancel".into(),
                identity: identity.clone(),
                payload: nip::Payload::CancelDraft,
            };
            control.write_all(&cancel.encode().unwrap()).unwrap();
            write(writer, b"\x18\x02");
            wait(|| has(messages, &cancel.request_id, "draftCleared"), raw);
            write(writer, b"\x18a\r");
            assert!(!messages.lock().unwrap().iter().any(|message|matches!(message,nip::Message::Operation(reply)if reply.identity==identity&&matches!(reply.payload,nip::Payload::SubmissionAccepted|nip::Payload::Started{..}))));
        } else {
            let commit = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: format!("history-commit-{index}"),
                identity,
                payload: nip::Payload::Commit {
                    source_digest: digest,
                    plan_digest,
                },
            };
            control.write_all(&commit.encode().unwrap()).unwrap();
            write(writer, b"\x18\x02");
            wait(|| has(messages, &commit.request_id, "commitArmed"), raw);
            write(writer, b"\x18a");
            wait(
                || {
                    has(messages, &commit.request_id, "submissionAccepted")
                        && has(messages, &prepare.request_id, "started")
                        && has(messages, &prepare.request_id, "settled")
                },
                raw,
            );
            wait(
                || {
                    String::from_utf8_lossy(&raw.lock().unwrap())
                        .contains(&format!("HISTORY_EXECUTED_{index}"))
                },
                raw,
            );
            sources.push(source);
        }
    }
    let after = snapshot(writer, raw, evidence, 2);
    assert_eq!(
        before["historyOptions"], after["historyOptions"],
        "Native operations changed caller history options"
    );
    let history = after["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    if mode == "history-small" {
        assert_eq!(after["historyOptions"]["maximum"], 3);
        assert_eq!(history, sources[2..]);
    } else {
        for source in &sources {
            assert_eq!(
                history.iter().filter(|entry| *entry == source).count(),
                1,
                "Actual source was not recorded exactly once"
            );
        }
    }
    assert!(
        !history.iter().any(|line| line.contains("HISTORY_CANCEL_")
            || line.contains("__shellspan_nip_begin")
            || line.contains("native-powershell-host")),
        "Cancelled draft or private plan entered history"
    );
    assert!(
        !String::from_utf8_lossy(&raw.lock().unwrap()).contains("HISTORY_CANCEL_SHOULD_NOT_RUN")
    );
    let startup: serde_json::Value =
        serde_json::from_slice(&fs::read(evidence.join("history-startup.json")).unwrap()).unwrap();
    if matches!(mode, "history-empty" | "history-null") {
        assert_eq!(startup["pathSettingRejected"], true);
    }
    if mode == "history-save-nothing" {
        assert_eq!(after["historyOptions"]["style"], "SaveNothing");
    }
    if mode == "history-save-at-exit" {
        assert_eq!(after["historyOptions"]["style"], "SaveAtExit");
    }
    fs::write(evidence.join("history-before-exit.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"mode":mode,"before":before,"after":after,"sources":sources,"accepted":5,"cancelled":1,"scope":"Actual frozen Windows native provider and public history API; not full App or GNU39 matrix"})).unwrap()).unwrap();
    write(writer, b"exit\r");
}

pub(super) fn after_exit(evidence: &std::path::Path, mode: &str) {
    let data: serde_json::Value =
        serde_json::from_slice(&fs::read(evidence.join("history-before-exit.json")).unwrap())
            .unwrap();
    let path = std::path::PathBuf::from(data["after"]["historyOptions"]["path"].as_str().unwrap());
    let content = if mode == "history-save-nothing" {
        assert!(!path.exists(), "SaveNothing created a history file");
        String::new()
    } else {
        fs::read_to_string(&path).expect("History was not persisted after actual normal exit")
    };
    assert!(
        !content.contains("HISTORY_CANCEL_")
            && !content.contains("__shellspan_nip_begin")
            && !content.contains("native-powershell-host")
    );
    if mode != "history-save-nothing" {
        let sources = data["sources"].as_array().unwrap();
        let expected = if mode == "history-small" {
            &sources[4..]
        } else {
            sources.as_slice()
        };
        for source in expected {
            assert_eq!(
                content
                    .lines()
                    .filter(|line| *line == source.as_str().unwrap())
                    .count(),
                1,
                "Persisted native source missing or repeated"
            );
        }
        if mode != "history-small" {
            for seed in [
                "Write-Output 'HISTORY_SEED_A'",
                "Write-Output 'HISTORY_SEED_B'",
            ] {
                assert!(
                    content.lines().any(|line| line == seed),
                    "Existing isolated history was lost"
                );
            }
        }
    }
    fs::write(evidence.join("history-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"mode":mode,"accepted":5,"cancelled":1,"optionsPreserved":true,"nativeSourceRecordedOnce":true,"cancelledAndPrivatePlanAbsent":true,"gracefulExit":true,"historyFileCreated":path.exists(),"historyFileBytes":content.len(),"scope":"Actual P7/PSReadLine history options and persistence only"})).unwrap()).unwrap();
}
