// These tests use the real session store and filesystem, without a model adapter.
#[test]
fn incremental_loop_counts_match_full_history_for_long_and_alternating_turns() {
    for period in 1..=5 {
        let mut progress = super::super::driver_progress::LoopProgress::default();
        let mut events = Vec::new();
        for index in 0..80 {
            let step = repeated_step(
                &format!("step-{index}"),
                &format!("call-{index}"),
                &format!("observation-{}", index % period),
                index == 40,
                index * 10,
            );
            for event in &step {
                progress.observe(event);
            }
            events.extend(step);
            assert_eq!(
                progress.counts("turn-1").1,
                repeated_tool_step_streak_bounded(&events, "turn-1", usize::MAX),
                "period={period}, step={index}"
            );
        }
        assert_eq!(progress.counts("other-turn"), (0, 0));
        progress.observe(&event(1_000, AgentSessionEventPayload::SessionResumed {}));
        assert_eq!(progress.counts("turn-1"), (0, 0));
    }
    let mut progress = super::super::driver_progress::LoopProgress::default();
    let mut events = Vec::new();
    for index in 0..12 {
        let step = file_edit_step(
            index,
            if index % 2 == 0 { "a.rs" } else { "b.rs" },
            index == 10,
        );
        for event in &step {
            progress.observe(event);
        }
        events.extend(step);
        assert_eq!(
            progress.counts("turn-1").0,
            failed_file_edit_streak(&events, "turn-1")
        );
    }
}

#[tokio::test]
async fn bounded_writer_pressure_leaves_the_async_scheduler_responsive() {
    let (_root, sink) = persisted_stream();
    let sessions = sink.sessions.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    let guard = tokio::task::spawn_blocking(move || {
        sessions.read_events("stream-test", |_| {
            let _ = entered.send(());
            let _ = held.recv();
        })
    });
    ready.await.unwrap();
    let producer_sink = Arc::clone(&sink);
    let producer = tokio::task::spawn_blocking(move || {
        producer_sink.emit(StreamDelta::Text {
            index: 0,
            text: include_str!("../driver_metrics.rs").repeat(256),
        })
    });
    // The real writer is waiting for the real store lock; after a timer tick the
    // scheduler must still accept cancellation while the bounded producer waits.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!producer.is_finished());
    sink.cancellation.cancel();
    release.send(()).unwrap();
    guard.await.unwrap().unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), producer)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    sink.flush_async(true).await.unwrap();
    assert!(!persisted_text(&sink.sessions).is_empty());
}

#[tokio::test]
async fn committed_loop_projection_survives_restart_and_rejected_batches() {
    let (root, sink) = persisted_stream();
    let source = include_str!("../driver_metrics.rs");
    for index in 0..8 {
        let step_id = format!("step-{}", index + 1);
        if index > 0 {
            sink.sessions
                .append(
                    "stream-test",
                    Some("turn-1".into()),
                    Some(step_id.clone()),
                    AgentSessionEventPayload::StepStart,
                )
                .unwrap();
        }
        let mut payloads: Vec<_> = repeated_step(
            &step_id,
            &format!("call-{index}"),
            source,
            false,
            index * 10,
        )
        .into_iter()
        .map(|event| AgentScopedPayload {
            turn_id: event.turn_id,
            step_id: event.step_id,
            payload: event.payload,
        })
        .collect();
        payloads.insert(
            1,
            AgentScopedPayload {
                turn_id: Some("turn-1".into()),
                step_id: Some(step_id.clone()),
                payload: AgentSessionEventPayload::ToolApproval {
                    request_id: "request-1".into(),
                    call_id: format!("call-{index}"),
                    approval_id: None,
                    status: super::super::AgentToolApprovalStatus::Approved,
                    risk: None,
                    reason: Some("sessionRuntimeAuthorized".into()),
                    expires_at_unix_ms: None,
                    prompt: None,
                },
            },
        );
        payloads.insert(
            2,
            AgentScopedPayload {
                turn_id: Some("turn-1".into()),
                step_id: Some(step_id),
                payload: AgentSessionEventPayload::ToolExecution {
                    call_id: format!("call-{index}"),
                    status: super::super::AgentToolExecutionStatus::Dispatched,
                    idempotency: "yes".into(),
                },
            },
        );
        sink.sessions.append_batch("stream-test", payloads).unwrap();
        assert_eq!(
            sink.sessions
                .loop_progress_counts("stream-test", "turn-1")
                .unwrap(),
            (0, index as usize + 1)
        );
    }
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        reopened
            .loop_progress_counts("stream-test", "turn-1")
            .unwrap(),
        (0, 8)
    );
    assert!(reopened
        .append_batch(
            "stream-test",
            vec![
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-9".into()),
                    payload: AgentSessionEventPayload::StepEnd {
                        reason: "completed".into()
                    }
                },
                AgentScopedPayload {
                    turn_id: Some("turn-1".into()),
                    step_id: Some("step-9".into()),
                    payload: AgentSessionEventPayload::StepEnd {
                        reason: String::new()
                    }
                },
            ]
        )
        .is_err());
    assert_eq!(
        reopened
            .loop_progress_counts("stream-test", "turn-1")
            .unwrap(),
        (0, 8)
    );
}

