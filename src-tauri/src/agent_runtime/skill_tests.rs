use super::*;
use crate::agent_runtime::skills::*;
use crate::agent_runtime::AgentCapabilityScope;
pub(super) fn create_skill_session(runtime: &AgentRuntime, session: &str, root: &std::path::Path) {
    runtime
        .create_session(CreateAgentSessionRequest {
            session_id: session.into(),
            task_id: format!("task-{session}"),
            goal: "Read Skills".into(),
            parent_session_id: None,
            target: Some(AgentSessionTarget {
                kind: "local".into(),
                target_id: "local-target".into(),
                session_id: "terminal".into(),
                label: None,
                profile_id: None,
                host: None,
                port: None,
                username: None,
                cwd: Some(
                    std::fs::canonicalize(root)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .into(),
                ),
                root_path: None,
                local_root: None,
            }),
            permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
            success_criteria: vec!["Skills reach model".into()],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
}
pub(super) fn write_skill(root: &std::path::Path, name: &str, policy: &str, body: &str) {
    let path = root.join(".agents/skills");
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(
        path.join(format!("{name}.md")),
        format!("---\nname: {name}\ndescription: useful {name}\n{policy}---\n{body}"),
    )
    .unwrap();
}
async fn idle_skill(runtime: &AgentRuntime, session: &str) {
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        runtime.await_idle(session),
    )
    .await
    .unwrap()
    .unwrap();
}
fn skill_call(name: &str) -> ModelToolCall {
    ModelToolCall {
        call_id: "skill-call".into(),
        provider_call_id: Some("wire-skill".into()),
        name: SKILL_TOOL.into(),
        arguments: json!({"name":name}),
    }
}

#[tokio::test]
async fn skill_builtin_rootless_local_remote_slash_model_permissions_and_replay() {
    for kind in ["local", "remote"] {
        let model = FakeAdapter::new(vec![
            tool_response(vec![skill_call("network-diagnosis")]),
            reply("done", &[]),
        ]);
        let (storage, runtime) = configured(model.clone());
        let mut target: AgentSessionTarget = serde_json::from_value(json!({
            "kind": kind, "targetId": "ops-target", "sessionId": "terminal",
            "host": "example.test", "port": 22, "username": "operator"
        }))
        .unwrap();
        if kind == "local" {
            target.host = None;
            target.port = None;
            target.username = None;
        }
        let request = CreateAgentSessionRequest {
            session_id: "builtin".into(),
            task_id: "task-builtin".into(),
            goal: "Inspect target".into(),
            parent_session_id: None,
            target: Some(target.clone()),
            permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
            success_criteria: vec!["Diagnose without a directory".into()],
            capability_scope: None,
            subagent: None,
        };
        runtime.create_session(request.clone()).unwrap();
        let list = runtime.list_skills("builtin").await.unwrap();
        assert_eq!(list.status, "fresh");
        assert_eq!(list.entries.len(), 5);
        assert_eq!(model.request_count(), 0);
        assert!(
            all_events(&runtime, "builtin")
                .iter()
                .find_map(crate::agent_runtime::file_references::bound_scope)
                .is_none(),
            "bundled skills must not bind a filesystem root"
        );
        for entry in &list.entries {
            runtime
                .tools
                .skills
                .load(
                    "builtin",
                    &entry.name,
                    SkillInvocationKind::User,
                    vec![],
                    None,
                    CancellationToken::new(),
                )
                .await
                .unwrap()
                .validate()
                .unwrap();
        }
        runtime
            .followup("builtin", "user".into(), "/system-status".into())
            .unwrap();
        runtime.start("builtin", provider(), None).unwrap();
        idle_skill(&runtime, "builtin").await;
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let first = serde_json::to_string(&requests[0]).unwrap();
        let second = serde_json::to_string(&requests[1]).unwrap();
        assert!(first.contains("# System status"));
        assert!(
            !first.contains("# Docker diagnosis"),
            "only invoked bodies enter the prompt"
        );
        assert!(second.contains("# Network diagnosis"));
        assert!(second.contains(crate::agent_runtime::builtin_skills::PROVIDER));
        drop(requests);
        let events = all_events(&runtime, "builtin");
        assert!(events.iter().any(|e| matches!(&e.payload, AgentSessionEventPayload::ToolResult { name, status: AgentToolResultStatus::Completed, .. } if name == SKILL_TOOL)));
        assert_eq!(
            runtime.session("builtin").unwrap().header.permission_mode,
            Some(AgentSessionPermissionMode::RequestApproval)
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(runtime
            .tools
            .skills
            .load(
                "builtin",
                "system-status",
                SkillInvocationKind::User,
                vec![],
                None,
                cancelled
            )
            .await
            .is_err());
        runtime
            .create_session(CreateAgentSessionRequest {
                session_id: "restricted".into(),
                task_id: "task-restricted".into(),
                capability_scope: Some(AgentCapabilityScope {
                    tool_names: vec!["run_terminal_command".into()],
                    effects: vec![AgentSessionEffect::ReadOnly],
                    target_ids: vec![target.target_id],
                }),
                ..request
            })
            .unwrap();
        assert!(runtime
            .list_skills("restricted")
            .await
            .unwrap()
            .entries
            .is_empty());
        assert!(runtime
            .tools
            .skills
            .load(
                "restricted",
                "system-status",
                SkillInvocationKind::User,
                vec![],
                None,
                CancellationToken::new()
            )
            .await
            .is_err());
        drop(runtime);
        let restored = AgentRuntimeBuilder::new().build();
        restored.configure(storage.path().into()).unwrap();
        let replay = serde_json::to_string(&restored.session("builtin").unwrap().surface).unwrap();
        assert!(replay.contains("# System status") && replay.contains("# Network diagnosis"));
    }
}

#[tokio::test]
async fn skill_runtime_slash_model_complete_large_body_and_replay() {
    let body = format!("{}\nFINAL INSTRUCTION", "full instructions ".repeat(1024));
    let model = FakeAdapter::new(vec![
        tool_response(vec![skill_call("both")]),
        reply("done", &[]),
    ]);
    let (storage, runtime) = configured(model.clone());
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "both", "", &body);
    write_skill(
        root.path(),
        "user-only",
        "disable-model-invocation: true\n",
        "human-selected instruction",
    );
    create_skill_session(&runtime, "skills", root.path());
    let list = runtime.list_skills("skills").await.unwrap();
    assert_eq!(
        list.entries.len(),
        2 + crate::agent_runtime::builtin_skills::definitions().len()
    );
    assert_eq!(model.request_count(), 0);
    runtime
        .followup(
            "skills",
            "user".into(),
            "Use /user-only and /user-only".into(),
        )
        .unwrap();
    runtime.start("skills", provider(), None).unwrap();
    idle_skill(&runtime, "skills").await;
    assert_eq!(
        model.request_count(),
        2,
        "{:?}",
        runtime.sessions.snapshot("skills").unwrap().task
    );
    let events = all_events(&runtime, "skills");
    let result = events
        .iter()
        .find_map(|e| match &e.payload {
            AgentSessionEventPayload::ToolResult { name, data, .. } if name == SKILL_TOOL => {
                data.clone()
            }
            _ => None,
        })
        .unwrap();
    let loaded: LoadedSkill = serde_json::from_value(result).unwrap();
    assert_eq!(loaded.instructions, body);
    loaded.validate().unwrap();
    let requests = model.requests.lock().unwrap();
    let first = serde_json::to_string(&requests[0]).unwrap();
    let second = serde_json::to_string(&requests[1]).unwrap();
    assert!(first.contains("human-selected instruction"));
    assert!(second.contains("FINAL INSTRUCTION"));
    assert!(second.contains("skill_provenance"));
    assert_eq!(
        events
            .iter()
            .filter_map(|e| match &e.payload {
                AgentSessionEventPayload::SkillStepPrepared { prepared } =>
                    Some(prepared.outcomes.len()),
                _ => None,
            })
            .sum::<usize>(),
        1
    );
    drop(requests);
    drop(runtime);
    write_skill(root.path(), "both", "", "changed");
    let restored = AgentRuntimeBuilder::new().build();
    restored.configure(storage.path().to_path_buf()).unwrap();
    assert!(
        serde_json::to_string(&restored.sessions.snapshot("skills").unwrap().surface)
            .unwrap()
            .contains("FINAL INSTRUCTION")
    );
}

#[tokio::test]
async fn skill_runtime_refresh_retirement_incomplete_and_current_policy() {
    let model = FakeAdapter::new(vec![
        reply("one", &[]),
        reply("two", &[]),
        reply("three", &[]),
    ]);
    let (_storage, runtime) = configured(model.clone());
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "one", "", "v1");
    create_skill_session(&runtime, "refresh", root.path());
    runtime
        .followup("refresh", "a".into(), "hi".into())
        .unwrap();
    runtime.start("refresh", provider(), None).unwrap();
    idle_skill(&runtime, "refresh").await;
    let initial = runtime.list_skills("refresh").await.unwrap();
    std::fs::write(
        root.path().join(".agents/skills/one.md"),
        vec![b'x'; MAX_SKILL_FILE + 1],
    )
    .unwrap();
    let stale = runtime.list_skills("refresh").await.unwrap();
    assert_eq!(stale.status, "stale");
    assert_eq!(stale.revision, initial.revision);
    write_skill(root.path(), "one", "user-invocable: false\n", "v2");
    assert!(runtime
        .tools
        .skills
        .load(
            "refresh",
            "one",
            SkillInvocationKind::User,
            vec![],
            None,
            CancellationToken::new()
        )
        .await
        .is_err());
    runtime
        .followup("refresh", "b".into(), "again".into())
        .unwrap();
    idle_skill(&runtime, "refresh").await;
    std::fs::remove_dir_all(root.path().join(".agents/skills")).unwrap();
    runtime
        .followup("refresh", "c".into(), "gone".into())
        .unwrap();
    idle_skill(&runtime, "refresh").await;
    let events = all_events(&runtime, "refresh");
    let publications: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.payload {
            AgentSessionEventPayload::SkillStepPrepared { prepared } => prepared.catalog.as_ref(),
            _ => None,
        })
        .collect();
    assert_eq!(
        publications.len(),
        2,
        "body/policy-only change does not repeat identical model summary"
    );
    assert!(!publications[1].content.contains("one: useful"));
}

