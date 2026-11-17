use super::*;

#[tokio::test]
async fn a_click_that_commits_expiry_wakes_the_original_turn() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let runtime = &scenario.runtime;
    let session = "approval-expiry-click";
    let turn = "original-turn";
    let step = "approval-step";
    let entry = scenario.root(
        session,
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::RequestApproval,
    );
    scenario.start(&entry, turn, step);

    // Drive native admission without starting the driver's expiry waiter. The
    // click deterministically owns the transition after the real deadline.
    let settlement = runtime.tools.process_model_calls(&entry, turn, step, "approval-request", vec![
        ModelToolCall {
            call_id: "write-script".into(),
            provider_call_id: None,
            name: "write_file".into(),
            arguments: json!({"path":"check.sh", "content":"pwd\n", "fileScope":"scratch", "precondition":{"mustNotExist":true}}),
        },
    ]).await.unwrap();
    assert_eq!(
        settlement,
        crate::agent_runtime::ToolPipelineSettlement::Waiting
    );
    let approval = scenario.approval(session);
    let expires = runtime
        .sessions
        .all_events(session)
        .unwrap()
        .iter()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::ToolApproval {
                status: AgentToolApprovalStatus::Requested,
                expires_at_unix_ms,
                ..
            } => *expires_at_unix_ms,
            _ => None,
        })
        .unwrap();
    while let Some(delay) =
        expires.checked_sub(crate::agent_runtime::driver::current_unix_ms().unwrap())
    {
        tokio::time::sleep(Duration::from_millis(delay.saturating_add(1))).await;
    }
    assert_eq!(
        runtime.approve_tool(approval).await.unwrap_err(),
        "Approval expired"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if runtime
                .sessions
                .all_events(session)
                .unwrap()
                .iter()
                .any(|event| {
                    matches!(event.payload, AgentSessionEventPayload::StepStart)
                        && event.turn_id.as_deref() == Some(turn)
                        && event.step_id.as_deref() != Some(step)
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("settling the expired approval must wake the waiting turn");
    runtime.cancel(session).await.unwrap();
    let events = runtime.sessions.all_events(session).unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload,
        AgentSessionEventPayload::ToolApproval { status: AgentToolApprovalStatus::Expired, call_id, .. }
            if call_id == "write-script"
    )));
    assert!(events.iter().all(|event| !matches!(&event.payload,
        AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == "write-script"
    )));
}
