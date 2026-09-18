use super::*;
include!("inbox_steer.rs");

#[test]
fn snapshot_uncertainty_tracks_dispatched_tools_until_their_exact_result() {
    let event = |seq, step: &str, payload| {
        AgentSessionEvent::new(
            "session".into(),
            seq,
            1_000 + seq,
            Some("turn".into()),
            Some(step.into()),
            payload,
        )
    };
    let dispatched = event(
        0,
        "step-1",
        AgentSessionEventPayload::ToolExecution {
            call_id: "call-1".into(),
            status: super::super::AgentToolExecutionStatus::Dispatched,
            idempotency: "no".into(),
        },
    );
    let result = event(
        1,
        "step-1",
        AgentSessionEventPayload::ToolResult {
            call_id: "call-1".into(),
            name: "exec_command".into(),
            status: super::super::AgentToolResultStatus::Completed,
            summary: "done".into(),
            data: None,
            duration_ms: None,
            evidence_refs: Vec::new(),
        },
    );
    assert!(has_uncertain_tool_executions(&[dispatched.clone()]));
    assert!(!has_uncertain_tool_executions(&[
        dispatched.clone(),
        result.clone()
    ]));
    let uncertain = AgentSessionEvent {
        payload: AgentSessionEventPayload::ToolResult {
            call_id: "call-1".into(),
            name: "terminal_execute".into(),
            status: super::super::AgentToolResultStatus::Uncertain,
            summary: "cooperative completion was lost".into(),
            data: Some(serde_json::json!({ "state": "uncertain", "noAutoReplay": true })),
            duration_ms: None,
            evidence_refs: Vec::new(),
        },
        ..result.clone()
    };
    assert!(has_uncertain_tool_executions(&[
        dispatched.clone(),
        uncertain,
    ]));
    let wrong_step = AgentSessionEvent {
        step_id: Some("step-2".into()),
        ..result
    };
    assert!(has_uncertain_tool_executions(&[dispatched, wrong_step]));
}

#[test]
fn stream_delta_validation_accepts_provider_whitespace_but_rejects_oversized_chunks() {
    assert_eq!(validate_optional_stream_delta(None, "stream delta"), Ok(()));
    assert_eq!(
        validate_optional_stream_delta(Some(""), "stream delta"),
        Ok(())
    );
    assert_eq!(
        validate_optional_stream_delta(Some(" \r\n\t"), "stream delta"),
        Ok(())
    );
    assert_eq!(
        validate_optional_stream_delta(
            Some(&"x".repeat(MAX_AGENT_STREAM_DELTA_BYTES)),
            "stream delta",
        ),
        Ok(())
    );
    assert_eq!(
        validate_optional_stream_delta(
            Some(&"x".repeat(MAX_AGENT_STREAM_DELTA_BYTES + 1)),
            "stream delta",
        ),
        Err(format!(
            "stream delta exceeds {MAX_AGENT_STREAM_DELTA_BYTES} bytes"
        ))
    );
}

fn configured() -> (tempfile::TempDir, AgentSessionStore) {
    let root = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    store.configure(root.path().to_path_buf()).unwrap();
    (root, store)
}

