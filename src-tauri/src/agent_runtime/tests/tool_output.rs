use super::*;
use crate::agent_runtime::{AgentSessionPermissionMode, CreateAgentSessionRequest};

fn stores() -> (tempfile::TempDir, AgentSessionStore, AgentArtifactStore) {
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    let artifacts = AgentArtifactStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    artifacts.configure(root.path()).unwrap();
    for id in ["source", "other"] {
        sessions
            .create(CreateAgentSessionRequest {
                session_id: id.into(),
                task_id: id.into(),
                goal: "Read repository instructions".into(),
                parent_session_id: None,
                continued_from_session_id: None,
                target: None,
                permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
                execution_surface: crate::agent_runtime::AgentExecutionSurface::Direct,
                success_criteria: vec![],
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
    }
    (root, sessions, artifacts)
}

fn create_child(
    sessions: &AgentSessionStore,
    id: &str,
    inheritance: crate::agent_runtime::AgentSubagentInheritance,
    readable: bool,
    readonly: bool,
) {
    let tools = if readable {
        vec![READ_TOOL_RESULT]
    } else {
        vec!["read_file"]
    };
    let effects = if readonly {
        vec!["readOnly"]
    } else {
        vec!["sensitiveRead"]
    };
    let scope = json!({"toolNames":tools,"effects":effects,"targetIds":["artifact-target"]});
    sessions.create(serde_json::from_value(json!({
        "sessionId":id,"taskId":id,"goal":"Inspect inherited repository evidence","executionSurface":"direct","parentSessionId":"source","capabilityScope":scope,
        "subagent":{"descriptorId":format!("descriptor-{id}"),"parentTaskId":"source","role":"reviewer","continuable":true,"depth":1,"inheritance":inheritance,"capabilityScope":scope,
            "targetScope":[{"kind":"local","targetId":"artifact-target","sessionId":"source"}],
            "budget":{"maxStepsPerTurn":16,"maxTurns":8,"maxToolCalls":32,"maxTokens":16384,"timeoutMs":60000},"provider":{"routeId":"storage-audit","modelId":"storage-audit"}}
    })).unwrap()).unwrap();
    sessions
        .enqueue(
            id,
            crate::agent_runtime::AgentInboxLane::NextTurn,
            crate::agent_runtime::AgentInboxMessage {
                message_id: format!("message-{id}"),
                client_submission_id: None,
                content: "Inspect the inherited stored repository evidence.".into(),
                source: crate::agent_runtime::AgentMessageSource::user(),
                images: vec![],
                terminal_context: None,
            },
        )
        .unwrap();
    sessions
        .begin_turn_step(id, format!("turn-{id}"), format!("step-{id}"))
        .unwrap();
}

fn parent_prefix(
    sessions: &AgentSessionStore,
    artifacts: &AgentArtifactStore,
    references: &[String],
    metadata: &[AgentArtifactMetadata],
) -> u64 {
    sessions
        .enqueue(
            "source",
            crate::agent_runtime::AgentInboxLane::NextTurn,
            crate::agent_runtime::AgentInboxMessage {
                message_id: "parent-input".into(),
                client_submission_id: None,
                content: format!("读取{}的已保存结果", references.join("、")),
                source: crate::agent_runtime::AgentMessageSource::user(),
                images: vec![],
                terminal_context: None,
            },
        )
        .unwrap();
    sessions
        .begin_turn_step("source", "turn-parent".into(), "step-parent".into())
        .unwrap();
    for item in metadata {
        publish_artifact(sessions, "source", "turn-parent", "step-parent", item).unwrap();
        assert_eq!(
            artifacts.verify("source", item).unwrap(),
            crate::agent_runtime::AgentArtifactIntegrity::Verified
        );
    }
    sessions.pause_for_input("source", "stoppedByUser").unwrap();
    sessions
        .all_events("source")
        .unwrap()
        .iter()
        .rev()
        .find(|event| matches!(event.payload, AgentSessionEventPayload::TurnEnd { .. }))
        .unwrap()
        .seq
}

#[test]
fn safe_prefix_transfers_referenced_claim_checks_and_survives_store_reload() {
    use crate::agent_runtime::AgentSubagentInheritance;
    let (root, sessions, artifacts) = stores();
    let data = json!({"text":include_str!("../../../../AGENTS.md")});
    let leaf = artifacts
        .store_json("source", "tool-result", "Repository instructions", &data)
        .unwrap();
    let envelope = json!({"status":"completed","summary":"Stored repository instructions","data":result_reference(&data,&leaf,64)});
    let outer = artifacts
        .store_json(
            "source",
            "model-tool-result",
            "Repository claim check",
            &envelope,
        )
        .unwrap();
    let unreferenced = artifacts
        .store_json(
            "source",
            "tool-result",
            "Unreferenced manifest",
            &json!({"text":include_str!("../../../../src-tauri/Cargo.toml")}),
        )
        .unwrap();
    let private = artifacts
        .store_json(
            "source",
            "structured-compaction",
            "Private checkpoint",
            &json!({"text":include_str!("../../../../src-tauri/Cargo.lock")}),
        )
        .unwrap();
    let late = artifacts
        .store_json(
            "source",
            "tool-result",
            "Later lockfile",
            &json!({"lockfile":include_str!("../../../../src-tauri/Cargo.lock")}),
        )
        .unwrap();
    let unrelated = artifacts
        .store_json(
            "other",
            "tool-result",
            "Other Session output",
            &json!({"manifest":include_str!("../../../../src-tauri/Cargo.toml")}),
        )
        .unwrap();
    publish_artifact(&sessions, "other", "turn-other", "step-other", &unrelated).unwrap();
    let boundary = parent_prefix(
        &sessions,
        &artifacts,
        &[
            outer.artifact_id.clone(),
            private.artifact_id.clone(),
            late.artifact_id.clone(),
            unrelated.artifact_id.clone(),
        ],
        &[
            leaf.clone(),
            outer.clone(),
            unreferenced.clone(),
            private.clone(),
        ],
    );
    publish_artifact(&sessions, "source", "turn-later", "step-later", &late).unwrap();
    create_child(
        &sessions,
        "child",
        AgentSubagentInheritance::SafePrefix {
            parent_through_seq: Some(boundary),
        },
        true,
        true,
    );
    let inherited = sessions.inherited_surface("child").unwrap().unwrap();
    materialize_inherited_results(
        &sessions,
        &artifacts,
        "child",
        "turn-child",
        "step-child",
        &inherited,
        &tokio_util::sync::CancellationToken::new(),
    )
    .unwrap();
    for item in [&leaf, &outer] {
        let bytes = artifacts
            .retrieve("child", item, item.size_bytes as usize)
            .unwrap();
        assert_eq!(
            bytes,
            artifacts
                .retrieve("source", item, item.size_bytes as usize)
                .unwrap()
        );
        assert!(read_result(
            &sessions,
            &artifacts,
            "child",
            json!({"artifactId":item.artifact_id,"offset":0,"maxBytes":2048})
        )
        .is_ok());
    }
    for item in [&unreferenced, &private, &late, &unrelated] {
        assert!(read_result(
            &sessions,
            &artifacts,
            "child",
            json!({"artifactId":item.artifact_id,"offset":0,"maxBytes":2048})
        )
        .is_err());
        assert!(!root
            .path()
            .join("agent-runtime/artifacts-v2/child")
            .join(format!("{}.bin", item.artifact_id))
            .exists());
    }
    let events = sessions.all_events("child").unwrap();
    materialize_inherited_results(
        &sessions,
        &artifacts,
        "child",
        "turn-child",
        "step-child",
        &inherited,
        &tokio_util::sync::CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(sessions.all_events("child").unwrap(), events);
    sessions.pause_for_input("child", "stoppedByUser").unwrap();
    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    // Once copied, the child relies on its own verified bytes, not parent files.
    for item in [&leaf, &outer] {
        let path = root
            .path()
            .join("agent-runtime/artifacts-v2/source")
            .join(format!("{}.bin", item.artifact_id));
        std::fs::rename(&path, path.with_extension("saved")).unwrap();
    }
    materialize_inherited_results(
        &restarted,
        &artifacts,
        "child",
        "turn-child",
        "step-child",
        &inherited,
        &tokio_util::sync::CancellationToken::new(),
    )
    .unwrap();
    assert!(read_result(
        &restarted,
        &artifacts,
        "child",
        json!({"artifactId":leaf.artifact_id,"offset":0,"maxBytes":2048})
    )
    .is_ok());
    let path = root
        .path()
        .join("agent-runtime/artifacts-v2/child")
        .join(format!("{}.bin", leaf.artifact_id));
    std::fs::write(&path, include_str!("../../../../src-tauri/Cargo.toml")).unwrap();
    assert!(materialize_inherited_results(
        &restarted,
        &artifacts,
        "child",
        "turn-child",
        "step-child",
        &inherited,
        &tokio_util::sync::CancellationToken::new()
    )
    .unwrap_err()
    .contains("integrity"));
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        include_str!("../../../../src-tauri/Cargo.toml")
    );
}

#[test]
fn inheritance_transfer_denies_blank_scope_missing_capability_cancellation_and_bad_parent_bytes() {
    use crate::agent_runtime::AgentSubagentInheritance;
    let (root, sessions, artifacts) = stores();
    let item = artifacts
        .store_json(
            "source",
            "tool-result",
            "Repository instructions",
            &json!({"text":include_str!("../../../../AGENTS.md")}),
        )
        .unwrap();
    let boundary = parent_prefix(
        &sessions,
        &artifacts,
        std::slice::from_ref(&item.artifact_id),
        std::slice::from_ref(&item),
    );
    let inheritance = AgentSubagentInheritance::SafePrefix {
        parent_through_seq: Some(boundary),
    };
    for (id, mode, readable, readonly) in [
        ("blank", AgentSubagentInheritance::Blank, true, true),
        ("denied", inheritance.clone(), false, true),
        ("effect-denied", inheritance.clone(), true, false),
        ("cancelled", inheritance.clone(), true, true),
        ("corrupt", inheritance, true, true),
    ] {
        create_child(&sessions, id, mode, readable, readonly);
    }
    let inherited = sessions.inherited_surface("corrupt").unwrap().unwrap();
    for id in ["blank", "denied", "effect-denied"] {
        materialize_inherited_results(
            &sessions,
            &artifacts,
            id,
            &format!("turn-{id}"),
            &format!("step-{id}"),
            &inherited,
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
        assert!(read_result(
            &sessions,
            &artifacts,
            id,
            json!({"artifactId":item.artifact_id,"offset":0,"maxBytes":2048})
        )
        .is_err());
    }
    let cancelled = tokio_util::sync::CancellationToken::new();
    cancelled.cancel();
    let before = sessions.all_events("cancelled").unwrap();
    assert!(materialize_inherited_results(
        &sessions,
        &artifacts,
        "cancelled",
        "turn-cancelled",
        "step-cancelled",
        &inherited,
        &cancelled
    )
    .is_err());
    assert_eq!(sessions.all_events("cancelled").unwrap(), before);
    let path = root
        .path()
        .join("agent-runtime/artifacts-v2/source")
        .join(format!("{}.bin", item.artifact_id));
    std::fs::write(path, include_str!("../../../../src-tauri/Cargo.toml")).unwrap();
    assert!(materialize_inherited_results(
        &sessions,
        &artifacts,
        "corrupt",
        "turn-corrupt",
        "step-corrupt",
        &inherited,
        &tokio_util::sync::CancellationToken::new()
    )
    .is_err());
    assert!(read_result(
        &sessions,
        &artifacts,
        "corrupt",
        json!({"artifactId":item.artifact_id,"offset":0,"maxBytes":2048})
    )
    .is_err());
}

fn pressure_budget() -> ModelSurfaceBudget {
    serde_json::from_value(json!({"reservedTokensPerImage":0,"contextWindow":16384,"outputReserveTokens":2252,"safetyReserveTokens":1024,"usableInputTokens":13108,"compactionThresholdTokens":11141,"compactionTargetTokens":7864,"systemTokens":1513,"toolSchemaTokens":4362,"messageTokens":10000,"estimatedInputTokens":15875,"estimatedInputBytes":63500,"maximumInputBytes":52432})).unwrap()
}

#[test]
fn real_repository_output_is_bounded_and_fully_retrievable_without_duplicate_artifacts() {
    let (_root, sessions, artifacts) = stores();
    let original = json!({"status":"completed","summary":"Read repository instructions","data":{"exitCode":0,"stdout":include_str!("../../../../AGENTS.md")}});
    let mut request = ModelRequest {
        request_id: "read".into(),
        surface_generation: 0,
        system_prompt: String::new(),
        tools: crate::agent_runtime::model_tools::default_model_tools()
            .into_iter()
            .filter(|tool| tool.name == READ_TOOL_RESULT)
            .collect(),
        messages: vec![ModelMessage::Tool {
            call_id: "read-instructions".into(),
            provider_call_id: None,
            name: "read_file".into(),
            content: original.to_string(),
        }],
    };
    let original_request = request.clone();
    bound_request_results(
        &sessions,
        &artifacts,
        "source",
        "turn",
        "step",
        &mut request,
        &pressure_budget(),
    )
    .unwrap();
    let ModelMessage::Tool { content, .. } = &request.messages[0] else {
        panic!()
    };
    assert!(content.len() < 1024);
    let bounded: Value = serde_json::from_str(content).unwrap();
    assert_eq!(bounded["status"], "completed");
    assert_eq!(bounded["data"]["exitCode"], 0);
    let artifact_id = bounded["data"]["artifactRef"].as_str().unwrap();
    let mut offset = 0;
    let mut recovered = String::new();
    loop {
        let result = read_result(
            &sessions,
            &artifacts,
            "source",
            json!({"artifactId":artifact_id,"offset":offset,"maxBytes":2048}),
        )
        .unwrap();
        let excerpt = result["untrustedExcerpt"].as_str().unwrap();
        assert!(excerpt.len() <= 2048);
        recovered.push_str(excerpt);
        offset = result["nextOffset"].as_u64().unwrap() as usize;
        if result["hasMore"] == false {
            break;
        }
    }
    assert_eq!(serde_json::from_str::<Value>(&recovered).unwrap(), original);
    let mut rebuilt = original_request;
    bound_request_results(
        &sessions,
        &artifacts,
        "source",
        "turn",
        "step",
        &mut rebuilt,
        &pressure_budget(),
    )
    .unwrap();
    assert_eq!(rebuilt, request);
    assert_eq!(
        sessions
            .all_events("source")
            .unwrap()
            .iter()
            .filter(|event| matches!(
                event.payload,
                AgentSessionEventPayload::ContextArtifact { .. }
            ))
            .count(),
        1
    );
    assert!(read_result(
        &sessions,
        &artifacts,
        "other",
        json!({"artifactId":artifact_id,"offset":0,"maxBytes":2048})
    )
    .unwrap_err()
    .contains("this session"));
    assert_eq!(
        read_result(
            &sessions,
            &artifacts,
            "source",
            json!({"artifactId":artifact_id,"offset":0,"maxBytes":2049})
        )
        .unwrap(),
        read_result(
            &sessions,
            &artifacts,
            "source",
            json!({"artifactId":artifact_id,"offset":0,"maxBytes":2048})
        )
        .unwrap()
    );
    let middle = recovered
        .char_indices()
        .find(|(_, ch)| !ch.is_ascii())
        .unwrap()
        .0
        + 1;
    assert!(read_result(
        &sessions,
        &artifacts,
        "source",
        json!({"artifactId":artifact_id,"offset":middle,"maxBytes":2048})
    )
    .is_err());
}

fn stored_repository_output(
    sessions: &AgentSessionStore,
    artifacts: &AgentArtifactStore,
) -> (AgentArtifactMetadata, String) {
    let original = json!({"source":include_str!("../../../../AGENTS.md")});
    let metadata = artifacts
        .store_json(
            "source",
            "tool-result",
            "Repository instructions",
            &original,
        )
        .unwrap();
    publish_artifact(sessions, "source", "turn", "step", &metadata).unwrap();
    (metadata, original.to_string())
}

#[test]
fn tool_result_pages_default_and_cap_sizes_without_losing_bytes() {
    let (_root, sessions, artifacts) = stores();
    let (metadata, original) = stored_repository_output(&sessions, &artifacts);
    assert!(original.len() > 2048);
    for requested in [None, Some(17), Some(2048), Some(2049), Some(usize::MAX)] {
        let applied = requested.unwrap_or(2048).min(2048);
        let mut offset = 0;
        let mut recovered = String::new();
        loop {
            let mut arguments = json!({"artifactId":metadata.artifact_id});
            if offset > 0 {
                arguments["offset"] = json!(offset);
            }
            if let Some(max_bytes) = requested {
                arguments["maxBytes"] = json!(max_bytes);
            }
            let result = read_result(&sessions, &artifacts, "source", arguments).unwrap();
            let excerpt = result["untrustedExcerpt"].as_str().unwrap();
            let next = result["nextOffset"].as_u64().unwrap() as usize;
            assert_eq!(result["artifactRef"], metadata.artifact_id);
            assert_eq!(result["sha256"], metadata.sha256);
            assert_eq!(result["sizeBytes"], original.len());
            assert_eq!(result["offset"], offset);
            assert_eq!(result["maxBytes"], applied);
            assert_eq!(result["readBytes"], excerpt.len());
            assert!(excerpt.len() <= applied);
            assert_eq!(next, offset + excerpt.len());
            assert!(next > offset, "non-final pages must make progress");
            assert!(original.is_char_boundary(next));
            assert_eq!(result["hasMore"], next < original.len());
            recovered.push_str(excerpt);
            offset = next;
            if result["hasMore"] == false {
                break;
            }
        }
        assert_eq!(recovered, original);
        let eof = read_result(
            &sessions,
            &artifacts,
            "source",
            json!({"artifactId":metadata.artifact_id,"offset":offset}),
        )
        .unwrap();
        assert_eq!(eof["untrustedExcerpt"], "");
        assert_eq!(eof["readBytes"], 0);
        assert_eq!(eof["nextOffset"], original.len());
        assert_eq!(eof["hasMore"], false);
    }
    assert!(read_result(
        &sessions,
        &artifacts,
        "other",
        json!({"artifactId":metadata.artifact_id,"maxBytes":usize::MAX})
    )
    .unwrap_err()
    .contains("this session"));
}

#[test]
fn tool_result_pages_preserve_utf8_boundaries_and_reject_invalid_arguments() {
    let (_root, sessions, artifacts) = stores();
    let (metadata, original) = stored_repository_output(&sessions, &artifacts);
    let (position, character) = original
        .char_indices()
        .find(|(_, ch)| !ch.is_ascii())
        .unwrap();
    assert!(position > 0 && original.is_char_boundary(position - 1));
    let page = read_result(
        &sessions,
        &artifacts,
        "source",
        json!({"artifactId":metadata.artifact_id,"offset":position-1,"maxBytes":character.len_utf8()}),
    )
    .unwrap();
    assert_eq!(page["untrustedExcerpt"], &original[position - 1..position]);
    assert_eq!(page["readBytes"], 1);
    assert_eq!(page["nextOffset"], position);
    assert_eq!(page["hasMore"], true);
    let next = read_result(
        &sessions,
        &artifacts,
        "source",
        json!({"artifactId":metadata.artifact_id,"offset":page["nextOffset"]}),
    )
    .unwrap();
    assert!(next["untrustedExcerpt"]
        .as_str()
        .unwrap()
        .starts_with(character));
    for max_bytes in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!("2048"),
        Value::Null,
        json!(true),
    ] {
        assert!(
            read_result(
                &sessions,
                &artifacts,
                "source",
                json!({"artifactId":metadata.artifact_id,"maxBytes":max_bytes})
            )
            .is_err(),
            "invalid maxBytes must be rejected: {max_bytes}"
        );
    }
    assert!(read_result(
        &sessions,
        &artifacts,
        "source",
        json!({"artifactId":metadata.artifact_id,"offset":position,"maxBytes":character.len_utf8()-1})
    )
    .unwrap_err()
    .contains("omit it"));
    for offset in [
        json!(position + 1),
        json!(original.len() + 1),
        json!(-1),
        json!(1.5),
        json!("0"),
        Value::Null,
    ] {
        assert!(
            read_result(
                &sessions,
                &artifacts,
                "source",
                json!({"artifactId":metadata.artifact_id,"offset":offset})
            )
            .is_err(),
            "invalid offset must be rejected: {offset}"
        );
    }
}

#[test]
fn tool_result_schema_allows_default_paging_and_oversized_requests() {
    let tool = crate::agent_runtime::model_tools::default_model_tools()
        .into_iter()
        .find(|tool| tool.name == READ_TOOL_RESULT)
        .unwrap();
    let schema = tool.input_schema;
    assert_eq!(schema["required"], json!(["artifactId"]));
    assert_eq!(schema["properties"]["offset"]["default"], 0);
    assert_eq!(schema["properties"]["maxBytes"]["default"], 2048);
    assert_eq!(schema["properties"]["maxBytes"]["minimum"], 1);
    assert!(schema["properties"]["maxBytes"].get("maximum").is_none());
}

#[test]
fn terminal_observations_and_complete_skill_bodies_are_never_offloaded() {
    let (_root, sessions, artifacts) = stores();
    let mut request = ModelRequest {
        request_id: "read".into(),
        surface_generation: 0,
        system_prompt: String::new(),
        tools: crate::agent_runtime::model_tools::default_model_tools()
            .into_iter()
            .filter(|tool| tool.name == READ_TOOL_RESULT)
            .collect(),
        messages: ["read_terminal", "wait_terminal", "skill"]
            .into_iter()
            .map(|name| ModelMessage::Tool {
                call_id: name.into(),
                provider_call_id: None,
                name: name.into(),
                content: include_str!("../../../../AGENTS.md").into(),
            })
            .collect(),
    };
    let original = request.clone();
    bound_request_results(
        &sessions,
        &artifacts,
        "source",
        "turn",
        "step",
        &mut request,
        &pressure_budget(),
    )
    .unwrap();
    assert_eq!(request, original);
    assert!(!sessions
        .all_events("source")
        .unwrap()
        .iter()
        .any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ContextArtifact { .. }
        )));
}

