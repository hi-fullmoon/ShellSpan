#[test]
fn user_operation_journal_keeps_the_execution_barrier_across_restart() {
    use crate::agent_runtime::user_questions::{
        self, AnswerQuestionInput, QuestionAnswer, QuestionArguments, QuestionIdentity,
        UserActionResponse,
    };
    use crate::agent_runtime::{
        AgentLifecyclePhase, AgentRegistry, AgentToolPipeline, NativeToolEngine,
        NativeToolRuntimeSlot,
    };
    use crate::llm::{adapter::ModelAdapterFactory, registry::HttpModelAdapterFactory};
    use crate::models::{
        ManagedSession, SessionCommandSender, SessionIdentity, SessionManager, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crate::terminal_broker::{TerminalGeometry, TerminalSessionBroker, TerminalTransportKind};
    use sha2::{Digest, Sha256};
    use std::sync::mpsc::{sync_channel, RecvTimeoutError};
    use std::time::Duration;
    let (root, store) = configured();
    const TERMINAL_ID: &str = "bound-local-terminal";
    store
        .create(
            serde_json::from_value(serde_json::json!({
                "sessionId": "session-1",
                "taskId": "task-1",
                "goal": "Verify the local terminal after a manual operation",
                "executionSurface": "boundTerminal",
                "target": {"kind": "local", "targetId": TERMINAL_ID, "sessionId": TERMINAL_ID}
            }))
            .unwrap(),
        )
        .unwrap();
    let snapshot = begin_prepared_request(&store);
    let args = serde_json::json!({"questions":[{
        "id":"access", "question":"Choose access method", "decision_key":"service-access",
        "decision_context":"current account", "options":[{
            "label":"Configure manually", "user_action":{
                "instructions":"Finish the access configuration outside the Agent, then confirm.",
                "verification_command":"test -r /etc/hosts"
            }
        },{"label":"Use an existing connection"}]
    }]});
    let model_call = crate::llm::types::ModelToolCall {
        call_id: "access-call".into(),
        provider_call_id: Some("access-call".into()),
        name: "ask_user_question".into(),
        arguments: args.clone(),
    };
    let model_content = vec![crate::llm::types::ModelContentBlock::ToolCall {
        call: model_call.clone(),
    }];
    let envelope = crate::llm::replay::prepare_envelope(
        crate::llm::registry::replay_codec("chat-completions").unwrap(),
        "request-1",
        &snapshot,
        &model_content,
        crate::llm::types::AdapterReplayCapture {
            response: serde_json::json!({}),
            blocks: vec![serde_json::json!({"providerCallId":"access-call"})],
        },
    )
    .unwrap();
    let append = |store: &AgentSessionStore, payload| {
        store.append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            payload,
        )
    };
    let call = crate::agent_runtime::recorded_tool_call(model_call);
    append(
        &store,
        AgentSessionEventPayload::AssistantMessage {
            message_id: "decision-message".into(),
            content: vec![AgentAssistantContentBlock::ToolCall {
                call: Box::new(call.clone()),
            }],
            usage: Default::default(),
            stop_reason: crate::agent_runtime::AgentStopReason::ToolCalls,
            interrupted: false,
            replay: Some(crate::agent_runtime::AgentStoredReplay::inline(envelope)),
        },
    )
    .unwrap();
    append(&store, AgentSessionEventPayload::ToolCall { call }).unwrap();
    let identity = QuestionIdentity {
        session_id: "session-1".into(),
        turn_id: "turn-1".into(),
        step_id: "step-1".into(),
        request_id: "request-1".into(),
        call_id: "access-call".into(),
        question_request_id: "access-question".into(),
    };
    append(
        &store,
        AgentSessionEventPayload::QuestionRequested {
            identity: identity.clone(),
            arguments: QuestionArguments::parse(args).unwrap(),
            provider: crate::agent_runtime::AgentSubagentModel {
                route_id: "route-a".into(),
                model_id: "model-a".into(),
                reasoning_effort: None,
                route_revision: None,
            },
        },
    )
    .unwrap();
    let selection = AnswerQuestionInput {
        identity: identity.clone(),
        client_operation_id: "select-access".into(),
        action: None,
        answers: vec![QuestionAnswer {
            id: "access".into(),
            selected: vec!["Configure manually".into()],
            custom: None,
        }],
    };
    let fingerprint = |input: &AnswerQuestionInput| {
        hex::encode(Sha256::digest(serde_json::to_vec(input).unwrap()))
    };
    let pipeline = |store: &AgentSessionStore, engine: Arc<NativeToolEngine>| {
        AgentToolPipeline::new(
            AgentRegistry::default(),
            store.clone(),
            Default::default(),
            Arc::new(NativeToolRuntimeSlot::default()),
            Default::default(),
            Default::default(),
            engine,
        )
    };
    let attach = |pipeline: &AgentToolPipeline| {
        let provider: crate::ai::AiProviderConfig = serde_json::from_value(serde_json::json!({
            "profile": "ollama", "id": "ollama", "kind": "ollama",
            "baseUrl": "http://127.0.0.1:11434", "model": "qwen3", "requiresApiKey": false,
        }))
        .unwrap();
        let adapter = HttpModelAdapterFactory
            .create(provider.clone(), None)
            .unwrap();
        pipeline
            .agents
            .attach(
                pipeline.sessions.clone(),
                "session-1".into(),
                provider,
                adapter,
            )
            .unwrap()
    };
    let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 64);
    broker
        .attach_transport(
            TERMINAL_ID,
            None,
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(80, 24),
        )
        .unwrap();
    let live_terminals = SessionManager::default();
    let (sender, _input) = crossbeam_channel::unbounded();
    live_terminals
        .insert(
            TERMINAL_ID.into(),
            ManagedSession {
                sender: SessionCommandSender::Event(sender),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: TERMINAL_ID.into(),
                    status: SessionStatus::Connected,
                    message: None,
                },
                output_ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                output_paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                terminal_kind: SessionTerminalKind::Local,
                identity: SessionIdentity {
                    title: "Local".into(),
                    host: "local".into(),
                    port: 0,
                    username: "tester".into(),
                },
            },
        )
        .unwrap();
    let engine = Arc::new(NativeToolEngine::with_terminal_broker(broker.clone()));
    let initial = pipeline(&store, engine.clone());
    let handle = attach(&initial);
    let leases = &engine.terminal_leases;
    leases.begin_turn(TERMINAL_ID, "session-1").unwrap();
    let command = leases
        .acquire(TERMINAL_ID, "session-1", "task-1", "operation-1", None)
        .unwrap();
    assert_eq!(
        initial
            .submit_question_answer(&handle.entry(), selection.clone())
            .unwrap_err(),
        crate::agent_runtime::TERMINAL_MANUAL_HANDOFF_BUSY
    );
    assert!(
        user_questions::records(&store.all_events("session-1").unwrap())
            .last()
            .unwrap()
            .answer
            .is_none()
    );
    leases
        .release(
            TERMINAL_ID,
            "session-1",
            "task-1",
            &command.operation_id,
            crate::agent_runtime::TerminalLeaseReleaseReason::Completed,
        )
        .unwrap();
    initial
        .submit_question_answer(&handle.entry(), selection.clone())
        .unwrap();
    assert_eq!(
        leases.turn_owner(TERMINAL_ID).unwrap().as_deref(),
        Some("session-1")
    );
    assert!(leases.begin_turn(TERMINAL_ID, "session-1").is_err());
    assert_eq!(
        store.snapshot("session-1").unwrap().recovery.kind,
        crate::agent_runtime::AgentRecoveryCheckpointKind::WaitingQuestion
    );
    let record = user_questions::records(&store.all_events("session-1").unwrap())
        .pop()
        .unwrap();
    assert!(
        append(&store, user_questions::result(&record)).is_err(),
        "selection alone must not settle the tool"
    );
    // Export only the actual production-store ledger for visual verification.
    if let Ok(destination) = std::env::var("SHELLSPAN_USER_ACTION_LEDGER_OUT") {
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, &std::fs::read(log_path(&root))?)
            })
            .unwrap();
    }
    drop(handle);
    drop(initial);
    drop(store);
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restored.snapshot("session-1").unwrap().recovery.kind,
        crate::agent_runtime::AgentRecoveryCheckpointKind::WaitingQuestion
    );
    let completed = AnswerQuestionInput {
        action: Some(UserActionResponse::Completed),
        client_operation_id: "complete-access".into(),
        ..selection
    };
    let payload = AgentSessionEventPayload::QuestionActionAnswered {
        fingerprint: fingerprint(&completed),
        submission: completed.clone(),
    };
    let engine = Arc::new(NativeToolEngine::with_terminal_broker(broker));
    let restored_pipeline = pipeline(&restored, engine.clone());
    let handle = attach(&restored_pipeline);
    let entry = handle.entry();
    restored_pipeline.restore_question_phase(&entry).unwrap();
    let live = restored_pipeline
        .terminal_manual_handoffs(&live_terminals)
        .unwrap();
    let [waiting] = live.as_slice() else {
        panic!("expected one attached manual handoff")
    };
    assert_eq!(waiting.handoff.turn_id, identity.turn_id);
    assert_eq!(waiting.handoff.task_id, "task-1");
    assert_eq!(waiting.terminal.session_id, TERMINAL_ID);

    // Hold the actual answer publisher while the restore path is entered on
    // another thread. Its projection must wait for the answer transaction.
    let (publish_started, publishing) = sync_channel(0);
    let (release_publish, publish_release) = sync_channel(0);
    let publish_release = Mutex::new(publish_release);
    restored
        .set_publisher(Arc::new(move |event| {
            if matches!(
                event.payload,
                AgentSessionEventPayload::QuestionActionAnswered { .. }
            ) {
                publish_started.send(()).unwrap();
                publish_release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
        }))
        .unwrap();
    std::thread::scope(|scope| {
        let submission =
            scope.spawn(|| restored_pipeline.submit_question_answer(&entry, completed));
        publishing.recv_timeout(Duration::from_secs(5)).unwrap();
        let (start_restore, restore_started) = sync_channel(0);
        let (finish_restore, restored_result) = sync_channel(1);
        let pipeline = &restored_pipeline;
        let restored_entry = &entry;
        let recovery = scope.spawn(move || {
            start_restore.send(()).unwrap();
            finish_restore
                .send(pipeline.restore_question_phase(restored_entry))
                .unwrap();
        });
        restore_started
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        let early_result = restored_result.recv_timeout(Duration::from_millis(150));
        release_publish.send(()).unwrap();
        submission.join().unwrap().unwrap();
        recovery.join().unwrap();
        assert_eq!(early_result, Err(RecvTimeoutError::Timeout));
        restored_result
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
    });
    assert_eq!(entry.phase().unwrap(), AgentLifecyclePhase::Running);
    assert!(restored_pipeline
        .terminal_manual_handoffs(&live_terminals)
        .unwrap()
        .is_empty());
    engine
        .terminal_leases
        .begin_turn(TERMINAL_ID, "session-1")
        .unwrap();
    if let Ok(destination) = std::env::var("SHELLSPAN_TERMINAL_HANDOFF_TEST_OUT") {
        let resumed = restored.all_events("session-1").unwrap().pop().unwrap();
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .unwrap();
        serde_json::to_writer_pretty(
            &mut file,
            &serde_json::json!({"live": live, "resumed": resumed}),
        )
        .unwrap();
    }
    assert!(
        append(&restored, payload).is_err(),
        "duplicate completion cannot commit twice"
    );
    let record = user_questions::records(&restored.all_events("session-1").unwrap())
        .pop()
        .unwrap();
    append(&restored, user_questions::result(&record)).unwrap();
    assert_eq!(
        restored.snapshot("session-1").unwrap().recovery.kind,
        crate::agent_runtime::AgentRecoveryCheckpointKind::QuestionContinuation
    );
}