#[tokio::test]
async fn skill_claim_every_complete_jsonl_prefix_recovers_one_input_and_prepared_bytes() {
    let model = FakeAdapter::new(vec![reply("done", &[])]);
    let (_storage, runtime) = configured(model);
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "one", "", "original body");
    create_skill_session(&runtime, "prefix", root.path());
    runtime
        .followup("prefix", "user".into(), "/one".into())
        .unwrap();
    runtime.start("prefix", provider(), None).unwrap();
    idle_skill(&runtime, "prefix").await;
    let events = all_events(&runtime, "prefix");
    let from = events
        .iter()
        .position(|e| matches!(e.payload, AgentSessionEventPayload::StepInputClaim { .. }))
        .unwrap();
    let to = events
        .iter()
        .position(|e| matches!(e.payload, AgentSessionEventPayload::RequestHeader { .. }))
        .unwrap();
    for end in from..=to {
        let storage = tempfile::tempdir().unwrap();
        let dir = storage.path().join("agent-runtime/sessions-v4");
        std::fs::create_dir_all(&dir).unwrap();
        let mut lines = String::new();
        for e in &events[..=end] {
            lines.push_str(&serde_json::to_string(e).unwrap());
            lines.push('\n');
        }
        lines.push_str("{partial");
        std::fs::write(dir.join("prefix.jsonl"), lines).unwrap();
        write_skill(root.path(), "one", "", "changed body");
        let model = FakeAdapter::new(vec![reply("restored", &[])]);
        let restored = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(model.clone())))
            .build();
        restored.configure(storage.path().to_path_buf()).unwrap();
        restored.start("prefix", provider(), None).unwrap();
        idle_skill(&restored, "prefix").await;
        let log = all_events(&restored, "prefix");
        assert_eq!(log.iter().filter(|e|matches!(&e.payload,AgentSessionEventPayload::UserMessage{message}if message.message_id=="user")).count(),1,"prefix {end}");
        assert_eq!(
            log.iter()
                .filter(|e| matches!(
                    e.payload,
                    AgentSessionEventPayload::SkillStepPrepared { .. }
                ))
                .count(),
            1,
            "prefix {end}"
        );
        assert_eq!(model.request_count(), 1, "prefix {end}");
        let rendered = serde_json::to_string(&model.requests.lock().unwrap()[0]).unwrap();
        if events[..=end].iter().any(|e| {
            matches!(
                e.payload,
                AgentSessionEventPayload::SkillStepPrepared { .. }
            )
        }) {
            assert!(rendered.contains("original body"), "prefix {end}");
        }
    }
}

