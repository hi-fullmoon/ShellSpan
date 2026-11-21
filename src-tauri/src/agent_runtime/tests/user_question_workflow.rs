use super::*;
use crate::agent_runtime::{
    AgentSubagentModel, AgentToolExecutionStatus, AgentToolResultStatus, ModelToolCall,
    RecordedToolCall,
};

fn identity() -> QuestionIdentity {
    QuestionIdentity {
        session_id: "workflow".into(),
        turn_id: "turn".into(),
        step_id: "decision".into(),
        request_id: "request".into(),
        call_id: "decision".into(),
        question_request_id: "question".into(),
    }
}

fn arguments(command: &str) -> QuestionArguments {
    QuestionArguments::parse(json!({"questions":[{
        "id":"access","question":"Choose access method", "input_kind":"non_sensitive",
        "decision_key":"service-access","decision_context":"current host and account",
        "options":[{"label":"Configure access manually","user_action":{
            "instructions":"Complete the configuration outside the Agent, then confirm.",
            "verification_command":command
        }},{"label":"Use another existing connection"}]
    }]}))
    .unwrap()
}

fn submission(action: Option<UserActionResponse>) -> AnswerQuestionInput {
    AnswerQuestionInput {
        identity: identity(),
        client_operation_id: if action.is_some() {
            "complete"
        } else {
            "select"
        }
        .into(),
        answers: vec![QuestionAnswer {
            id: "access".into(),
            selected: vec!["Configure access manually".into()],
            custom: None,
        }],
        action,
        action_note: None,
    }
}

fn event(seq: usize, payload: AgentSessionEventPayload) -> AgentSessionEvent {
    AgentSessionEvent {
        version: 5,
        session_id: "workflow".into(),
        seq: seq as u64,
        time_unix_ms: seq as u64,
        turn_id: Some("turn".into()),
        step_id: Some("decision".into()),
        payload,
    }
}

fn answered(seq: usize, input: AnswerQuestionInput, action: bool) -> AgentSessionEvent {
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&input).unwrap()));
    event(
        seq,
        if action {
            AgentSessionEventPayload::QuestionActionAnswered {
                submission: input,
                fingerprint,
            }
        } else {
            AgentSessionEventPayload::QuestionAnswered {
                submission: input,
                fingerprint,
            }
        },
    )
}

fn selected(command: &str) -> Vec<AgentSessionEvent> {
    vec![
        event(
            0,
            AgentSessionEventPayload::QuestionRequested {
                identity: identity(),
                arguments: arguments(command),
                provider: AgentSubagentModel {
                    route_id: "route".into(),
                    model_id: "model".into(),
                    reasoning_effort: None,
                    route_revision: None,
                },
            },
        ),
        answered(1, submission(None), false),
    ]
}

fn command(id: &str, command: &str) -> ModelToolCall {
    ModelToolCall {
        call_id: id.into(),
        provider_call_id: None,
        name: "run_terminal_command".into(),
        arguments: json!({"command":command,"explanation":"Verify the user prerequisite"}),
    }
}

fn record_call(events: &mut Vec<AgentSessionEvent>, call: &ModelToolCall) {
    events.push(event(
        events.len(),
        AgentSessionEventPayload::ToolCall {
            call: RecordedToolCall {
                call_id: call.call_id.clone(),
                provider_call_id: None,
                name: call.name.clone(),
                native_name: None,
                arguments: call.arguments.clone(),
                title: None,
                effect: Some(super::super::super::AgentSessionEffect::ReadOnly),
                target: None,
            },
        },
    ));
}

fn record_execution(events: &mut Vec<AgentSessionEvent>, call: &ModelToolCall, exit_code: i32) {
    record_call(events, call);
    events.push(event(
        events.len(),
        AgentSessionEventPayload::ToolResult {
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            status: AgentToolResultStatus::Completed,
            summary: "Foreground command exited".into(),
            data: Some(json!({"exitCode":exit_code,"state":"exited"})),
            duration_ms: None,
            evidence_refs: vec![],
        },
    ));
}

#[test]
fn selected_plan_remains_waiting_and_completion_cannot_change_it() {
    let events = selected("test -r /etc/hosts");
    let record = records(&events).pop().unwrap();
    assert!(record.waiting());
    assert!(!matches_result(&record, &result(&record)));
    assert!(record
        .validate_submission(&submission(Some(UserActionResponse::Completed)))
        .is_ok());
    let mut changed = submission(Some(UserActionResponse::Completed));
    changed.answers[0].selected = vec!["Use another existing connection".into()];
    assert!(record.validate_submission(&changed).is_err());
    assert!(is_same_submission(&record, &submission(None)).unwrap());
    assert!(check_call(&events, "turn", &command("poll", "sleep 1"), 1)
        .unwrap_err()
        .starts_with("USER_ACTION_PENDING"));
}

