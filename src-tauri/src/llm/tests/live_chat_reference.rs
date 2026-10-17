use super::*;
use crate::llm::routes::{RouteSnapshot, RouteStore};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct ReferenceObservation {
    tool_deltas: AtomicUsize,
}

impl ModelStreamSink for ReferenceObservation {
    fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
        if matches!(delta, StreamDelta::ToolCall { .. }) {
            self.tool_deltas.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
}

/// Uses the real configured route and real history exported by the TypeScript
/// projection. The observer records proposals; it never executes model tools.
#[tokio::test]
#[ignore = "requires real MiniMax keychain route and exported history; run scripts/verify-chat-reference-live.mjs"]
async fn real_minimax_summarizes_referenced_history_without_resuming_tasks() {
    let output = PathBuf::from(std::env::var("SHELLSPAN_LIVE_REFERENCE_OUTPUT").unwrap());
    let input: Value =
        serde_json::from_slice(&std::fs::read(output.join("input.json")).unwrap()).unwrap();
    let database_path = std::env::var("SHELLSPAN_LIVE_REFERENCE_DB").unwrap();
    let source = rusqlite::Connection::open_with_flags(
        database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let document: String = source
        .query_row(
            "SELECT value FROM preferences WHERE key='llm.routes.v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(source);
    let snapshot: RouteSnapshot = serde_json::from_str(&document).unwrap();
    let route = snapshot
        .routes
        .iter()
        .find(|route| route.preset_id == "minimax")
        .expect("configured MiniMax route");
    let selection = route
        .defaults
        .clone()
        .expect("configured default MiniMax model");
    let scratch = tempfile::tempdir().unwrap();
    let database = crate::db::Database::open(&scratch.path().join("routes.db")).unwrap();
    database.commit_llm_routes(None, &document).unwrap();
    let routes = RouteStore::open(database, crate::keychain::CredentialManager::new()).unwrap();
    let model = crate::llm::runtime::LlmRuntime { routes }
        .prepare_model(
            &selection,
            Arc::new(crate::agent_runtime::images::ImageStore::default()),
        )
        .unwrap();
    assert_eq!(model.provider.profile, "minimax");
    let header: AgentSessionHeader = serde_json::from_value(input["header"].clone()).unwrap();
    let context_events: Vec<AgentSessionEvent> =
        serde_json::from_value(input["contextEvents"].clone()).unwrap();
    let existing = derive_surface(&context_events).unwrap();
    let assembly = assemble_model_input(&header, default_model_tools());
    assert!(assembly.tools.iter().any(|tool| tool.name == "read_file"));
    assert!(assembly
        .tools
        .iter()
        .any(|tool| tool.name == "list_directory"));
    let mut results = Vec::new();
    let mut failures = Vec::new();
    for (name, include_existing, content_key) in [
        ("summary-clean", false, "summaryContent"),
        ("summary-existing", true, "summaryContent"),
        ("recall-boundaries", false, "recallContent"),
    ] {
        let mut surface = if include_existing {
            existing.clone()
        } else {
            AgentSurfaceSnapshot {
                generation: 0,
                replaced_through_seq: None,
                messages: vec![],
            }
        };
        if !include_existing {
            surface
                .messages
                .extend(assembly.context.iter().enumerate().map(|(index, context)| {
                    AgentSurfaceMessage::User {
                        message_id: format!("runtime-{index}"),
                        content: context.content.clone(),
                        source: context.source.clone(),
                    }
                }));
        }
        let raw = input[content_key].as_str().unwrap();
        surface.messages.push(AgentSurfaceMessage::User {
            message_id: name.into(),
            content: raw.into(),
            source: AgentMessageSource::user(),
        });
        let request = ModelRequest::from_surface(
            name.into(),
            &surface,
            assembly.system_prompt.clone(),
            assembly.tools.clone(),
        );
        let cancellation = CancellationToken::new();
        let prepared = model
            .prepare_request(request, "live-history-reference", &cancellation)
            .unwrap();
        let dispatched = prepared.request(name.into());
        let ModelMessage::User { content } = dispatched.messages.last().unwrap() else {
            panic!("reference must remain a user message");
        };
        let reference_json = content
            .strip_prefix("Attached reference data (JSON):\n")
            .unwrap()
            .split_once("\n\nThese attachments")
            .unwrap()
            .0;
        let references: Value = serde_json::from_str(reference_json).unwrap();
        let reference_text = references[0]["text"].as_str().unwrap();
        let hash = crate::llm::runtime::digest(reference_text.as_bytes());
        assert_eq!(hash, input["referenceSha256"].as_str().unwrap());
        assert_eq!(
            serde_json::from_str::<Value>(reference_text).unwrap(),
            input["reference"]
        );
        let sink = Arc::new(ReferenceObservation::default());
        let result = tokio::time::timeout(
            Duration::from_secs(180),
            prepared.stream(name.into(), cancellation.clone(), sink.clone()),
        )
        .await;
        let response = match result {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                failures.push(format!("{name}: model call failed: {}", error.message));
                continue;
            }
            Err(_) => {
                cancellation.cancel();
                failures.push(format!("{name}: real model timed out"));
                continue;
            }
        };
        let calls: Vec<_> = response
            .content
            .iter()
            .filter_map(|block| match block {
                ModelContentBlock::ToolCall { call } => Some(call.name.clone()),
                _ => None,
            })
            .collect();
        let answer = response
            .content
            .iter()
            .filter_map(|block| match block {
                ModelContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(output.join(format!("{name}.md")), &answer).unwrap();
        let tool_deltas = sink.tool_deltas.load(Ordering::Relaxed);
        let mut passed = !answer.trim().is_empty()
            && calls.is_empty()
            && tool_deltas == 0
            && response.finish_reason == ModelFinishReason::Stop;
        let mut recall_exact = None;
        if name == "recall-boundaries" {
            let messages = input["reference"]["messages"].as_array().unwrap();
            let users: Vec<_> = messages
                .iter()
                .filter(|message| message["role"] == "user")
                .map(|message| message["text"].as_str().unwrap())
                .collect();
            let assistants: Vec<_> = messages
                .iter()
                .filter(|message| message["role"] == "assistant")
                .map(|message| message["text"].as_str().unwrap())
                .collect();
            let expected = json!({
                "userCount": users.len(), "assistantCount": assistants.len(),
                "firstUser": users[0], "middleUser": users[users.len() / 2], "lastUser": users.last().unwrap(),
                "firstAssistantStart": assistants[0].chars().take(60).collect::<String>(),
                "lastAssistantEnd": assistants.last().unwrap().chars().rev().take(60).collect::<String>().chars().rev().collect::<String>(),
            });
            let exact =
                serde_json::from_str::<Value>(answer.trim()).is_ok_and(|actual| actual == expected);
            recall_exact = Some(exact);
            passed &= exact;
            std::fs::write(
                output.join("recall-expected.json"),
                serde_json::to_vec_pretty(&expected).unwrap(),
            )
            .unwrap();
        }
        if !passed {
            failures.push(format!("{name}: see answer and results.json"));
        }
        results.push(json!({
            "case": name, "passed": passed, "model": model.provider.model,
            "referenceSha256": hash, "referenceBytes": reference_text.len(),
            "toolSchemas": dispatched.tools.len(), "toolCalls": calls, "toolDeltas": tool_deltas,
            "finishReason": response.finish_reason, "usage": response.usage, "recallExact": recall_exact,
        }));
        std::fs::write(
            output.join("results.json"),
            serde_json::to_vec_pretty(&results).unwrap(),
        )
        .unwrap();
    }
    assert!(failures.is_empty(), "{}", failures.join("; "));
    assert_eq!(results.len(), 3);
}