#[tokio::test]
async fn skill_real_runtime_http_wire_catalog_slash_and_model_tool_body() {
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
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"wire-question","type":"function","function":{"name":"skill","arguments":skill_call("model").arguments.to_string()}}]},"finish_reason":"tool_calls"}]})
            } else {
                json!({"choices":[{"delta":{"content":"Wire answer accepted"},"finish_reason":"stop"}]})
            };
            let body = format!("data: {delta}\n\ndata: [DONE]\n\n");
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        bodies
    });

    let storage = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    create_skill_session(&runtime, "wire-skill", root.path());
    let body = format!("{}TAIL", "full instructions ".repeat(1024));
    write_skill(root.path(), "model", "user-invocable: false\n", &body);
    write_skill(
        root.path(),
        "user",
        "disable-model-invocation: true\n",
        "direct user instructions",
    );
    runtime
        .followup("wire-skill", "ingress".into(), "please /user".into())
        .unwrap();
    runtime
        .start(
            "wire-skill",
            AiProviderConfig {
                id: "skills-http".into(),
                kind: AiProviderKind::OpenAiCompatible,
                base_url: url,
                model: "test-model".into(),
                requires_api_key: false,
                reasoning_effort: None,
                ..provider()
            },
            None,
        )
        .unwrap();
    idle_skill(&runtime, "wire-skill").await;
    if let Ok(path) = std::env::var("SHELLSPAN_SKILLS_FIXTURE_OUTPUT") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&all_events(&runtime, "wire-skill")).unwrap(),
        )
        .unwrap();
    }
    let bodies = tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bodies.len(), 2);
    let first = bodies[0]["messages"].to_string();
    assert!(first.contains("model: useful model"));
    assert!(first.contains("direct user instructions"));
    assert!(!first.contains("user: useful user"));
    let second = bodies[1]["messages"].to_string();
    assert!(second.contains("TAIL"));
    assert!(second.contains("skill_provenance"));
    assert!(second.contains("wire-question"));
}

