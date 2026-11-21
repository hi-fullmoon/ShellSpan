use super::*;
use crate::agent_runtime::user_questions::{AnswerQuestionInput, UserActionResponse};
use crate::agent_runtime::{
    AgentAssistantContentBlock, AgentEntry, AgentRecoveryCheckpointKind, AgentSessionStatus,
    AgentStopReason,
};
use std::future::{poll_fn, Future};
use std::task::Poll;

fn record_tool_step(
    runtime: &AgentRuntime,
    entry: &AgentEntry,
    turn: &str,
    step: &str,
    request_id: &str,
    tool: &ModelToolCall,
) {
    use crate::llm::types::{AdapterReplayCapture, ModelContentBlock};
    let model = entry.prepare_model().unwrap();
    let surface = runtime.sessions.model_surface(&entry.session_id).unwrap();
    let request = super::super::super::ModelRequest::from_surface(
        request_id.into(),
        &surface,
        String::new(),
        Vec::new(),
    );
    let prepared = model
        .prepare_request(request.clone(), "step", &entry.cancellation())
        .unwrap();
    let mut events = runtime
        .sessions
        .read_events(&entry.session_id, |events| {
            crate::agent_runtime::request_log::request_events(
                events,
                entry,
                &model.provider,
                &request,
                &prepared.snapshot,
                crate::agent_runtime::AgentRequestReason::Initial,
                1,
            )
        })
        .unwrap();
    let model_content = [ModelContentBlock::ToolCall { call: tool.clone() }];
    let replay = crate::llm::replay::prepare_envelope(
        model.adapter.replay_codec(),
        request_id,
        &prepared.snapshot,
        &model_content,
        AdapterReplayCapture {
            response: json!({}),
            blocks: vec![json!({})],
        },
    )
    .unwrap();
    events.push(AgentSessionEventPayload::AssistantMessage {
        message_id: format!("assistant-{request_id}"),
        content: vec![AgentAssistantContentBlock::ToolCall {
            call: Box::new(crate::agent_runtime::recorded_tool_call(tool.clone())),
        }],
        usage: Default::default(),
        stop_reason: AgentStopReason::ToolCalls,
        interrupted: false,
        replay: Some(crate::agent_runtime::AgentStoredReplay::inline(replay)),
    });
    runtime
        .sessions
        .append_batch(
            &entry.session_id,
            events
                .into_iter()
                .map(|payload| crate::agent_runtime::AgentScopedPayload {
                    turn_id: Some(turn.into()),
                    step_id: Some(step.into()),
                    payload,
                })
                .collect(),
        )
        .unwrap();
}

#[tokio::test]
async fn stopping_blocks_new_tool_calls_while_a_child_is_draining() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let runtime = &scenario.runtime;
    let entry = scenario.root(
        "stop-during-child-drain",
        AgentExecutionSurface::BoundTerminal,
        AgentSessionPermissionMode::RequestApproval,
    );
    let child = scenario.child(&entry.session_id);
    scenario.start(&entry, "parent-turn", "parent-step");
    assert!(child.try_acquire_driver().unwrap());
    entry.stop_admission().unwrap();
    assert!(child.with_input_admission(|| Ok(())).unwrap().is_none());
    assert!(!child.cancellation().is_cancelled());
    let mut stop = Box::pin(runtime.interrupt(&entry.session_id));
    assert!(poll_fn(|cx| Poll::Ready(stop.as_mut().poll(cx).is_pending())).await);
    assert!(child.cancellation().is_cancelled());
    assert!(!entry.cancellation().is_cancelled());

    let settlement = runtime
        .tools
        .process_model_calls(
            &entry,
            "parent-turn",
            "parent-step",
            "parent-request",
            vec![file_call(
                "run_terminal_command",
                "late-call",
                json!({
                    "command": "pwd -P", "explanation": "Read the real shell directory",
                }),
            )],
        )
        .await
        .unwrap();
    assert_eq!(settlement, ToolPipelineSettlement::Cancelled);
    let events = runtime.sessions.all_events(&entry.session_id).unwrap();
    assert!(events.iter().all(|event| !matches!(&event.payload,
        AgentSessionEventPayload::ToolApproval { call_id, .. }
        | AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == "late-call"
    )));
    child.release_driver();
    tokio::time::timeout(Duration::from_secs(5), stop)
        .await
        .unwrap()
        .unwrap();
}

