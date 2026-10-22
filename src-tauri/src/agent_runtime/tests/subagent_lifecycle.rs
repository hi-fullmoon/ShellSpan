use super::*;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};

use futures_util::task::{waker, ArcWake};

use super::super::{
    AgentArtifactStore, AgentExecutionSurface, NativeToolRuntimeSlot, OrchestrationToolRuntimeSlot,
};

// Exercise the real session store, registry, admission gate and HTTP adapter.
// These lifecycle tests reserve the driver slot themselves and never send a
// model request or replace the model/native runtime with a test implementation.
fn setup() -> (tempfile::TempDir, SubAgentManager, Arc<AgentEntry>) {
    let root = tempfile::tempdir().unwrap();
    let sessions = AgentSessionStore::default();
    sessions.configure(root.path().to_path_buf()).unwrap();
    let agents = AgentRegistry::default();
    let models = ModelRegistry::default();
    let provider = AiProviderConfig {
        id: "lifecycle-route".into(),
        kind: crate::ai::AiProviderKind::Ollama,
        profile: "ollama".into(),
        base_url: "http://127.0.0.1:11434".into(),
        model: "lifecycle-model".into(),
        model_definition: Some(crate::llm::catalog::fixture_definition(
            crate::ai::AiProviderKind::Ollama,
            32768,
        )),
        retry_policy: None,
        reasoning_effort: None,
        requires_api_key: false,
        api_key: None,
    };
    let adapter = models.resolve(provider.clone(), None).unwrap();
    let target = super::super::AgentSessionTarget {
        kind: "local".into(),
        target_id: "lifecycle-target".into(),
        session_id: "lifecycle-terminal".into(),
        label: None,
        profile_id: None,
        host: None,
        port: None,
        username: None,
        cwd: Some(root.path().to_string_lossy().into_owned()),
        root_path: None,
        local_root: None,
    };
    let parent_request = CreateAgentSessionRequest {
        session_id: "lifecycle-parent".into(),
        task_id: "lifecycle-parent-task".into(),
        goal: "Inspect child lifecycle".into(),
        parent_session_id: None,
        continued_from_session_id: None,
        target: Some(target.clone()),
        permission_mode: None,
        execution_surface: AgentExecutionSurface::Direct,
        success_criteria: Vec::new(),
        capability_scope: None,
        subagent: None,
    };
    sessions.create(parent_request.clone()).unwrap();
    let parent = agents
        .attach(
            sessions.clone(),
            parent_request.session_id.clone(),
            provider.clone(),
            adapter.clone(),
        )
        .unwrap();
    let scope = AgentCapabilityScope {
        tool_names: vec!["list_directory".into()],
        effects: vec![AgentSessionEffect::ReadOnly],
        target_ids: vec![target.target_id.clone()],
    };
    sessions
        .create(CreateAgentSessionRequest {
            session_id: "lifecycle-child".into(),
            task_id: "lifecycle-child-task".into(),
            parent_session_id: Some(parent_request.session_id),
            capability_scope: Some(scope.clone()),
            subagent: Some(AgentSubagentSession {
                descriptor_id: "lifecycle-descriptor".into(),
                parent_task_id: parent_request.task_id.clone(),
                role: AgentSubagentRole::Explorer,
                continuable: true,
                depth: 1,
                inheritance: AgentSubagentInheritance::Blank,
                capability_scope: scope,
                target_scope: vec![target],
                budget: default_subagent_budget(),
                provider: provider_descriptor(&provider),
            }),
            ..parent_request
        })
        .unwrap();
    let handle = Arc::new(
        agents
            .attach(
                sessions.clone(),
                "lifecycle-child".into(),
                provider,
                adapter,
            )
            .unwrap(),
    );
    let entry = handle.entry();
    agents.set_owner(&entry, &parent.entry()).unwrap();
    let artifacts = AgentArtifactStore::default();
    artifacts.configure(root.path()).unwrap();
    let hooks = AgentHookBus::default();
    let tools = AgentToolPipeline::new(
        agents.clone(),
        sessions.clone(),
        hooks.clone(),
        Arc::new(NativeToolRuntimeSlot::default()),
        artifacts.clone(),
        OrchestrationToolRuntimeSlot::default(),
    );
    let manager = SubAgentManager::new(
        sessions.clone(),
        agents,
        models,
        hooks,
        tools,
        AgentCompactionManager::new(sessions, artifacts),
        AgentDriverConfig::default(),
    );
    manager
        .handles
        .lock()
        .unwrap()
        .insert(entry.session_id.clone(), handle);
    (root, manager, entry)
}

