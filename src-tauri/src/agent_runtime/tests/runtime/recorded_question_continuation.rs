use super::*;

fn recorded_runtime(root: &std::path::Path) -> AgentRuntime {
    use crate::agent_runtime::native_adapter::{NativeToolAdapter, NativeToolServices};
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.to_path_buf()).unwrap();
    runtime
        .native_slot
        .as_ref()
        .unwrap()
        .install(Arc::new(
            NativeToolAdapter::from_services(
                NativeToolServices {
                    sessions: crate::models::SessionManager::default(),
                    database: crate::db::Database::open(&root.join("profiles.db")).unwrap(),
                    credentials: crate::keychain::CredentialManager::new(),
                    known_hosts_path: root.join("known_hosts"),
                    data_root: root.to_path_buf(),
                },
                runtime.native_engine.clone(),
            )
            .unwrap(),
        ))
        .unwrap();
    runtime
}

// Replay an actual cancelled-question journal in a private temporary store.
// The production HTTP adapter is constructed, but no model or terminal call is
// dispatched: startup has no ready input, and admission runs after interruption.
#[tokio::test]
#[ignore = "requires read-only SHELLSPAN_CONTINUATION_LEDGER and SHELLSPAN_CONTINUATION_DATABASE"]
async fn recorded_cancelled_question_allows_resume_restart_and_continue_admission() {
    use crate::llm::routes::{ModelSelection, RouteSnapshot};
    use rusqlite::{Connection, OpenFlags};
    use std::io::BufReader;

    let ledger = std::fs::File::open(
        std::env::var("SHELLSPAN_CONTINUATION_LEDGER").expect("recorded ledger path"),
    )
    .unwrap();
    let events = serde_json::Deserializer::from_reader(BufReader::new(ledger))
        .into_iter::<AgentSessionEvent>()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let cancellation = events
        .iter()
        .position(|event| {
            matches!(
                event.payload,
                AgentSessionEventPayload::QuestionCancelled { .. }
            )
        })
        .expect("recorded cancelled question");
    let ended = events
        .iter()
        .enumerate()
        .skip(cancellation)
        .find(|(_, event)| matches!(event.payload, AgentSessionEventPayload::SessionEnded { .. }))
        .map(|(index, _)| index)
        .expect("completed cancellation");
    let selected = events[..=ended]
        .iter()
        .rev()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::SessionModelSelected { provider } => Some(provider),
            _ => None,
        })
        .expect("recorded model selection");
    let database = Connection::open_with_flags(
        std::env::var("SHELLSPAN_CONTINUATION_DATABASE").expect("route database path"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let document: String = database
        .query_row(
            "SELECT value FROM preferences WHERE key='llm.routes.v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let routes: RouteSnapshot = serde_json::from_str(&document).unwrap();
    let provider = routes
        .routes
        .iter()
        .find(|route| route.id == selected.route_id)
        .unwrap()
        .provider(&ModelSelection {
            route_id: selected.route_id.clone(),
            model_id: selected.model_id.clone(),
            reasoning_effort: selected.reasoning_effort.clone(),
        })
        .unwrap();
    let session_id = &events[0].session_id;
    for end in cancellation..=ended {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("agent-runtime/sessions-v5");
        std::fs::create_dir_all(&directory).unwrap();
        let prefix = &events[..=end];
        std::fs::write(
            directory.join(format!("{session_id}.jsonl")),
            prefix
                .iter()
                .map(|event| format!("{}\n", serde_json::to_string(event).unwrap()))
                .collect::<String>(),
        )
        .unwrap();
        let runtime = recorded_runtime(root.path());
        if end < ended {
            runtime.start(session_id, provider.clone(), None).unwrap();
            assert!(
                runtime.session(session_id).unwrap().ended,
                "unfinished cancellation must settle"
            );
        }
        let resumed = runtime.resume(session_id).await.unwrap();
        assert!(!resumed.ended);
        let started = runtime.start(session_id, provider.clone(), None).unwrap();
        assert!(
            !started.ended,
            "historical question cancellation must not end a resumed session"
        );
        assert_eq!(started.status, AgentSessionStatus::Idle);
        runtime.interrupt(session_id).await.unwrap();
        drop(runtime);

        let restarted = recorded_runtime(root.path());
        let started = restarted.start(session_id, provider.clone(), None).unwrap();
        assert!(
            !started.ended,
            "an interrupted conversation must survive process restart"
        );
        restarted.interrupt(session_id).await.unwrap();
        let accepted = restarted
            .followup(session_id, "continue-after-recovery".into(), "继续".into())
            .unwrap();
        assert!(!accepted.ended);
        assert!(accepted
            .inbox
            .next_turn
            .iter()
            .any(|message| message.content == "继续"));
        let retry = restarted
            .followup(session_id, "continue-after-recovery".into(), "继续".into())
            .unwrap();
        assert_eq!(
            retry.event_count, accepted.event_count,
            "retry must reuse the durable receipt"
        );
        let replay = restarted.sessions.all_events(session_id).unwrap();
        assert_eq!(
            &replay[..prefix.len()],
            prefix,
            "historical evidence must stay unchanged"
        );
    }
}