fn single_worker_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap()
}

async fn hold_blocking_worker() -> std::sync::mpsc::Sender<()> {
    let (release, blocked) = std::sync::mpsc::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    tokio::task::spawn_blocking(move || {
        let _ = started.send(());
        let _ = blocked.recv();
    });
    ready.await.unwrap();
    release
}

#[test]
fn stop_cancels_a_dispatched_write_before_the_worker_starts() {
    single_worker_runtime().block_on(async {
        let scenario = Scenario::new(TerminalShellKind::Bash);
        let runtime = &scenario.runtime;
        let entry = scenario.root(
            "stop-with-dispatched-write",
            AgentExecutionSurface::BoundTerminal,
            AgentSessionPermissionMode::RequestApproval,
        );
        let session = &entry.session_id;
        let child = scenario.child(session);
        assert!(child.try_acquire_driver().unwrap());
        scenario.start(&entry, "turn", "step");
        let call = file_call("write_file", "write", json!({
            "path": "stop-before-write.md",
            "content": include_str!("../../../../../src/lib/README.md"),
            "precondition": { "mustNotExist": true },
        }));
        assert_eq!(runtime.tools.process_model_calls(&entry, "turn", "step", "request", vec![call]).await.unwrap(), ToolPipelineSettlement::Waiting);
        let release = hold_blocking_worker().await;
        let mut approval = Box::pin(runtime.approve_tool(scenario.approval(session)));
        assert!(poll_fn(|cx| Poll::Ready(approval.as_mut().poll(cx).is_pending())).await);
        assert!(runtime.sessions.read_events(session, |events| events.iter().any(|event| matches!(
            &event.payload, AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == "write"
        ))).unwrap());

        let mut stop = Box::pin(runtime.interrupt(session));
        assert!(poll_fn(|cx| Poll::Ready(stop.as_mut().poll(cx).is_pending())).await);
        assert!(!entry.cancellation().is_cancelled());
        assert!(child.tool_cancellation().unwrap().is_cancelled());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), approval).await.unwrap().unwrap();
        assert!(!scenario.root.path().join("work/stop-before-write.md").exists());
        assert!(runtime.sessions.read_events(session, |events| events.iter().any(|event| matches!(
            &event.payload, AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Cancelled, .. } if call_id == "write"
        ))).unwrap());
        child.release_driver();
        tokio::time::timeout(Duration::from_secs(5), stop).await.unwrap().unwrap();
    });
}

#[test]
fn queue_submission_cannot_wake_the_model_while_approval_tail_is_running() {
    single_worker_runtime().block_on(async {
        let scenario = Scenario::new(TerminalShellKind::Bash);
        let runtime = &scenario.runtime;
        let entry = scenario.root(
            "approval-tail-before-model",
            AgentExecutionSurface::Direct,
            AgentSessionPermissionMode::ScopedAutopilot,
        );
        let session = &entry.session_id;
        let contents = include_str!("../../../../../src/lib/README.md");
        std::fs::write(scenario.root.path().join("work/README.md"), contents).unwrap();
        scenario.start(&entry, "turn", "step");
        let calls = vec![
            file_call("write_file", "write", json!({
                "path": "review.md", "content": contents,
                "precondition": { "mustNotExist": true },
            })),
            file_call("read_file", "read", json!({"path": "README.md", "encoding": "utf8"})),
        ];
        assert_eq!(runtime.tools.process_model_calls(&entry, "turn", "step", "request", calls).await.unwrap(), ToolPipelineSettlement::Waiting);

        let release = hold_blocking_worker().await;
        let mut decision = Box::pin(runtime.reject_tool(scenario.approval(session)));
        assert!(poll_fn(|cx| Poll::Ready(decision.as_mut().poll(cx).is_pending())).await);
        runtime.followup_submission(session, "queued".into(), "queued".into(), "Summarize the repository README".into(), None).unwrap();
        assert!(!entry.is_driver_active());
        assert_eq!(entry.phase().unwrap(), AgentLifecyclePhase::Waiting);
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), decision).await.unwrap().unwrap();
        assert!(runtime.sessions.read_events(session, |events| events.iter().any(|event| matches!(
            &event.payload, AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Completed, .. } if call_id == "read"
        ))).unwrap());
        runtime.interrupt(session).await.unwrap();
    });
}

