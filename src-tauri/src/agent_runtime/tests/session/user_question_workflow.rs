#[test]
fn user_operation_journal_keeps_the_execution_barrier_across_restart() {
    use crate::agent_runtime::user_questions::{
        self, AnswerQuestionInput, QuestionAnswer, QuestionArguments, QuestionIdentity,
        UserActionResponse,
    };
    use sha2::{Digest, Sha256};
    let (root, store) = configured();
    create(&store);
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
    append(
        &store,
        AgentSessionEventPayload::QuestionAnswered {
            fingerprint: fingerprint(&selection),
            submission: selection.clone(),
        },
    )
    .unwrap();
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
        submission: completed,
    };
    append(&restored, payload.clone()).unwrap();
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