fn create(store: &AgentSessionStore) {
    store
        .create(CreateAgentSessionRequest {
            session_id: "session-1".into(),
            task_id: "task-1".into(),
            goal: "Inspect nginx".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: None,
            permission_mode: None,
            execution_surface: crate::agent_runtime::AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
}

fn message(id: &str, content: &str) -> AgentInboxMessage {
    AgentInboxMessage {
        images: Vec::new(),
        message_id: id.into(),
        client_submission_id: Some(id.into()),
        content: content.into(),
        source: AgentMessageSource::user(),
        terminal_context: None,
    }
}

fn log_path(root: &tempfile::TempDir) -> PathBuf {
    root.path()
        .join("agent-runtime/sessions-v5/session-1.jsonl")
}

fn begin_prepared_request(store: &AgentSessionStore) -> crate::llm::runtime::RequestSnapshot {
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::StepStart,
        )
        .unwrap();
    let snapshot = crate::llm::runtime::RequestSnapshot::Prepared {
        route_id: "route-a".into(),
        route_revision: 4,
        adapter_id: "chat-completions".into(),
        model_id: "model-a".into(),
        catalog_version: 1,
        capabilities: crate::llm::catalog::fixture_definition(
            crate::llm::config::AiProviderKind::OpenAiCompatible,
            8192,
        ),
        endpoint_identity: "https://example.test/v1/chat/completions".into(),
        replay_domain_id: "domain-a".into(),
        reasoning_effort: None,
        output_tokens: 8192,
        retry_policy: Default::default(),
        timeouts: Default::default(),
        purpose: "step".into(),
        preparation_version: 1,
        projection_policy: "immutable-png-v1-strict".into(),
        content_hash: crate::llm::runtime::digest(b"request"),
        images: Vec::new(),
    };
    let series = crate::agent_runtime::AgentRequestSeries {
        series_id: "series-1".into(),
        request_index: 0,
        starts_series: true,
    };
    store
        .append_batch(
            "session-1",
            vec![
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::RequestHeader {
                        request_id: "request-1".into(),
                        snapshot: snapshot.clone(),
                        snapshot_digest: snapshot.digest(),
                        provider_id: "route-a".into(),
                        model: "model-a".into(),
                        reasoning_effort: None,
                        reason: crate::agent_runtime::AgentRequestReason::Initial,
                        series: series.clone(),
                        snapshot_reason: crate::agent_runtime::AgentRequestSnapshotReason::Initial,
                        system_prompt: "system".into(),
                        tool_schemas: Vec::new(),
                        attempt: 1,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::RequestStart {
                        request_id: "request-1".into(),
                        header_request_id: "request-1".into(),
                        provider_id: "route-a".into(),
                        model: "model-a".into(),
                        reasoning_effort: None,
                        reason: crate::agent_runtime::AgentRequestReason::Initial,
                        series,
                        attempt: 1,
                    },
                },
            ],
        )
        .unwrap();
    snapshot
}

#[test]
fn execution_surface_is_persisted_in_session_created_and_restored_from_header() {
    let (root, store) = configured();
    let snapshot = store
        .create(CreateAgentSessionRequest {
            session_id: "visible-session".into(),
            task_id: "visible-task".into(),
            goal: "Show commands in the bound terminal".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: None,
            permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
            execution_surface: AgentExecutionSurface::BoundTerminal,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    assert_eq!(
        snapshot.header.execution_surface,
        AgentExecutionSurface::BoundTerminal
    );
    assert!(matches!(
        &store.all_events("visible-session").unwrap()[0].payload,
        AgentSessionEventPayload::SessionCreated {
            execution_surface: AgentExecutionSurface::BoundTerminal,
            ..
        }
    ));

    drop(store);
    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restarted
            .snapshot("visible-session")
            .unwrap()
            .header
            .execution_surface,
        AgentExecutionSurface::BoundTerminal
    );
}

#[test]
fn pre_surface_semantics_v1_sessions_restore_frozen_values_without_rewrite() {
    let root = tempfile::tempdir().unwrap();
    let sessions_root = root.path().join("agent-runtime/sessions-v5");
    fs::create_dir_all(&sessions_root).unwrap();
    let fixtures = [
        (
            "pre-semantics-direct",
            "direct",
            AgentExecutionSurface::Direct,
        ),
        (
            "pre-semantics-visible",
            "boundTerminal",
            AgentExecutionSurface::BoundTerminal,
        ),
    ];
    let mut persisted = Vec::new();
    for (session_id, stored_surface, _) in fixtures {
        let bytes = format!(
            "{}\n",
            serde_json::json!({
                "version": 5,
                "sessionId": session_id,
                "seq": 0,
                "timeUnixMs": 1_000,
                "type": "session/created",
                "data": {
                    "taskId": format!("task-{session_id}"),
                    "goal": "Restore a session persisted before Phase 1 semantics",
                    "executionSurface": stored_surface,
                },
            })
        )
        .into_bytes();
        let path = sessions_root.join(format!("{session_id}.jsonl"));
        fs::write(&path, &bytes).unwrap();
        persisted.push((path, bytes));
    }

    let store = AgentSessionStore::default();
    store.configure(root.path().to_path_buf()).unwrap();

    for (session_id, _, expected_surface) in fixtures {
        assert_eq!(
            store.snapshot(session_id).unwrap().header.execution_surface,
            expected_surface
        );
    }
    for (path, original_bytes) in persisted {
        assert_eq!(fs::read(path).unwrap(), original_bytes);
    }
}

#[test]
fn terminal_continuation_links_full_history_without_rebinding_the_old_target() {
    let (root, store) = configured();
    let old_target = target();
    store
        .create(CreateAgentSessionRequest {
            session_id: "historical-root".into(),
            task_id: "historical-task".into(),
            goal: "Explain the result".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: Some(old_target.clone()),
            permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
            execution_surface: AgentExecutionSurface::Direct,
            success_criteria: vec!["Explain the result".into()],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    let new_target = AgentSessionTarget {
        target_id: "target-2".into(),
        session_id: "terminal-2".into(),
        ..old_target.clone()
    };
    let continued = CreateAgentSessionRequest {
        session_id: "continued-root".into(),
        task_id: "continued-task".into(),
        goal: "Explain the result".into(),
        parent_session_id: None,
        continued_from_session_id: Some("historical-root".into()),
        target: Some(new_target.clone()),
        permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
        execution_surface: AgentExecutionSurface::Direct,
        success_criteria: vec!["Explain the result".into()],
        capability_scope: None,
        subagent: None,
    };
    assert!(store
        .create(CreateAgentSessionRequest {
            target: Some(old_target.clone()),
            ..continued.clone()
        })
        .is_err());
    let snapshot = store.create(continued).unwrap();
    assert_eq!(
        snapshot.header.continued_from_session_id.as_deref(),
        Some("historical-root")
    );
    assert_eq!(snapshot.header.target.as_ref(), Some(&new_target));
    assert_eq!(
        store
            .snapshot("historical-root")
            .unwrap()
            .header
            .target
            .as_ref(),
        Some(&old_target)
    );
    store.archive("historical-root").unwrap();
    assert!(store
        .delete_archived("historical-root")
        .unwrap_err()
        .contains("referenced"));

    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restored
            .snapshot("continued-root")
            .unwrap()
            .header
            .continued_from_session_id
            .as_deref(),
        Some("historical-root")
    );
}

#[test]
fn terminal_continuation_model_context_excludes_old_tool_effects() {
    let (_root, store) = configured();
    let old_target = target();
    store
        .create(CreateAgentSessionRequest {
            session_id: "historical-root".into(),
            task_id: "historical-task".into(),
            goal: "Explain the result".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: Some(old_target.clone()),
            permission_mode: None,
            execution_surface: AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    store
        .append(
            "historical-root",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    store
        .append(
            "historical-root",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::StepStart,
        )
        .unwrap();
    store
        .append(
            "historical-root",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::UserMessage {
                message: message("old-question", "What happened before the terminal closed?"),
            },
        )
        .unwrap();
    store
        .create(CreateAgentSessionRequest {
            session_id: "continued-root".into(),
            task_id: "continued-task".into(),
            goal: "Explain the result".into(),
            parent_session_id: None,
            continued_from_session_id: Some("historical-root".into()),
            target: Some(AgentSessionTarget {
                target_id: "target-2".into(),
                session_id: "terminal-2".into(),
                ..old_target
            }),
            permission_mode: None,
            execution_surface: AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    let inherited = store.inherited_surface("continued-root").unwrap().unwrap();
    assert_eq!(inherited.messages.len(), 1);
    let AgentSurfaceMessage::User {
        content, source, ..
    } = &inherited.messages[0]
    else {
        panic!("historical context should be a single source-attributed message")
    };
    assert_eq!(source.kind, AgentMessageSourceKind::SessionReference);
    assert!(content.contains("What happened before the terminal closed?"));
    assert!(content.contains("Never retry them automatically"));
    assert!(content.contains("ask for clarification without calling tools"));
}

#[test]
fn prepared_response_may_omit_replay_only_for_redacted_ephemeral_terminal_arguments() {
    let (root, store) = configured();
    create(&store);
    begin_prepared_request(&store);

    let missing_replay = store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::AssistantMessage {
                message_id: "ordinary-response".into(),
                content: vec![AgentAssistantContentBlock::Text {
                    text: "ordinary response".into(),
                }],
                usage: crate::agent_runtime::AgentTokenUsage::default(),
                stop_reason: crate::agent_runtime::AgentStopReason::Stop,
                interrupted: false,
                replay: None,
            },
        )
        .unwrap_err();
    assert!(missing_replay.contains("REPLAY_CAPTURE_MISSING"));

    let call = super::super::recorded_tool_call(crate::llm::types::ModelToolCall {
        call_id: "write-1".into(),
        provider_call_id: None,
        name: "write_terminal_input".into(),
        arguments: serde_json::json!({
            "inputKind": "text",
            "text": "systemctl status nginx\n",
        }),
    });
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::AssistantMessage {
                message_id: "ephemeral-terminal-response".into(),
                content: vec![AgentAssistantContentBlock::ToolCall {
                    call: Box::new(call),
                }],
                usage: crate::agent_runtime::AgentTokenUsage::default(),
                stop_reason: crate::agent_runtime::AgentStopReason::ToolCalls,
                interrupted: false,
                replay: None,
            },
        )
        .unwrap();

    let encoded = serde_json::to_string(&store.all_events("session-1").unwrap()).unwrap();
    assert!(!encoded.contains("systemctl status nginx"));
    assert!(encoded.contains("contentPersisted"));
    drop(store);

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert!(restarted.snapshot("session-1").is_ok());
}

#[test]
fn ui_pages_hide_private_replay_while_restart_keeps_same_domain_authority() {
    let (root, store) = configured();
    create(&store);
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::StepStart,
        )
        .unwrap();
    let snapshot = crate::llm::runtime::RequestSnapshot::Prepared {
        route_id: "route-a".into(),
        route_revision: 4,
        adapter_id: "chat-completions".into(),
        model_id: "model-a".into(),
        catalog_version: 1,
        capabilities: crate::llm::catalog::fixture_definition(
            crate::llm::config::AiProviderKind::OpenAiCompatible,
            8192,
        ),
        endpoint_identity: "https://example.test/v1/chat/completions".into(),
        replay_domain_id: "domain-a".into(),
        reasoning_effort: None,
        output_tokens: 8192,
        retry_policy: Default::default(),
        timeouts: Default::default(),
        purpose: "step".into(),
        preparation_version: 1,
        projection_policy: "immutable-png-v1-strict".into(),
        content_hash: crate::llm::runtime::digest(b"request"),
        images: Vec::new(),
    };
    let series = crate::agent_runtime::AgentRequestSeries {
        series_id: "series-1".into(),
        request_index: 0,
        starts_series: true,
    };
    store
        .append_batch(
            "session-1",
            vec![
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::RequestHeader {
                        request_id: "request-1".into(),
                        snapshot: snapshot.clone(),
                        snapshot_digest: snapshot.digest(),
                        provider_id: "route-a".into(),
                        model: "model-a".into(),
                        reasoning_effort: None,
                        reason: crate::agent_runtime::AgentRequestReason::Initial,
                        series: series.clone(),
                        snapshot_reason: crate::agent_runtime::AgentRequestSnapshotReason::Initial,
                        system_prompt: "system".into(),
                        tool_schemas: Vec::new(),
                        attempt: 1,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::RequestStart {
                        request_id: "request-1".into(),
                        header_request_id: "request-1".into(),
                        provider_id: "route-a".into(),
                        model: "model-a".into(),
                        reasoning_effort: None,
                        reason: crate::agent_runtime::AgentRequestReason::Initial,
                        series,
                        attempt: 1,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-1".into()),
                    payload: AgentSessionEventPayload::RequestStart {
                        request_id: "request-2".into(),
                        header_request_id: "request-1".into(),
                        provider_id: "route-a".into(),
                        model: "model-a".into(),
                        reasoning_effort: None,
                        reason: crate::agent_runtime::AgentRequestReason::Retry,
                        series: crate::agent_runtime::AgentRequestSeries {
                            series_id: "series-1".into(),
                            request_index: 1,
                            starts_series: false,
                        },
                        attempt: 2,
                    },
                },
            ],
        )
        .unwrap();
    let model_content = vec![crate::llm::types::ModelContentBlock::Reasoning {
        text: "display reasoning".into(),
        provider_item: None,
    }];
    let envelope = crate::llm::replay::prepare_envelope(
        crate::llm::registry::replay_codec("chat-completions").unwrap(),
        "request-2",
        &snapshot,
        &model_content,
        crate::llm::types::AdapterReplayCapture {
            response: serde_json::json!({"id":"private-response-id"}),
            blocks: vec![serde_json::json!({"reasoningDetails":[{
                "type":"reasoning.text", "text":"display reasoning",
                "signature":"private-reasoning-signature"
            }]})],
        },
    )
    .unwrap();
    let published = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&published);
    store
        .set_publisher(Arc::new(move |event| {
            observed.lock().unwrap().push(event.clone());
        }))
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::AssistantMessage {
                message_id: "assistant-1".into(),
                content: vec![AgentAssistantContentBlock::Reasoning {
                    text: "display reasoning".into(),
                    provider_item: None,
                }],
                usage: crate::agent_runtime::AgentTokenUsage::default(),
                stop_reason: crate::agent_runtime::AgentStopReason::Stop,
                interrupted: false,
                replay: Some(crate::agent_runtime::AgentStoredReplay::inline(envelope)),
            },
        )
        .unwrap();

    let raw = serde_json::to_string(&store.all_events("session-1").unwrap()).unwrap();
    assert!(raw.contains("private-response-id"));
    assert!(raw.contains("private-reasoning-signature"));
    let public = serde_json::to_string(
        &store
            .events_page(AgentSessionEventsRequest {
                session_id: "session-1".into(),
                cursor: None,
                limit: 100,
            })
            .unwrap(),
    )
    .unwrap();
    assert!(!public.contains("private-response-id"));
    assert!(!public.contains("private-reasoning-signature"));
    assert!(!public.contains("providerItem"));
    let public_event = store
        .events_page(AgentSessionEventsRequest {
            session_id: "session-1".into(),
            cursor: Some(7),
            limit: 1,
        })
        .unwrap()
        .events
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(published.lock().unwrap().as_slice(), &[public_event]);

    let mut corrupt = store.all_events("session-1").unwrap();
    let replay = corrupt
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            AgentSessionEventPayload::AssistantMessage {
                replay:
                    Some(crate::agent_runtime::AgentStoredReplay::Inline(
                        crate::llm::replay::ReplayEnvelopeV5::Prepared { blocks, .. },
                    )),
                ..
            } => Some(blocks),
            _ => None,
        });
    replay.unwrap()[0].content_hash = "0".repeat(64);
    assert!(validate_session_events(corrupt)
        .unwrap_err()
        .contains("REPLAY_BLOCK_MISMATCH"));
    let mut wrong_attempt = store.all_events("session-1").unwrap();
    if let Some(crate::agent_runtime::AgentStoredReplay::Inline(
        crate::llm::replay::ReplayEnvelopeV5::Prepared { source, .. },
    )) = wrong_attempt
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            AgentSessionEventPayload::AssistantMessage { replay, .. } => replay.as_mut(),
            _ => None,
        })
    {
        source.request_id = "request-1".into();
    }
    assert!(validate_session_events(wrong_attempt)
        .unwrap_err()
        .contains("REPLAY_SOURCE_MISMATCH"));

    drop(store);
    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    let restarted_raw = restarted.all_events("session-1").unwrap();
    assert!(serde_json::to_string(&restarted_raw)
        .unwrap()
        .contains("private-reasoning-signature"));
    let surface = restarted.snapshot("session-1").unwrap().surface;
    let mut request = crate::llm::types::ModelRequest::from_surface(
        "request-2".into(),
        &surface,
        "system".into(),
        Vec::new(),
    );
    crate::llm::replay::project_history(
        crate::llm::registry::replay_codec("chat-completions").unwrap(),
        &mut request.messages,
        crate::llm::replay::ReplayTarget {
            route_id: "route-a",
            model_id: "model-a",
            replay_domain_id: "domain-a",
        },
    )
    .unwrap();
    assert!(serde_json::to_string(&request.messages)
        .unwrap()
        .contains("private-reasoning-signature"));
}

