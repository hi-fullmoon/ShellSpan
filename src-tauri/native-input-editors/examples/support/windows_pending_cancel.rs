use super::*;

pub(super) fn verify(
    control: &mut fs::File,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    messages: &Arc<Mutex<Vec<nip::Message>>>,
    raw: &Arc<Mutex<Vec<u8>>>,
    profile: &nip::PeerProfile,
    connection_id: &str,
    evidence: &PathBuf,
) {
    let source = "[Console]::WriteLine('PENDING_CANCEL_'+'EFFECT')".to_string();
    let plan = nip::native_foreground_plan(&source, profile.shell).unwrap();
    let digest = nip::sha(&source);
    let plan_digest = nip::bound_plan_digest(&digest, &plan);
    let identity = nip::Identity {
        terminal_session_id: connection_id.into(),
        terminal_generation: 1,
        lease_id: "pending-cancel-lease".into(),
        lease_generation: 1,
        agent_session_id: "pending-cancel-agent".into(),
        task_id: "pending-cancel-task".into(),
        operation_id: "pending-cancel-operation".into(),
        command_id: "pending-cancel-command".into(),
        source_revision: 1,
    };
    let prepare = nip::Envelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "pending-cancel-prepare".into(),
        identity: identity.clone(),
        payload: nip::Payload::PrepareInput {
            source,
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
    let commit = nip::Envelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "pending-cancel-commit".into(),
        identity: identity.clone(),
        payload: nip::Payload::Commit {
            source_digest: digest,
            plan_digest,
        },
    };
    control.write_all(&commit.encode().unwrap()).unwrap();
    write(writer, b"\x18\x02");
    wait(|| has(messages, &commit.request_id, "commitArmed"), raw);
    let cancel = nip::Envelope {
        protocol: nip::PROTOCOL.into(),
        request_id: "pending-cancel-stop".into(),
        identity: identity.clone(),
        payload: nip::Payload::CancelDraft,
    };
    // A complete real cancellation is in the private pipe before the physical
    // protected accept key. The key must drain it without a separate poll key.
    control.write_all(&cancel.encode().unwrap()).unwrap();
    write(writer, b"\x18a");
    wait(
        || {
            has(messages, &cancel.request_id, "draftCleared")
                || has(messages, &commit.request_id, "submissionAccepted")
        },
        raw,
    );
    let accepted = has(messages, &commit.request_id, "submissionAccepted");
    if accepted {
        wait(|| has(messages, &prepare.request_id, "settled"), raw);
    }
    let effect = String::from_utf8_lossy(&raw.lock().unwrap()).contains("PENDING_CANCEL_EFFECT");
    let cleared = has(messages, &cancel.request_id, "draftCleared");
    fs::write(evidence.join("pending-cancel-facts.json"),serde_json::to_vec_pretty(&serde_json::json!({"cancelWrittenBeforeProtectedKey":true,"draftCleared":cleared,"submissionAccepted":accepted,"sourceEffectObserved":effect,"scope":"Actual provider component ordering, not backend/model/intent chain"})).unwrap()).unwrap();
    assert!(
        cleared && !accepted && !effect,
        "A queued cancellation was bypassed by the accept key"
    );
    assert!(messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Operation(reply) if reply.request_id==cancel.request_id&&matches!(reply.payload,nip::Payload::DraftCleared{editor_empty:true}))));
    assert!(!messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Operation(reply) if reply.identity==identity&&matches!(reply.payload,nip::Payload::Started{..}))));
    write(writer, b"\r");
    write(
        writer,
        b"[Console]::WriteLine('PENDING_CANCEL_'+'USER_RESTORED')\r",
    );
    wait(
        || String::from_utf8_lossy(&raw.lock().unwrap()).contains("PENDING_CANCEL_USER_RESTORED"),
        raw,
    );
    assert!(!String::from_utf8_lossy(&raw.lock().unwrap()).contains("PENDING_CANCEL_EFFECT"));
    fs::write(evidence.join("pending-cancel-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"cancelWrittenBeforeProtectedKey":true,"draftCleared":true,"editorEmpty":true,"submissionAccepted":0,"started":0,"sourceEffectObserved":false,"ordinaryEditingRestored":true,"scope":"Actual provider component ordering only"})).unwrap()).unwrap();
}
