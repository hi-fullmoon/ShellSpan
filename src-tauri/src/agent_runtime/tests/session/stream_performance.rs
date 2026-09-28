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