#[test]
fn request_starts_require_current_snapshots_and_contiguous_series() {
    let (_root, store) = configured();
    create(&store);
    let append = |value| {
        store.append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            serde_json::from_value(value).unwrap(),
        )
    };
    let mut start = serde_json::json!({
        "type": "request/start", "data": {
            "requestId": "request-1", "headerRequestId": "request-1",
            "providerId": "fake", "model": "fake", "reason": "initial", "attempt": 1,
            "series": { "seriesId": "series-1", "requestIndex": 0, "startsSeries": true }
        }
    });
    assert!(append(start.clone())
        .unwrap_err()
        .contains("recorded header snapshot"));
    let mut header = start.clone();
    header["type"] = "request/header".into();
    header["data"]
        .as_object_mut()
        .unwrap()
        .remove("headerRequestId");
    header["data"]["systemPrompt"] = "".into();
    header["data"]["toolSchemas"] = serde_json::json!([]);
    header["data"]["snapshotReason"] = "initial".into();
    let snapshot = crate::llm::runtime::RequestSnapshot::Prepared {
        route_id: "fake".into(),
        route_revision: 1,
        adapter_id: "chat-completions".into(),
        model_id: "fake".into(),
        catalog_version: 1,
        capabilities: crate::llm::catalog::fixture_definition(
            crate::llm::config::AiProviderKind::OpenAiCompatible,
            8192,
        ),
        endpoint_identity: "https://example.test/v1/chat/completions".into(),
        replay_domain_id: "domain".into(),
        reasoning_effort: None,
        output_tokens: 2048,
        retry_policy: Default::default(),
        timeouts: Default::default(),
        purpose: "step".into(),
        preparation_version: 1,
        projection_policy: "immutable-png-v1-strict".into(),
        content_hash: crate::llm::runtime::digest(b"request"),
        images: Vec::new(),
    };
    header["data"]["snapshot"] = serde_json::to_value(&snapshot).unwrap();
    header["data"]["snapshotDigest"] = snapshot.digest().into();
    append(header).unwrap();
    append(start.clone()).unwrap();
    assert!(append(start.clone())
        .unwrap_err()
        .contains("already committed"));
    start["data"]["requestId"] = "request-2".into();
    start["data"]["series"]["requestIndex"] = 1.into();
    start["data"]["series"]["startsSeries"] = false.into();
    start["data"]["headerRequestId"] = "missing".into();
    assert!(append(start.clone())
        .unwrap_err()
        .contains("current matching header"));
    start["data"]["headerRequestId"] = "request-1".into();
    start["data"]["model"] = "different-model".into();
    assert!(append(start.clone())
        .unwrap_err()
        .contains("current matching header"));
    start["data"]["model"] = "fake".into();
    start["data"]["series"]["requestIndex"] = 3.into();
    assert!(append(start.clone())
        .unwrap_err()
        .contains("not contiguous"));
    start["data"]["series"]["requestIndex"] = 1.into();
    append(start).unwrap();
}
fn target() -> AgentSessionTarget {
    AgentSessionTarget {
        kind: "local".into(),
        target_id: "target-1".into(),
        session_id: "terminal-1".into(),
        label: None,
        profile_id: None,
        host: None,
        port: None,
        username: None,
        cwd: Some("/tmp".into()),
        root_path: None,
        local_root: Some("/tmp".into()),
    }
}