fn persisted_stream() -> (tempfile::TempDir, Arc<DurableModelStreamSink>) {
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    sessions
        .create(super::super::CreateAgentSessionRequest {
            session_id: "stream-test".into(),
            task_id: "stream-test".into(),
            goal: "Review agent loop".into(),
            parent_session_id: None,
            continued_from_session_id: None,
            target: None,
            permission_mode: None,
            execution_surface: super::super::AgentExecutionSurface::Direct,
            success_criteria: Vec::new(),
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    sessions
        .append(
            "stream-test",
            Some("turn-1".into()),
            None,
            AgentSessionEventPayload::TurnStart,
        )
        .unwrap();
    sessions
        .append(
            "stream-test",
            Some("turn-1".into()),
            Some("step-1".into()),
            AgentSessionEventPayload::StepStart,
        )
        .unwrap();
    (
        root,
        Arc::new(DurableModelStreamSink {
            writer: super::super::stream_writer::StreamWriter::new(
                sessions.clone(),
                "stream-test".into(),
            )
            .unwrap(),
            sessions,
            turn_id: "turn-1".into(),
            step_id: "step-1".into(),
            request_id: "request-1".into(),
            collected: Arc::new(Mutex::new(PartialContentAccumulator::default())),
            cancellation: tokio_util::sync::CancellationToken::new(),
            pending: Mutex::new(StreamBatch::default()),
        }),
    )
}

fn persisted_text(sessions: &AgentSessionStore) -> String {
    sessions
        .read_events("stream-test", |events| {
            events
                .iter()
                .filter_map(|event| match &event.payload {
                    AgentSessionEventPayload::AssistantChunk {
                        text_delta: Some(text),
                        ..
                    } => Some(text.as_str()),
                    _ => None,
                })
                .collect()
        })
        .unwrap()
}

#[tokio::test]
async fn stream_batches_preserve_real_source_text_and_reopen_from_disk() {
    let (root, sink) = persisted_stream();
    let source = include_str!("../driver_metrics.rs");
    for ch in source.chars() {
        sink.emit(StreamDelta::Text {
            index: 0,
            text: ch.to_string(),
        })
        .unwrap();
    }
    assert!(persisted_text(&sink.sessions).is_empty());
    sink.flush_async(true).await.unwrap();
    assert_eq!(persisted_text(&sink.sessions), source);
    let chunks = sink
        .sessions
        .read_events("stream-test", |events| {
            events
                .iter()
                .filter(|event| {
                    matches!(
                        event.payload,
                        AgentSessionEventPayload::AssistantChunk { .. }
                    )
                })
                .count()
        })
        .unwrap();
    assert_eq!(chunks, 1);
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(persisted_text(&reopened), source);
    assert!(sink
        .emit(StreamDelta::Text {
            index: 0,
            text: source.into()
        })
        .is_err());
}

#[tokio::test]
async fn stream_cancellation_flushes_accepted_text_and_rejects_late_output() {
    let (_root, sink) = persisted_stream();
    let source = include_str!("../driver_metrics.rs");
    sink.emit(StreamDelta::Text {
        index: 0,
        text: source.into(),
    })
    .unwrap();
    sink.cancellation.cancel();
    assert!(sink
        .emit(StreamDelta::Text {
            index: 0,
            text: source.into()
        })
        .is_err());
    sink.flush_async(true).await.unwrap();
    assert_eq!(persisted_text(&sink.sessions), source);
}

#[tokio::test]
async fn stream_storage_failure_is_sticky_and_does_not_publish_uncommitted_text() {
    let (root, sink) = persisted_stream();
    let log = root
        .path()
        .join("agent-runtime/sessions-v5/stream-test.jsonl");
    let moved = log.with_extension("saved");
    sink.emit(StreamDelta::Text {
        index: 0,
        text: include_str!("../driver_metrics.rs").into(),
    })
    .unwrap();
    std::fs::rename(&log, &moved).unwrap();
    assert!(sink.flush_async(false).await.is_err());
    std::fs::rename(&moved, &log).unwrap();
    assert!(sink.flush_async(true).await.is_err());
    assert!(persisted_text(&sink.sessions).is_empty());
}

#[tokio::test]
async fn stream_buffer_applies_backpressure_and_preserves_utf8_and_block_order() {
    let (_root, sink) = persisted_stream();
    let source = include_str!("../driver_metrics.rs");
    let mut expected = String::new();
    while expected.len() < STREAM_BATCH_MAX_BYTES * 2 {
        sink.emit(StreamDelta::Text {
            index: 0,
            text: source.into(),
        })
        .unwrap();
        expected.push_str(source);
        assert!(sink.pending.lock().unwrap().bytes <= STREAM_BATCH_MAX_BYTES);
    }
    // A size-triggered flush enqueues work; wait for that work without flushing
    // the remaining partial batch, then verify that it really reached disk.
    let queued = Arc::clone(&sink);
    tokio::task::spawn_blocking(move || queued.writer.fence())
        .await
        .unwrap()
        .unwrap();
    assert!(!persisted_text(&sink.sessions).is_empty());
    sink.emit(StreamDelta::Reasoning {
        index: 1,
        text: "审核结束".into(),
    })
    .unwrap();
    sink.emit(StreamDelta::Text {
        index: 2,
        text: "已验证".into(),
    })
    .unwrap();
    expected.push_str("已验证");
    sink.flush_async(true).await.unwrap();
    assert_eq!(persisted_text(&sink.sessions), expected);
    let events = sink.sessions.all_events("stream-test").unwrap();
    assert!(
        matches!(&events[events.len()-2].payload, AgentSessionEventPayload::AssistantChunk { reasoning_delta: Some(text), .. } if text == "审核结束")
    );
    for event in events {
        if let AgentSessionEventPayload::AssistantChunk {
            text_delta: Some(text),
            ..
        } = event.payload
        {
            assert!(text.len() <= MAX_AGENT_STREAM_DELTA_BYTES);
        }
    }
}
