use crate::agent_runtime::{AgentRuntimeBuilder, AgentSessionEvent, AgentSessionEventPayload};

#[test]
#[ignore = "requires the actual own Wry model crash recording, never fabricated events"]
fn recorded_workbench_crash_requires_recovery_without_a_resident_driver() {
    let evidence = std::path::PathBuf::from(
        std::env::var("SHELLSPAN_STAGE2_RECOVERY_FIXTURE").expect("actual recording required"),
    );
    let directory = evidence.join("fixture/agent-runtime/sessions-v5");
    let journal = std::fs::read_dir(directory)
        .unwrap()
        .map(|item| item.unwrap().path())
        .find(|path| {
            std::fs::read_to_string(path).is_ok_and(|content| content.contains("recovery-started"))
        })
        .expect("actual dispatched recording required");
    let raw = std::fs::read_to_string(journal).unwrap();
    let lines = raw.lines().collect::<Vec<_>>();
    let events = lines
        .iter()
        .map(|line| serde_json::from_str::<AgentSessionEvent>(line).unwrap())
        .collect::<Vec<_>>();
    let boundary = events
        .iter()
        .rposition(|event| {
            matches!(
                event.payload,
                AgentSessionEventPayload::ToolExecution { .. }
            )
        })
        .expect("actual dispatch required");
    let session_id = &events[0].session_id;
    let storage = tempfile::tempdir().unwrap();
    let sessions = storage.path().join("agent-runtime/sessions-v5");
    std::fs::create_dir_all(&sessions).unwrap();
    let file = sessions.join(format!("{session_id}.jsonl"));
    // Exact recorded prefix: no synthesized events, model responses or tool effects.
    std::fs::write(&file, format!("{}\n", lines[..=boundary].join("\n"))).unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let snapshot = runtime.session_for_client(session_id).unwrap();
    assert!(snapshot.recovery_required);
    assert!(snapshot.uncertain_native_effects);
    assert_eq!(
        snapshot.recovery.kind,
        crate::agent_runtime::AgentRecoveryCheckpointKind::ExecutionInFlight
    );
    drop(runtime);
    std::fs::write(&file, raw).unwrap();
    let reopened = AgentRuntimeBuilder::new().build();
    reopened.configure(storage.path().to_path_buf()).unwrap();
    assert!(
        !reopened
            .session_for_client(session_id)
            .unwrap()
            .recovery_required
    );
}

#[test]
#[ignore = "requires the actual own multi-session Wry model recording"]
fn recorded_delegation_uses_the_parent_binding_instead_of_another_session() {
    let evidence = std::path::PathBuf::from(
        std::env::var("SHELLSPAN_STAGE2_RECOVERY_FIXTURE").expect("actual recording required"),
    );
    let storage = tempfile::tempdir().unwrap();
    let destination = storage.path().join("agent-runtime/sessions-v5");
    std::fs::create_dir_all(&destination).unwrap();
    for item in std::fs::read_dir(evidence.join("fixture/agent-runtime/sessions-v5")).unwrap() {
        let path = item.unwrap().path();
        std::fs::copy(&path, destination.join(path.file_name().unwrap())).unwrap();
    }
    let store = crate::agent_runtime::AgentSessionStore::default();
    store.configure(storage.path().to_path_buf()).unwrap();
    let page = store
        .list_page(crate::agent_runtime::AgentSessionListRequest {
            cursor: None,
            limit: 200,
        })
        .unwrap();
    let mut observed_different_binding = false;
    for session in page.sessions {
        let Some(target) = &session.header.target else {
            continue;
        };
        let selected = crate::agent_runtime::subagent::delegation_target(
            &store,
            &store.snapshot(&session.header.session_id).unwrap(),
            &target.target_id,
        )
        .unwrap();
        assert_eq!(&selected, target);
        if store.target_by_id(&target.target_id).unwrap() != *target {
            observed_different_binding = true;
        }
    }
    assert!(
        observed_different_binding,
        "actual differently labelled/bound sessions required"
    );
}