#[tokio::test]
async fn original_approval_can_be_approved_or_rejected_after_reopening_the_store() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let state = scenario.root.path().join("state");
    let contents = include_str!("../../../../../src/lib/README.md");
    for (root, approve, delegated, configure_model) in [
        ("approve-after-restart", true, false, true),
        ("reject-after-restart", false, false, true),
        ("delegation-after-restart", true, true, true),
        ("reject-without-original-model", false, false, false),
        (
            "reject-delegation-without-original-model",
            false,
            true,
            false,
        ),
    ] {
        let owner = scenario.root(
            root,
            AgentExecutionSurface::Direct,
            AgentSessionPermissionMode::RequestApproval,
        );
        let provider = owner.model().unwrap().provider.clone();
        scenario
            .runtime
            .sessions
            .append(
                root,
                None,
                None,
                AgentSessionEventPayload::SessionModelSelected {
                    provider: crate::agent_runtime::subagent::provider_descriptor(&provider),
                },
            )
            .unwrap();
        let entry = if delegated {
            let child = scenario
                .runtime
                .subagents
                .create_child(
                    root,
                    "Write the requested project note".into(),
                    AgentSubagentRole::General,
                    "blank",
                    vec![TERMINAL.into()],
                    serde_json::from_value(json!({"maxTurns": 8, "timeoutMs": 60_000})).unwrap(),
                    true,
                )
                .unwrap();
            scenario.runtime.agents.get(&child).unwrap().unwrap()
        } else {
            owner
        };
        let session = entry.session_id.as_str();
        scenario.start(&entry, "original-turn", "original-step");
        let original = scenario
            .root
            .path()
            .join("work")
            .join(format!("{session}.md"));
        let call = file_call(
            "write_file",
            "pending-write",
            json!({
                "path": format!("{session}.md"), "content": contents, "precondition": { "mustNotExist": true },
            }),
        );
        record_tool_step(
            &scenario.runtime,
            &entry,
            "original-turn",
            "original-step",
            "original-request",
            &call,
        );
        assert_eq!(
            scenario
                .runtime
                .tools
                .process_model_calls(
                    &entry,
                    "original-turn",
                    "original-step",
                    "original-request",
                    vec![call],
                )
                .await
                .unwrap(),
            ToolPipelineSettlement::Waiting
        );
        let approval = scenario.approval(session);
        assert!(!original.exists());

        let engine = Arc::new(NativeToolEngine::default());
        let adapter = NativeToolAdapter::from_services(
            NativeToolServices {
                sessions: scenario.transport.clone(),
                database: crate::db::Database::open(&state.join("profiles.db")).unwrap(),
                credentials: crate::keychain::CredentialManager::new(),
                known_hosts_path: state.join("known_hosts"),
                data_root: state.clone(),
            },
            engine.clone(),
        )
        .unwrap();
        let mut builder = AgentRuntimeBuilder::new().native_tool_runtime(Arc::new(adapter));
        builder.native_engine = engine;
        let restored = builder.build();
        restored.configure(state.clone()).unwrap();
        if configure_model {
            restored.configure_test_model(provider).unwrap();
        }
        assert_eq!(
            restored.inspect_recovery(session).unwrap().kind,
            AgentRecoveryCheckpointKind::WaitingApproval
        );
        let mut stale = approval.clone();
        stale.approval_id = "obsolete-approval".into();
        assert!(restored.approve_tool(stale.clone()).await.is_err());
        assert!(restored.reject_tool(stale).await.is_err());
        assert!(restored.agents.get(session).unwrap().is_none());
        if approve {
            restored.approve_tool(approval.clone()).await.unwrap();
        } else {
            restored.reject_tool(approval.clone()).await.unwrap();
            assert!(!original.exists());
            if !configure_model {
                assert!(restored.agents.get(session).unwrap().is_none());
                assert_eq!(
                    restored.inspect_recovery(session).unwrap().kind,
                    AgentRecoveryCheckpointKind::ToolResultCommitted
                );
            }
        }
        assert!(restored.approve_tool(approval).await.is_err());
        let events = restored.sessions.all_events(session).unwrap();
        let result = events
            .iter()
            .find_map(|event| match &event.payload {
                AgentSessionEventPayload::ToolResult {
                    call_id,
                    status,
                    summary,
                    ..
                } if call_id == "pending-write" => Some((*status, summary.as_str())),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            result.0,
            if approve {
                AgentToolResultStatus::Completed
            } else {
                AgentToolResultStatus::Rejected
            },
            "{}",
            result.1
        );
        if approve {
            assert_eq!(std::fs::read_to_string(&original).unwrap(), contents);
        }
        assert_eq!(events.iter().filter(|event| matches!(&event.payload,
            AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == "pending-write"
        )).count(), usize::from(approve));
        restored.interrupt(root).await.unwrap();
    }
}

