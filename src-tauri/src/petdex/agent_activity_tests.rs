use super::*;
use crate::agent_runtime::{
    AgentDriverSettlement, AgentExecutionSurface, AgentInboxLane, AgentInboxMessage,
    AgentMessageSource, AgentSessionEventPayload, AgentSessionStatus, AgentSessionStore,
    CreateAgentSessionRequest,
};

fn create_session(store: &AgentSessionStore, id: &str) {
    store
        .create(CreateAgentSessionRequest {
            session_id: id.into(),
            task_id: format!("task-{id}"),
            goal: "Inspect the workspace".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: None,
            permission_mode: None,
            execution_surface: AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
}

fn begin_turn(store: &AgentSessionStore, session: &str, turn: &str) {
    store
        .enqueue(
            session,
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                images: Vec::new(),
                message_id: format!("message-{turn}"),
                client_submission_id: None,
                content: "Inspect the workspace".into(),
                source: AgentMessageSource::user(),
                terminal_context: None,
            },
        )
        .unwrap();
    assert!(store
        .begin_turn_step(session, turn.into(), format!("step-{turn}"))
        .unwrap()
        .is_some());
    store
        .append(
            session,
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Running,
                reason: None,
            },
        )
        .unwrap();
}

fn current(adapter: &PetdexAdapter) -> PetdexState {
    adapter
        .inner
        .coordinator
        .lock()
        .unwrap()
        .arbiter
        .target(Instant::now())
        .state
}

#[test]
fn agent_committed_turns_survive_driver_wait_and_isolate_concurrent_sessions() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    store.configure(root.path().to_owned()).unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    store.attach_petdex(adapter.clone()).unwrap();
    for id in ["first", "second"] {
        create_session(&store, id);
        begin_turn(&store, id, id);
    }
    assert_eq!(current(&adapter), PetdexState::Idle, "AI is opt-in");
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    assert_eq!(current(&adapter), PetdexState::Running);
    let generation = store.begin_petdex_driver("first");
    store.settle_petdex_driver("first", generation, AgentDriverSettlement::Waiting);
    store.interrupt("second").unwrap();
    assert_eq!(
        current(&adapter),
        PetdexState::Running,
        "waiting driver did not drop the admitted turn"
    );
    store.interrupt("first").unwrap();
    assert_eq!(current(&adapter), PetdexState::Idle);
    begin_turn(&store, "first", "again");
    store.cancel("second").unwrap();
    assert_eq!(
        current(&adapter),
        PetdexState::Running,
        "old session termination did not end the new turn"
    );
    store
        .terminate("first", AgentSessionStatus::Failed, "final failure".into())
        .unwrap();
    assert_eq!(
        current(&adapter),
        PetdexState::Idle,
        "disabled integration never retains results"
    );
    assert_eq!(adapter.status().status, PetdexConnectionStatus::Disabled);
    assert!(adapter.inner.coordinator.lock().unwrap().sender.is_none());
}

#[test]
fn agent_success_is_published_once_and_reconstruction_does_not_replay_results() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    store.configure(root.path().to_owned()).unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    store.attach_petdex(adapter.clone()).unwrap();
    let (_receiver, _) = adapter.prepare_coordinator().unwrap();
    create_session(&store, "first");
    begin_turn(&store, "first", "turn");
    store
        .append(
            "first",
            Some("turn".into()),
            Some("step-turn".into()),
            AgentSessionEventPayload::StepEnd {
                reason: "completed".into(),
            },
        )
        .unwrap();
    assert!(store
        .end_turn_if_no_step_input("first", "turn", "completed")
        .unwrap());
    let deadline = adapter
        .inner
        .coordinator
        .lock()
        .unwrap()
        .arbiter
        .target(Instant::now())
        .expires_at;
    assert_eq!(current(&adapter), PetdexState::Jumping);
    store
        .terminate("first", AgentSessionStatus::Completed, "completed".into())
        .unwrap();
    assert_eq!(
        adapter
            .inner
            .coordinator
            .lock()
            .unwrap()
            .arbiter
            .target(Instant::now())
            .expires_at,
        deadline
    );
    adapter.set_categories(PetdexCategories::default());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    assert_eq!(current(&adapter), PetdexState::Idle);
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_owned()).unwrap();
    restored.attach_petdex(adapter.clone()).unwrap();
    assert_eq!(current(&adapter), PetdexState::Idle);
    adapter.stop_coordinator();
}