fn child_request() -> (CreateAgentSessionRequest, AgentSessionEventPayload) {
    let scope = super::super::AgentCapabilityScope {
        tool_names: vec!["read_file".into()],
        effects: vec![super::super::AgentSessionEffect::ReadOnly],
        target_ids: vec!["target-1".into()],
    };
    let budget = super::super::AgentSubagentBudget {
        max_steps_per_turn: 4,
        max_turns: 1,
        max_tool_calls: 8,
        max_tokens: 8_192,
        timeout_ms: 60_000,
    };
    let metadata = AgentSubagentSession {
        descriptor_id: "descriptor-1".into(),
        parent_task_id: "task-1".into(),
        role: super::super::AgentSubagentRole::Explorer,
        continuable: false,
        depth: 1,
        inheritance: super::super::AgentSubagentInheritance::Blank,
        capability_scope: scope.clone(),
        target_scope: vec![target()],
        budget: budget.clone(),
        provider: super::super::AgentSubagentModel {
            route_id: "provider-1".into(),
            model_id: "test".into(),
            reasoning_effort: None,
            route_revision: Some(1),
        },
    };
    (
        CreateAgentSessionRequest {
            session_id: "child-1".into(),
            task_id: "child-task-1".into(),
            goal: "inspect".into(),
            parent_session_id: Some("session-1".into()),
            continued_from_session_id: None,
            target: Some(target()),
            permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
            execution_surface: crate::agent_runtime::AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: Some(scope.clone()),
            subagent: Some(metadata),
        },
        AgentSessionEventPayload::SubagentDescriptor {
            descriptor_id: "descriptor-1".into(),
            child_session_id: "child-1".into(),
            parent_session_id: "session-1".into(),
            parent_task_id: "task-1".into(),
            role: super::super::AgentSubagentRole::Explorer,
            continuable: false,
            depth: 1,
            inheritance: super::super::AgentSubagentInheritance::Blank,
            capability_scope: scope,
            target_scope: vec![target()],
            budget,
        },
    )
}

