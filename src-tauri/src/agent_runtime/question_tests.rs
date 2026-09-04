use super::*;
use crate::agent_runtime::user_questions::{self, AnswerQuestionInput, QuestionAnswer};

fn provider() -> AiProviderConfig {
    AiProviderConfig {
        reasoning_effort: None,
        ..super::provider()
    }
}

fn question_call(id: &str) -> ModelToolCall {
    ModelToolCall {
        call_id: id.into(),
        provider_call_id: Some(format!("provider-{id}")),
        name: "ask_user_question".into(),
        arguments: json!({"questions":[{"id":"choice","question":"Which approach?","options":[{"label":"A (Recommended)"},{"label":"B"}]}]}),
    }
}

fn answer(runtime: &AgentRuntime, session: &str) -> AnswerQuestionInput {
    let record = user_questions::records(&all_events(runtime, session))
        .into_iter()
        .rev()
        .find(|r| r.answer.is_none())
        .unwrap();
    AnswerQuestionInput {
        identity: record.identity,
        client_operation_id: "operation-1".into(),
        answers: vec![QuestionAnswer {
            id: "choice".into(),
            selected: vec!["B".into()],
            custom: None,
        }],
    }
}

async fn idle(runtime: &AgentRuntime, session: &str) {
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.await_idle(session),
    )
    .await
    .expect("driver stuck")
    .unwrap();
}

#[tokio::test]
async fn question_single_answer_entry_reattaches_original_turn_and_next_request() {
    let initial = FakeAdapter::new(vec![tool_response(vec![question_call("question-1")])]);
    let (root, runtime) = configured(initial.clone());
    create(&runtime, "questions");
    runtime
        .followup("questions", "user-1".into(), "inspect".into())
        .unwrap();
    runtime.start("questions", provider(), None).unwrap();
    idle(&runtime, "questions").await;
    let input = answer(&runtime, "questions");
    drop(runtime);
    let model = FakeAdapter::new(vec![reply("Choice accepted", &[])]);
    let restored = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(model.clone())))
        .build();
    restored.configure(root.path().to_path_buf()).unwrap();
    restored.answer_question(input.clone(), None).unwrap();
    idle(&restored, "questions").await;
    restored.answer_question(input.clone(), None).unwrap();
    idle(&restored, "questions").await;
    let events = all_events(&restored, "questions");
    assert_eq!(model.request_count(), 1);
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e.payload, AgentSessionEventPayload::TurnStart))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.step_id.as_ref() == Some(&input.identity.step_id)
                && matches!(e.payload, AgentSessionEventPayload::StepEnd { .. }))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e.payload, AgentSessionEventPayload::QuestionAnswered { .. }))
            .count(),
        1
    );
    let request = serde_json::to_string(&model.requests.lock().unwrap()[0].messages).unwrap();
    assert!(request.contains("provider-question-1"));
    assert!(request.contains("answers"));
    assert!(request.contains("B"));
}

#[tokio::test]
async fn question_read_question_write_question_keeps_barriers_and_approval() {
    let native = RecordingNativeRuntime::new(true);
    let model = FakeAdapter::new(vec![
        tool_response(vec![
            native_call("read", "list_directory"),
            question_call("q1"),
            native_call("write", "apply_patch"),
            question_call("q2"),
        ]),
        reply("Done", &[]),
    ]);
    let (_root, runtime) =
        configured_with_native(model.clone(), AgentDriverConfig::default(), native.clone());
    create(&runtime, "chain");
    runtime
        .followup("chain", "user".into(), "inspect".into())
        .unwrap();
    runtime.start("chain", provider(), None).unwrap();
    idle(&runtime, "chain").await;
    runtime
        .approve_tool(pending_approval(&runtime, "chain"))
        .await
        .unwrap();
    idle(&runtime, "chain").await;
    assert_eq!(native.executions.load(Ordering::Acquire), 1);
    runtime
        .answer_question(answer(&runtime, "chain"), None)
        .unwrap();
    idle(&runtime, "chain").await;
    assert_eq!(
        native.executions.load(Ordering::Acquire),
        1,
        "answer must not approve write"
    );
    let approval = pending_approval(&runtime, "chain");
    assert_eq!(approval.call_id, "write");
    runtime.approve_tool(approval).await.unwrap();
    idle(&runtime, "chain").await;
    let mut second = answer(&runtime, "chain");
    assert!(
        runtime.answer_question(second.clone(), None).is_err(),
        "operation ids cannot be reused on another question"
    );
    second.client_operation_id = "operation-2".into();
    runtime.answer_question(second, None).unwrap();
    idle(&runtime, "chain").await;
    assert_eq!(native.executions.load(Ordering::Acquire), 2);
    assert_eq!(model.request_count(), 2);
    let results: Vec<_> = all_events(&runtime, "chain")
        .into_iter()
        .filter_map(|e| match e.payload {
            AgentSessionEventPayload::ToolResult { call_id, .. } => Some(call_id),
            _ => None,
        })
        .collect();
    assert_eq!(results, ["read", "q1", "write", "q2"]);
}

