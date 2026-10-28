fn captured_stream_payloads() -> Vec<AgentScopedPayload> {
    let events: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../src/test/fixtures/agent-skills-runtime.json"
    ))
    .unwrap();
    events
        .into_iter()
        .filter(|event| event["type"] == "assistant/chunk")
        .map(|event| serde_json::from_value::<AgentSessionEvent>(event).unwrap())
        .map(|event| AgentScopedPayload {
            turn_id: event.turn_id,
            step_id: event.step_id,
            payload: event.payload,
        })
        .collect()
}

fn assert_cached_log_usage(store: &AgentSessionStore) {
    let mut inner = store.lock_configured().unwrap();
    let expected = total_log_bytes(inner.root.as_ref().unwrap()).unwrap()
        + total_log_bytes(inner.archive_root.as_ref().unwrap()).unwrap();
    assert_eq!(inner.log_bytes().unwrap(), expected);
}

#[test]
fn expanded_stream_chunks_keep_metadata_once_and_mixed_batches_atomic() {
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
    let published = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&published);
    store
        .set_publisher(Arc::new(move |event| {
            observer.lock().unwrap().push(event.clone());
        }))
        .unwrap();
    let source = " token=a".repeat(MAX_AGENT_STREAM_DELTA_BYTES / 8);
    let expected = redact_sensitive_text(&source);
    assert!(source.len() <= MAX_AGENT_STREAM_DELTA_BYTES);
    assert!(expected.len() > MAX_AGENT_STREAM_DELTA_BYTES * 2);
    let usage = super::super::AgentTokenUsage {
        output_tokens: Some(32),
        ..Default::default()
    };
    let chunk = AgentScopedPayload {
        turn_id: Some("turn-1".into()),
        step_id: Some("step-1".into()),
        payload: AgentSessionEventPayload::AssistantChunk {
            request_id: "request-1".into(),
            text_delta: Some(source.clone()),
            reasoning_delta: Some(String::new()),
            tool_call_delta: Some(super::super::AgentToolCallDelta {
                index: 3,
                call_id: Some("call-1".into()),
                name_delta: Some("run_command".into()),
                arguments_delta: Some(source),
            }),
            usage: Some(usage.clone()),
        },
    };
    let end = |reason: &str| AgentScopedPayload {
        turn_id: Some("turn-1".into()),
        step_id: Some("step-1".into()),
        payload: AgentSessionEventPayload::StepEnd {
            reason: reason.into(),
        },
    };
    let before = store.all_events("session-1").unwrap();
    let disk_before = fs::read(log_path(&root)).unwrap();
    assert!(store
        .append_batch(
            "session-1",
            vec![
                AgentScopedPayload {
                    turn_id: chunk.turn_id.clone(),
                    step_id: chunk.step_id.clone(),
                    payload: chunk.payload.clone(),
                },
                end("")
            ]
        )
        .is_err());
    assert_eq!(store.all_events("session-1").unwrap(), before);
    assert_eq!(fs::read(log_path(&root)).unwrap(), disk_before);
    assert!(published.lock().unwrap().is_empty());
    assert_cached_log_usage(&store);

    let events = store
        .append_batch("session-1", vec![chunk, end("complete")])
        .unwrap();
    assert_eq!(*published.lock().unwrap(), events);
    assert!(events.len() > 3);
    let mut text = String::new();
    let mut arguments = String::new();
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.seq, (before.len() + index) as u64);
        if let AgentSessionEventPayload::AssistantChunk {
            text_delta,
            reasoning_delta,
            tool_call_delta,
            usage: actual_usage,
            ..
        } = &event.payload
        {
            let delta = tool_call_delta.as_ref().unwrap();
            assert_eq!(delta.index, 3);
            assert_eq!(delta.call_id.as_deref(), (index == 0).then_some("call-1"));
            assert_eq!(
                delta.name_delta.as_deref(),
                (index == 0).then_some("run_command")
            );
            assert_eq!(*actual_usage, (index == 0).then(|| usage.clone()));
            assert_eq!(reasoning_delta.as_deref(), (index == 0).then_some(""));
            let piece = text_delta.as_deref().unwrap();
            let argument_piece = delta.arguments_delta.as_deref().unwrap();
            assert!(piece.len() <= MAX_AGENT_STREAM_DELTA_BYTES);
            assert!(argument_piece.len() <= MAX_AGENT_STREAM_DELTA_BYTES);
            text.push_str(piece);
            arguments.push_str(argument_piece);
        }
    }
    assert_eq!(text, expected);
    assert_eq!(arguments, expected);
    assert!(matches!(
        events.last().unwrap().payload,
        AgentSessionEventPayload::StepEnd { .. }
    ));
    assert_cached_log_usage(&store);
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        reopened.all_events("session-1").unwrap(),
        store.all_events("session-1").unwrap()
    );
    assert_cached_log_usage(&reopened);
}