#[test]
fn child_session_and_parent_descriptor_are_committed_together() {
    let (_root, store) = configured();
    store
        .create(CreateAgentSessionRequest {
            session_id: "session-1".into(),
            task_id: "task-1".into(),
            goal: "parent".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: Some(target()),
            permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
            execution_surface: crate::agent_runtime::AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    let (request, descriptor) = child_request();
    store
        .create_child_with_descriptor("session-1", request, descriptor)
        .unwrap();
    assert_eq!(
        store
            .snapshot("child-1")
            .unwrap()
            .header
            .parent_session_id
            .as_deref(),
        Some("session-1")
    );
    assert!(store
            .all_events("session-1")
            .unwrap()
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::SubagentDescriptor { ref child_session_id, .. } if child_session_id == "child-1")));
}

#[test]
fn append_is_durable_sequential_redacted_and_published_after_commit() {
    let (root, store) = configured();
    let published = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&published);
    store
        .set_publisher(Arc::new(move |event| {
            observed.lock().unwrap().push(event.clone());
        }))
        .unwrap();
    create(&store);
    let snapshot = store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("message-1", "Authorization: Bearer plaintext-secret"),
        )
        .unwrap();
    assert_eq!(snapshot.event_count, 3);
    assert_eq!(snapshot.inbox.next_turn[0].content, "[REDACTED]");
    assert_eq!(published.lock().unwrap().len(), 3);

    let recovered = AgentSessionStore::default();
    recovered.configure(root.path().to_path_buf()).unwrap();
    let page = recovered
        .events_page(AgentSessionEventsRequest {
            session_id: "session-1".into(),
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    let encoded = fs::read_to_string(log_path(&root)).unwrap();
    assert!(!encoded.contains("plaintext-secret"));
    assert!(encoded.contains("\"taskId\""));
    assert!(encoded.contains("\"messageId\""));
}

#[test]
fn committed_event_backfill_uses_exclusive_after_seq() {
    let (_root, store) = configured();
    create(&store);
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("message-1", "inspect"),
        )
        .unwrap();
    let page = store
        .committed_events_page(AgentCommittedEventsRequest {
            session_id: "session-1".into(),
            after_seq: Some(1),
            limit: 16,
        })
        .unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![2]
    );
}

#[test]
fn ended_logs_archive_as_read_only_and_reload_from_the_archive_root() {
    let (root, store) = configured();
    create(&store);
    store.cancel("session-1").unwrap();
    let archived = store.archive("session-1").unwrap();
    assert!(archived.archived);
    assert!(!log_path(&root).exists());
    assert!(root
        .path()
        .join("agent-runtime/archives-v5/session-1.jsonl")
        .is_file());
    assert!(store
        .append(
            "session-1",
            None,
            None,
            AgentSessionEventPayload::TaskEvidence {
                evidence_id: "late".into(),
                kind: "invalid".into(),
                summary: "must not append".into(),
            },
        )
        .is_err());

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert!(restarted.snapshot("session-1").unwrap().archived);
}

#[test]
fn only_archived_logs_can_be_permanently_deleted() {
    let (root, store) = configured();
    create(&store);
    assert_eq!(
        store.delete_archived("session-1").unwrap_err(),
        "only an archived Agent Session can be deleted"
    );
    assert!(log_path(&root).is_file());

    store.cancel("session-1").unwrap();
    store.archive("session-1").unwrap();
    let archived_path = root
        .path()
        .join("agent-runtime/archives-v5/session-1.jsonl");
    assert!(archived_path.is_file());

    store.delete_archived("session-1").unwrap();
    assert!(!archived_path.exists());
    assert!(store.snapshot("session-1").is_err());

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert!(restarted.snapshot("session-1").is_err());
}

#[test]
fn v4_logs_are_ignored_without_migration_or_compatibility_reads() {
    let root = tempfile::tempdir().unwrap();
    let previous_root = root.path().join("agent-runtime/sessions-v4");
    fs::create_dir_all(&previous_root).unwrap();
    let previous_path = previous_root.join("session-previous.jsonl");
    let sentinel = b"{\"version\":4,\"sessionId\":\"session-previous\"}\n";
    fs::write(&previous_path, sentinel).unwrap();

    let store = AgentSessionStore::default();
    store.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(fs::read(&previous_path).unwrap(), sentinel);
    assert!(store.snapshot("session-previous").is_err());
    assert!(root.path().join("agent-runtime/sessions-v5").is_dir());
}

#[test]
fn restart_preserves_fifo_claims_and_message_id_tombstones() {
    let (root, store) = configured();
    create(&store);
    for id in ["turn-1", "turn-2"] {
        store
            .enqueue("session-1", AgentInboxLane::NextTurn, message(id, id))
            .unwrap();
    }
    for id in ["step-1", "step-2"] {
        store
            .enqueue("session-1", AgentInboxLane::NextStep, message(id, id))
            .unwrap();
    }
    assert_eq!(
        store.claim_turn("session-1").unwrap()[0].message_id,
        "turn-1"
    );
    assert_eq!(store.claim_step("session-1").unwrap().len(), 2);

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restarted.snapshot("session-1").unwrap().inbox.next_turn[0].message_id,
        "turn-2"
    );
    assert!(restarted
        .enqueue(
            "session-1",
            AgentInboxLane::NextStep,
            message("turn-1", "reuse")
        )
        .is_err());
}