/// Materialize *every* complete JSONL prefix across the question transaction,
/// not just snapshots produced after append_batch returned.
#[tokio::test]
async fn question_every_jsonl_prefix_repairs_answer_result_and_step_once() {
    let model = FakeAdapter::new(vec![
        tool_response(vec![question_call("q")]),
        reply("Done", &[]),
    ]);
    let (_root, runtime) = configured(model);
    create(&runtime, "prefix");
    runtime
        .followup("prefix", "user".into(), "inspect".into())
        .unwrap();
    runtime.start("prefix", provider(), None).unwrap();
    idle(&runtime, "prefix").await;
    let input = answer(&runtime, "prefix");
    runtime.answer_question(input.clone(), None).unwrap();
    idle(&runtime, "prefix").await;
    let events = all_events(&runtime, "prefix");
    let first = events
        .iter()
        .position(|e| matches!(e.payload, AgentSessionEventPayload::ToolCall { .. }))
        .unwrap();
    let last = events.iter().position(|e| matches!(&e.payload, AgentSessionEventPayload::StepEnd { reason } if reason == "toolsCompleted")).unwrap();
    for end in first..=last {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("agent-runtime/sessions-v4");
        std::fs::create_dir_all(&dir).unwrap();
        let lines: String = events[..=end]
            .iter()
            .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
            .collect();
        std::fs::write(dir.join("prefix.jsonl"), lines).unwrap();
        let model = FakeAdapter::new(vec![reply("Recovered", &[])]);
        let restored = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(model.clone())))
            .build();
        restored.configure(root.path().to_path_buf()).unwrap();
        if end == first {
            restored.start("prefix", provider(), None).unwrap();
            idle(&restored, "prefix").await;
            restored
                .answer_question(answer(&restored, "prefix"), None)
                .unwrap();
        } else {
            restored
                .answer_question(input.clone(), None)
                .unwrap_or_else(|e| panic!("prefix {end}: {e}"));
        }
        idle(&restored, "prefix").await;
        assert_eq!(model.request_count(), 1, "prefix {end}");
        let recovered = all_events(&restored, "prefix");
        for count in [
            recovered.iter().filter(|e| matches!(e.payload, AgentSessionEventPayload::QuestionRequested { .. })).count(),
            recovered.iter().filter(|e| matches!(e.payload, AgentSessionEventPayload::QuestionAnswered { .. })).count(),
            recovered.iter().filter(|e| matches!(e.payload, AgentSessionEventPayload::ToolResult { .. })).count(),
            recovered.iter().filter(|e| matches!(&e.payload, AgentSessionEventPayload::StepEnd { reason } if reason == "toolsCompleted")).count(),
        ] { assert_eq!(count, 1, "prefix {end}"); }
    }
}