#[test]
fn stream_batches_commit_atomically_and_replay_after_disk_failure() {
    let (root, store) = configured();
    create(&store);
    assert_cached_log_usage(&store);
    let path = log_path(&root);
    let published = Arc::new(Mutex::new(Vec::new()));
    let observed = published.clone();
    let observed_path = path.clone();
    store
        .set_publisher(Arc::new(move |event| {
            let persisted = fs::read_to_string(&observed_path).unwrap();
            let durable: AgentSessionEvent =
                serde_json::from_str(persisted.lines().nth(event.seq as usize).unwrap()).unwrap();
            assert_eq!(durable, *event, "published events must already be durable");
            observed.lock().unwrap().push(event.clone());
        }))
        .unwrap();

    let before = store.snapshot("session-1").unwrap();
    let disk_before = fs::read(&path).unwrap();
    let mut invalid = captured_stream_payloads();
    if let AgentSessionEventPayload::AssistantChunk { request_id, .. } =
        &mut invalid.last_mut().unwrap().payload
    {
        request_id.clear();
    }
    assert!(store.append_batch("session-1", invalid).is_err());
    assert_eq!(store.snapshot("session-1").unwrap(), before);
    assert_eq!(fs::read(&path).unwrap(), disk_before);
    assert!(published.lock().unwrap().is_empty());
    assert_cached_log_usage(&store);

    // Exercise the actual filesystem error path, without an injected writer.
    let saved = path.with_extension("saved");
    fs::rename(&path, &saved).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(store
        .append_batch("session-1", captured_stream_payloads())
        .is_err());
    assert_eq!(store.snapshot("session-1").unwrap(), before);
    assert!(published.lock().unwrap().is_empty());
    fs::remove_dir(&path).unwrap();
    fs::rename(&saved, &path).unwrap();

    let committed = store
        .append_batch("session-1", captured_stream_payloads())
        .unwrap();
    assert_eq!(committed, *published.lock().unwrap());
    assert_eq!(committed[0].seq, before.event_count);
    assert!(
        committed
            .windows(2)
            .all(|pair| pair[1].seq == pair[0].seq + 1
                && pair[1].time_unix_ms >= pair[0].time_unix_ms)
    );
    assert_eq!(store.snapshot("session-1").unwrap().surface, before.surface);
    assert_cached_log_usage(&store);
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        store.snapshot("session-1").unwrap(),
        reopened.snapshot("session-1").unwrap()
    );
    assert_cached_log_usage(&reopened);
}

#[test]
fn log_usage_tracks_streams_archives_and_deletion() {
    let (root, store) = configured();
    create(&store);
    store
        .append_batch("session-1", captured_stream_payloads())
        .unwrap();
    assert_cached_log_usage(&store);
    store.cancel("session-1").unwrap();
    assert_cached_log_usage(&store);
    store.archive("session-1").unwrap();
    assert_cached_log_usage(&store);
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_cached_log_usage(&reopened);
    reopened.delete_archived("session-1").unwrap();
    assert_cached_log_usage(&reopened);
    assert_eq!(reopened.lock_configured().unwrap().log_bytes, Some(0));
}

#[test]
#[ignore = "run explicitly to measure durable stream appends using recorded runtime output"]
fn durable_stream_append_scaling() {
    for history_batches in [0, 2_000] {
        let (_root, store) = configured();
        create(&store);
        let chunks = captured_stream_payloads();
        let copy_chunks = || {
            chunks
                .iter()
                .map(|chunk| AgentScopedPayload {
                    turn_id: chunk.turn_id.clone(),
                    step_id: chunk.step_id.clone(),
                    payload: chunk.payload.clone(),
                })
                .collect::<Vec<_>>()
        };
        let history = (0..history_batches)
            .flat_map(|_| copy_chunks())
            .collect::<Vec<_>>();
        if !history.is_empty() {
            store.append_batch("session-1", history).unwrap();
        }
        let mut samples = Vec::new();
        for _ in 0..100 {
            let start = std::time::Instant::now();
            store.append_batch("session-1", copy_chunks()).unwrap();
            samples.push(start.elapsed());
        }
        samples.sort();
        eprintln!(
            "durable stream history_batches={history_batches}: median={:?}, p95={:?}",
            samples[50], samples[95]
        );
    }
}