fn set_waiting(manager: &SubAgentManager, entry: &AgentEntry) {
    manager
        .sessions
        .append(
            &entry.session_id,
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Waiting,
                reason: Some("waitingApproval".into()),
            },
        )
        .unwrap();
    entry.set_phase(AgentLifecyclePhase::Waiting).unwrap();
}

#[tokio::test]
async fn continuation_winning_idle_release_keeps_its_handle_and_cancellation() {
    let (_root, manager, entry) = setup();
    assert!(entry.try_acquire_driver().unwrap());
    manager
        .send_input(
            "lifecycle-parent",
            &entry.session_id,
            "Continue from saved progress".into(),
            Some("continue-operation".into()),
        )
        .await
        .unwrap();
    manager
        .release_continuable(&entry.session_id)
        .await
        .unwrap();
    assert!(manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&entry.session_id));
    assert!(Arc::ptr_eq(
        &manager.agents.get(&entry.session_id).unwrap().unwrap(),
        &entry,
    ));
    assert_eq!(
        manager
            .sessions
            .snapshot(&entry.session_id)
            .unwrap()
            .inbox
            .next_turn
            .len(),
        1
    );

    // An unconfigured native adapter is a real cancellation failure. Even then
    // the running entry must receive cancellation and remain reachable for retry.
    let error = manager.cancel_tree(&entry.session_id).await.unwrap_err();
    assert!(error.contains("native tool adapter is not configured"));
    assert!(entry.cancellation().is_cancelled());
    assert!(manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&entry.session_id));
    assert!(manager
        .send_input(
            "lifecycle-parent",
            &entry.session_id,
            "Too late".into(),
            None
        )
        .await
        .unwrap_err()
        .contains("stopping"));
    entry.release_driver();
    let handle = manager
        .handles
        .lock()
        .unwrap()
        .get(&entry.session_id)
        .cloned()
        .unwrap();
    assert!(handle.dispose().await.unwrap().ended);
}

#[tokio::test]
async fn queued_input_prevents_idle_release_even_without_an_active_driver() {
    let (_root, manager, entry) = setup();
    entry
        .with_input_admission(|| {
            manager.sessions.enqueue(
                &entry.session_id,
                AgentInboxLane::NextTurn,
                AgentInboxMessage {
                    images: Vec::new(),
                    message_id: "queued-continuation".into(),
                    client_submission_id: None,
                    content: "Inspect remaining work".into(),
                    source: AgentMessageSource::user(),
                    terminal_context: None,
                },
            )
        })
        .unwrap()
        .unwrap();
    manager
        .release_continuable(&entry.session_id)
        .await
        .unwrap();
    assert!(manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&entry.session_id));
    assert!(entry.is_admitting());
    assert!(entry.try_acquire_driver().unwrap());
    entry.release_driver();
}

#[tokio::test]
async fn successful_idle_release_allows_one_cold_attachment() {
    let (_root, manager, old_entry) = setup();
    manager
        .release_continuable(&old_entry.session_id)
        .await
        .unwrap();
    assert!(!manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&old_entry.session_id));
    assert!(manager.agents.get(&old_entry.session_id).unwrap().is_none());
    assert!(!old_entry.try_acquire_driver().unwrap());
    assert!(
        !manager
            .sessions
            .snapshot(&old_entry.session_id)
            .unwrap()
            .ended
    );

    let entries = std::thread::scope(|scope| {
        let attach = || {
            let mut handles = manager.handles.lock().unwrap();
            manager
                .ensure_resident(&old_entry.session_id, &mut handles)
                .unwrap()
        };
        let first = scope.spawn(attach);
        let second = scope.spawn(attach);
        (first.join().unwrap(), second.join().unwrap())
    });
    assert!(Arc::ptr_eq(&entries.0, &entries.1));
    assert!(!Arc::ptr_eq(&entries.0, &old_entry));
    assert!(manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&old_entry.session_id));
    // Continue through the public admission path while an actual worker lease
    // is reserved, so this lifecycle test never starts an HTTP request.
    assert!(entries.0.try_acquire_driver().unwrap());
    manager
        .send_input(
            "lifecycle-parent",
            &old_entry.session_id,
            "Resume".into(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        manager
            .sessions
            .snapshot(&old_entry.session_id)
            .unwrap()
            .inbox
            .next_turn
            .len(),
        1
    );
    entries.0.release_driver();
}