#[tokio::test]
async fn stop_after_reopening_persists_cancellation_for_the_original_approval() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let entry = scenario.root(
        "stop-restored-approval",
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::RequestApproval,
    );
    let session = &entry.session_id;
    scenario.start(&entry, "turn", "step");
    let call = file_call(
        "write_file",
        "write",
        json!({
            "path": "stop-restored-approval.md",
            "content": include_str!("../../../../../src/lib/README.md"),
            "precondition": { "mustNotExist": true },
        }),
    );
    record_tool_step(&scenario.runtime, &entry, "turn", "step", "request", &call);
    assert_eq!(
        scenario
            .runtime
            .tools
            .process_model_calls(&entry, "turn", "step", "request", vec![call])
            .await
            .unwrap(),
        ToolPipelineSettlement::Waiting
    );
    let approval = scenario.approval(session);
    let state = scenario.root.path().join("state");
    let restored = AgentRuntimeBuilder::new().build();
    restored.configure(state.clone()).unwrap();
    assert_eq!(
        restored.inspect_recovery(session).unwrap().kind,
        AgentRecoveryCheckpointKind::WaitingApproval
    );
    assert_eq!(
        restored.interrupt(session).await.unwrap().status,
        AgentSessionStatus::Idle
    );
    assert!(restored.reject_tool(approval.clone()).await.is_err());
    assert!(restored.approve_tool(approval.clone()).await.is_err());

    let reopened = AgentSessionStore::default();
    reopened.configure(state).unwrap();
    let events = reopened.all_events(session).unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolApproval { approval_id: Some(id), status: AgentToolApprovalStatus::Cancelled, .. }
            if id == &approval.approval_id)));
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Cancelled, .. } if call_id == "write")));
    assert!(events.iter().all(|event| !matches!(&event.payload,
        AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == "write")));
    assert!(!scenario
        .root
        .path()
        .join("work/stop-restored-approval.md")
        .exists());
}