#[tokio::test]
async fn question_chain_every_prefix_preserves_unexecuted_queue_and_never_replays_dispatch() {
    let native = RecordingNativeRuntime::new(true);
    let model = FakeAdapter::new(vec![
        tool_response(vec![
            native_call("read", "list_directory"),
            question_call("q1"),
            native_call("write", "apply_patch"),
            question_call("q2"),
        ]),
        reply("Done", &[]),
    ]);
    let (_root, runtime) = configured_with_native(model, AgentDriverConfig::default(), native);
    create(&runtime, "prefix-chain");
    runtime
        .followup("prefix-chain", "user".into(), "inspect".into())
        .unwrap();
    runtime.start("prefix-chain", provider(), None).unwrap();
    idle(&runtime, "prefix-chain").await;
    runtime
        .approve_tool(pending_approval(&runtime, "prefix-chain"))
        .await
        .unwrap();
    let first_answer = answer(&runtime, "prefix-chain");
    runtime.answer_question(first_answer.clone(), None).unwrap();
    idle(&runtime, "prefix-chain").await;
    runtime
        .approve_tool(pending_approval(&runtime, "prefix-chain"))
        .await
        .unwrap();
    let mut second_answer = answer(&runtime, "prefix-chain");
    second_answer.client_operation_id = "operation-2".into();
    runtime.answer_question(second_answer, None).unwrap();
    idle(&runtime, "prefix-chain").await;
    let events = all_events(&runtime, "prefix-chain");
    let first = events.iter().position(|e| matches!(&e.payload, AgentSessionEventPayload::ToolCall { call } if call.name == "ask_user_question")).unwrap();
    let last = events.iter().position(|e| matches!(&e.payload, AgentSessionEventPayload::StepEnd { reason } if reason == "toolsCompleted")).unwrap();
    for end in first..=last {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("agent-runtime/sessions-v4");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("prefix-chain.jsonl"),
            events[..=end]
                .iter()
                .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
                .collect::<String>(),
        )
        .unwrap();
        let native = RecordingNativeRuntime::new(true);
        let model = FakeAdapter::new(vec![reply("Recovered", &[])]);
        let restored = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(model.clone())))
            .native_tool_runtime(native.clone())
            .build();
        restored.configure(root.path().to_path_buf()).unwrap();
        restored
            .start("prefix-chain", provider(), None)
            .unwrap_or_else(|e| panic!("prefix {end}: {e}"));
        for _ in 0..8 {
            idle(&restored, "prefix-chain").await;
            let recovered = all_events(&restored, "prefix-chain");
            if model.request_count() == 1 {
                break;
            }
            match restored.inspect_recovery("prefix-chain").unwrap().kind {
                crate::agent_runtime::AgentRecoveryCheckpointKind::ExecutionInFlight => {
                    assert_eq!(native.executions.load(Ordering::Acquire), 0);
                    assert_eq!(model.request_count(), 0);
                    break; // uncertain dispatch requires operator reconciliation, never replay
                }
                crate::agent_runtime::AgentRecoveryCheckpointKind::AuthorizedBeforeExecute => {
                    restored.resume_recovery("prefix-chain").await.unwrap();
                }
                crate::agent_runtime::AgentRecoveryCheckpointKind::WaitingApproval => {
                    restored
                        .approve_tool(pending_approval(&restored, "prefix-chain"))
                        .await
                        .unwrap();
                }
                _ => {
                    let Some(record) = user_questions::records(&recovered)
                        .into_iter()
                        .find(|r| r.answer.is_none())
                    else {
                        panic!(
                            "prefix {end}: stuck {:?}",
                            restored.inspect_recovery("prefix-chain")
                        );
                    };
                    let input = AnswerQuestionInput {
                        identity: record.identity.clone(),
                        client_operation_id: format!("recovered-{}", record.identity.call_id),
                        answers: first_answer.answers.clone(),
                    };
                    restored.answer_question(input, None).unwrap();
                }
            }
        }
        let recovered = all_events(&restored, "prefix-chain");
        let uncertain = restored.inspect_recovery("prefix-chain").unwrap().kind
            == crate::agent_runtime::AgentRecoveryCheckpointKind::ExecutionInFlight;
        if !uncertain {
            assert_eq!(model.request_count(), 1, "prefix {end}");
            let results: Vec<_> = recovered
                .iter()
                .filter_map(|e| match &e.payload {
                    AgentSessionEventPayload::ToolResult { call_id, .. } => Some(call_id.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(results, ["read", "q1", "write", "q2"], "prefix {end}");
            let already_written = events[..=end].iter().any(|e| matches!(&e.payload, AgentSessionEventPayload::ToolResult { call_id, .. } if call_id == "write"));
            assert_eq!(
                native.executions.load(Ordering::Acquire),
                usize::from(!already_written),
                "prefix {end}"
            );
        }
    }
}

#[tokio::test]
async fn question_answer_cancel_and_driver_lease_races_have_one_commit_order() {
    for order in ["answer", "cancel-first", "answer-then-cancel"] {
        let model = FakeAdapter::new(vec![
            tool_response(vec![
                question_call("q"),
                native_call("write", "apply_patch"),
            ]),
            reply("Done", &[]),
        ]);
        let native = RecordingNativeRuntime::new(false);
        let (_root, runtime) =
            configured_with_native(model.clone(), AgentDriverConfig::default(), native.clone());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        *runtime.tools.question_lease_pause.lock().unwrap() =
            Some((entered.clone(), release.clone()));
        create(&runtime, "race");
        runtime
            .followup("race", "user".into(), "inspect".into())
            .unwrap();
        runtime.start("race", provider(), None).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        let input = answer(&runtime, "race");
        let entry = runtime.agents.get("race").unwrap().unwrap();
        assert!(entry.is_driver_active());
        if order == "cancel-first" {
            runtime.tools.cancel_session(&entry).unwrap();
        }
        let accepted = runtime.answer_question(input.clone(), None);
        assert_eq!(accepted.is_ok(), order != "cancel-first");
        if order == "answer-then-cancel" {
            runtime.tools.cancel_session(&entry).unwrap();
        }
        release.notify_one();
        idle(&runtime, "race").await;
        let events = all_events(&runtime, "race");
        assert_eq!(events.iter().filter(|e| matches!(&e.payload, AgentSessionEventPayload::ToolResult { call_id, .. } if call_id == "q")).count(), 1);
        assert_eq!(
            native.executions.load(Ordering::Acquire),
            usize::from(order == "answer")
        );
        assert_eq!(model.request_count(), if order == "answer" { 2 } else { 1 });
        if order != "answer" {
            assert!(runtime.answer_question(input, None).is_err());
        }
    }
}

#[tokio::test]
async fn question_sensitive_answer_retry_uses_raw_fingerprint_not_redacted_content() {
    let model = FakeAdapter::new(vec![
        tool_response(vec![question_call("q")]),
        reply("Done", &[]),
    ]);
    let (root, runtime) = configured(model.clone());
    create(&runtime, "secret-answer");
    runtime
        .followup("secret-answer", "user".into(), "inspect".into())
        .unwrap();
    runtime.start("secret-answer", provider(), None).unwrap();
    idle(&runtime, "secret-answer").await;
    let mut input = answer(&runtime, "secret-answer");
    input.answers[0].custom = Some("password=first-private-answer".into());
    runtime.answer_question(input.clone(), None).unwrap();
    idle(&runtime, "secret-answer").await;
    runtime.answer_question(input.clone(), None).unwrap();
    let mut changed = input.clone();
    changed.answers[0].custom = Some("password=second-private-answer".into());
    assert!(runtime.answer_question(changed, None).is_err());
    let logged = std::fs::read_to_string(
        root.path()
            .join("agent-runtime/sessions-v4/secret-answer.jsonl"),
    )
    .unwrap();
    assert!(!logged.contains("first-private-answer"));
    assert!(!logged.contains("second-private-answer"));
    assert!(logged.contains("[REDACTED]"));
    let record = user_questions::records(&all_events(&runtime, "secret-answer"))
        .pop()
        .unwrap();
    assert!(record.answer.unwrap().answers[0].selected.is_empty());
    drop(runtime);
    let restored = AgentRuntimeBuilder::new().build();
    restored.configure(root.path().to_path_buf()).unwrap();
    restored.answer_question(input, None).unwrap();
    assert_eq!(model.request_count(), 2);
}

#[tokio::test]
async fn question_real_http_resume_uses_current_credentials_and_original_tool_history() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut bodies = Vec::<serde_json::Value>::new();
        for attempt in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 8192];
            let (end, length) = loop {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes
                    .windows(4)
                    .position(|p| p == b"\r\n\r\n")
                    .map(|i| i + 4)
                {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    assert!(headers.contains(if attempt == 0 {
                        "authorization: bearer initial-fixture-key"
                    } else {
                        "authorization: bearer rotated-fixture-key"
                    }));
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    break (end, length);
                }
            };
            while bytes.len() < end + length {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
            }
            bodies.push(serde_json::from_slice(&bytes[end..end + length]).unwrap());
            let delta = if attempt == 0 {
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"wire-question","type":"function","function":{"name":"ask_user_question","arguments":question_call("q").arguments.to_string()}}]},"finish_reason":"tool_calls"}]})
            } else {
                json!({"choices":[{"delta":{"content":"Wire answer accepted"},"finish_reason":"stop"}]})
            };
            let body = format!("data: {delta}\n\ndata: [DONE]\n\n");
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        bodies
    });
    let root = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    create(&runtime, "wire");
    runtime
        .followup("wire", "user".into(), "inspect".into())
        .unwrap();
    let provider = AiProviderConfig {
        id: "question-http-fixture".into(),
        kind: AiProviderKind::OpenAiCompatible,
        base_url: url,
        model: "test-model".into(),
        requires_api_key: true,
        ..provider()
    };
    runtime
        .start("wire", provider.clone(), Some("initial-fixture-key".into()))
        .unwrap();
    idle(&runtime, "wire").await;
    let input = answer(&runtime, "wire");
    drop(runtime);
    let credentials = crate::keychain::CredentialManager::in_memory_for_tests();
    credentials
        .set_credential(
            crate::keychain::AI_KEY_SERVICE,
            &provider.id,
            "rotated-fixture-key",
        )
        .unwrap();
    let restored = AgentRuntimeBuilder::new().build();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert!(restored.answer_question(input.clone(), None).is_err());
    restored
        .answer_question(input.clone(), Some(&credentials))
        .unwrap();
    idle(&restored, "wire").await;
    let bodies = tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert!(bodies[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["function"]["name"] == "ask_user_question"));
    let messages = bodies[1]["messages"].as_array().unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["role"] == "user" && m["content"] == "inspect")
            .count(),
        1
    );
    let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
    assert_eq!(result["tool_call_id"], "wire-question");
    assert!(result["content"].as_str().unwrap().contains("answers"));
    let events = all_events(&restored, "wire");
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e.payload, AgentSessionEventPayload::TurnStart))
            .count(),
        1
    );
    assert!(events
        .iter()
        .filter(|e| matches!(e.payload, AgentSessionEventPayload::RequestHeader { .. }))
        .all(|e| e.turn_id.as_ref() == Some(&input.identity.turn_id)));
    let log =
        std::fs::read_to_string(root.path().join("agent-runtime/sessions-v4/wire.jsonl")).unwrap();
    assert!(!log.contains("fixture-key"));
}