#[test]
fn durable_replay_preserves_selection_and_completion_receipts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("workflow.json");
    let mut events = selected("test -r /etc/hosts");
    std::fs::write(&path, serde_json::to_vec(&events).unwrap()).unwrap();
    let restored: Vec<AgentSessionEvent> =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let record = records(&restored).pop().unwrap();
    assert!(record.waiting());
    let completion = answered(2, submission(Some(UserActionResponse::Completed)), true);
    validate_payload(&completion).unwrap();
    validate_transition(&restored, &completion).unwrap();
    events.push(completion.clone());
    assert!(validate_transition(&events, &completion).is_err());
    std::fs::write(&path, serde_json::to_vec(&events).unwrap()).unwrap();
    let restored: Vec<AgentSessionEvent> =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let record = records(&restored).pop().unwrap();
    assert!(!record.waiting());
    assert!(is_same_submission(&record, &submission(None)).unwrap());
    assert!(is_same_submission(&record, &submission(Some(UserActionResponse::Completed))).unwrap());
    assert!(
        !is_same_submission(&record, &submission(Some(UserActionResponse::ChangePlan))).unwrap()
    );
    assert!(matches_result(&record, &result(&record)));
}

#[test]
fn real_foreground_verification_is_required_before_dependent_work() {
    use crate::agent_runtime::driver::{text_response_completion, TextResponseCompletion};

    let root = tempfile::tempdir().unwrap();
    let prerequisite = root.path().join("ready");
    let source = if cfg!(windows) {
        format!(
            "if ([IO.File]::Exists('{}')) {{ exit 0 }} else {{ exit 1 }}",
            prerequisite.display().to_string().replace('\'', "''")
        )
    } else {
        format!("test -f '{}'", prerequisite.display())
    };
    let run_verification = || {
        let mut command = std::process::Command::new(if cfg!(windows) {
            "powershell.exe"
        } else {
            "sh"
        });
        if cfg!(windows) {
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &source,
            ]);
        } else {
            command.args(["-c", &source]);
        }
        command.status().unwrap()
    };
    let verify = command("verify", &source);
    let dependent = command("dependent", "printf dependent");
    let mut events = selected(&source);
    events.push(answered(
        2,
        submission(Some(UserActionResponse::Completed)),
        true,
    ));
    assert_eq!(
        text_response_completion(&events, "turn", false),
        TextResponseCompletion::Incomplete,
        "the user confirmed the action, but no verification has executed"
    );
    assert!(check_call(&events, "turn", &dependent, 1).is_err());
    assert!(check_call(&events, "turn", &verify, 2).is_err());
    let mut handoff = command("handoff", &source);
    handoff.arguments["handoffToUser"] = json!(true);
    assert!(check_call(&events, "turn", &handoff, 1).is_err());
    assert!(check_call(&events, "turn", &verify, 1).is_ok());
    let mut prepared = events.clone();
    record_execution(&mut prepared, &verify, 0);
    prepared.pop();
    assert!(
        check_call(&prepared, "turn", &verify, 1).is_ok(),
        "a prepared but undispatched verification must pass the dispatch recheck"
    );
    // This is an actual subprocess result, not a mocked execution or success.
    let failure = run_verification();
    assert!(!failure.success());
    let mut failed_events = events.clone();
    record_execution(&mut failed_events, &verify, failure.code().unwrap());
    assert_eq!(
        text_response_completion(&failed_events, "turn", false),
        TextResponseCompletion::Incomplete,
    );
    assert!(check_call(&failed_events, "turn", &dependent, 1).is_err());
    assert!(check_call(&failed_events, "turn", &verify, 1)
        .unwrap_err()
        .starts_with("USER_ACTION_VERIFICATION_FAILED"));
    std::fs::write(prerequisite, "ready").unwrap();
    let success = run_verification();
    assert!(success.success());
    let mut history_with_handoff = events.clone();
    record_execution(&mut history_with_handoff, &handoff, success.code().unwrap());
    assert!(check_call(&history_with_handoff, "turn", &dependent, 1).is_err());
    assert!(check_call(&history_with_handoff, "turn", &verify, 1).is_ok());
    record_execution(&mut events, &verify, success.code().unwrap());
    assert!(check_call(&events, "turn", &dependent, 1).is_ok());
    let replay: Vec<AgentSessionEvent> =
        serde_json::from_slice(&serde_json::to_vec(&events).unwrap()).unwrap();
    assert!(check_call(&replay, "turn", &dependent, 1).is_ok());
    assert_eq!(
        text_response_completion(&replay, "turn", false),
        TextResponseCompletion::Completed,
    );
}