#[tokio::test]
async fn child_approval_resumes_when_the_waiting_driver_releases_its_lease() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let runtime = &scenario.runtime;
    let owner = scenario.root(
        "child-approval-handoff",
        AgentExecutionSurface::BoundTerminal,
        AgentSessionPermissionMode::RequestApproval,
    );
    let child = scenario.child(&owner.session_id);
    let session = &child.session_id;
    let turn = "approval-turn";
    let step = "approval-step";
    scenario.start(&child, turn, step);
    assert!(child.try_acquire_driver().unwrap());
    let result = runtime.tools.process_model_calls(
        &child, turn, step, "approval-request",
        vec![file_call("run_terminal_command", "wait-for-approval", json!({
            "command": "pwd -P > approval-result", "explanation": "Save the current terminal directory",
        }))],
    ).await.unwrap();
    assert_eq!(result, ToolPipelineSettlement::Waiting);
    runtime
        .reject_tool(scenario.approval(session))
        .await
        .unwrap();
    let continued = || {
        runtime
            .sessions
            .read_events(session, |events| {
                events.iter().any(|event| {
                    matches!(event.payload, AgentSessionEventPayload::StepStart)
                        && event.turn_id.as_deref() == Some(turn)
                        && event.step_id.as_deref() != Some(step)
                })
            })
            .unwrap()
    };
    assert!(!continued());
    child.release_driver();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !continued() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a resolved child approval must resume the original turn");
    runtime.interrupt(&owner.session_id).await.unwrap();
}

#[tokio::test]
async fn a_declined_verification_cannot_request_approval_again() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let runtime = &scenario.runtime;
    let entry = scenario.root(
        "declined-verification",
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::RequestApproval,
    );
    let turn = "original-turn";
    scenario.start(&entry, turn, "question-step");
    let verification = "test -r /etc/hosts";
    let action = file_call(
        "request_user_action",
        "manual-action",
        json!({"id":"verify-access", "instructions":"Confirm access to the hosts file.", "verification_command":verification}),
    );
    record_tool_step(
        runtime,
        &entry,
        turn,
        "question-step",
        "question-request",
        &action,
    );
    assert_eq!(
        runtime
            .tools
            .process_model_calls(
                &entry,
                turn,
                "question-step",
                "question-request",
                vec![action]
            )
            .await
            .unwrap(),
        ToolPipelineSettlement::Waiting
    );
    let question = runtime
        .sessions
        .read_events(&entry.session_id, |events| {
            events.iter().find_map(|event| match &event.payload {
                AgentSessionEventPayload::QuestionRequested { identity, .. } => {
                    Some(identity.clone())
                }
                _ => None,
            })
        })
        .unwrap()
        .unwrap();
    runtime
        .tools
        .submit_question_answer(
            &entry,
            AnswerQuestionInput {
                identity: question,
                client_operation_id: "manual-work-complete".into(),
                answers: Vec::new(),
                action: Some(UserActionResponse::Completed),
                action_note: None,
            },
        )
        .unwrap();
    runtime.tools.continue_questions(&entry).await.unwrap();
    let verify = |id| {
        file_call(
            "run_terminal_command",
            id,
            json!({"command":verification, "explanation":"Verify the requested file can be read"}),
        )
    };
    for (step, call) in [
        ("verify-step", "verification"),
        ("repeat-step", "repeat-verification"),
    ] {
        runtime
            .sessions
            .begin_continuation_step(&entry.session_id, turn.into(), step.into())
            .unwrap();
        entry
            .set_scope(Some(AgentActiveScope {
                turn_id: turn.into(),
                step_id: Some(step.into()),
            }))
            .unwrap();
        let settlement = runtime
            .tools
            .process_model_calls(
                &entry,
                turn,
                step,
                "verification-request",
                vec![verify(call)],
            )
            .await
            .unwrap();
        if call == "verification" {
            assert_eq!(settlement, ToolPipelineSettlement::Waiting);
            runtime
                .tools
                .decide(
                    &entry,
                    scenario.approval(&entry.session_id),
                    AgentToolDecision::Reject,
                )
                .await
                .unwrap();
        } else {
            assert_eq!(settlement, ToolPipelineSettlement::Completed);
        }
    }
    let events = runtime.sessions.all_events(&entry.session_id).unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Rejected, summary, .. }
        if call_id == "repeat-verification" && summary.starts_with("USER_ACTION_VERIFICATION_REJECTED")
    )));
    assert!(events.iter().all(|event| !matches!(&event.payload,
        AgentSessionEventPayload::ToolApproval { call_id, .. } if call_id == "repeat-verification"
    )));
}