#[tokio::test]
async fn skill_model_tool_every_complete_prefix_reuses_committed_body_and_original_queue() {
    let model = FakeAdapter::new(vec![
        tool_response(vec![skill_call("one")]),
        reply("done", &[]),
    ]);
    let (_storage, runtime) = configured(model);
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "one", "", "original tool body");
    create_skill_session(&runtime, "tool-prefix", root.path());
    runtime
        .followup("tool-prefix", "user".into(), "load the skill".into())
        .unwrap();
    runtime.start("tool-prefix", provider(), None).unwrap();
    idle_skill(&runtime, "tool-prefix").await;
    let events = all_events(&runtime, "tool-prefix");
    let from = events
        .iter()
        .position(|e| matches!(e.payload, AgentSessionEventPayload::AssistantMessage { .. }))
        .unwrap();
    let to = events
        .iter()
        .position(|e| matches!(e.payload, AgentSessionEventPayload::StepEnd { .. }))
        .unwrap();
    for end in from..=to {
        let storage = tempfile::tempdir().unwrap();
        let dir = storage.path().join("agent-runtime/sessions-v4");
        std::fs::create_dir_all(&dir).unwrap();
        let lines = events[..=end]
            .iter()
            .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
            .collect::<String>();
        std::fs::write(dir.join("tool-prefix.jsonl"), lines).unwrap();
        write_skill(root.path(), "one", "", "new tool body");
        let model = FakeAdapter::new(vec![reply("resumed", &[])]);
        let restored = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(model.clone())))
            .build();
        restored.configure(storage.path().to_path_buf()).unwrap();
        restored.start("tool-prefix", provider(), None).unwrap();
        idle_skill(&restored, "tool-prefix").await;
        let log = all_events(&restored, "tool-prefix");
        assert_eq!(
            model.request_count(),
            1,
            "prefix {end}: {:?}",
            restored.sessions.snapshot("tool-prefix").unwrap().task
        );
        assert_eq!(log.iter().filter(|e|matches!(&e.payload,AgentSessionEventPayload::ToolResult{name,..} if name == SKILL_TOOL)).count(),1,"prefix {end}");
        if events[..=end]
            .iter()
            .any(|e| matches!(e.payload, AgentSessionEventPayload::ToolResult { .. }))
        {
            assert!(serde_json::to_string(&model.requests.lock().unwrap()[0])
                .unwrap()
                .contains("original tool body"));
        }
    }
}

#[tokio::test]
async fn skill_retry_preparation_unknown_name_is_not_reloaded_and_form_is_ignored() {
    let model = FakeAdapter::new(vec![
        FakeScript::Error(NormalizedModelError::new(
            NormalizedModelErrorKind::Transport,
            "retry",
        )),
        reply("done", &[]),
    ]);
    let (_storage, runtime) = configured(model.clone());
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "one", "", "instructions");
    create_skill_session(&runtime, "retry-skills", root.path());
    runtime
        .sessions
        .enqueue(
            "retry-skills",
            AgentInboxLane::NextStep,
            AgentInboxMessage {
                images: Vec::new(),
                message_id: "form".into(),
                client_submission_id: None,
                content: "/one".into(),
                source: AgentMessageSource {
                    kind: crate::agent_runtime::AgentMessageSourceKind::Form,
                    label: "form".into(),
                    producer_id: "form".into(),
                    metadata: Default::default(),
                },
            },
        )
        .unwrap();
    runtime
        .followup("retry-skills", "user".into(), "/missing".into())
        .unwrap();
    runtime.start("retry-skills", provider(), None).unwrap();
    idle_skill(&runtime, "retry-skills").await;
    let events = all_events(&runtime, "retry-skills");
    let prepared: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.payload {
            AgentSessionEventPayload::SkillStepPrepared { prepared } => Some(prepared),
            _ => None,
        })
        .collect();
    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].outcomes.len(), 1);
    assert_eq!(prepared[0].outcomes[0].name, "missing");
    assert_eq!(model.request_count(), 2);
}

#[tokio::test]
async fn skill_sensitive_complete_body_is_rejected_and_budget_blocks_oversized_first_request() {
    for (session, body, model_name) in [
        (
            "redaction",
            "password=super-sensitive-value".to_string(),
            "test-model",
        ),
        ("budget", "long instruction ".repeat(4000), "context-8192"),
    ] {
        let model = FakeAdapter::new(vec![reply("done", &[])]);
        let (_storage, runtime) = configured(model.clone());
        let root = tempfile::tempdir().unwrap();
        write_skill(root.path(), "one", "", &body);
        create_skill_session(&runtime, session, root.path());
        runtime
            .followup(session, "u".into(), "/one".into())
            .unwrap();
        runtime
            .start(
                session,
                AiProviderConfig {
                    model: model_name.into(),
                    ..provider()
                },
                None,
            )
            .unwrap();
        idle_skill(&runtime, session).await;
        let events = all_events(&runtime, session);
        let prepared = events
            .iter()
            .find_map(|e| match &e.payload {
                AgentSessionEventPayload::SkillStepPrepared { prepared } => Some(prepared),
                _ => None,
            })
            .unwrap();
        if session == "redaction" {
            assert!(prepared.outcomes[0].loaded.is_none());
            assert!(prepared.outcomes[0]
                .error
                .as_deref()
                .unwrap()
                .contains("redaction"));
            assert!(!serde_json::to_string(&events)
                .unwrap()
                .contains("super-sensitive-value"));
        } else {
            assert_eq!(model.request_count(), 0);
            assert!(prepared.outcomes[0].loaded.is_some());
        }
    }
}