#[test]
fn flat_human_answers_stay_complete_without_artifact_or_payload_changes() {
    let (_root, sessions, artifacts) = stores();
    let source = include_str!("../../../../AGENTS.md");
    let custom = source
        .char_indices()
        .take_while(|(offset, ch)| offset + ch.len_utf8() <= 7000)
        .map(|(_, ch)| ch)
        .collect::<String>();
    let content =
        json!({"answers":[{"id":"instructions","selected":[],"custom":custom}]}).to_string();
    let budget = pressure_budget();
    assert!(content.len() as u64 > budget.usable_input_tokens * 4 / 16);
    let mut request = ModelRequest {
        request_id: "answers".into(),
        surface_generation: 0,
        system_prompt: String::new(),
        tools: crate::agent_runtime::model_tools::default_model_tools(),
        messages: vec![ModelMessage::Tool {
            call_id: "question".into(),
            provider_call_id: None,
            name: "ask_user_question".into(),
            content,
        }],
    };
    let original = request.clone();
    for _ in 0..2 {
        bound_request_results(
            &sessions,
            &artifacts,
            "source",
            "turn",
            "step",
            &mut request,
            &budget,
        )
        .unwrap();
        assert_eq!(request, original);
    }
    assert!(!sessions
        .all_events("source")
        .unwrap()
        .iter()
        .any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ContextArtifact { .. }
        )));
}