#[test]
fn category_change_cancels_old_transport_but_preserves_other_sources_and_preview() {
    let root = tempfile::tempdir().unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    let (_receiver, old) = adapter.prepare_coordinator().unwrap();
    let mut ssh = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Ssh,
        ActivityPhase::Connecting,
    );
    let mut ai = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Ai,
        ActivityPhase::Running,
    );
    ssh.transition(ActivityPhase::Failed);
    ai.transition(ActivityPhase::Failed);
    adapter
        .inner
        .coordinator
        .lock()
        .unwrap()
        .arbiter
        .start_preview(Instant::now());
    adapter.set_categories(PetdexCategories::default());
    assert!(old.is_cancelled());
    let (_receiver, _) = adapter.prepare_coordinator().unwrap();
    assert_eq!(
        current(&adapter),
        PetdexState::Failed,
        "SSH failure survives disabling AI"
    );
    adapter.set_categories(PetdexCategories {
        ssh: false,
        ..Default::default()
    });
    assert_eq!(
        current(&adapter),
        PetdexState::Waving,
        "preview is independent of category results"
    );
    adapter.stop_coordinator();
}

#[test]
fn new_driver_before_turn_start_does_not_inherit_a_historical_success_or_old_settlement() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    store.configure(root.path().to_owned()).unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    store.attach_petdex(adapter.clone()).unwrap();
    create_session(&store, "repeat");
    let old = store.begin_petdex_driver("repeat");
    begin_turn(&store, "repeat", "completed");
    store
        .append(
            "repeat",
            Some("completed".into()),
            Some("step-completed".into()),
            AgentSessionEventPayload::StepEnd {
                reason: "completed".into(),
            },
        )
        .unwrap();
    assert!(store
        .end_turn_if_no_step_input("repeat", "completed", "completed")
        .unwrap());
    store.settle_petdex_driver("repeat", old, AgentDriverSettlement::Idle);
    let new = store.begin_petdex_driver("repeat");
    store
        .append(
            "repeat",
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Running,
                reason: Some("preparing next turn".into()),
            },
        )
        .unwrap();
    assert_eq!(current(&adapter), PetdexState::Running);
    store.settle_petdex_driver("repeat", old, AgentDriverSettlement::Failed);
    assert_eq!(
        current(&adapter),
        PetdexState::Running,
        "a stale lease cannot clear the new driver"
    );
    begin_turn(&store, "repeat", "next");
    store.settle_petdex_driver("repeat", new, AgentDriverSettlement::Waiting);
    assert_eq!(current(&adapter), PetdexState::Running);
    store
        .terminate("repeat", AgentSessionStatus::Failed, "final failure".into())
        .unwrap();
    store.resume("repeat").unwrap();
    let retry = store.begin_petdex_driver("repeat");
    begin_turn(&store, "repeat", "retry");
    store.settle_petdex_driver("repeat", new, AgentDriverSettlement::Failed);
    assert_eq!(current(&adapter), PetdexState::Running);
    store.settle_petdex_driver("repeat", retry, AgentDriverSettlement::Cancelled);
    assert_eq!(current(&adapter), PetdexState::Idle);
}