#[test]
fn question_schema_and_answer_byte_limits_are_strict() {
    use user_questions::QuestionArguments;
    let valid = question_call("q").arguments;
    for count in [0, 4] {
        let mut value = valid.clone();
        value["questions"] = json!(vec![valid["questions"][0].clone(); count]);
        assert!(QuestionArguments::parse(value).is_err());
    }
    for count in [1, 8] {
        let mut value = valid.clone();
        value["questions"][0]["options"] = json!((0..count)
            .map(|i| json!({"label":i.to_string()}))
            .collect::<Vec<_>>());
        assert!(QuestionArguments::parse(value).is_err());
    }
    for (field, value) in [
        ("unknown", json!(true)),
        ("id", json!(" ")),
        ("question", json!("中".repeat(683))),
        ("header", json!("中".repeat(43))),
        ("options", json!([{"label":"A"},{"label":"A"}])),
    ] {
        let mut args = valid.clone();
        args["questions"][0][field] = value;
        assert!(QuestionArguments::parse(args).is_err(), "{field}");
    }
    assert!(
        QuestionArguments::parse(json!({"questions":[{"id":"text","question":"Text?"}]})).is_ok()
    );
    assert!(QuestionArguments::parse(json!({"questions":[{"id":"a","question":"A?"},{"id":"b","question":"B?"},{"id":"c","question":"C?"}]})).is_ok());
    assert!(QuestionArguments::parse(
        json!({"questions":[{"id":"a","question":"A?"},{"id":"a","question":"B?"}]})
    )
    .is_err());
    let args = QuestionArguments::parse(valid.clone()).unwrap();
    let mut answer = QuestionAnswer {
        id: "choice".into(),
        selected: vec![],
        custom: None,
    };
    for custom in [None, Some(" ".into()), Some("中".repeat(2731))] {
        answer.custom = custom;
        assert!(args.normalize_answers(&[answer.clone()]).is_err());
    }
    answer.custom = Some("custom".into());
    answer.selected = vec!["B".into()];
    assert!(args.normalize_answers(&[answer.clone()]).unwrap()[0]
        .selected
        .is_empty());
    let mut multi = valid;
    multi["questions"][0]["multi_select"] = json!(true);
    assert_eq!(
        QuestionArguments::parse(multi)
            .unwrap()
            .normalize_answers(&[answer.clone()])
            .unwrap()[0]
            .selected,
        ["B"]
    );
    answer.selected = vec!["not-an-option".into()];
    assert!(args.normalize_answers(&[answer]).is_err());
    assert!(serde_json::from_value::<QuestionAnswer>(
        json!({"id":"choice","selected":[],"extra":true})
    )
    .is_err());
}

