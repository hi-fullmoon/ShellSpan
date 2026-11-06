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
    let multiline = "$boundary = @'\n中文 e\u{301} 👩🏽‍💻 ! \"double\" 'single'\t\n'@\n# tail";
    let cases = [
        (
            "unicode-tab-quotes",
            "\t$boundary = '中文 e\u{301} 👩🏽‍💻 ! single''quote'\n# \"double\" and `backtick"
                .to_string(),
        ),
        ("multiline-lf", multiline.to_string()),
        ("multiline-crlf", multiline.replace('\n', "\r\n")),
        ("multiline-cr", multiline.replace('\n', "\r")),
        ("ascii-8192", format!("#{}", "a".repeat(8191))),
        ("unicode-8192", format!("#{}a", "中".repeat(2730))),
    ];
    let mut checks = Vec::new();
    for (index, (scenario, source)) in cases.into_iter().enumerate() {
        fs::write(
            evidence.join(format!("input-{index}.txt")),
            source.as_bytes(),
        )
        .unwrap();
        fs::write(evidence.join("input-boundary-result.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "complete": false, "currentCase": scenario, "checks": checks,
            "scope": "Actual native provider input and cancel only; no runtime/model/Agent submission",
        })).unwrap()).unwrap();
        let probe_id = format!("boundary-probe-{index}");
        let probe = nip::ConnectionEnvelope {
            protocol: nip::PROTOCOL.into(),
            request_id: probe_id.clone(),
            connection: nip::ConnectionIdentity {
                terminal_session_id: connection_id.into(),
                terminal_generation: 1,
                control_id: connection_id.into(),
            },
            payload: nip::ConnectionPayload::Probe,
        };
        control.write_all(&probe.encode().unwrap()).unwrap();
        write(writer, b"\x18\x02");
        wait(
            || {
                messages.lock().unwrap().iter().any(|value| matches!(value, nip::Message::Connection(reply) if reply.request_id==probe_id && matches!(reply.payload,nip::ConnectionPayload::Capabilities{native_inline:true,editor_empty:true,..})))
            },
            raw,
        );
        let plan = nip::native_foreground_plan(&source, profile.shell).unwrap();
        let digest = nip::sha(&source);
        let plan_digest = nip::bound_plan_digest(&digest, &plan);
        let identity = nip::Identity {
            terminal_session_id: connection_id.into(),
            terminal_generation: 1,
            lease_id: format!("boundary-lease-{index}"),
            lease_generation: index as u64 + 1,
            agent_session_id: "boundary-agent".into(),
            task_id: "boundary-task".into(),
            operation_id: format!("boundary-operation-{index}"),
            command_id: format!("boundary-command-{index}"),
            source_revision: 1,
        };
        let prepare = nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: format!("boundary-prepare-{index}"),
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
        wait(
            || {
                has(messages, &prepare.request_id, "inputConfirmed")
                    || has(messages, &prepare.request_id, "rejected")
            },
            raw,
        );
        let proofs = messages.lock().unwrap().iter().filter(|value| matches!(value,nip::Message::Operation(reply) if reply.request_id==prepare.request_id && matches!(&reply.payload,nip::Payload::InputConfirmed{source_digest,plan_digest:bound,utf8_bytes,cursor_utf8_bytes,end_utf8_bytes} if source_digest==&digest&&bound==&plan_digest&&*utf8_bytes==source.len()&&*cursor_utf8_bytes==source.len()&&*end_utf8_bytes==source.len()))).count();
        assert_eq!(proofs, 1, "Actual exact input proof missing for {scenario}");
        let cancel = nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: format!("boundary-cancel-{index}"),
            identity: identity.clone(),
            payload: nip::Payload::CancelDraft,
        };
        control.write_all(&cancel.encode().unwrap()).unwrap();
        write(writer, b"\x18\x02");
        wait(|| has(messages, &cancel.request_id, "draftCleared"), raw);
        assert!(messages.lock().unwrap().iter().any(|value| matches!(value,nip::Message::Operation(reply) if reply.request_id==cancel.request_id&&matches!(reply.payload,nip::Payload::DraftCleared{editor_empty:true}))));
        write(writer, b"\x18a\r");
        write(
            writer,
            format!("[Console]::WriteLine('INPUT_BOUNDARY_'+'USER_{index}')\r").as_bytes(),
        );
        wait(
            || {
                String::from_utf8_lossy(&raw.lock().unwrap())
                    .contains(&format!("INPUT_BOUNDARY_USER_{index}"))
            },
            raw,
        );
        assert!(!messages.lock().unwrap().iter().any(|value| matches!(value,nip::Message::Operation(reply) if reply.identity==identity&&matches!(reply.payload,nip::Payload::CommitArmed|nip::Payload::SubmissionAccepted|nip::Payload::Started{..}))));
        checks.push(serde_json::json!({"scenario":scenario,"sourceUtf8Bytes":source.len(),"sourceSha256":digest,"exactInputProofs":proofs,"cursorUtf8Bytes":source.len(),"endUtf8Bytes":source.len(),"draftCleared":true,"editorEmpty":true,"armed":0,"submissionAccepted":0,"started":0,"ordinaryEditingRestored":true}));
    }
    fs::write(evidence.join("input-boundary-result.json"), serde_json::to_vec_pretty(&serde_json::json!({"complete":true,"checks":checks,"scope":"Actual native provider input and cancel only; over-limit/malformed frames and runtime/model/Agent submission not covered"})).unwrap()).unwrap();
}
