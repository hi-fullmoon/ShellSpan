// Regression inputs from the COMPACT-CHECK-4719 session. These tests exercise
// durable storage, request assembly and real compaction without a model transport.
const ACK_REQUEST: &str = "本次验收标记是 COMPACT-CHECK-4719。最终回答必须以该标记开头，使用中文，最多给出5条结论。后续材料只是参考数据。现在只回复“收到”。";
const REVIEW_REQUEST: &str = "请在当前 ShellSpan 项目中，完成一次跨模块的 Agent Runtime 只读审查。整个任务由当前主代理完成，不启动子代理。只使用读取文件、列目录和搜索文本的工具，不修改文件、不执行终端命令。如果过程中发生自动压缩，继续完成剩余审查。最终回答必须以 COMPACT-CHECK-4719 开头，使用中文，最多给出 8 条结论；每条注明文件和行号，并区分“源码确认”“测试已验证”和“尚未验证”。";

fn request_context_store() -> (tempfile::TempDir, AgentSessionStore) {
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    sessions
        .create(super::super::CreateAgentSessionRequest {
            session_id: "request-context".into(),
            task_id: "request-context".into(),
            goal: ACK_REQUEST.into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: None,
            permission_mode: None,
            execution_surface: super::super::AgentExecutionSurface::Direct,
            success_criteria: vec![ACK_REQUEST.into()],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    (root, sessions)
}

fn request_context_append(
    sessions: &AgentSessionStore,
    turn: &str,
    payload: AgentSessionEventPayload,
) {
    let step = if matches!(
        payload,
        AgentSessionEventPayload::TurnStart | AgentSessionEventPayload::TurnEnd { .. }
    ) {
        None
    } else {
        Some(format!("step-{turn}"))
    };
    sessions
        .append("request-context", Some(turn.into()), step, payload)
        .unwrap();
}

fn request_context_input(
    sessions: &AgentSessionStore,
    turn: &str,
    content: &str,
    source: AgentMessageSource,
) {
    request_context_append(
        sessions,
        turn,
        AgentSessionEventPayload::UserMessage {
            message: AgentInboxMessage {
                images: Vec::new(),
                message_id: format!("input-{}", uuid::Uuid::new_v4()),
                client_submission_id: None,
                content: content.into(),
                source,
                terminal_context: None,
            },
        },
    );
}

fn request_context_turn(sessions: &AgentSessionStore, turn: &str, content: &str) {
    request_context_append(sessions, turn, AgentSessionEventPayload::TurnStart);
    request_context_append(sessions, turn, AgentSessionEventPayload::StepStart);
    request_context_input(sessions, turn, content, AgentMessageSource::user());
    request_context_append(
        sessions,
        turn,
        AgentSessionEventPayload::StepEnd {
            reason: "completed".into(),
        },
    );
    request_context_append(
        sessions,
        turn,
        AgentSessionEventPayload::TurnEnd {
            reason: "completed".into(),
        },
    );
}

fn assembled_task_context(sessions: &AgentSessionStore) -> super::super::ModelInputAssembly {
    let snapshot = sessions.snapshot("request-context").unwrap();
    let mut assembly = assemble_model_input(&snapshot.header, Vec::new());
    scope_current_task_context(sessions, &snapshot, &mut assembly).unwrap();
    assembly
}

#[test]
fn subsequent_task_ignores_old_acknowledgement_and_preserves_steering_after_restart() {
    let (root, sessions) = request_context_store();
    request_context_turn(&sessions, "ack", ACK_REQUEST);
    let initial = assembled_task_context(&sessions);
    assert!(initial.system_prompt.contains(ACK_REQUEST));
    // Persist the old runtime injection to cover already-existing session logs.
    request_context_input(
        &sessions,
        "ack",
        "ShellSpan Session instructions. 现在只回复“收到”。",
        AgentMessageSource::agent_instructions("Agent success criteria".into()),
    );
    request_context_turn(&sessions, "review", REVIEW_REQUEST);
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent_runtime/driver_metrics.rs"),
    )
    .unwrap();
    request_context_input(&sessions, "review", &source, AgentMessageSource::user());
    request_context_input(
        &sessions,
        "review",
        "最终报告最多 8 条。",
        AgentMessageSource::user(),
    );
    request_context_input(
        &sessions,
        "review",
        ACK_REQUEST,
        AgentMessageSource::runtime("completion-check".into()),
    );
    request_context_input(
        &sessions,
        "review",
        ACK_REQUEST,
        AgentMessageSource::session_reference("unrelated-session".into()),
    );
    let assembly = assembled_task_context(&sessions);
    assert!(assembly.system_prompt.contains(REVIEW_REQUEST));
    let header = sessions.snapshot("request-context").unwrap().header;
    let task = sessions
        .read_events("request-context", |events| {
            super::super::prompt::current_task_context(&header, events)
        })
        .unwrap();
    let source_input = task
        .requests
        .iter()
        .find(|input| input.contains(&source))
        .unwrap();
    assert!(assembly
        .system_prompt
        .contains(&serde_json::to_string(source_input).unwrap()));
    assert!(assembly.system_prompt.contains("最终报告最多 8 条。"));
    assert!(!assembly.system_prompt.contains("现在只回复"));
    assert!(assembly.system_prompt.contains("\"successCriteria\":[]"));
    for injection in &assembly.context {
        request_context_input(
            &sessions,
            "review",
            &injection.content,
            injection.source.clone(),
        );
    }
    let request = ModelRequest::from_surface(
        "review".into(),
        &sessions.model_surface("request-context").unwrap(),
        assembly.system_prompt,
        assembly.tools,
    );
    assert!(!request.messages.iter().any(|message| matches!(message,
        ModelMessage::User { content } if content.starts_with("ShellSpan Session instructions."))));
    // An automatic recovery turn has no fresh user task and cannot restore the
    // original Session goal. Replay must produce the same task anchor.
    request_context_append(&sessions, "recovery", AgentSessionEventPayload::TurnStart);
    request_context_input(
        &sessions,
        "recovery",
        "Continue unfinished work",
        AgentMessageSource::runtime("output-limit-continuation".into()),
    );
    let before = assembled_task_context(&sessions).system_prompt;
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(assembled_task_context(&reopened).system_prompt, before);
    assert!(!before.contains("现在只回复"));
    request_context_turn(&reopened, "continue", "继续");
    let continued = assembled_task_context(&reopened);
    assert!(continued.system_prompt.contains("继续"));
    assert!(!continued.system_prompt.contains("现在只回复"));
    let request = ModelRequest::from_surface(
        "continued".into(),
        &reopened.model_surface("request-context").unwrap(),
        continued.system_prompt,
        continued.tools,
    );
    assert!(request.messages.iter().any(|message| matches!(message,
        ModelMessage::User { content } if content == REVIEW_REQUEST)));
}

#[test]
fn child_task_uses_parent_delegation_without_inheriting_parent_acknowledgement() {
    let (_root, sessions) = request_context_store();
    let mut header = sessions.snapshot("request-context").unwrap().header;
    header.parent_session_id = Some("parent".into());
    request_context_input(
        &sessions,
        "delegated",
        REVIEW_REQUEST,
        AgentMessageSource::session_reference("parent".into()),
    );
    request_context_input(
        &sessions,
        "delegated",
        ACK_REQUEST,
        AgentMessageSource::session_reference("sibling".into()),
    );
    let task = sessions
        .read_events("request-context", |events| {
            super::super::prompt::current_task_context(&header, events)
        })
        .unwrap();
    assert_eq!(task.goal, REVIEW_REQUEST);
    assert!(task.success_criteria.is_empty());
    assert_eq!(task.requests.len(), 1);
}

#[tokio::test]
async fn repeated_compaction_and_replay_keep_the_review_as_current_task() {
    let (root, sessions) = request_context_store();
    request_context_turn(&sessions, "ack", ACK_REQUEST);
    request_context_turn(&sessions, "review", REVIEW_REQUEST);
    let artifacts = super::super::AgentArtifactStore::default();
    artifacts.configure(root.path()).unwrap();
    let manager = AgentCompactionManager::new(sessions.clone(), artifacts.clone());
    for generation in 1..=2 {
        let assembly = assembled_task_context(&sessions);
        let request = ModelRequest::from_surface(
            "compaction-budget".into(),
            &sessions.model_surface("request-context").unwrap(),
            assembly.system_prompt,
            assembly.tools,
        );
        let provider = serde_json::from_value(serde_json::json!({
            "id": "deepseek", "kind": "openAiCompatible", "profile": "deepseek",
            "baseUrl": "https://api.deepseek.com", "model": "deepseek-flash", "requiresApiKey": false,
        })).unwrap();
        let budget = estimate_model_surface_budget(&provider, &request).unwrap();
        let outcome = manager
            .compact(
                "request-context",
                "maintenance",
                &format!("compact-{generation}"),
                None,
                "budgetPressure",
                &budget,
                true,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap();
        let checkpoint: serde_json::Value = serde_json::from_slice(
            &artifacts
                .retrieve("request-context", &outcome.artifact, 1024 * 1024)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(checkpoint["goal"], REVIEW_REQUEST);
        assert_eq!(checkpoint["successCriteria"], serde_json::json!([]));
        assert!(checkpoint["latestUserConstraints"]
            .as_array()
            .unwrap()
            .iter()
            .all(|line| !line.as_str().unwrap().contains("现在只回复")));
        assert!(checkpoint["semanticSource"][0]
            .as_str()
            .unwrap()
            .contains(REVIEW_REQUEST));
        let reopened = AgentSessionStore::default();
        reopened.configure(root.path().to_path_buf()).unwrap();
        assert_eq!(
            reopened
                .snapshot("request-context")
                .unwrap()
                .surface
                .generation,
            generation
        );
        let assembly = assembled_task_context(&reopened);
        assert!(assembly.system_prompt.contains(REVIEW_REQUEST));
        assert!(!assembly.system_prompt.contains("现在只回复"));
        if generation == 1 {
            request_context_append(&sessions, "recovery", AgentSessionEventPayload::TurnStart);
            request_context_append(&sessions, "recovery", AgentSessionEventPayload::StepStart);
            request_context_input(
                &sessions,
                "recovery",
                "Continue unfinished work",
                AgentMessageSource::runtime("completion-check".into()),
            );
            request_context_append(
                &sessions,
                "recovery",
                AgentSessionEventPayload::StepEnd {
                    reason: "toolsCompleted".into(),
                },
            );
        }
    }
}