#[tokio::test]
async fn question_live_ownership_not_lineage_and_subagent_entry_rejection() {
    let model = FakeAdapter::new(vec![
        tool_response(vec![question_call("q")]),
        reply("Report unresolved choice to parent", &[]),
    ]);
    let (_root, runtime) = configured(model);
    create(&runtime, "parent");
    create(&runtime, "child");
    runtime.start("parent", provider(), None).unwrap();
    runtime.start("child", provider(), None).unwrap();
    idle(&runtime, "parent").await;
    idle(&runtime, "child").await;
    let parent = runtime.agents.get("parent").unwrap().unwrap();
    let child = runtime.agents.get("child").unwrap().unwrap();
    assert!(
        child.subagent.is_none(),
        "depth-zero live child must still be refused"
    );
    runtime.agents.set_owner(&child, &parent).unwrap();
    runtime
        .followup("child", "user".into(), "ask".into())
        .unwrap();
    idle(&runtime, "child").await;
    assert!(user_questions::records(&all_events(&runtime, "child")).is_empty());
    assert!(all_events(&runtime, "child").iter().any(|e| matches!(&e.payload, AgentSessionEventPayload::ToolResult { status: AgentToolResultStatus::Failed, summary, .. } if summary.contains("DELEGATED_CALLER"))));
    let other_registry = crate::agent_runtime::AgentRegistry::default();
    let impostor = other_registry
        .attach(
            runtime.sessions.clone(),
            "parent".into(),
            provider(),
            FakeAdapter::new(vec![]),
        )
        .unwrap();
    assert!(runtime
        .agents
        .require_live_root(&impostor.entry())
        .unwrap_err()
        .contains("CALLER_NOT_LIVE"));
    runtime.agents.detach("parent").unwrap();
    runtime.agents.require_live_root(&child).unwrap();
}

