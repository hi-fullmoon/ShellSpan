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
    let mut checks = Vec::new();
    for (index, scenario) in ["unarmed-key", "wrong-digest", "wrong-generation", "duplicate-arm-cancel"].into_iter().enumerate() {
        let probe_id = format!("negative-probe-{index}");
        let probe = nip::ConnectionEnvelope {
            protocol: nip::PROTOCOL.into(), request_id: probe_id.clone(),
            connection: nip::ConnectionIdentity { terminal_session_id: connection_id.into(), terminal_generation: 1, control_id: connection_id.into() },
            payload: nip::ConnectionPayload::Probe,
        };
        control.write_all(&probe.encode().unwrap()).unwrap();
        write(writer, b"\x18\x02");
        wait(|| messages.lock().unwrap().iter().any(|value| matches!(value, nip::Message::Connection(reply) if reply.request_id==probe_id && matches!(reply.payload,nip::ConnectionPayload::Capabilities{native_inline:true,editor_empty:true,..}))), raw);
        let source = "[Console]::WriteLine('NEGATIVE_'+'EFFECT')".to_string();
        let plan = nip::native_foreground_plan(&source, profile.shell).unwrap();
        let digest = nip::sha(&source);
        let plan_digest = nip::bound_plan_digest(&digest, &plan);
        let identity = nip::Identity {
            terminal_session_id: connection_id.into(), terminal_generation: 1,
            lease_id: format!("negative-lease-{index}"), lease_generation: index as u64+1,
            agent_session_id: "negative-agent".into(), task_id: "negative-task".into(),
            operation_id: format!("negative-operation-{index}"), command_id: format!("negative-command-{index}"), source_revision: 1,
        };
        let prepare = nip::Envelope { protocol:nip::PROTOCOL.into(),request_id:format!("negative-prepare-{index}"),identity:identity.clone(),payload:nip::Payload::PrepareInput {source:source.clone(),source_digest:digest.clone(),plan,plan_digest:plan_digest.clone(),budget_ms:5000,reduced_motion:true,job:None} };
        control.write_all(&prepare.encode().unwrap()).unwrap();write(writer,b"\x18\x02");
        wait(||has(messages,&prepare.request_id,"inputConfirmed"),raw);
        let before = messages.lock().unwrap().len();
        if scenario!="unarmed-key" {
            let mut commit = nip::Envelope {protocol:nip::PROTOCOL.into(),request_id:format!("negative-commit-{index}"),identity:identity.clone(),payload:nip::Payload::Commit {source_digest:if scenario=="wrong-digest"{"0".repeat(64)}else{digest.clone()},plan_digest:plan_digest.clone()}};
            if scenario=="wrong-generation" {commit.identity.terminal_generation+=1;}
            control.write_all(&commit.encode().unwrap()).unwrap();
            if scenario=="duplicate-arm-cancel" {
                wait(||has(messages,&commit.request_id,"commitArmed"),raw);
                commit.request_id.push_str("-duplicate");
                control.write_all(&commit.encode().unwrap()).unwrap();
                write(writer,b"\x18\x02");
            }
            wait(||has(messages,&commit.request_id,"rejected"),raw);
            let expected=match scenario {"wrong-generation"=>nip::ErrorCode::Identity,"duplicate-arm-cancel"=>nip::ErrorCode::DuplicateRequest,_=>nip::ErrorCode::Binding};
            assert!(messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Operation(reply) if reply.request_id==commit.request_id&&matches!(reply.payload,nip::Payload::Rejected{code}if code==expected))));
        }
        if scenario!="duplicate-arm-cancel" {write(writer,b"\x18a");thread::sleep(Duration::from_millis(150));}
        assert!(!has(messages,&prepare.request_id,"started"),"A rejected/unarmed key started source");
        let arm_count=messages.lock().unwrap()[before..].iter().filter(|value|matches!(value,nip::Message::Operation(reply)if reply.identity==identity&&matches!(reply.payload,nip::Payload::CommitArmed))).count();
        assert_eq!(arm_count,usize::from(scenario=="duplicate-arm-cancel"));
        let cancel = nip::Envelope {protocol:nip::PROTOCOL.into(),request_id:format!("negative-cancel-{index}"),identity:identity.clone(),payload:nip::Payload::CancelDraft};
        control.write_all(&cancel.encode().unwrap()).unwrap();write(writer,b"\x18\x02");
        wait(||has(messages,&cancel.request_id,"draftCleared"),raw);
        assert!(messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Operation(reply)if reply.request_id==cancel.request_id&&matches!(reply.payload,nip::Payload::DraftCleared{editor_empty:true}))));
        // An old accept key and the next ordinary Enter must not revive the
        // cleared source. A real ordinary command then proves editing works.
        write(writer,b"\x18a\r");
        let token=format!("USER_EDIT_{index}");
        let ordinary=format!("[Console]::WriteLine('USER_'+'EDIT_{index}')\r");
        write(writer,ordinary.as_bytes());
        wait(||String::from_utf8_lossy(&raw.lock().unwrap()).contains(&token),raw);
        assert!(!String::from_utf8_lossy(&raw.lock().unwrap()).contains("NEGATIVE_EFFECT"),"Cancelled source produced its actual effect");
        assert!(!has(messages,&prepare.request_id,"started"));
        assert!(!messages.lock().unwrap().iter().any(|value|matches!(value,nip::Message::Operation(reply)if reply.identity==identity&&matches!(reply.payload,nip::Payload::SubmissionAccepted))));
        checks.push(serde_json::json!({"scenario":scenario,"fullInputObserved":true,"armedCount":arm_count,"draftCleared":true,"editorEmpty":true,"started":0,"submissionAccepted":0,"sourceEffectCount":0,"ordinaryUserEditingRestored":true}));
    }
    fs::write(evidence.join("negative-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"scope":"Actual native provider component only, not runtime approval/journal/model chain","checks":checks})).unwrap()).unwrap();
}