#[tokio::test]
async fn skill_limits_measure_utf8_escaped_wrapper_and_complete_batch() {
    let (_storage, runtime) = configured(FakeAdapter::new(vec![]));
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "one", "", "body");
    create_skill_session(&runtime, "limits", root.path());
    let original = runtime
        .tools
        .skills
        .load(
            "limits",
            "one",
            SkillInvocationKind::User,
            vec!["m".into()],
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let build = |name: &str, body: String| {
        let mut p = original.provenance.clone();
        p.instruction_hash = digest(body.as_bytes());
        LoadedSkill::new(name.into(), body, p)
    };
    let overhead = LoadedSkill::render("one", "", &original.provenance).len();
    for limit in [
        MAX_SKILL_RENDERED - 1,
        MAX_SKILL_RENDERED,
        MAX_SKILL_RENDERED + 1,
    ] {
        let length = limit - overhead;
        let body = format!("{}{}", "界".repeat(length / 3), "x".repeat(length % 3));
        assert_eq!(build("one", body).is_ok(), limit <= MAX_SKILL_RENDERED);
    }
    assert!(
        build("one", "\"".repeat(MAX_SKILL_RENDERED / 6)).is_err(),
        "XML escaping counts toward the limit"
    );
    for delta in [0, 1] {
        let first = build("one", "x".repeat(60000 - overhead)).unwrap();
        let second = build("two", "x".repeat(MAX_SKILL_STEP - 60000 - overhead + delta)).unwrap();
        let prepared = SkillStepPrepared {
            protocol_version: 1,
            message_ids: vec!["m".into()],
            catalog: None,
            outcomes: vec![
                SkillSlashOutcome {
                    name: "one".into(),
                    message_ids: vec!["m".into()],
                    loaded: Some(first),
                    error: None,
                },
                SkillSlashOutcome {
                    name: "two".into(),
                    message_ids: vec!["m".into()],
                    loaded: Some(second),
                    error: None,
                },
            ],
        };
        assert_eq!(prepared.validate().is_ok(), delta == 0);
    }
}

#[tokio::test]
async fn skill_question_resume_reuses_prepared_body_and_answer_slash_does_not_invoke() {
    use crate::agent_runtime::user_questions::{self, AnswerQuestionInput, QuestionAnswer};
    let question = ModelToolCall {
        call_id: "q".into(),
        provider_call_id: Some("q".into()),
        name: "ask_user_question".into(),
        arguments: json!({"questions":[{"id":"choice","question":"Choice?","options":[{"label":"A"},{"label":"B"}]}]}),
    };
    let model = FakeAdapter::new(vec![tool_response(vec![question])]);
    let (storage, runtime) = configured(model);
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "one", "", "first complete body");
    write_skill(root.path(), "answer", "", "must not load");
    create_skill_session(&runtime, "question-skill", root.path());
    runtime
        .followup("question-skill", "u".into(), "/one".into())
        .unwrap();
    runtime
        .start(
            "question-skill",
            AiProviderConfig {
                reasoning_effort: None,
                ..provider()
            },
            None,
        )
        .unwrap();
    idle_skill(&runtime, "question-skill").await;
    let record = user_questions::records(&all_events(&runtime, "question-skill"))
        .pop()
        .unwrap();
    drop(runtime);
    write_skill(root.path(), "one", "", "edited while answering");
    let model = FakeAdapter::new(vec![reply("done", &[])]);
    let runtime = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(model.clone())))
        .build();
    runtime.configure(storage.path().into()).unwrap();
    runtime
        .answer_question(
            AnswerQuestionInput {
                identity: record.identity,
                client_operation_id: "answer-id".into(),
                answers: vec![QuestionAnswer {
                    id: "choice".into(),
                    selected: vec![],
                    custom: Some("/answer".into()),
                }],
            },
            None,
        )
        .unwrap();
    idle_skill(&runtime, "question-skill").await;
    let events = all_events(&runtime, "question-skill");
    assert_eq!(
        events
            .iter()
            .filter_map(|e| match &e.payload {
                AgentSessionEventPayload::SkillStepPrepared { prepared } =>
                    Some(prepared.outcomes.len()),
                _ => None,
            })
            .sum::<usize>(),
        1
    );
    let wire = serde_json::to_string(&model.requests.lock().unwrap()[0]).unwrap();
    assert!(wire.contains("first complete body"));
    assert!(!wire.contains("edited while answering"));
    assert!(!wire.contains("must not load"));
}