#[tokio::test]
async fn question_failed_answer_write_keeps_pending_and_identity_is_strict() {
    let model = FakeAdapter::new(vec![
        tool_response(vec![question_call("q")]),
        reply("Done", &[]),
    ]);
    let (root, runtime) = configured(model.clone());
    create(&runtime, "failure");
    runtime
        .followup("failure", "user".into(), "ask".into())
        .unwrap();
    runtime.start("failure", provider(), None).unwrap();
    idle(&runtime, "failure").await;
    let input = answer(&runtime, "failure");
    for field in [
        "sessionId",
        "turnId",
        "stepId",
        "requestId",
        "callId",
        "questionRequestId",
    ] {
        let mut value = serde_json::to_value(&input).unwrap();
        value["identity"][field] = json!("stale");
        assert!(runtime
            .answer_question(serde_json::from_value(value).unwrap(), None)
            .is_err());
    }
    let file = root.path().join("agent-runtime/sessions-v4/failure.jsonl");
    let backup = file.with_extension("backup");
    std::fs::rename(&file, &backup).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert!(runtime.answer_question(input.clone(), None).is_err());
    assert!(user_questions::records(&all_events(&runtime, "failure"))[0]
        .answer
        .is_none());
    assert_eq!(
        runtime
            .agents
            .get("failure")
            .unwrap()
            .unwrap()
            .phase()
            .unwrap(),
        AgentLifecyclePhase::Waiting
    );
    std::fs::remove_dir(&file).unwrap();
    std::fs::rename(backup, file).unwrap();
    let entry = runtime.agents.get("failure").unwrap().unwrap();
    assert!(!runtime.tools.wait_for_expiry(&entry).await.unwrap());
    assert!(user_questions::records(&all_events(&runtime, "failure"))[0]
        .answer
        .is_none());
    runtime.answer_question(input, None).unwrap();
    idle(&runtime, "failure").await;
    assert_eq!(model.request_count(), 2);
}