#[tokio::test]
async fn cold_cancellation_fences_attachment_until_the_terminal_event_is_durable() {
    let (_root, manager, entry) = setup();
    manager
        .release_continuable(&entry.session_id)
        .await
        .unwrap();
    let observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed_by_publisher = observed.clone();
    let handles = Arc::downgrade(&manager.handles);
    manager
        .sessions
        .set_publisher(Arc::new(move |event| {
            if event.session_id == "lifecycle-child"
                && matches!(
                    event.payload,
                    AgentSessionEventPayload::SessionEnded {
                        status: AgentSessionStatus::Cancelled,
                        ..
                    }
                )
            {
                assert!(
                    handles.upgrade().unwrap().try_lock().is_err(),
                    "cold attachment must remain fenced while cancellation is committed"
                );
                observed_by_publisher.store(true, Ordering::Release);
            }
        }))
        .unwrap();
    manager.cancel_tree(&entry.session_id).await.unwrap();
    assert!(observed.load(Ordering::Acquire));
    assert!(manager.sessions.snapshot(&entry.session_id).unwrap().ended);
    assert!(manager
        .send_input(
            "lifecycle-parent",
            &entry.session_id,
            "Too late".into(),
            None,
        )
        .await
        .unwrap_err()
        .contains("terminal child"));
    assert!(manager.agents.get(&entry.session_id).unwrap().is_none());
}

#[derive(Default)]
struct WakeCounter(AtomicUsize);

impl ArcWake for WakeCounter {
    fn wake_by_ref(arc_self: &Arc<Self>) {
        arc_self.0.fetch_add(1, Ordering::Relaxed);
    }
}

#[tokio::test]
async fn waiting_child_sleeps_without_rescheduling_and_wakes_on_completion() {
    let (_root, manager, entry) = setup();
    set_waiting(&manager, &entry);
    let counter = Arc::new(WakeCounter::default());
    let task_waker = waker(counter.clone());
    let mut context = Context::from_waker(&task_waker);
    let mut wait = Box::pin(manager.await_settlement(&entry.session_id, CancellationToken::new()));
    assert!(wait.as_mut().poll(&mut context).is_pending());
    assert_eq!(
        counter.0.load(Ordering::Relaxed),
        0,
        "waiting for approval must not schedule a busy loop"
    );

    manager
        .sessions
        .terminate(
            &entry.session_id,
            AgentSessionStatus::Completed,
            "completed".into(),
        )
        .unwrap();
    entry.set_phase(AgentLifecyclePhase::Stopping).unwrap();
    assert!(counter.0.load(Ordering::Relaxed) > 0);
    let Poll::Ready(result) = wait.as_mut().poll(&mut context) else {
        panic!("a completed child must wake its settlement waiter");
    };
    assert_eq!(
        result.unwrap().snapshot.status,
        AgentSessionStatus::Completed
    );
}

#[tokio::test]
async fn settlement_waits_for_driver_release_and_does_not_miss_notifications() {
    let (_root, manager, entry) = setup();
    assert!(entry.try_acquire_driver().unwrap());
    let counter = Arc::new(WakeCounter::default());
    let task_waker = waker(counter.clone());
    let mut context = Context::from_waker(&task_waker);
    let mut wait = Box::pin(manager.await_settlement(&entry.session_id, CancellationToken::new()));
    assert!(wait.as_mut().poll(&mut context).is_pending());
    manager
        .sessions
        .terminate(
            &entry.session_id,
            AgentSessionStatus::Completed,
            "completed".into(),
        )
        .unwrap();
    entry.set_phase(AgentLifecyclePhase::Stopping).unwrap();
    assert!(
        wait.as_mut().poll(&mut context).is_pending(),
        "durable completion must still join the active driver"
    );
    entry.release_driver();
    assert!(counter.0.load(Ordering::Relaxed) > 0);
    assert!(wait.as_mut().poll(&mut context).is_ready());
}

#[tokio::test(start_paused = true)]
async fn waiting_child_timeout_still_cancels_and_preserves_failed_cleanup_handle() {
    let (_root, manager, entry) = setup();
    set_waiting(&manager, &entry);
    let error = manager
        .await_settlement(&entry.session_id, CancellationToken::new())
        .await
        .err()
        .unwrap();
    assert!(error.contains("native tool adapter is not configured"));
    assert!(entry.cancellation().is_cancelled());
    assert!(manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&entry.session_id));
}

#[tokio::test]
async fn waiting_child_parent_cancellation_wakes_without_a_state_change() {
    let (_root, manager, entry) = setup();
    set_waiting(&manager, &entry);
    let cancellation = CancellationToken::new();
    let mut wait = Box::pin(manager.await_settlement(&entry.session_id, cancellation.clone()));
    assert!(futures_util::poll!(&mut wait).is_pending());
    cancellation.cancel();
    let error = wait.await.err().unwrap();
    assert!(error.contains("native tool adapter is not configured"));
    assert!(entry.cancellation().is_cancelled());
}