#[test]
fn replay_artifacts_are_inaccessible_and_tampered_results_are_rejected() {
    let (root, sessions, artifacts) = stores();
    let private = artifacts
        .store_json(
            "source",
            "structured-compaction",
            "Private context",
            &json!({"source":include_str!("../../../../AGENTS.md")}),
        )
        .unwrap();
    publish_artifact(&sessions, "source", "turn", "step", &private).unwrap();
    assert!(read_result(
        &sessions,
        &artifacts,
        "source",
        json!({"artifactId":private.artifact_id,"offset":0,"maxBytes":2048})
    )
    .is_err());
    let data = artifacts
        .store_json(
            "source",
            "tool-result",
            "Repository contents",
            &json!({"source":include_str!("../../../../AGENTS.md")}),
        )
        .unwrap();
    publish_artifact(&sessions, "source", "turn", "step", &data).unwrap();
    let path = root
        .path()
        .join("agent-runtime/artifacts-v2/source")
        .join(format!("{}.bin", data.artifact_id));
    std::fs::write(path, include_str!("../../../../AGENTS.md")).unwrap();
    assert!(read_result(
        &sessions,
        &artifacts,
        "source",
        json!({"artifactId":data.artifact_id,"offset":0,"maxBytes":2048})
    )
    .unwrap_err()
    .contains("tampered"));
}