#[tokio::test]
async fn question_historical_child_can_resume_as_new_live_root() {
    let model = FakeAdapter::new(vec![reply("child report", &[])]);
    let (root, runtime) = configured(model);
    create(&runtime, "parent");
    runtime.start("parent", provider(), None).unwrap();
    idle(&runtime, "parent").await;
    let child = runtime
        .spawn_subagent(AgentSubagentSpawnRequest {
            parent_session_id: "parent".into(),
            goal: "inspect".into(),
            role: AgentSubagentRole::Explorer,
            inheritance_mode: "blank".into(),
            target_ids: vec!["target-local".into()],
            budget: None,
            continuable: true,
        })
        .await
        .unwrap();
    idle(&runtime, &child.header.session_id).await;
    drop(runtime);
    let model = FakeAdapter::new(vec![
        tool_response(vec![question_call("q")]),
        reply("Done", &[]),
    ]);
    let restored = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(model.clone())))
        .build();
    restored.configure(root.path().to_path_buf()).unwrap();
    restored
        .start(&child.header.session_id, provider(), None)
        .unwrap();
    let entry = restored
        .agents
        .get(&child.header.session_id)
        .unwrap()
        .unwrap();
    assert!(entry.subagent.is_some());
    restored.agents.require_live_root(&entry).unwrap();
    restored
        .followup(&child.header.session_id, "user-direct".into(), "ask".into())
        .unwrap();
    idle(&restored, &child.header.session_id).await;
    assert!(model.requests.lock().unwrap()[0]
        .tools
        .iter()
        .any(|tool| tool.name == "ask_user_question"));
    restored
        .answer_question(answer(&restored, &child.header.session_id), None)
        .unwrap();
    idle(&restored, &child.header.session_id).await;
    assert_eq!(model.request_count(), 2);
}

#[tokio::test]
async fn question_redaction_collisions_fail_without_pending_or_waiting() {
    for arguments in [
        json!({"questions":[{"id":"q","question":"password=sensitive"}]}),
        json!({"questions":[{"id":"q","question":"Choose?","options":[{"label":"token=one"},{"label":"token=two"}]}]}),
    ] {
        let mut call = question_call("q");
        call.arguments = arguments;
        let model = FakeAdapter::new(vec![
            tool_response(vec![call]),
            reply("Use safe labels", &[]),
        ]);
        let (_root, runtime) = configured(model.clone());
        create(&runtime, "redaction");
        runtime
            .followup("redaction", "user".into(), "ask".into())
            .unwrap();
        runtime.start("redaction", provider(), None).unwrap();
        idle(&runtime, "redaction").await;
        assert!(user_questions::records(&all_events(&runtime, "redaction")).is_empty());
        assert_eq!(model.request_count(), 2);
        assert_eq!(
            runtime.session("redaction").unwrap().status,
            AgentSessionStatus::Idle
        );
    }
}