#[tokio::test]
async fn skill_compaction_republishes_catalog_and_preserves_durable_hashes() {
    for revoked in [false, true] {
        let model = FakeAdapter::new(vec![reply("completed turn", &[])]);
        let (_storage, runtime) = configured(model.clone());
        let root = tempfile::tempdir().unwrap();
        write_skill(root.path(), "one", "", "original complete body");
        create_skill_session(&runtime, "compact-skill", root.path());
        runtime
            .followup("compact-skill", "u".into(), "/one".into())
            .unwrap();
        runtime.start("compact-skill", provider(), None).unwrap();
        idle_skill(&runtime, "compact-skill").await;
        let before = all_events(&runtime, "compact-skill");
        let prepared = before
            .iter()
            .find(|e| {
                matches!(
                    e.payload,
                    AgentSessionEventPayload::SkillStepPrepared { .. }
                )
            })
            .unwrap();
        let budget = crate::agent_runtime::estimate_model_surface_budget(
            &provider(),
            &model.requests.lock().unwrap()[0],
        );
        runtime
            .compactions
            .compact(
                "compact-skill",
                prepared.turn_id.as_deref().unwrap(),
                prepared.step_id.as_deref().unwrap(),
                None,
                "test",
                &budget,
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let compacted = runtime.session("compact-skill").unwrap();
        assert!(compacted.surface.generation > 0);
        if revoked {
            runtime
                .sessions
                .append(
                    "compact-skill",
                    None,
                    None,
                    AgentSessionEventPayload::SkillCatalogObserved {
                        observation:
                            crate::agent_runtime::skill_runtime::SkillReadResult::unavailable(
                                "root revoked after compaction",
                            )
                            .observation,
                    },
                )
                .unwrap();
        }
        runtime
            .tools
            .skills
            .republish_if_missing(
                "compact-skill",
                prepared.turn_id.as_deref().unwrap(),
                prepared.step_id.as_deref().unwrap(),
            )
            .unwrap();
        let events = all_events(&runtime, "compact-skill");
        assert_eq!(
            serde_json::to_value(&events[prepared.seq as usize]).unwrap(),
            serde_json::to_value(prepared).unwrap()
        );
        assert!(matches!(
            events.last().unwrap().payload,
            AgentSessionEventPayload::SkillCatalogPublished { .. }
        ));
        if let AgentSessionEventPayload::SkillCatalogPublished { catalog } =
            &events.last().unwrap().payload
        {
            assert_eq!(catalog.content.contains("one: useful one"), !revoked);
        }
    }
}

#[tokio::test]
async fn skill_current_winner_policy_delete_rename_and_cross_target_isolation() {
    let (_storage, runtime) = configured(FakeAdapter::new(vec![]));
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    write_skill(a.path(), "same", "", "A BODY");
    write_skill(b.path(), "same", "", "B BODY");
    create_skill_session(&runtime, "a", a.path());
    create_skill_session(&runtime, "b", b.path());
    let read = |session: &'static str, kind| {
        runtime.tools.skills.load(
            session,
            "same",
            kind,
            vec!["m".into()],
            None,
            CancellationToken::new(),
        )
    };
    assert_eq!(
        read("a", SkillInvocationKind::User)
            .await
            .unwrap()
            .instructions,
        "A BODY"
    );
    assert_eq!(
        read("b", SkillInvocationKind::User)
            .await
            .unwrap()
            .instructions,
        "B BODY"
    );
    runtime.list_skills("a").await.unwrap();
    std::fs::write(a.path().join(".agents/skills/0-winner.md"),"---\nname: same\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\ndisabled winner").unwrap();
    assert!(read("a", SkillInvocationKind::Model).await.is_err());
    assert!(read("a", SkillInvocationKind::User).await.is_err());
    assert!(runtime
        .list_skills("a")
        .await
        .unwrap()
        .entries
        .iter()
        .all(|entry| entry.name != "same"));
    std::fs::remove_file(a.path().join(".agents/skills/0-winner.md")).unwrap();
    write_skill(a.path(), "same", "user-invocable: false\n", "latest body");
    assert!(read("a", SkillInvocationKind::User).await.is_err());
    std::fs::remove_file(a.path().join(".agents/skills/same.md")).unwrap();
    write_skill(a.path(), "renamed", "", "new name");
    assert!(read("a", SkillInvocationKind::Model).await.is_err());
}