#[test]
fn frontend_readiness_rejection_allows_one_fresh_verification() {
    let source = "test -r /etc/hosts";
    let verify = command("verify", source);
    let retry = command("retry", source);
    let dependent = command("dependent", "printf dependent");
    let mut events = selected(source);
    events.push(answered(
        2,
        submission(Some(UserActionResponse::Completed)),
        true,
    ));
    for call in [&verify, &retry] {
        record_call(&mut events, call);
        events.push(event(
            events.len(),
            AgentSessionEventPayload::ToolExecution {
                call_id: call.call_id.clone(),
                status: AgentToolExecutionStatus::Dispatched,
                idempotency: "conditional".into(),
            },
        ));
        assert!(check_call(&events, "turn", &retry, 1).is_err());
        events.push(event(
            events.len(),
            AgentSessionEventPayload::ToolResult {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                status: AgentToolResultStatus::Failed,
                summary: "Rejected before terminal submission".into(),
                data: Some(json!({
                    "execution":"notStarted",
                    "error":"TERMINAL_FRONTEND_PENDING_INPUT: terminal has unsubmitted user input",
                })),
                duration_ms: None,
                evidence_refs: vec![],
            },
        ));
        assert!(check_call(&events, "turn", &dependent, 1).is_err());
        assert!(check_call(&events, "turn", &retry, 2).is_err());
        if call.call_id == verify.call_id {
            assert!(check_call(&events, "turn", &retry, 1).is_ok());
        }
    }
    assert!(check_call(&events, "turn", &command("third", source), 1)
        .unwrap_err()
        .starts_with("USER_ACTION_VERIFICATION_FAILED"));
}

#[test]
fn cancelled_or_changed_plan_does_not_execute_the_original_queue() {
    for response in [
        UserActionResponse::Cancelled,
        UserActionResponse::ChangePlan,
    ] {
        let mut events = selected("test -r /etc/hosts");
        events.push(answered(2, submission(Some(response)), true));
        assert!(check_call(&events, "turn", &command("old", "printf old"), 1).is_err());
        let ask = ModelToolCall {
            call_id: "new".into(),
            provider_call_id: None,
            name: TOOL_NAME.into(),
            arguments: json!({}),
        };
        assert!(check_call(&events, "turn", &ask, 1).is_ok());
    }
}

#[test]
fn ordinary_questions_cannot_bypass_an_outstanding_verification() {
    let mut events = selected("test -r /etc/hosts");
    events.push(answered(
        2,
        submission(Some(UserActionResponse::Completed)),
        true,
    ));
    let mut unrelated = events[0].clone();
    unrelated.seq = 3;
    if let AgentSessionEventPayload::QuestionRequested {
        identity,
        arguments,
        ..
    } = &mut unrelated.payload
    {
        identity.call_id = "another".into();
        identity.question_request_id = "another".into();
        *arguments =
            QuestionArguments::parse(json!({"questions":[{"id":"q","question":"Continue?"}]}))
                .unwrap();
    }
    events.push(unrelated);
    assert!(check_call(
        &events,
        "turn",
        &command("dependent", "printf dependent"),
        1
    )
    .is_err());
}

#[test]
fn safe_input_schema_and_user_action_shape_are_enforced() {
    for kind in ["password", "secret", "credential", "api_key"] {
        assert!(QuestionArguments::parse(
            json!({"questions":[{"id":"q","question":"Input", "input_kind":kind}]})
        )
        .is_err());
    }
    let mut args = arguments("test -r /etc/hosts");
    args.questions[0].multi_select = true;
    assert!(args.validate().is_err());
    let direct=parse_call(ACTION_TOOL_NAME,json!({"id":"manual","instructions":"Complete authentication in the application.","verification_command":"test -r /etc/hosts"})).unwrap();
    assert!(direct.questions[0].options.is_none());
    assert!(parse_call(TOOL_NAME, serde_json::to_value(&direct).unwrap()).is_err());
    let mut events = selected("test -r /etc/hosts");
    if let AgentSessionEventPayload::QuestionRequested { arguments, .. } = &mut events[0].payload {
        *arguments = direct;
    }
    let record = records(&events[..1]).pop().unwrap();
    let mut input = submission(Some(UserActionResponse::Completed));
    input.answers.clear();
    assert!(record.validate_submission(&input).is_ok());
    input.action = None;
    assert!(record.validate_submission(&input).is_err());
}

