use super::*;

pub(super) fn read_actual_editor(
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    evidence: &std::path::Path,
    sample: usize,
) -> serde_json::Value {
    let path = evidence.join(format!("actual-editor-{sample}.json"));
    fs::write(evidence.join("editor-read-request.txt"), sample.to_string()).unwrap();
    let mut next_read = Instant::now();
    // A custom-key error can flush queued console keys. Retrying this read-only
    // public-editor observation is safe; no source or submission is replayed.
    wait(
        || {
            if fs::read(&path)
                .is_ok_and(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).is_ok())
            {
                return true;
            }
            if Instant::now() >= next_read {
                write(writer, b"\x18\x14");
                next_read = Instant::now() + Duration::from_millis(100);
            }
            false
        },
        raw,
    );
    let observed: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(observed["activeEditor"], true);
    assert_eq!(observed["thread"], observed["expectedThread"]);
    observed
}

pub(super) fn verify(
    control: &mut fs::File,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    messages: &Arc<Mutex<Vec<nip::Message>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    profile: &nip::PeerProfile,
    connection_id: &str,
    evidence: &PathBuf,
    scenario: &str,
) {
    let mut source = "[Console]::WriteLine('FAULT_INPUT_'+'EFFECT');".to_string();
    if scenario == "fault-unicode" {
        source = format!("$boundary='中文 e\u{301} 👩🏽‍💻';{source}");
    }
    let typing = scenario == "fault-typing";
    if typing {
        source.push_str(&format!("\n#{}", "a".repeat(4000)));
    }
    let plan = nip::native_foreground_plan(&source, profile.shell).unwrap();
    let digest = nip::sha(&source);
    let plan_digest = nip::bound_plan_digest(&digest, &plan);
    let identity = nip::Identity {
        terminal_session_id: connection_id.into(),
        terminal_generation: 1,
        lease_id: "fault-lease".into(),
        lease_generation: 1,
        agent_session_id: "fault-agent".into(),
        task_id: "fault-task".into(),
        operation_id: "fault-operation".into(),
        command_id: "fault-command".into(),
        source_revision: 1,
    };
    let prepare = nip::Envelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "fault-prepare".into(),
        identity: identity.clone(),
        payload: nip::Payload::PrepareInput {
            source: source.clone(),
            source_digest: digest.clone(),
            plan,
            plan_digest: plan_digest.clone(),
            budget_ms: 5000,
            reduced_motion: !typing,
            job: None,
        },
    };
    fs::write(evidence.join("source.txt"), &source).unwrap();
    control.write_all(&prepare.encode().unwrap()).unwrap();
    write(writer, b"\x18\x02");
    if typing {
        wait(
            || {
                messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Operation(reply) if reply.identity==identity&&matches!(reply.payload,nip::Payload::InputProgress{applied_utf8_bytes} if applied_utf8_bytes>0&&applied_utf8_bytes<source.len())))
            },
            raw,
        );
    } else {
        wait(|| has(messages, &prepare.request_id, "inputConfirmed"), raw);
    }
    let armed = matches!(
        scenario,
        "fault-armed" | "fault-unowned" | "fault-armed-enter"
    );
    if armed {
        let commit = nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: "fault-commit".into(),
            identity: identity.clone(),
            payload: nip::Payload::Commit {
                source_digest: digest,
                plan_digest,
            },
        };
        control.write_all(&commit.encode().unwrap()).unwrap();
        write(writer, b"\x18\x02");
        wait(|| has(messages, &commit.request_id, "commitArmed"), raw);
    }
    if scenario == "fault-unowned" {
        write(writer, b" #USER_MODIFIED_DRAFT");
        write(writer, b"\x18\x02");
        // Real user interference is itself an ownership failure, observed by
        // the actual editor loop. No forged protocol fact is supplied.
    } else if scenario == "fault-armed-enter" {
        write(writer, b"\r");
    } else {
        control.write_all(&[0xff, b'\n']).unwrap();
        write(writer, b"\x18\x02");
    }
    wait(|| available(control).is_none(), raw);
    let observed = read_actual_editor(writer, raw, evidence, 1);
    if scenario == "fault-unowned" {
        assert_eq!(
            observed["text"],
            format!("{source} #USER_MODIFIED_DRAFT"),
            "A non-owned edited draft was erased"
        );
        assert_eq!(
            observed["cursorUtf16"],
            format!("{source} #USER_MODIFIED_DRAFT")
                .encode_utf16()
                .count()
        );
    } else {
        assert_eq!(
            observed["text"], "",
            "An owned failed prefix survived actual cleanup"
        );
        assert_eq!(observed["cursorUtf16"], 0);
    }
    write(writer, b"\x18a\r");
    let after_enter = read_actual_editor(writer, raw, evidence, 2);
    assert_eq!(after_enter["text"], "");
    assert_eq!(after_enter["cursorUtf16"], 0);
    write(writer, b"\x03\x18\x02");
    let after_discard = read_actual_editor(writer, raw, evidence, 3);
    assert_eq!(after_discard["text"], "");
    assert_eq!(after_discard["cursorUtf16"], 0);
    write(
        writer,
        b"[Console]::WriteLine('FAULT_INPUT_'+'USER_RESTORED')\r",
    );
    wait(
        || String::from_utf8_lossy(&raw.lock().unwrap()).contains("FAULT_INPUT_USER_RESTORED"),
        raw,
    );
    let effect = String::from_utf8_lossy(&raw.lock().unwrap()).contains("FAULT_INPUT_EFFECT");
    let own = messages
        .lock()
        .unwrap()
        .iter()
        .filter_map(|value| match value {
            nip::Message::Operation(reply) if reply.identity == identity => {
                Some(reply.payload.clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let count = |kind: &str| {
        own.iter()
            .filter(|payload| serde_json::to_value(payload).unwrap()["kind"] == kind)
            .count()
    };
    assert_eq!(count("commitArmed"), usize::from(armed));
    for kind in ["submissionAccepted", "started", "draftCleared"] {
        assert_eq!(
            count(kind),
            0,
            "Unexpected private fact after fault: {kind}"
        );
    }
    assert!(
        !effect,
        "A failed uncommitted source escaped to its parent parser"
    );
    fs::write(evidence.join("fault-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"scenario":scenario,"sourceUtf8Bytes":source.len(),"privateChannelClosed":true,"partialInputObserved":typing,"fullInputObserved":!typing,"armed":usize::from(armed),"actualBufferBeforeLateEnter":observed,"actualBufferAfterLateEnter":after_enter,"actualBufferAfterExplicitDiscard":after_discard,"submissionAccepted":0,"started":0,"draftClearedReceipts":0,"sourceEffectObserved":effect,"ordinaryEditingRestored":true,"scope":"Actual provider same-thread local cleanup and parser guard, not backend intent/recovery/lease settlement"})).unwrap()).unwrap();
}