struct ControlledSkillsProvider {
    mode: AtomicUsize,
    entered: tokio::sync::Notify,
    release: (Mutex<bool>, std::sync::Condvar),
}
impl NativeToolRuntime for ControlledSkillsProvider {
    fn prepare(&self, _: NativeToolRequest) -> Result<NativeToolPreparation, String> {
        Err("unused".into())
    }
    fn execute(&self, _: &str, _: bool, _: CancellationToken) -> Result<NativeToolResult, String> {
        Err("unused".into())
    }
    fn abandon(&self, _: &str) {}
    fn read_skills(
        &self,
        request: crate::agent_runtime::skill_runtime::SkillReadRequest,
    ) -> crate::agent_runtime::skill_runtime::SkillReadResult {
        use crate::agent_runtime::{native::scoped_read::ScopeReadError, skill_runtime::*};
        match self.mode.load(Ordering::Acquire) {
            1 => SkillReadResult::failed(ScopeReadError::Io),
            2 => SkillReadResult::unavailable("test scope revoked"),
            3 => {
                self.entered.notify_one();
                let held = self.release.0.lock().unwrap();
                let (held, timeout) = self
                    .release
                    .1
                    .wait_timeout_while(held, std::time::Duration::from_secs(5), |released| {
                        !*released
                    })
                    .unwrap();
                drop(held);
                assert!(!timeout.timed_out());
                read_local(request)
            }
            _ => read_local(request),
        }
    }
}
impl ControlledSkillsProvider {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            mode: AtomicUsize::new(0),
            entered: tokio::sync::Notify::new(),
            release: (Mutex::new(false), std::sync::Condvar::new()),
        })
    }
}
#[tokio::test]
async fn skill_incomplete_preserves_last_good_but_revocation_retires_list_and_model_catalog() {
    let native = ControlledSkillsProvider::new();
    let model = FakeAdapter::new(vec![reply("done", &[]), reply("retired", &[])]);
    let (_storage, runtime) =
        configured_with_native(model.clone(), AgentDriverConfig::default(), native.clone());
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "one", "", "first body");
    create_skill_session(&runtime, "scope", root.path());
    runtime.followup("scope", "u".into(), "hi".into()).unwrap();
    runtime.start("scope", provider(), None).unwrap();
    idle_skill(&runtime, "scope").await;
    let good = runtime.list_skills("scope").await.unwrap();
    native.mode.store(1, Ordering::Release);
    let stale = runtime.list_skills("scope").await.unwrap();
    assert_eq!(stale.revision, good.revision);
    assert_eq!(stale.status, "stale");
    assert!(runtime
        .tools
        .skills
        .load(
            "scope",
            "one",
            SkillInvocationKind::Model,
            vec![],
            Some(("r".into(), "c".into())),
            CancellationToken::new()
        )
        .await
        .is_err());
    native.mode.store(2, Ordering::Release);
    let revoked = runtime.list_skills("scope").await.unwrap();
    assert_eq!(revoked.status, "unavailable");
    assert!(revoked.entries.is_empty());
    native.mode.store(1, Ordering::Release);
    assert!(
        runtime
            .list_skills("scope")
            .await
            .unwrap()
            .entries
            .is_empty(),
        "incomplete after revocation must not revive old authority"
    );
    runtime
        .followup("scope", "v".into(), "next".into())
        .unwrap();
    idle_skill(&runtime, "scope").await;
    let catalog = all_events(&runtime, "scope")
        .into_iter()
        .filter_map(|e| match e.payload {
            AgentSessionEventPayload::SkillStepPrepared { prepared } => prepared.catalog,
            _ => None,
        })
        .next_back()
        .unwrap();
    assert!(!catalog.content.contains("one: useful"));
}
#[tokio::test]
async fn skill_cancelled_read_is_joined_and_cannot_commit_loaded_body() {
    let native = ControlledSkillsProvider::new();
    let model = FakeAdapter::new(vec![tool_response(vec![skill_call("one")])]);
    let (_storage, runtime) =
        configured_with_native(model, AgentDriverConfig::default(), native.clone());
    let root = tempfile::tempdir().unwrap();
    write_skill(root.path(), "one", "", "must never commit");
    create_skill_session(&runtime, "cancel-read", root.path());
    let observer = native.clone();
    runtime
        .sessions
        .set_publisher(Arc::new(move |event| {
            if matches!(
                event.payload,
                AgentSessionEventPayload::AssistantMessage { .. }
            ) {
                observer.mode.store(3, Ordering::Release);
            }
        }))
        .unwrap();
    runtime
        .followup("cancel-read", "u".into(), "load it".into())
        .unwrap();
    runtime.start("cancel-read", provider(), None).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), native.entered.notified())
        .await
        .unwrap();
    runtime.agents.get("cancel-read").unwrap().unwrap().cancel();
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(20),
            runtime.await_idle("cancel-read")
        )
        .await
        .is_err(),
        "cancel must join the owned blocking read"
    );
    *native.release.0.lock().unwrap() = true;
    native.release.1.notify_all();
    idle_skill(&runtime, "cancel-read").await;
    let events = all_events(&runtime, "cancel-read");
    assert!(!serde_json::to_string(&events)
        .unwrap()
        .contains("must never commit"));
    assert!(events.iter().any(|e|matches!(&e.payload,AgentSessionEventPayload::ToolResult{name,status:AgentToolResultStatus::Cancelled,..}if name=="skill")));
}