#[test]
fn append_failure_does_not_update_memory_or_publish() {
    let (root, store) = configured();
    create(&store);
    let published = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&published);
    store
        .set_publisher(Arc::new(move |event| {
            observed.lock().unwrap().push(event.clone());
        }))
        .unwrap();
    let path = log_path(&root);
    fs::rename(&path, path.with_extension("saved")).unwrap();
    fs::create_dir(&path).unwrap();

    assert!(store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("message-failed", "must not appear"),
        )
        .is_err());
    let snapshot = store.snapshot("session-1").unwrap();
    assert_eq!(snapshot.event_count, 2);
    assert!(snapshot.inbox.next_turn.is_empty());
    assert!(published.lock().unwrap().is_empty());
}

#[test]
fn inbox_update_remove_and_reorder_commit_with_expected_revision() {
    let (root, store) = configured();
    create(&store);
    for (id, lane) in [
        ("turn-a", AgentInboxLane::NextTurn),
        ("turn-b", AgentInboxLane::NextTurn),
        ("step-a", AgentInboxLane::NextStep),
    ] {
        store.enqueue("session-1", lane, message(id, id)).unwrap();
    }

    let reordered = store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: 5,
            client_operation_id: "reorder-1".into(),
            mutation: AgentInboxMutation::Reorder {
                lane: AgentInboxLane::NextTurn,
                ordered_item_ids: vec!["turn-b".into(), "turn-a".into()],
            },
        })
        .unwrap();
    assert_eq!(reordered.event_count, 6);
    assert_eq!(reordered.inbox.next_turn[0].message_id, "turn-b");

    let updated = store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: 6,
            client_operation_id: "update-1".into(),
            mutation: AgentInboxMutation::Update {
                item_id: "turn-b".into(),
                content: "updated text".into(),
            },
        })
        .unwrap();
    assert_eq!(updated.inbox.next_turn[0].content, "updated text");

    let removed = store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: 7,
            client_operation_id: "remove-1".into(),
            mutation: AgentInboxMutation::Remove {
                item_id: "turn-a".into(),
            },
        })
        .unwrap();
    assert_eq!(removed.event_count, 8);
    assert_eq!(removed.inbox.next_turn.len(), 1);
    assert_eq!(removed.inbox.next_step[0].message_id, "step-a");
    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    let replayed = restarted.snapshot("session-1").unwrap();
    assert_eq!(replayed.inbox.next_turn[0].message_id, "turn-b");
    assert_eq!(replayed.inbox.next_turn[0].content, "updated text");
}

#[test]
fn inbox_mutations_reject_conflicts_claimed_missing_and_terminal_items() {
    let (_root, store) = configured();
    create(&store);
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("turn-a", "queued"),
        )
        .unwrap();

    let conflict = store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: 2,
            client_operation_id: "conflict-1".into(),
            mutation: AgentInboxMutation::Remove {
                item_id: "turn-a".into(),
            },
        })
        .unwrap_err();
    assert!(conflict.contains("current revision 3"));

    store.claim_turn("session-1").unwrap();
    let claimed_revision = store.snapshot("session-1").unwrap().event_count;
    assert!(store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: claimed_revision,
            client_operation_id: "claimed-1".into(),
            mutation: AgentInboxMutation::Update {
                item_id: "turn-a".into(),
                content: "late".into(),
            },
        })
        .unwrap_err()
        .contains("no longer queued"));
    assert!(store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: claimed_revision,
            client_operation_id: "missing-1".into(),
            mutation: AgentInboxMutation::Remove {
                item_id: "missing".into(),
            },
        })
        .unwrap_err()
        .contains("not found"));

    store.cancel("session-1").unwrap();
    let terminal_revision = store.snapshot("session-1").unwrap().event_count;
    assert!(store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: terminal_revision,
            client_operation_id: "terminal-1".into(),
            mutation: AgentInboxMutation::Reorder {
                lane: AgentInboxLane::NextTurn,
                ordered_item_ids: Vec::new(),
            },
        })
        .unwrap_err()
        .contains("terminal"));
    assert!(store
        .rename(AgentSessionRenameInput {
            session_id: "session-1".into(),
            expected_revision: terminal_revision,
            client_operation_id: "rename-terminal".into(),
            title: "Too late".into(),
        })
        .unwrap_err()
        .contains("terminal"));
}

#[test]
fn mutation_persistence_failure_keeps_snapshot_and_publish_unchanged() {
    let (root, store) = configured();
    create(&store);
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("turn-a", "before"),
        )
        .unwrap();
    let published = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&published);
    store
        .set_publisher(Arc::new(move |event| {
            observed.lock().unwrap().push(event.clone());
        }))
        .unwrap();
    let path = log_path(&root);
    fs::rename(&path, path.with_extension("saved")).unwrap();
    fs::create_dir(&path).unwrap();

    assert!(store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: 3,
            client_operation_id: "update-failed".into(),
            mutation: AgentInboxMutation::Update {
                item_id: "turn-a".into(),
                content: "after".into(),
            },
        })
        .is_err());
    let snapshot = store.snapshot("session-1").unwrap();
    assert_eq!(snapshot.event_count, 3);
    assert_eq!(snapshot.inbox.next_turn[0].content, "before");
    assert!(published.lock().unwrap().is_empty());
}

#[test]
fn mutation_publish_observes_the_already_committed_log() {
    let (root, store) = configured();
    create(&store);
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("turn-a", "before"),
        )
        .unwrap();
    let observed = Arc::new(Mutex::new(false));
    let callback_observed = Arc::clone(&observed);
    let path = log_path(&root);
    store
        .set_publisher(Arc::new(move |event| {
            if matches!(
                event.payload,
                AgentSessionEventPayload::InboxItemUpdated { .. }
            ) {
                let encoded = fs::read_to_string(&path).unwrap();
                *callback_observed.lock().unwrap() = encoded.contains("update-committed");
            }
        }))
        .unwrap();
    store
        .mutate_inbox(AgentInboxMutationInput {
            session_id: "session-1".into(),
            expected_revision: 3,
            client_operation_id: "update-committed".into(),
            mutation: AgentInboxMutation::Update {
                item_id: "turn-a".into(),
                content: "after".into(),
            },
        })
        .unwrap();
    assert!(*observed.lock().unwrap());
}

