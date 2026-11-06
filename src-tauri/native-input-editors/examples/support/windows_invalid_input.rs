use super::*;

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
    let effect_source = "[Console]::WriteLine('ILLEGAL_B01_'+'EXECUTION');";
    let source = match scenario {
        "invalid-overlimit" => format!(
            "{effect_source}#{}",
            "a".repeat(8193 - effect_source.len() - 1)
        ),
        "invalid-empty" => String::new(),
        "invalid-nul" => format!("{effect_source}\0"),
        "invalid-control" => format!("{effect_source}\u{1b}"),
        _ => effect_source.to_string(),
    };
    let plan = nip::native_foreground_plan(&source, profile.shell).unwrap();
    let digest = nip::sha(&source);
    let identity = nip::Identity {
        terminal_session_id: connection_id.into(),
        terminal_generation: 1,
        lease_id: "invalid-lease".into(),
        lease_generation: 1,
        agent_session_id: "invalid-agent".into(),
        task_id: "invalid-task".into(),
        operation_id: "invalid-operation".into(),
        command_id: "invalid-command".into(),
        source_revision: 1,
    };
    let request = nip::Envelope {
        protocol: if scenario == "invalid-version" {
            "unsupported.native-input".into()
        } else {
            nip::PROTOCOL.into()
        },
        request_id: "invalid-prepare".into(),
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
    // Deliberately send invalid requests to the real receiver. These are not
    // simulated receipts/proofs; normal Envelope::encode must reject them.
    if scenario == "invalid-after-input" {
        control.write_all(&request.encode().unwrap()).unwrap();
        write(writer, b"\x18\x02");
        wait(|| has(messages, &request.request_id, "inputConfirmed"), raw);
    }
    let bytes = match scenario {
        "invalid-utf8" | "invalid-after-input" => vec![0xff, b'\n'],
        "invalid-json" => b"{not-json}\n".to_vec(),
        _ => {
            let mut bytes = serde_json::to_vec(&request).unwrap();
            bytes.push(b'\n');
            bytes
        }
    };
    fs::write(evidence.join("invalid-request.bin"), &bytes).unwrap();
    fs::write(evidence.join("invalid-plan.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scenario":scenario,"requestBytes":bytes.len(),"sourceUtf8Bytes":source.len(),
        "requestSha256":hex::encode(sha2::Sha256::digest(&bytes)),
        "expected":"Actual receiver closes invalid private channel before any input, ordinary editing remains usable",
        "scope":"Actual native provider boundary only, no runtime/model/Agent submission",
    })).unwrap()).unwrap();
    control.write_all(&bytes).unwrap();
    write(writer, b"\x18\x02");
    wait(|| available(control).is_none(), raw);
    write(writer, b"\x18a\r");
    write(
        writer,
        b"[Console]::WriteLine('INVALID_INPUT_'+'USER_RESTORED')\r",
    );
    wait(
        || String::from_utf8_lossy(&raw.lock().unwrap()).contains("INVALID_INPUT_USER_RESTORED"),
        raw,
    );
    let accepted_facts=messages.lock().unwrap().iter().filter(|value| matches!(value,nip::Message::Operation(reply) if reply.identity==identity&&(matches!(reply.payload,nip::Payload::CommitArmed|nip::Payload::SubmissionAccepted|nip::Payload::Started{..})||scenario!="invalid-after-input"&&matches!(reply.payload,nip::Payload::Prepared{..}|nip::Payload::InputProgress{..}|nip::Payload::InputConfirmed{..})))).count();
    let effect_observed =
        String::from_utf8_lossy(&raw.lock().unwrap()).contains("ILLEGAL_B01_EXECUTION");
    fs::write(evidence.join("invalid-facts.json"),serde_json::to_vec_pretty(&serde_json::json!({"scenario":scenario,"privateChannelClosed":true,"fullInputBeforeFault":scenario=="invalid-after-input","unexpectedInputOrExecutionFacts":accepted_facts,"sourceEffectObserved":effect_observed,"ordinaryUserCommandObserved":true})).unwrap()).unwrap();
    assert_eq!(
        accepted_facts, 0,
        "Invalid request reached actual input for {scenario}"
    );
    assert!(
        !String::from_utf8_lossy(&raw.lock().unwrap()).contains("ILLEGAL_B01_EXECUTION"),
        "Invalid source survived to a later Enter"
    );
    fs::write(evidence.join("invalid-result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scenario":scenario,"ok":true,"privateChannelClosed":true,"inputFacts":accepted_facts,
        "sourceEffectObserved":false,"ordinaryEditingRestored":true,
        "scope":"Actual native provider boundary only; EOF half-frame/overlong frame/runtime recovery not covered",
    })).unwrap()).unwrap();
}