#[test]
fn only_unchanged_completed_decisions_are_reused() {
    let mut events = selected("test -r /etc/hosts");
    if let AgentSessionEventPayload::QuestionAnswered { submission, .. } = &mut events[1].payload {
        submission.answers[0].selected = vec!["Use another existing connection".into()];
    }
    let all = records(&events);
    let mut args = all[0].arguments.clone();
    assert!(reusable(&all, "turn", &args, None).is_some());
    assert!(reusable(&all, "next-turn", &args, None).is_none());
    args.questions[0].question = "Choose connection".into();
    assert!(reusable(&all, "turn", &args, None).is_some());
    args.questions[0].id = "new-call-question-id".into();
    let previous = reusable(&all, "turn", &args, None)
        .expect("stable decision identity is independent of the local question id");
    assert_eq!(
        reused_answers(previous, &args).unwrap()[0].id,
        "new-call-question-id"
    );
    args.questions[0].decision_context = Some("another account".into());
    assert!(reusable(&all, "turn", &args, None).is_none());
    assert!(reusable(
        &records(&selected("test -r /etc/hosts")),
        "turn",
        &arguments("test -r /etc/hosts"),
        None
    )
    .is_none());
}

#[test]
fn choosing_a_different_or_custom_plan_never_executes_the_speculative_queue() {
    let original = selected("test -r /etc/hosts");
    for answer in [
        QuestionAnswer {
            id: "access".into(),
            selected: vec!["Use another existing connection".into()],
            custom: None,
        },
        QuestionAnswer {
            id: "access".into(),
            selected: vec![],
            custom: Some("Stop and use another approach".into()),
        },
    ] {
        let mut events = original.clone();
        if let AgentSessionEventPayload::QuestionAnswered { submission, .. } =
            &mut events[1].payload
        {
            submission.answers = vec![answer];
        }
        let call = command("old-command", "printf dependent");
        assert!(check_queue(&events, "decision", &call).is_err());
        assert!(check_queue(&events, "new-step", &call).is_ok());
    }
}

#[test]
fn standalone_instructions_keep_their_full_byte_budget() {
    let instructions = "操作".repeat(1300);
    let args=parse_call(ACTION_TOOL_NAME,json!({"id":"manual","instructions":instructions,"verification_command":"test -r /etc/hosts"})).unwrap();
    assert_eq!(
        args.questions[0].user_action.as_ref().unwrap().instructions,
        instructions
    );
    assert!(args.questions[0].question.len() <= 2048);
}

#[test]
fn fresh_human_instructions_invalidate_prior_decision_reuse() {
    let mut events = selected("test -r /etc/hosts");
    if let AgentSessionEventPayload::QuestionAnswered { submission, .. } = &mut events[1].payload {
        submission.answers[0].selected = vec!["Use another existing connection".into()];
    }
    let args = records(&events)[0].arguments.clone();
    assert!(reusable(&records(&events), "turn", &args, None).is_some());
    events.push(event(
        2,
        AgentSessionEventPayload::UserMessage {
            message: crate::agent_runtime::AgentInboxMessage {
                images: vec![],
                message_id: "steer".into(),
                client_submission_id: Some("steer".into()),
                content: "Change the chosen access method".into(),
                source: crate::agent_runtime::AgentMessageSource::user(),
                terminal_context: None,
            },
        },
    ));
    assert!(reusable(&records(&events), "turn", &args, None).is_none());
}

#[test]
fn change_plan_accepts_optional_non_sensitive_note_and_rejects_other_actions() {
    let mut change = submission(Some(UserActionResponse::ChangePlan));
    change.action_note = Some("admin is not in the sudoers file".into());
    change.validate().unwrap();

    let mut completed = submission(Some(UserActionResponse::Completed));
    completed.action_note = Some("should fail".into());
    assert!(completed.validate().is_err());

    let mut cancelled = submission(Some(UserActionResponse::Cancelled));
    cancelled.action_note = Some("should fail".into());
    assert!(cancelled.validate().is_err());

    let mut blank = submission(Some(UserActionResponse::ChangePlan));
    blank.action_note = Some("   ".into());
    assert!(blank.validate().is_err());

    let mut events = selected("test -r /etc/hosts");
    events.push(answered(2, change, true));
    let record = records(&events).pop().unwrap();
    assert_eq!(record.action_note(), Some("admin is not in the sudoers file"));
    let AgentSessionEventPayload::ToolResult { data: Some(data), .. } = result(&record) else {
        panic!("expected tool result data");
    };
    assert_eq!(
        data["userAction"]["note"],
        json!("admin is not in the sudoers file")
    );
}