#[test]
fn client_submission_ids_are_idempotent_per_session_and_survive_restart() {
    let (root, store) = configured();
    create(&store);
    let first = store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("submission-1", "inspect"),
        )
        .unwrap();
    let retry = store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("submission-1", "inspect"),
        )
        .unwrap();
    assert_eq!(retry.event_count, first.event_count);
    assert!(store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("submission-1", "different"),
        )
        .is_err());

    store
        .create(CreateAgentSessionRequest {
            session_id: "session-2".into(),
            task_id: "task-2".into(),
            goal: "Other".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: None,
            permission_mode: None,
            execution_surface: crate::agent_runtime::AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    assert_eq!(
        store
            .enqueue(
                "session-2",
                AgentInboxLane::NextTurn,
                message("submission-1", "independent"),
            )
            .unwrap()
            .inbox
            .next_turn
            .len(),
        1
    );

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    let recovered = restarted.snapshot("session-1").unwrap();
    assert_eq!(
        recovered.inbox.next_turn[0].client_submission_id.as_deref(),
        Some("submission-1")
    );
    assert_eq!(
        restarted
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("submission-1", "inspect"),
            )
            .unwrap()
            .event_count,
        recovered.event_count
    );
}

#[test]
fn rename_is_durable_and_task_goal_cannot_override_the_manual_title() {
    let (root, store) = configured();
    create(&store);
    let renamed = store
        .rename(AgentSessionRenameInput {
            session_id: "session-1".into(),
            expected_revision: 2,
            client_operation_id: "rename-1".into(),
            title: "  手动标题  ".into(),
        })
        .unwrap();
    assert_eq!(renamed.header.title.as_deref(), Some("手动标题"));
    assert_eq!(renamed.header.goal, "Inspect nginx");
    store
        .append(
            "session-1",
            None,
            None,
            AgentSessionEventPayload::TaskLinked {
                task_id: "task-1".into(),
                goal: Some("Automatic title candidate".into()),
            },
        )
        .unwrap();
    assert_eq!(
        store.snapshot("session-1").unwrap().header.title.as_deref(),
        Some("手动标题")
    );

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restarted
            .snapshot("session-1")
            .unwrap()
            .header
            .title
            .as_deref(),
        Some("手动标题")
    );
}

#[test]
fn oversized_event_is_rejected_before_persistence() {
    let (_root, store) = configured();
    create(&store);
    let oversized = "x".repeat(MAX_SESSION_EVENT_BYTES);
    assert!(store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::ToolResult {
                call_id: "call-1".into(),
                name: "inspect".into(),
                status: crate::agent_runtime::AgentToolResultStatus::Completed,
                summary: "bounded summary".into(),
                data: Some(serde_json::json!({ "output": oversized })),
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
        )
        .is_err());
    assert_eq!(store.snapshot("session-1").unwrap().event_count, 2);
}

#[test]
fn cancel_discards_both_lanes_before_the_terminal_event() {
    let (_root, store) = configured();
    create(&store);
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("turn-1", "turn"),
        )
        .unwrap();
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextStep,
            message("step-1", "step"),
        )
        .unwrap();
    let snapshot = store.cancel("session-1").unwrap();
    assert!(snapshot.ended);
    assert_eq!(snapshot.status, AgentSessionStatus::Cancelled);
    assert!(snapshot.inbox.next_turn.is_empty());
    assert!(snapshot.inbox.next_step.is_empty());
    let page = store
        .events_page(AgentSessionEventsRequest {
            session_id: "session-1".into(),
            cursor: None,
            limit: 32,
        })
        .unwrap();
    let operations = page
        .events
        .iter()
        .filter_map(|event| match event.payload {
            AgentSessionEventPayload::InboxSpliced { operation, .. } => Some(operation),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        operations,
        vec![
            AgentInboxOperation::Enqueued,
            AgentInboxOperation::Enqueued,
            AgentInboxOperation::Discarded,
            AgentInboxOperation::Discarded,
        ]
    );
    assert!(store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("late", "late")
        )
        .is_err());
}

#[test]
fn ending_requires_an_empty_inbox_and_one_complete_terminal_transition() {
    let (_root, store) = configured();
    create(&store);
    store
        .enqueue(
            "session-1",
            AgentInboxLane::NextTurn,
            message("turn-1", "pending"),
        )
        .unwrap();
    assert!(store
        .append(
            "session-1",
            None,
            None,
            AgentSessionEventPayload::SessionEnded {
                status: AgentSessionStatus::Completed,
                reason: None,
            },
        )
        .is_err());
    store.claim_turn("session-1").unwrap();
    store
        .append(
            "session-1",
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Completed,
                reason: None,
            },
        )
        .unwrap();
    assert!(!store.snapshot("session-1").unwrap().ended);
    let snapshot = store
        .end("session-1", AgentSessionStatus::Completed, None)
        .unwrap();
    assert!(snapshot.ended);
    assert_eq!(snapshot.status, AgentSessionStatus::Completed);
}

