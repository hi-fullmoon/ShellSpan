use std::time::Duration;

#[tokio::test]
async fn stopping_tree_fences_children_before_waiting_for_existing_workers() {
    let (_root, manager, child) = setup_with_services(
        default_subagent_budget(),
        "http://127.0.0.1:11434".into(),
        true,
    );
    let parent = manager.agents.get("lifecycle-parent").unwrap().unwrap();
    assert!(child.try_acquire_driver().unwrap());
    parent.stop_admission().unwrap();
    assert!(child.with_input_admission(|| Ok(())).unwrap().is_none());
    let mut stop = Box::pin(manager.cancel_descendants(&parent.session_id));
    let cancellation = child.cancellation();
    tokio::select! {
        _ = &mut stop => panic!("stop returned before the child driver was released"),
        result = tokio::time::timeout(Duration::from_secs(5), cancellation.cancelled()) => result.unwrap(),
    }
    assert!(child.cancellation().is_cancelled());

    for owner in [&parent.session_id, &child.session_id] {
        let before = manager.sessions.child_session_ids(owner).unwrap();
        let result = manager.create_child(
            owner,
            "Inspect directory contents".into(),
            AgentSubagentRole::Explorer,
            "blank",
            vec!["lifecycle-target".into()],
            default_subagent_budget(),
            false,
        );
        assert_eq!(result.unwrap_err(), "parent Agent Session is stopping");
        assert_eq!(manager.sessions.child_session_ids(owner).unwrap(), before);
    }

    child.release_driver();
    tokio::time::timeout(Duration::from_secs(5), stop)
        .await
        .unwrap()
        .unwrap();
    assert!(manager.agents.get(&child.session_id).unwrap().is_none());
    assert_eq!(
        manager.sessions.snapshot(&child.session_id).unwrap().status,
        AgentSessionStatus::Cancelled,
    );
}

async fn fleet_with_model_connection() -> (
    tempfile::TempDir,
    SubAgentManager,
    AgentFleetControlRequest,
    tokio::net::TcpStream,
    tokio::task::JoinHandle<Result<AgentFleetInspection, String>>,
) {
    // Let the production HTTP adapter connect, then keep the real socket open
    // so the Explorer stays active without supplying any model response.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (root, manager, _) = setup_with_services(
        default_subagent_budget(),
        format!("http://{}", listener.local_addr().unwrap()),
        true,
    );
    let plan = manager
        .plan_fleet(AgentFleetPlanRequest {
            parent_session_id: "lifecycle-parent".into(),
            targets: vec![AgentFleetTargetRequest {
                target_id: "lifecycle-target".into(),
                goal: "Inspect the local directory".into(),
            }],
            canary_size: 1,
            wave_size: 1,
            failure_threshold: 0,
            budget: None,
        })
        .unwrap();
    let control = AgentFleetControlRequest {
        parent_session_id: "lifecycle-parent".into(),
        fleet_id: plan.fleet.fleet_id.unwrap(),
    };
    let runner = {
        let manager = manager.clone();
        let control = control.clone();
        tokio::spawn(async move { manager.start_fleet(control).await })
    };
    let (socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .expect("Explorer did not connect to the loopback listener")
        .unwrap();
    (root, manager, control, socket, runner)
}

fn last_fleet_checkpoint(
    manager: &SubAgentManager,
    control: &AgentFleetControlRequest,
) -> AgentFleetState {
    manager
        .sessions
        .read_events(&control.parent_session_id, |events| {
            events.iter().rev().find_map(|event| match &event.payload {
                AgentSessionEventPayload::TaskState {
                    fleet: Some(fleet), ..
                } if fleet.fleet_id.as_deref() == Some(&control.fleet_id) => Some(fleet.clone()),
                _ => None,
            })
        })
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn fleet_start_and_resume_cannot_replace_an_active_scheduler() {
    let (_root, manager, control, _socket, runner) = fleet_with_model_connection().await;
    for status in ["running", "paused"] {
        if status == "paused" {
            manager.pause_fleet(control.clone()).unwrap();
        }
        let duplicate = manager.start_fleet(control.clone()).await.unwrap_err();
        assert_eq!(duplicate, "Fleet already has an active scheduler");
        let checkpoint = last_fleet_checkpoint(&manager, &control);
        assert_eq!(checkpoint.status.as_deref(), Some(status));
        assert_eq!(checkpoint.targets[0].child_session_ids.len(), 1);
    }
    manager.abort_fleet(control).await.unwrap();
    assert_eq!(
        runner.await.unwrap().unwrap().fleet.status.as_deref(),
        Some("aborted")
    );
}

#[tokio::test]
async fn fleet_abort_cancels_the_durably_registered_child_and_prevents_next_role() {
    let (_root, manager, control, _socket, runner) = fleet_with_model_connection().await;
    let started = last_fleet_checkpoint(&manager, &control);
    let [child] = started.targets[0].child_session_ids.as_slice() else {
        panic!("the running Explorer must already belong to the durable Fleet");
    };
    assert!(manager
        .agents
        .get(child)
        .unwrap()
        .unwrap()
        .is_driver_active());
    let aborted = tokio::time::timeout(
        Duration::from_secs(10),
        manager.abort_fleet(control.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    let finished = tokio::time::timeout(Duration::from_secs(10), runner)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(aborted.fleet.status.as_deref(), Some("aborted"));
    assert_eq!(finished.fleet.status.as_deref(), Some("aborted"));
    let checkpoint = last_fleet_checkpoint(&manager, &control);
    assert_eq!(checkpoint.status.as_deref(), Some("aborted"));
    assert_eq!(checkpoint.targets[0].child_session_ids, [child.clone()]);
    assert_eq!(
        manager.sessions.snapshot(child).unwrap().status,
        AgentSessionStatus::Cancelled
    );
    assert!(manager.agents.get(child).unwrap().is_none());
    assert_eq!(
        manager.start_fleet(control).await.unwrap().fleet,
        checkpoint
    );
}

#[tokio::test]
async fn fleet_abort_record_blocks_approval_recovery_before_child_cleanup() {
    let (root, manager, control, _socket, runner) = fleet_with_model_connection().await;
    let child = last_fleet_checkpoint(&manager, &control).targets[0].child_session_ids[0].clone();
    manager.require_open_fleet_for_child(&child).unwrap();
    // Reopen the on-disk state at the point where abort has committed but the
    // cancellation workers have not yet written their terminal events.
    manager
        .set_fleet_status(&control.parent_session_id, &control.fleet_id, "aborted")
        .unwrap();
    let mut restored = manager.clone();
    restored.sessions = AgentSessionStore::default();
    restored
        .sessions
        .configure(root.path().to_path_buf())
        .unwrap();
    assert!(!restored.sessions.snapshot(&child).unwrap().ended);
    assert_eq!(
        restored.require_open_fleet_for_child(&child).unwrap_err(),
        "Cannot restore approval in an aborted Fleet"
    );
    manager.abort_fleet(control).await.unwrap();
    runner.await.unwrap().unwrap();
}