#[test]
fn committed_approval_survives_driver_release_and_store_reconstruction() {
    use crate::agent_runtime::{AgentSessionEffect, AgentToolApprovalStatus, RecordedToolCall};
    let root = tempfile::tempdir().unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    let store = AgentSessionStore::default();
    store.configure(root.path().to_owned()).unwrap();
    store.attach_petdex(adapter.clone()).unwrap();
    create_session(&store, "approval");
    let driver = store.begin_petdex_driver("approval");
    begin_turn(&store, "approval", "turn");
    store
        .append(
            "approval",
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Waiting,
                reason: Some("waitingForNetwork".into()),
            },
        )
        .unwrap();
    assert_eq!(
        current(&adapter),
        PetdexState::Running,
        "network recovery is an internal wait"
    );
    store
        .append(
            "approval",
            Some("turn".into()),
            Some("step-turn".into()),
            AgentSessionEventPayload::ToolCall {
                call: RecordedToolCall {
                    call_id: "read".into(),
                    provider_call_id: None,
                    name: "read_file".into(),
                    native_name: None,
                    arguments: serde_json::json!({"path": root.path().join("agent-runtime")}),
                    title: None,
                    effect: Some(AgentSessionEffect::ReadOnly),
                    target: None,
                },
            },
        )
        .unwrap();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    store
        .append(
            "approval",
            Some("turn".into()),
            Some("step-turn".into()),
            AgentSessionEventPayload::ToolApproval {
                request_id: "request".into(),
                call_id: "read".into(),
                approval_id: Some("approval".into()),
                status: AgentToolApprovalStatus::Requested,
                risk: Some(AgentSessionEffect::ReadOnly),
                reason: None,
                expires_at_unix_ms: Some(expires),
                prompt: None,
            },
        )
        .unwrap();
    store.settle_petdex_driver("approval", driver, AgentDriverSettlement::Waiting);
    assert_eq!(current(&adapter), PetdexState::Waiting);
    drop(store);
    assert_eq!(current(&adapter), PetdexState::Idle);
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_owned()).unwrap();
    restored.attach_petdex(adapter.clone()).unwrap();
    assert_eq!(
        current(&adapter),
        PetdexState::Waiting,
        "only the current pending approval is restored"
    );
    restored
        .append(
            "approval",
            Some("turn".into()),
            Some("step-turn".into()),
            AgentSessionEventPayload::ToolApproval {
                request_id: "request".into(),
                call_id: "read".into(),
                approval_id: Some("approval".into()),
                status: AgentToolApprovalStatus::Rejected,
                risk: Some(AgentSessionEffect::ReadOnly),
                reason: None,
                expires_at_unix_ms: Some(expires),
                prompt: None,
            },
        )
        .unwrap();
    assert_eq!(
        current(&adapter),
        PetdexState::Running,
        "a rejected tool can continue the turn without final failure"
    );
    restored.interrupt("approval").unwrap();
    assert_eq!(current(&adapter), PetdexState::Idle);
}

#[tokio::test]
#[ignore = "uses the saved development model route and native keychain; makes real model requests"]
async fn configured_model_question_and_answer_follow_real_driver_lifecycle() {
    use crate::agent_runtime::{
        AgentRecoveryCheckpointKind, AgentRuntime, AgentSessionEventsRequest,
    };
    assert_eq!(std::env::var("SHELLSPAN_PETDEX_AI_E2E").as_deref(), Ok("1"));
    let home = std::env::var_os("HOME").expect("HOME is required");
    let source = PathBuf::from(home).join(".shellspan-dev/shellspan-v1.db");
    let connection =
        rusqlite::Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let routes: String = connection
        .query_row(
            "SELECT value FROM preferences WHERE key='llm.routes.v1'",
            [],
            |row| row.get(0),
        )
        .expect("saved model routes are required");
    // Isolate sessions and route migrations from the user's database. Only the
    // native keychain references in the saved route are reused; no secret is copied.
    let root = tempfile::tempdir().unwrap();
    let database = crate::db::Database::open(&root.path().join("routes.db")).unwrap();
    database
        .save_preferences(&[("llm.routes.v1".into(), routes)])
        .unwrap();
    let credentials = crate::keychain::CredentialManager::new();
    let routes = crate::llm::routes::RouteStore::open(database, credentials.clone()).unwrap();
    let snapshot = routes.snapshot().unwrap();
    let selection = snapshot
        .default_selection
        .as_ref()
        .expect("a default model selection is required");
    let provider = snapshot
        .route(&selection.route_id)
        .unwrap()
        .provider(selection)
        .unwrap();
    let runtime = AgentRuntime::default();
    runtime.configure(root.path().to_owned()).unwrap();
    runtime
        .configure_llm(crate::llm::runtime::LlmRuntime { routes })
        .unwrap();
    runtime.configure_credentials(credentials).unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    runtime.attach_petdex(adapter.clone()).unwrap();
    runtime
        .create_session(CreateAgentSessionRequest {
            session_id: "petdex-live-question".into(),
            task_id: "petdex-live-question".into(),
            goal: "Verify a user question and answer".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: Some(crate::agent_runtime::AgentSessionTarget {
                kind: "local".into(),
                target_id: "petdex-live-local".into(),
                session_id: "petdex-live-local".into(),
                label: None,
                profile_id: None,
                host: None,
                port: None,
                username: None,
                cwd: Some(root.path().to_string_lossy().into_owned()),
                root_path: Some(root.path().to_string_lossy().into_owned()),
                local_root: Some(root.path().to_string_lossy().into_owned()),
            }),
            permission_mode: Some(
                crate::agent_runtime::AgentSessionPermissionMode::RequestApproval,
            ),
            execution_surface: AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    runtime.followup("petdex-live-question", "question-check".into(),
        "This is a lifecycle integration check. Do not access files, terminals, or external tools. Call ask_user_question exactly once with one question whose id is confirm, asking 'Continue the integration check?' and two options labelled Yes and No. Wait for my answer. After I answer, reply only 'Confirmed' without further tool calls.".into()).unwrap();
    runtime
        .start("petdex-live-question", provider, None)
        .unwrap();
    let waited = tokio::time::timeout(
        Duration::from_secs(90),
        runtime.await_idle("petdex-live-question"),
    )
    .await;
    if !matches!(waited, Ok(Ok(()))) {
        runtime.cancel("petdex-live-question").await.unwrap();
        panic!("live model did not reach a settled boundary within 90 seconds");
    }
    let events = runtime
        .events(AgentSessionEventsRequest {
            session_id: "petdex-live-question".into(),
            cursor: None,
            limit: 256,
        })
        .unwrap();
    let failures: Vec<_> = events
        .events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::RequestFailure { failure, .. } => Some(failure.kind),
            _ => None,
        })
        .collect();
    let requests = events
        .events
        .iter()
        .filter(|event| {
            matches!(
                event.payload,
                AgentSessionEventPayload::RequestHeader { .. }
            )
        })
        .count();
    let terminal_reason = events.events.iter().find_map(|event| match &event.payload {
        AgentSessionEventPayload::SessionEnded { reason, .. } => reason.as_deref(),
        _ => None,
    });
    assert_eq!(
        runtime
            .session("petdex-live-question")
            .unwrap()
            .recovery
            .kind,
        AgentRecoveryCheckpointKind::WaitingQuestion,
        "real model requests={requests}, normalized failures={failures:?}, terminal reason={terminal_reason:?}"
    );
    assert_eq!(current(&adapter), PetdexState::Waiting);
    let identity = events
        .events
        .iter()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::QuestionRequested { identity, .. } => Some(identity.clone()),
            _ => None,
        })
        .expect("real model did not request a question");
    runtime
        .answer_question(
            serde_json::from_value(serde_json::json!({
                "identity": identity, "clientOperationId": "answer-check",
                "answers": [{"id": "confirm", "selected": ["Yes"]}]
            }))
            .unwrap(),
            None,
        )
        .unwrap();
    let waited = tokio::time::timeout(
        Duration::from_secs(90),
        runtime.await_idle("petdex-live-question"),
    )
    .await;
    if !matches!(waited, Ok(Ok(()))) {
        runtime.cancel("petdex-live-question").await.unwrap();
        panic!("live answer continuation did not settle within 90 seconds");
    }
    assert_eq!(
        runtime.session("petdex-live-question").unwrap().status,
        AgentSessionStatus::Idle
    );
    assert_eq!(current(&adapter), PetdexState::Idle);
}

