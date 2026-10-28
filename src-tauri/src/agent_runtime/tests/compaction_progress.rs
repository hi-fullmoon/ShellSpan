// Exercise the real event store, checkpoint renderer and artifact filesystem.
// No model adapter or generated model response is substituted.
fn progress_session() -> (
    tempfile::TempDir,
    AgentSessionStore,
    AgentArtifactStore,
    u64,
) {
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    let artifacts = AgentArtifactStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    artifacts.configure(root.path()).unwrap();
    sessions
        .create(super::super::CreateAgentSessionRequest {
            session_id: "progress".into(),
            task_id: "progress".into(),
            goal: "Review the runtime source and preserve task progress".into(),
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
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent_runtime/driver_metrics.rs"),
    )
    .unwrap();
    for payload in [
        AgentSessionEventPayload::TurnStart,
        AgentSessionEventPayload::StepStart,
        AgentSessionEventPayload::UserMessage {
            message: AgentInboxMessage {
                images: Vec::new(),
                message_id: "review".into(),
                client_submission_id: None,
                content: format!("Review the runtime source and preserve task progress:\n{source}"),
                source: AgentMessageSource::user(),
                terminal_context: None,
            },
        },
        AgentSessionEventPayload::TaskEvidence {
            evidence_id: "runtime-source".into(),
            kind: "source".into(),
            summary: format!("Read driver_metrics.rs ({} UTF-8 bytes)", source.len()),
        },
        AgentSessionEventPayload::StepEnd {
            reason: "toolsCompleted".into(),
        },
    ] {
        let step = if matches!(payload, AgentSessionEventPayload::TurnStart) {
            None
        } else {
            Some("read".into())
        };
        sessions
            .append("progress", Some("review-turn".into()), step, payload)
            .unwrap();
    }
    let boundary = sessions.all_events("progress").unwrap().last().unwrap().seq;
    (root, sessions, artifacts, boundary)
}

#[tokio::test]
async fn compaction_progress_is_published_before_work_and_records_real_outcomes() {
    let mut capture = serde_json::Map::new();
    for outcome in ["completed", "failed", "cancelled"] {
        let (root, sessions, artifacts, _) = progress_session();
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let published = Arc::clone(&observed);
        let store = sessions.clone();
        sessions
            .set_publisher(Arc::new(move |event| {
                if matches!(
                    event.payload,
                    AgentSessionEventPayload::CompactionStart { .. }
                ) {
                    let prefix = store.all_events("progress").unwrap();
                    assert!(matches!(
                        prefix.last().unwrap().payload,
                        AgentSessionEventPayload::CompactionStart { .. }
                    ));
                    assert_eq!(store.snapshot("progress").unwrap().surface.generation, 0);
                    assert!(!prefix.iter().any(|item| matches!(
                        item.payload,
                        AgentSessionEventPayload::ContextArtifact { .. }
                    )));
                }
                published.lock().unwrap().push(event.clone());
            }))
            .unwrap();
        if outcome == "failed" {
            // A real filesystem obstruction prevents artifact publication.
            std::fs::write(
                root.path().join("agent-runtime/artifacts-v2/progress"),
                "not a directory",
            )
            .unwrap();
        }
        let token = CancellationToken::new();
        let mut manager = AgentCompactionManager::new(sessions.clone(), artifacts);
        if outcome == "cancelled" {
            let cancellation = token.clone();
            manager.before_commit = Some(Arc::new(move || cancellation.cancel()));
        }
        let wall = Instant::now();
        let request = super::super::ModelRequest::from_surface(
            "progress-budget".into(),
            &sessions.model_surface("progress").unwrap(),
            "Review runtime source".into(),
            Vec::new(),
        );
        let provider = serde_json::from_value(serde_json::json!({
            "id": "deepseek", "kind": "openAiCompatible", "profile": "deepseek",
            "baseUrl": "https://api.deepseek.com", "model": "deepseek-flash", "requiresApiKey": false,
        })).unwrap();
        let actual_budget = estimate_model_surface_budget(&provider, &request).unwrap();
        let result = manager
            .compact(
                "progress",
                "review-turn",
                "compact",
                Some("review-turn"),
                "progressVerification",
                &actual_budget,
                true,
                &token,
            )
            .await;
        assert_eq!(
            result.is_ok(),
            outcome == "completed",
            "{outcome}: {result:?}"
        );
        let events = observed.lock().unwrap();
        let start = events
            .iter()
            .find_map(|event| match &event.payload {
                AgentSessionEventPayload::CompactionStart { compaction_id, .. } => {
                    compaction_id.as_ref()
                }
                _ => None,
            })
            .unwrap();
        let ends = events
            .iter()
            .filter_map(|event| match &event.payload {
                AgentSessionEventPayload::CompactionEnd {
                    compaction_id,
                    duration_ms,
                    status,
                    reason,
                    ..
                } => Some((compaction_id, duration_ms, status, reason)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0].0.as_ref(), Some(start));
        assert!(u128::from(ends[0].1.unwrap()) <= wall.elapsed().as_millis());
        assert_eq!(wire_name(ends[0].2), outcome);
        assert_eq!(ends[0].3.is_some(), outcome != "completed");
        if outcome == "failed" {
            std::fs::rename(
                root.path().join("agent-runtime/artifacts-v2/progress"),
                root.path().join("blocked-artifact-entry"),
            )
            .unwrap();
        }
        let reopened = AgentSessionStore::default();
        reopened.configure(root.path().to_path_buf()).unwrap();
        let raw = reopened.all_events("progress").unwrap();
        assert!(!has_compaction_in_flight(&raw));
        assert_eq!(
            reopened.snapshot("progress").unwrap().surface.generation,
            u64::from(outcome == "completed")
        );
        capture.insert(outcome.into(), serde_json::to_value(&raw).unwrap());
    }
    if let Ok(path) = std::env::var("SHELLSPAN_COMPACTION_PROGRESS_CAPTURE") {
        std::fs::write(path, serde_json::to_vec_pretty(&capture).unwrap()).unwrap();
    }
}

#[test]
fn dropped_compaction_closes_its_progress_and_restart_requires_explicit_resume() {
    let (root, sessions, _, boundary) = progress_session();
    let operation = CompactionOperation::start(
        &sessions,
        "progress",
        "review-turn",
        "compact",
        1,
        boundary,
        "budgetPressure",
    )
    .unwrap();
    assert!(has_compaction_in_flight(
        &sessions.all_events("progress").unwrap()
    ));
    let other = CompactionOperation::start(
        &sessions,
        "progress",
        "review-turn",
        "other",
        1,
        boundary,
        "budgetPressure",
    )
    .unwrap();
    drop(operation);
    assert!(has_compaction_in_flight(
        &sessions.all_events("progress").unwrap()
    ));
    assert_eq!(
        sessions.snapshot("progress").unwrap().recovery.kind,
        super::super::AgentRecoveryCheckpointKind::CompactionInFlight
    );
    drop(other);
    assert!(!has_compaction_in_flight(
        &sessions.all_events("progress").unwrap()
    ));
    assert!(matches!(
        sessions
            .all_events("progress")
            .unwrap()
            .last()
            .unwrap()
            .payload,
        AgentSessionEventPayload::CompactionEnd {
            status: AgentCompactionStatus::Cancelled,
            duration_ms: Some(_),
            ..
        }
    ));
    sessions
        .append(
            "progress",
            Some("review-turn".into()),
            Some("crashed".into()),
            AgentSessionEventPayload::CompactionStart {
                reason: "budgetPressure".into(),
                compaction_id: Some("interrupted".into()),
            },
        )
        .unwrap();
    let reopened = AgentSessionStore::default();
    reopened.configure(root.path().to_path_buf()).unwrap();
    let events = reopened.all_events("progress").unwrap();
    assert!(has_compaction_in_flight(&events));
    assert!(select_complete_compaction_prefix(&events, None, None, &budget(), true).is_err());
    reopened
        .end(
            "progress",
            super::super::AgentSessionStatus::Failed,
            Some("interrupted".into()),
        )
        .unwrap();
    reopened.resume("progress").unwrap();
    assert!(!has_compaction_in_flight(
        &reopened.all_events("progress").unwrap()
    ));
    assert_eq!(reopened.snapshot("progress").unwrap().surface.generation, 0);
}