#[tokio::test]
async fn question_cancelled_jsonl_prefix_recovery_finishes_cancellation_without_model() {
    let model = FakeAdapter::new(vec![tool_response(vec![question_call("q")])]);
    let (_root, runtime) = configured(model);
    create(&runtime, "cancel-prefix");
    runtime
        .followup("cancel-prefix", "user".into(), "ask".into())
        .unwrap();
    runtime.start("cancel-prefix", provider(), None).unwrap();
    idle(&runtime, "cancel-prefix").await;
    let input = answer(&runtime, "cancel-prefix");
    runtime.cancel("cancel-prefix").await.unwrap();
    let events = all_events(&runtime, "cancel-prefix");
    let first = events
        .iter()
        .position(|e| {
            matches!(
                e.payload,
                AgentSessionEventPayload::QuestionCancelled { .. }
            )
        })
        .unwrap();
    for end in first..events.len() - 1 {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("agent-runtime/sessions-v4");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("cancel-prefix.jsonl"),
            events[..=end]
                .iter()
                .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
                .collect::<String>(),
        )
        .unwrap();
        let model = FakeAdapter::new(vec![]);
        let restored = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(model.clone())))
            .build();
        restored.configure(root.path().to_path_buf()).unwrap();
        assert!(restored.answer_question(input.clone(), None).is_err());
        restored.start("cancel-prefix", provider(), None).unwrap();
        idle(&restored, "cancel-prefix").await;
        assert_eq!(model.request_count(), 0);
        assert!(restored.session("cancel-prefix").unwrap().ended);
        assert_eq!(
            restored.session("cancel-prefix").unwrap().status,
            AgentSessionStatus::Cancelled
        );
        assert_eq!(
            all_events(&restored, "cancel-prefix")
                .iter()
                .filter(|e| matches!(e.payload, AgentSessionEventPayload::ToolResult { .. }))
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn question_answer_racing_wait_publication_cannot_be_overwritten_or_lost() {
    let model = FakeAdapter::new(vec![
        tool_response(vec![question_call("q")]),
        reply("Done", &[]),
    ]);
    let (_root, runtime) = configured(model.clone());
    let runtime = Arc::new(runtime);
    create(&runtime, "publish");
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let publisher_gate = gate.clone();
    runtime
        .set_event_publisher(Arc::new(move |event| {
            if let AgentSessionEventPayload::QuestionRequested { identity, .. } = &event.payload {
                sent.send(identity.clone()).unwrap();
                let (lock, changed) = &*publisher_gate;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = changed.wait(released).unwrap();
                }
            }
        }))
        .unwrap();
    runtime
        .followup("publish", "user".into(), "ask".into())
        .unwrap();
    runtime.start("publish", provider(), None).unwrap();
    let identity = tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(runtime.tools.question_gate.try_lock().is_err());
    let submitter = runtime.clone();
    let submitting = tokio::task::spawn_blocking(move || {
        submitter.answer_question(
            AnswerQuestionInput {
                identity,
                client_operation_id: "publication-answer".into(),
                answers: vec![QuestionAnswer {
                    id: "choice".into(),
                    selected: vec!["B".into()],
                    custom: None,
                }],
            },
            None,
        )
    });
    *gate.0.lock().unwrap() = true;
    gate.1.notify_one();
    submitting.await.unwrap().unwrap();
    idle(&runtime, "publish").await;
    assert_eq!(model.request_count(), 2);
    assert_eq!(
        all_events(&runtime, "publish")
            .iter()
            .filter(|e| matches!(e.payload, AgentSessionEventPayload::QuestionAnswered { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn question_request_storage_failure_never_installs_or_publishes_pending() {
    let model = FakeAdapter::new(vec![tool_response(vec![question_call("q")])]);
    let (_root, runtime) = configured(model);
    create(&runtime, "request-failure");
    runtime
        .followup("request-failure", "user".into(), "ask".into())
        .unwrap();
    runtime.start("request-failure", provider(), None).unwrap();
    idle(&runtime, "request-failure").await;
    let input = answer(&runtime, "request-failure");
    let events = all_events(&runtime, "request-failure");
    let end = events
        .iter()
        .position(|e| matches!(e.payload, AgentSessionEventPayload::ToolCall { .. }))
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("agent-runtime/sessions-v4");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("request-failure.jsonl");
    std::fs::write(
        &file,
        events[..end]
            .iter()
            .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
            .collect::<String>(),
    )
    .unwrap();
    let restored = AgentRuntimeBuilder::new().build();
    restored.configure(root.path().to_path_buf()).unwrap();
    let handle = restored
        .agents
        .attach(
            restored.sessions.clone(),
            "request-failure".into(),
            provider(),
            FakeAdapter::new(vec![]),
        )
        .unwrap();
    let entry = handle.entry();
    let before = entry.phase().unwrap();
    let published = Arc::new(AtomicUsize::new(0));
    let count = published.clone();
    restored
        .set_event_publisher(Arc::new(move |_| {
            count.fetch_add(1, Ordering::AcqRel);
        }))
        .unwrap();
    std::fs::rename(&file, file.with_extension("backup")).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert!(restored
        .tools
        .request_question(
            &entry,
            &input.identity.turn_id,
            &input.identity.step_id,
            &input.identity.request_id,
            question_call("q")
        )
        .is_err());
    assert_eq!(entry.phase().unwrap(), before);
    assert_eq!(published.load(Ordering::Acquire), 0);
    assert!(user_questions::records(&all_events(&restored, "request-failure")).is_empty());
}

#[tokio::test]
async fn question_does_not_hide_required_scheduler_reconciliation() {
    let model = FakeAdapter::new(vec![tool_response(vec![question_call("q")])]);
    let (_root, runtime) = configured(model.clone());
    create(&runtime, "blocked-question");
    runtime
        .followup("blocked-question", "user".into(), "ask".into())
        .unwrap();
    runtime.start("blocked-question", provider(), None).unwrap();
    idle(&runtime, "blocked-question").await;
    let input = answer(&runtime, "blocked-question");
    runtime
        .sessions
        .append(
            "blocked-question",
            None,
            None,
            AgentSessionEventPayload::TaskState {
                status: "waiting".into(),
                phase: Some("reconciliation".into()),
                progress: None,
                fleet: None,
                recovery: Some(crate::agent_runtime::AgentRecoveryState {
                    status: crate::agent_runtime::AgentRecoveryStatus::Required,
                    summary: Some("toolSchedulerFailure: reconcile queue first".into()),
                }),
            },
        )
        .unwrap();
    assert_eq!(
        runtime.inspect_recovery("blocked-question").unwrap().status,
        crate::agent_runtime::AgentRecoveryStatus::Required
    );
    assert!(runtime.answer_question(input, None).is_err());
    assert_eq!(model.request_count(), 1);
}