#[test]
fn incomplete_turn_is_not_a_final_failure_and_explicit_failure_is_reported_once() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    store.configure(root.path().to_owned()).unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    store.attach_petdex(adapter.clone()).unwrap();
    let (_receiver, _) = adapter.prepare_coordinator().unwrap();
    create_session(&store, "incomplete");
    begin_turn(&store, "incomplete", "limited");
    store
        .append(
            "incomplete",
            Some("limited".into()),
            Some("step-limited".into()),
            AgentSessionEventPayload::StepEnd {
                reason: "incomplete".into(),
            },
        )
        .unwrap();
    store
        .end_turn_if_no_step_input("incomplete", "limited", "incomplete")
        .unwrap();
    assert_eq!(current(&adapter), PetdexState::Running);
    store
        .append(
            "incomplete",
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Idle,
                reason: None,
            },
        )
        .unwrap();
    assert_eq!(current(&adapter), PetdexState::Idle);
    begin_turn(&store, "incomplete", "continued");
    store
        .terminate(
            "incomplete",
            AgentSessionStatus::Failed,
            "final failure".into(),
        )
        .unwrap();
    assert_eq!(current(&adapter), PetdexState::Failed);
    let deadline = adapter
        .inner
        .coordinator
        .lock()
        .unwrap()
        .arbiter
        .target(Instant::now())
        .expires_at;
    store
        .terminate(
            "incomplete",
            AgentSessionStatus::Failed,
            "final failure".into(),
        )
        .unwrap();
    assert_eq!(
        adapter
            .inner
            .coordinator
            .lock()
            .unwrap()
            .arbiter
            .target(Instant::now())
            .expires_at,
        deadline
    );
    adapter.stop_coordinator();
}