#[tokio::test]
async fn skill_child_safe_prefix_filters_parent_instructions_and_counts_real_tool_admission() {
    let mut second = skill_call("one");
    second.call_id = "second".into();
    second.provider_call_id = Some("second".into());
    let model = FakeAdapter::new(vec![
        reply("parent done", &[]),
        tool_response(vec![skill_call("one"), second]),
        reply("child done", &[]),
    ]);
    let (_storage, runtime) = configured(model.clone());
    let root = tempfile::tempdir().unwrap();
    write_skill(
        root.path(),
        "parent-only",
        "disable-model-invocation: true\n",
        "SAVED PARENT INSTRUCTIONS",
    );
    write_skill(root.path(), "one", "", "child can load this once");
    create_skill_session(&runtime, "parent-skills", root.path());
    runtime
        .followup("parent-skills", "u".into(), "/parent-only".into())
        .unwrap();
    runtime.start("parent-skills", provider(), None).unwrap();
    idle_skill(&runtime, "parent-skills").await;
    let child = runtime
        .spawn_subagent(AgentSubagentSpawnRequest {
            parent_session_id: "parent-skills".into(),
            goal: "bounded work".into(),
            role: AgentSubagentRole::General,
            inheritance_mode: "safePrefix".into(),
            target_ids: vec!["local-target".into()],
            budget: Some(crate::agent_runtime::AgentSubagentBudget {
                max_steps_per_turn: 4,
                max_turns: 1,
                max_tool_calls: 1,
                max_tokens: 32768,
                timeout_ms: 10000,
            }),
            continuable: false,
        })
        .await
        .unwrap();
    idle_skill(&runtime, &child.header.session_id).await;
    let requests = model.requests.lock().unwrap();
    assert!(requests.len() >= 2);
    assert!(!serde_json::to_string(&requests[1])
        .unwrap()
        .contains("SAVED PARENT INSTRUCTIONS"));
    drop(requests);
    let events = all_events(&runtime, &child.header.session_id);
    assert!(events.iter().any(|e|matches!(&e.payload,AgentSessionEventPayload::ToolResult{call_id,status:AgentToolResultStatus::Completed,..}if call_id=="skill-call")));
    assert!(events.iter().any(|e|matches!(&e.payload,AgentSessionEventPayload::ToolResult{call_id,status:AgentToolResultStatus::Rejected,..}if call_id=="second")));
    assert_eq!(
        crate::agent_runtime::tool_pipeline::admitted_tool_calls(&events),
        1
    );
}
struct SkillLifecycleProbe {
    reject: bool,
    before: AtomicUsize,
    after: AtomicUsize,
    failed: AtomicUsize,
}
impl AgentBeforeToolHook for SkillLifecycleProbe {
    fn before_tool(&self, c: &AgentBeforeToolContext) -> Result<AgentBeforeToolDecision, String> {
        if c.name == "skill" {
            self.before.fetch_add(1, Ordering::SeqCst);
            if self.reject {
                return Ok(AgentBeforeToolDecision::Reject {
                    reason: "fixture policy".into(),
                });
            }
        }
        Ok(AgentBeforeToolDecision::Continue)
    }
}
impl AgentAfterToolHook for SkillLifecycleProbe {
    fn after_tool(&self, c: &AgentAfterToolContext) -> Result<AgentAfterToolDecision, String> {
        if c.name == "skill" {
            self.after.fetch_add(1, Ordering::SeqCst);
        }
        Ok(AgentAfterToolDecision::Continue)
    }
}
impl AgentToolFailedHook for SkillLifecycleProbe {
    fn tool_failed(&self, c: &AgentAfterToolContext) -> Result<AgentAfterToolDecision, String> {
        if c.name == "skill" {
            self.failed.fetch_add(1, Ordering::SeqCst);
        }
        Ok(AgentAfterToolDecision::Continue)
    }
}
#[tokio::test]
async fn skill_before_after_and_failure_hooks_keep_existing_authority() {
    for reject in [true, false] {
        let hook = Arc::new(SkillLifecycleProbe {
            reject,
            before: AtomicUsize::new(0),
            after: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
        });
        let model = FakeAdapter::new(vec![
            tool_response(vec![skill_call("one")]),
            reply("done", &[]),
        ]);
        let storage = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_skill(root.path(), "one", "allowed-tools: '*'\n", "valid body");
        let runtime = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(model)))
            .before_tool_hook(hook.clone())
            .after_tool_hook(hook.clone())
            .tool_failed_hook(hook.clone())
            .build();
        runtime.configure(storage.path().into()).unwrap();
        create_skill_session(&runtime, "hooks", root.path());
        runtime.followup("hooks", "u".into(), "go".into()).unwrap();
        runtime.start("hooks", provider(), None).unwrap();
        idle_skill(&runtime, "hooks").await;
        assert_eq!(hook.before.load(Ordering::SeqCst), 1);
        assert_eq!(hook.after.load(Ordering::SeqCst), usize::from(!reject));
        assert_eq!(hook.failed.load(Ordering::SeqCst), usize::from(reject));
    }
}