#[test]
fn startup_discards_and_audits_only_an_uncommitted_bad_tail() {
    let (root, store) = configured();
    create(&store);
    let path = log_path(&root);
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(br#"{"version":1,"sessionId":"session-1""#)
        .unwrap();
    drop(store);

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(restarted.snapshot("session-1").unwrap().event_count, 2);
    let list = restarted
        .list_page(AgentSessionListRequest {
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(list.recovery_notices.len(), 1);
    assert_eq!(
        list.recovery_notices[0].action,
        AgentSessionRecoveryAction::BadTailDiscarded
    );
    assert!(root
        .path()
        .join("agent-runtime/sessions-v5")
        .read_dir()
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("bad-tail")));
}

#[test]
fn startup_quarantines_complete_corruption_without_hiding_the_notice() {
    let (root, store) = configured();
    create(&store);
    OpenOptions::new()
        .append(true)
        .open(log_path(&root))
        .unwrap()
        .write_all(b"not-json\n")
        .unwrap();
    drop(store);

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert!(restarted.snapshot("session-1").is_err());
    let list = restarted
        .list_page(AgentSessionListRequest {
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(list.sessions.len(), 0);
    assert_eq!(
        list.recovery_notices[0].action,
        AgentSessionRecoveryAction::CorruptLogQuarantined
    );
}

#[test]
fn strict_replay_rejects_sequence_version_identity_and_timestamp_drift() {
    let base = vec![
        AgentSessionEvent::new(
            "session-1".into(),
            0,
            1_000,
            None,
            None,
            AgentSessionEventPayload::SessionCreated {
                task_id: "task-1".into(),
                goal: "goal".into(),
                parent_session_id: None,
                continued_from_session_id: None,
                target: None,
                permission_mode: None,
                execution_surface: crate::agent_runtime::AgentExecutionSurface::Direct,
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            },
        ),
        AgentSessionEvent::new(
            "session-1".into(),
            1,
            1_001,
            None,
            None,
            AgentSessionEventPayload::AgentCreated {
                agent_id: "session-1".into(),
                parent_agent_id: None,
            },
        ),
    ];
    for mutation in ["seq", "version", "identity", "timestamp"] {
        let mut events = base.clone();
        match mutation {
            "seq" => events[1].seq = 2,
            "version" => events[1].version = 99,
            "identity" => events[1].session_id = "session-2".into(),
            "timestamp" => events[1].time_unix_ms = 999,
            _ => unreachable!(),
        }
        assert!(
            AgentSessionRecord::from_events(events).is_err(),
            "{mutation}"
        );
    }
}

#[test]
fn pagination_cursors_and_limits_are_bounded() {
    let (_root, store) = configured();
    create(&store);
    for index in 0..3 {
        store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message(&format!("message-{index}"), "queued"),
            )
            .unwrap();
    }
    let first = store
        .events_page(AgentSessionEventsRequest {
            session_id: "session-1".into(),
            cursor: None,
            limit: 2,
        })
        .unwrap();
    assert_eq!(first.events.len(), 2);
    assert_eq!(first.next_cursor, Some(2));
    let second = store
        .events_page(AgentSessionEventsRequest {
            session_id: "session-1".into(),
            cursor: first.next_cursor,
            limit: 10,
        })
        .unwrap();
    assert_eq!(second.events[0].seq, 2);
    assert!(store
        .events_page(AgentSessionEventsRequest {
            session_id: "session-1".into(),
            cursor: Some(99),
            limit: 1,
        })
        .is_err());
    assert!(store
        .events_page(AgentSessionEventsRequest {
            session_id: "session-1".into(),
            cursor: None,
            limit: 0,
        })
        .is_err());
}

#[test]
fn compaction_advances_one_generation_and_keeps_raw_events() {
    let (_root, store) = configured();
    create(&store);
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::StepStart,
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::UserMessage {
                message: message("surface-user", "old model-visible content"),
            },
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::StepEnd {
                reason: "completed".into(),
            },
        )
        .unwrap();
    let turn_end = store
        .append(
            "session-1",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnEnd {
                reason: "completed".into(),
            },
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-2".into()),
            Some("step-2".into()),
            AgentSessionEventPayload::CompactionSummary {
                summary: "bounded summary".into(),
                replaced_through_seq: turn_end.seq,
                surface_generation: 1,
            },
        )
        .unwrap();
    store
        .append(
            "session-1",
            Some("turn-2".into()),
            Some("step-2".into()),
            AgentSessionEventPayload::CompactionEnd {
                surface_generation: 1,
                replaced_through_seq: turn_end.seq,
                status: crate::agent_runtime::AgentCompactionStatus::Completed,
            },
        )
        .unwrap();

    let snapshot = store.snapshot("session-1").unwrap();
    assert_eq!(snapshot.surface.generation, 1);
    assert_eq!(snapshot.surface.replaced_through_seq, Some(turn_end.seq));
    assert!(matches!(
        &snapshot.surface.messages[0],
        crate::agent_runtime::AgentSurfaceMessage::User { content, .. }
            if content == "bounded summary"
    ));
    let raw = store
        .events_page(AgentSessionEventsRequest {
            session_id: "session-1".into(),
            cursor: None,
            limit: 32,
        })
        .unwrap();
    assert!(raw.events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::UserMessage { message }
            if message.content == "old model-visible content"
    )));
    let count_before = snapshot.event_count;
    assert!(store
        .append(
            "session-1",
            Some("turn-2".into()),
            Some("step-2".into()),
            AgentSessionEventPayload::CompactionSummary {
                summary: "invalid generation".into(),
                replaced_through_seq: turn_end.seq,
                surface_generation: 3,
            },
        )
        .is_err());
    assert_eq!(
        store.snapshot("session-1").unwrap().event_count,
        count_before
    );
}

#[cfg(unix)]
#[test]
fn persisted_directories_and_logs_are_private() {
    use std::os::unix::fs::PermissionsExt;

    let (root, store) = configured();
    create(&store);
    assert_eq!(
        fs::metadata(root.path().join("agent-runtime/sessions-v5"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(log_path(&root)).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn startup_quarantines_log_symlinks_without_following_them() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let root = tempfile::tempdir().unwrap();
    let first = AgentSessionStore::default();
    first.configure(root.path().to_path_buf()).unwrap();
    drop(first);
    let external = root.path().join("external.txt");
    fs::write(&external, b"external").unwrap();
    fs::set_permissions(&external, fs::Permissions::from_mode(0o644)).unwrap();
    symlink(
        &external,
        root.path()
            .join("agent-runtime/sessions-v5/session-link.jsonl"),
    )
    .unwrap();

    let restarted = AgentSessionStore::default();
    restarted.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        fs::metadata(&external).unwrap().permissions().mode() & 0o777,
        0o644
    );
    let page = restarted
        .list_page(AgentSessionListRequest {
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(
        page.recovery_notices[0].action,
        AgentSessionRecoveryAction::CorruptLogQuarantined
    );
}
