use super::*;

pub(super) fn is_mode(mode: &str) -> bool {
    matches!(
        mode,
        "transport-split-utf8"
            | "transport-coalesced"
            | "transport-query-flood"
            | "transport-before-prepare"
            | "transport-duplicate-prepare"
            | "transport-old-generation"
            | "transport-overlong"
            | "transport-eof-empty"
            | "transport-eof-half-prepare"
            | "transport-eof-draft-half-query"
            | "transport-query-deadline"
    )
}

pub(super) fn is_eof_mode(mode: &str) -> bool {
    matches!(
        mode,
        "transport-eof-empty" | "transport-eof-half-prepare" | "transport-eof-draft-half-query"
    )
}

pub(super) fn verify_eof(
    control: &mut fs::File,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    messages: &Arc<Mutex<Vec<nip::Message>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    profile: &nip::PeerProfile,
    connection: &str,
    evidence: &PathBuf,
    mode: &str,
    stop: &Arc<std::sync::atomic::AtomicBool>,
    reader: &mut Option<thread::JoinHandle<()>>,
) {
    let source = "$x='中文'; [Console]::WriteLine('TRANSPORT_EOF_'+'UNEXPECTED')".to_string();
    let plan = nip::native_foreground_plan(&source, profile.shell).unwrap();
    let digest = nip::sha(&source);
    let identity = nip::Identity {
        terminal_session_id: connection.into(),
        terminal_generation: 1,
        lease_id: "eof-lease".into(),
        lease_generation: 1,
        agent_session_id: "eof-agent".into(),
        task_id: "eof-task".into(),
        operation_id: "eof-operation".into(),
        command_id: "eof-command".into(),
        source_revision: 1,
    };
    let prepare = nip::Envelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "eof-prepare".into(),
        identity: identity.clone(),
        payload: nip::Payload::PrepareInput {
            source: source.clone(),
            source_digest: digest.clone(),
            plan_digest: nip::bound_plan_digest(&digest, &plan),
            plan,
            budget_ms: 5000,
            reduced_motion: true,
            job: None,
        },
    };
    let with_draft = mode == "transport-eof-draft-half-query";
    if with_draft {
        control.write_all(&prepare.encode().unwrap()).unwrap();
        write(writer, b"\x18\x02");
        wait(|| has(messages, &prepare.request_id, "inputConfirmed"), raw);
    }
    let mut half_bytes = 0;
    if mode != "transport-eof-empty" {
        let frame = if with_draft {
            nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: "eof-half-query".into(),
                identity,
                payload: nip::Payload::Query,
            }
        } else {
            prepare.clone()
        };
        let bytes = frame.encode().unwrap();
        half_bytes = bytes.len() / 2;
        control.write_all(&bytes[..half_bytes]).unwrap();
        write(writer, b"\x18\x02");
        fs::write(evidence.join("actual-half-frame.bin"), &bytes[..half_bytes]).unwrap();
    }
    // Stop and join the actual client reader first, dropping its cloned handle.
    // Dropping the remaining client handle then causes physical pipe EOF; no
    // server failure or decoder result is synthesized.
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    reader.take().unwrap().join().unwrap();
    drop(std::mem::replace(control, fs::File::open("NUL").unwrap()));
    write(writer, b"\x18\x02");
    let actual = fault_input::read_actual_editor(writer, raw, evidence, 1);
    assert_eq!(
        actual["controlClosed"], true,
        "Actual host had not observed physical EOF"
    );
    assert_eq!(actual["text"], "");
    assert_eq!(actual["cursorUtf16"], 0);
    if !with_draft {
        assert!(!has(messages, &prepare.request_id, "prepared"));
        assert!(!has(messages, &prepare.request_id, "inputConfirmed"));
    }
    assert_no_execution(messages);
    write(writer, b"\r");
    write(
        writer,
        b"[Console]::WriteLine('TRANSPORT_EOF_'+'USER_RESTORED')\r",
    );
    wait(
        || String::from_utf8_lossy(&raw.lock().unwrap()).contains("TRANSPORT_EOF_USER_RESTORED"),
        raw,
    );
    assert!(!String::from_utf8_lossy(&raw.lock().unwrap()).contains("TRANSPORT_EOF_UNEXPECTED"));
    fs::write(evidence.join("transport-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"mode":mode,"actualClientReaderJoined":true,"actualClientHandlesDropped":true,"partialBytesWritten":half_bytes,"fullInputBeforeEof":with_draft,"actualHostControlClosed":actual["controlClosed"],"actualBuffer":actual,"observedSubmissionAccepted":0,"observedStarted":0,"sourceEffectObserved":false,"ordinaryInputRestored":true,"scope":"Actual physical provider pipe EOF and public local buffer observation; no backend recovery/settlement or absence of unobservable post-close receipts claimed"})).unwrap()).unwrap();
}

fn assert_no_execution(messages: &Arc<Mutex<Vec<nip::Message>>>) {
    assert!(!messages.lock().unwrap().iter().any(|message|matches!(message,nip::Message::Operation(reply)if matches!(reply.payload,nip::Payload::SubmissionAccepted|nip::Payload::Started{..}))));
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
    let identity = nip::Identity {
        terminal_session_id: connection.into(),
        terminal_generation: 1,
        lease_id: "transport-lease".into(),
        lease_generation: 1,
        agent_session_id: "transport-agent".into(),
        task_id: "transport-task".into(),
        operation_id: "transport-operation".into(),
        command_id: "transport-command".into(),
        source_revision: 1,
    };
    let source =
        "$x='中文-é-👩🏽‍💻'; [Console]::WriteLine('TRANSPORT_UNEXPECTED_'+'EFFECT')".to_string();
    let plan = nip::native_foreground_plan(&source, profile.shell).unwrap();
    let digest = nip::sha(&source);
    let plan_digest = nip::bound_plan_digest(&digest, &plan);
    let prepare = nip::Envelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "transport-prepare".into(),
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
    let commit = nip::Envelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "transport-commit".into(),
        identity: identity.clone(),
        payload: nip::Payload::Commit {
            source_digest: digest.clone(),
            plan_digest: plan_digest.clone(),
        },
    };
    let mut observations = serde_json::Map::new();
    if mode == "transport-overlong" {
        let bytes = vec![b'x'; nip::MAX_MESSAGE_BYTES + 32];
        let mut delivered = 0;
        for chunk in bytes.chunks(8192) {
            match control.write_all(chunk) {
                Ok(()) => delivered += chunk.len(),
                Err(error) => {
                    assert!(
                        delivered >= nip::MAX_MESSAGE_BYTES,
                        "Channel closed before its actual frame bound: {error}"
                    );
                    break;
                }
            }
            write(writer, b"\x18\x02");
        }
        wait(|| available(control).is_none(), raw);
        let actual = fault_input::read_actual_editor(writer, raw, evidence, 1);
        assert_eq!(actual["text"], "");
        assert_eq!(actual["cursorUtf16"], 0);
        assert!(!messages.lock().unwrap().iter().any(|message|matches!(message,nip::Message::Operation(reply)if matches!(reply.payload,nip::Payload::Prepared{..}|nip::Payload::InputProgress{..}|nip::Payload::InputConfirmed{..}))));
        observations.insert("overlongBytesWritten".into(), serde_json::json!(delivered));
        observations.insert("privateChannelClosed".into(), true.into());
    } else {
        if mode == "transport-before-prepare" || mode == "transport-old-generation" {
            let mut invalid = if mode == "transport-before-prepare" {
                commit.clone()
            } else {
                prepare.clone()
            };
            invalid.request_id = "transport-invalid-order".into();
            if mode == "transport-old-generation" {
                invalid.identity.terminal_generation += 1;
            }
            control.write_all(&invalid.encode().unwrap()).unwrap();
            write(writer, b"\x18\x02");
            wait(|| has(messages, &invalid.request_id, "rejected"), raw);
            let expected = if mode == "transport-before-prepare" {
                nip::ErrorCode::State
            } else {
                nip::ErrorCode::Identity
            };
            assert!(messages.lock().unwrap().iter().any(|message|matches!(message,nip::Message::Operation(reply)if reply.request_id==invalid.request_id&&matches!(reply.payload,nip::Payload::Rejected{code}if code==expected))));
            let actual = fault_input::read_actual_editor(writer, raw, evidence, 1);
            assert_eq!(actual["text"], "");
            assert_eq!(actual["cursorUtf16"], 0);
            observations.insert(
                "invalidOrderOrGenerationRejectedBeforeInput".into(),
                true.into(),
            );
        }
        if mode == "transport-split-utf8" {
            let bytes = prepare.encode().unwrap();
            let split = bytes
                .windows(3)
                .position(|part| part == "中".as_bytes())
                .unwrap()
                + 1;
            for byte in &bytes[..split] {
                control.write_all(&[*byte]).unwrap();
            }
            write(writer, b"\x18\x02");
            let actual = fault_input::read_actual_editor(writer, raw, evidence, 1);
            assert_eq!(actual["text"], "");
            assert_eq!(actual["cursorUtf16"], 0);
            assert!(!has(messages, &prepare.request_id, "prepared"));
            assert!(!has(messages, &prepare.request_id, "inputConfirmed"));
            for byte in &bytes[split..bytes.len() - 1] {
                control.write_all(&[*byte]).unwrap();
            }
            write(writer, b"\x18\x02");
            let complete_without_lf = fault_input::read_actual_editor(writer, raw, evidence, 2);
            assert_eq!(complete_without_lf["text"], "");
            assert_eq!(complete_without_lf["cursorUtf16"], 0);
            assert!(!has(messages, &prepare.request_id, "prepared"));
            control.write_all(b"\n").unwrap();
            write(writer, b"\x18\x02");
            observations.insert(
                "singleByteWrites".into(),
                serde_json::json!(bytes.len() - 1),
            );
            observations.insert("incompleteFrameDidNotType".into(), true.into());
            observations.insert("actualPollWithPartialUtf8".into(), true.into());
        } else if mode == "transport-coalesced" {
            let query = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: "transport-coalesced-query".into(),
                identity: identity.clone(),
                payload: nip::Payload::Query,
            };
            let mut bytes = prepare.encode().unwrap();
            bytes.extend(query.encode().unwrap());
            control.write_all(&bytes).unwrap();
            write(writer, b"\x18\x02");
            wait(|| has(messages, &query.request_id, "snapshot"), raw);
            observations.insert("completeFramesInSingleWrite".into(), 2.into());
        } else {
            control.write_all(&prepare.encode().unwrap()).unwrap();
            write(writer, b"\x18\x02");
        }
        wait(|| has(messages, &prepare.request_id, "inputConfirmed"), raw);
        assert!(messages.lock().unwrap().iter().any(|message|matches!(message,nip::Message::Operation(reply)if reply.request_id==prepare.request_id&&matches!(&reply.payload,nip::Payload::InputConfirmed{source_digest,plan_digest:bound,utf8_bytes,cursor_utf8_bytes,end_utf8_bytes}if source_digest==&digest&&bound==&plan_digest&&*utf8_bytes==source.len()&&*cursor_utf8_bytes==source.len()&&*end_utf8_bytes==source.len()))));
        if mode == "transport-query-deadline" {
            let clock = Instant::now();
            let mut queries = 0;
            while clock.elapsed() < Duration::from_secs(7) && available(control).is_some() {
                let query = nip::Envelope {
                    protocol: nip::PROTOCOL.into(),
                    request_id: format!("deadline-query-{queries}"),
                    identity: identity.clone(),
                    payload: nip::Payload::Query,
                };
                if control.write_all(&query.encode().unwrap()).is_err() {
                    break;
                }
                queries += 1;
                thread::sleep(Duration::from_millis(100));
            }
            assert!(
                available(control).is_none(),
                "Queries kept the prepared source alive past the fixed deadline"
            );
            assert!(
                queries >= 10,
                "Deadline scenario did not actually exercise repeated queries"
            );
            let actual = fault_input::read_actual_editor(writer, raw, evidence, 1);
            assert_eq!(actual["controlClosed"], true);
            assert_eq!(actual["text"], "");
            assert_eq!(actual["cursorUtf16"], 0);
            assert!(
                String::from_utf8_lossy(&raw.lock().unwrap())
                    .contains("TERMINAL_NATIVE_DEADLINE_EXPIRED"),
                "Physical close was not accompanied by the actual native deadline diagnostic"
            );
            write(writer, b"\r");
            write(
                writer,
                b"[Console]::WriteLine('TRANSPORT_DEADLINE_'+'USER_RESTORED')\r",
            );
            wait(
                || {
                    String::from_utf8_lossy(&raw.lock().unwrap())
                        .contains("TRANSPORT_DEADLINE_USER_RESTORED")
                },
                raw,
            );
            assert_no_execution(messages);
            assert!(!String::from_utf8_lossy(&raw.lock().unwrap())
                .contains("TRANSPORT_UNEXPECTED_EFFECT"));
            fs::write(evidence.join("transport-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"mode":mode,"queriesWritten":queries,"elapsedAfterFullProofMs":clock.elapsed().as_millis(),"actualDeadlineDiagnostic":true,"actualHostControlClosed":true,"actualEmptyBuffer":actual,"submissionAccepted":0,"started":0,"sourceEffectObserved":false,"ordinaryInputRestored":true,"scope":"Actual producer fixed deadline under repeated queries, not backend queue credits or complete runtime timeout recovery"})).unwrap()).unwrap();
            return;
        }
        if mode == "transport-duplicate-prepare" {
            control.write_all(&commit.encode().unwrap()).unwrap();
            write(writer, b"\x18\x02");
            wait(|| has(messages, &commit.request_id, "commitArmed"), raw);
            let changed = "[Console]::WriteLine('TRANSPORT_DUPLICATE_'+'EFFECT')".to_string();
            let changed_plan = nip::native_foreground_plan(&changed, profile.shell).unwrap();
            let changed_digest = nip::sha(&changed);
            let duplicate = nip::Envelope {
                protocol: nip::PROTOCOL.into(),
                request_id: prepare.request_id.clone(),
                identity: identity.clone(),
                payload: nip::Payload::PrepareInput {
                    source: changed,
                    source_digest: changed_digest.clone(),
                    plan_digest: nip::bound_plan_digest(&changed_digest, &changed_plan),
                    plan: changed_plan,
                    budget_ms: 5000,
                    reduced_motion: true,
                    job: None,
                },
            };
            control.write_all(&duplicate.encode().unwrap()).unwrap();
            write(writer, b"\x18\x02");
            wait(|| has(messages, &duplicate.request_id, "rejected"), raw);
            assert!(messages.lock().unwrap().iter().any(|message|matches!(message,nip::Message::Operation(reply)if reply.request_id==duplicate.request_id&&matches!(reply.payload,nip::Payload::Rejected{code:nip::ErrorCode::DuplicateRequest}))));
            let actual = fault_input::read_actual_editor(writer, raw, evidence, 1);
            assert_eq!(actual["text"], source);
            observations.insert(
                "conflictingDuplicateDidNotReplaceBuffer".into(),
                true.into(),
            );
        }
        let cancel = nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: "transport-cancel".into(),
            identity: identity.clone(),
            payload: nip::Payload::CancelDraft,
        };
        if mode == "transport-query-flood" {
            let mut bytes = Vec::new();
            for index in 0..100 {
                bytes.extend(
                    nip::Envelope {
                        protocol: nip::PROTOCOL.into(),
                        request_id: format!("transport-query-{index}"),
                        identity: identity.clone(),
                        payload: nip::Payload::Query,
                    }
                    .encode()
                    .unwrap(),
                );
            }
            bytes.extend(cancel.encode().unwrap());
            control.write_all(&bytes).unwrap();
            write(writer, b"\x18\x02");
        } else {
            control.write_all(&cancel.encode().unwrap()).unwrap();
            write(writer, b"\x18\x02");
        }
        wait(|| has(messages, &cancel.request_id, "draftCleared"), raw);
        assert!(messages.lock().unwrap().iter().any(|message|matches!(message,nip::Message::Operation(reply)if reply.request_id==cancel.request_id&&matches!(reply.payload,nip::Payload::DraftCleared{editor_empty:true}))));
        if mode == "transport-query-flood" {
            for index in 0..100 {
                assert!(has(
                    messages,
                    &format!("transport-query-{index}"),
                    "snapshot"
                ));
            }
            observations.insert("querySnapshotsBeforeRealCancel".into(), 100.into());
        }
        let actual = fault_input::read_actual_editor(
            writer,
            raw,
            evidence,
            if mode == "transport-split-utf8" { 3 } else { 2 },
        );
        assert_eq!(actual["text"], "");
        assert_eq!(actual["cursorUtf16"], 0);
        observations.insert("realDraftCleared".into(), true.into());
        write(writer, b"\r");
    }
    write(
        writer,
        b"[Console]::WriteLine('TRANSPORT_USER_'+'RESTORED')\r",
    );
    wait(
        || String::from_utf8_lossy(&raw.lock().unwrap()).contains("TRANSPORT_USER_RESTORED"),
        raw,
    );
    assert_no_execution(messages);
    let text = String::from_utf8_lossy(&raw.lock().unwrap()).to_string();
    assert!(
        !text.contains("TRANSPORT_UNEXPECTED_EFFECT")
            && !text.contains("TRANSPORT_DUPLICATE_EFFECT")
    );
    fs::write(evidence.join("transport-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"mode":mode,"observations":observations,"submissionAccepted":0,"started":0,"sourceEffectObserved":false,"ordinaryInputRestored":true,"scope":"Actual Windows private provider transport only; no backend queue credits/lease/FULL intent, query deadline extension or EOF half-frame claims"})).unwrap()).unwrap();
}
