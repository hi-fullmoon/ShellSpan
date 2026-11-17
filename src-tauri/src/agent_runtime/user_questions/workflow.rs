//! Structured user work stays inside the durable question barrier.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct UserAction {
    pub(crate) instructions: String,
    pub(crate) verification_command: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UserActionResponse {
    Completed,
    ChangePlan,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QuestionInputKind {
    NonSensitive,
}

pub(crate) fn is_question_tool(name: &str) -> bool {
    matches!(name, TOOL_NAME | ACTION_TOOL_NAME)
}

pub(crate) fn supports_user_action(header: &super::super::AgentSessionHeader) -> bool {
    header.target.as_ref().is_some_and(|target| {
        target.kind == "local"
            || (target.kind == "remote"
                && (target.profile_id.is_some()
                    || header.execution_surface
                        == super::super::AgentExecutionSurface::BoundTerminal))
    }) && header.capability_scope.as_ref().is_none_or(|scope| {
        scope
            .tool_names
            .iter()
            .any(|name| name == "run_terminal_command")
            && scope
                .effects
                .iter()
                .any(|effect| *effect != super::super::AgentSessionEffect::None)
    })
}

pub(super) fn validate_question(args: &QuestionArguments, q: &Question) -> Result<(), String> {
    match (&q.decision_key, &q.decision_context) {
        (Some(key), Some(context)) => {
            text(key, 128)?;
            text(context, 2048)?;
        }
        (None, None) => {}
        _ => return Err("decision_key and decision_context must be supplied together".into()),
    }
    let actions = q
        .options
        .iter()
        .flatten()
        .filter_map(|o| o.user_action.as_ref());
    let has_action = q.user_action.is_some() || actions.clone().next().is_some();
    if has_action && (args.questions.len() != 1 || q.multi_select) {
        return Err("user actions require one single-select question".into());
    }
    if q.user_action.is_some() && q.options.is_some() {
        return Err("standalone user action cannot have options".into());
    }
    for action in q.user_action.iter().chain(actions) {
        text(&action.instructions, 8192)?;
        text(&action.verification_command, 8192)?;
        if [&action.instructions, &action.verification_command]
            .into_iter()
            .any(|text| super::super::sudo_policy_reference(text))
        {
            return Err(super::super::SUDO_POLICY_DENIED.into());
        }
        if action.verification_command.contains(['\n', '\r', '\0']) {
            return Err("verification_command must be one bounded non-interactive command".into());
        }
    }
    Ok(())
}

pub(crate) fn parse_call(name: &str, arguments: Value) -> Result<QuestionArguments, String> {
    if name == ACTION_TOOL_NAME {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            id: String,
            title: Option<String>,
            instructions: String,
            verification_command: String,
        }
        bounded(&arguments)?;
        let input: Input = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
        let title = input
            .title
            .unwrap_or_else(|| input.instructions.chars().take(256).collect());
        QuestionArguments::parse(json!({"questions":[{
            "id":input.id, "question":title,
            "user_action":{"instructions":input.instructions,"verification_command":input.verification_command}
        }]}))
    } else {
        let args = QuestionArguments::parse(arguments)?;
        if args.questions.iter().any(|q| q.user_action.is_some()) {
            return Err("use request_user_action for standalone user work".into());
        }
        Ok(args)
    }
}

impl QuestionRecord {
    pub(crate) fn user_action(&self) -> Option<&UserAction> {
        self.arguments
            .questions
            .first()?
            .user_action
            .as_ref()
            .or_else(|| {
                self.arguments
                    .selected_user_action(&self.answer.as_ref()?.answers)
            })
    }

    pub(crate) fn action_response(&self) -> Option<UserActionResponse> {
        self.action_answer
            .as_ref()
            .or(self.answer.as_ref())
            .and_then(|a| a.action)
    }

    pub(crate) fn waiting(&self) -> bool {
        !self.cancelled
            && (self.answer.is_none()
                || (self.user_action().is_some() && self.action_response().is_none()))
    }

    pub(crate) fn validate_submission(
        &self,
        input: &AnswerQuestionInput,
    ) -> Result<Vec<QuestionAnswer>, String> {
        if input.action.is_some() {
            if self.user_action().is_none() {
                return Err("question has no pending user action".into());
            }
            if let Some(answer) = &self.answer {
                if input.answers != answer.answers {
                    return Err("user action response cannot change the committed selection".into());
                }
            } else if !input.answers.is_empty() {
                return Err("standalone user action cannot accept question answers".into());
            }
            Ok(input.answers.clone())
        } else if self
            .arguments
            .questions
            .iter()
            .any(|q| q.user_action.is_some())
        {
            Err("user action requires an explicit completion, change_plan or cancellation".into())
        } else {
            self.arguments.normalize_answers(&input.answers)
        }
    }
}

impl QuestionArguments {
    pub(super) fn selected_user_action(&self, answers: &[QuestionAnswer]) -> Option<&UserAction> {
        let question = self.questions.first()?;
        let answer = answers.first()?;
        // A custom answer replaces the selected plan and never inherits its action.
        if answer.id != question.id || answer.custom.is_some() {
            return None;
        }
        question
            .options
            .as_ref()?
            .iter()
            .find(|option| answer.selected.contains(&option.label))?
            .user_action
            .as_ref()
    }
}

pub(crate) fn action_schema() -> Value {
    json!({"type":"object","additionalProperties":false,
        "required":["instructions","verification_command"],"properties":{
        "instructions":{"type":"string","minLength":1,"maxLength":8192},
        "verification_command":{"type":"string","minLength":1,"maxLength":8192,
            "description":"One bounded foreground command that verifies the prerequisite without requesting credentials or changing configuration. Zero exit code is required before dependent work."}
    }})
}

pub(crate) fn standalone_schema() -> Value {
    let mut schema = action_schema();
    schema["required"] = json!(["id", "instructions", "verification_command"]);
    schema["properties"]["id"] = json!({"type":"string","minLength":1,"maxLength":64});
    schema["properties"]["title"] = json!({"type":"string","minLength":1,"maxLength":2048});
    schema
}

/// Reuse only identical decisions within the same turn and frozen target context.
/// No semantic matching, and failed/cancelled user work is never reused.
pub(super) fn reusable<'a>(
    records: &'a [QuestionRecord],
    turn: &str,
    args: &QuestionArguments,
    target: Option<&super::super::AgentSessionTarget>,
) -> Option<&'a QuestionRecord> {
    records.iter().rev().find(|r| {
        r.identity.turn_id == turn
            && r.reuse_allowed
            && !r.cancelled
            && !r.waiting()
            && r.target.as_ref() == target
            && r.answer.is_some()
            && r.user_action().is_none()
            && args.questions.iter().all(|q| q.decision_key.is_some())
            && r.arguments.questions.len() == args.questions.len()
            && r.arguments
                .questions
                .iter()
                .zip(&args.questions)
                .all(|(old, new)| {
                    old == new
                        || (old.decision_key.is_some()
                            && old.decision_key == new.decision_key
                            && old.decision_context == new.decision_context
                            && old.options == new.options
                            && old.multi_select == new.multi_select)
                })
    })
}

pub(super) fn reused_answers(
    record: &QuestionRecord,
    args: &QuestionArguments,
) -> Result<Vec<QuestionAnswer>, String> {
    let previous = record.answer.as_ref().ok_or("reused answer missing")?;
    let answers = record
        .arguments
        .questions
        .iter()
        .zip(&args.questions)
        .map(|(old, new)| {
            let answer = previous
                .answers
                .iter()
                .find(|answer| answer.id == old.id)
                .ok_or("reused answer missing")?;
            Ok(QuestionAnswer {
                id: new.id.clone(),
                ..answer.clone()
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    args.normalize_answers(&answers)
}

pub(crate) fn check_target(
    events: &[AgentSessionEvent],
    turn: &str,
    target: &super::super::AgentSessionTarget,
) -> Result<(), String> {
    if records(events)
        .iter()
        .rev()
        .find(|r| r.identity.turn_id == turn)
        .and_then(|r| r.target.as_ref())
        .is_some_and(|frozen| frozen != target)
    {
        return Err("USER_INTERACTION_TARGET_CHANGED: the decision and verification belong to another frozen target; obtain a new decision in a new turn".into());
    }
    Ok(())
}

/// Tools planned before a structured decision cannot assume which branch the
/// user will select. Return them unexecuted and let the next model step replan.
pub(crate) fn check_queue(
    events: &[AgentSessionEvent],
    step: &str,
    call: &super::super::ModelToolCall,
) -> Result<(), String> {
    if records(events).iter().any(|r| {
        r.identity.step_id == step
            && r.identity.call_id != call.call_id
            && r.answer.is_some()
            && r.arguments.questions.iter().any(|q| {
                q.decision_key.is_some()
                    || q.user_action.is_some()
                    || q.options.iter().flatten().any(|o| o.user_action.is_some())
            })
    }) {
        return Err("USER_INTERACTION_REPLAN_REQUIRED: this call was planned before the user's decision and was not executed; use the committed answer to plan a fresh step".into());
    }
    Ok(())
}

/// Enforce the selected prerequisite at tool admission, including the old batch.
/// A completion click permits verification, not dependent work.
pub(crate) fn check_call(
    events: &[AgentSessionEvent],
    turn: &str,
    call: &super::super::ModelToolCall,
    batch_len: usize,
) -> Result<(), String> {
    let records = records(events);
    if records
        .iter()
        .any(|r| r.identity.turn_id == turn && r.waiting())
    {
        return Err("USER_ACTION_PENDING: wait for the existing user interaction; do not poll or execute dependent tools".into());
    }
    let Some(record) = records
        .iter()
        .rev()
        .find(|r| r.identity.turn_id == turn && r.user_action().is_some())
    else {
        return Ok(());
    };
    let action = record.user_action().expect("selected above");
    if is_question_tool(&call.name)
        || matches!(call.name.as_str(), "update_plan" | "read_tool_result")
    {
        return Ok(());
    }
    if record.cancelled || record.action_response() != Some(UserActionResponse::Completed) {
        if record.action_response() == Some(UserActionResponse::ChangePlan)
            && records.iter().any(|r| r.identity.turn_id == turn && r.identity != record.identity
                && r.answer.is_some() && !r.cancelled && r.arguments.questions.iter().all(|q| q.decision_key.is_some())
                && events.iter().find(|e| matches!(&e.payload, AgentSessionEventPayload::QuestionRequested {identity,..} if identity == &r.identity))
                    .zip(events.iter().find(|e| matches!(&e.payload, AgentSessionEventPayload::QuestionRequested {identity,..} if identity == &record.identity)))
                    .is_some_and(|(new, old)| new.seq > old.seq)) {
            return Ok(());
        }
        return Err("USER_ACTION_NOT_COMPLETED: the user cancelled or requested another plan; ask for a new decision before dependent tools".into());
    }
    let confirmed = events
        .iter()
        .rposition(|e| match &e.payload {
            AgentSessionEventPayload::QuestionActionAnswered { submission, .. }
            | AgentSessionEventPayload::QuestionAnswered { submission, .. } => {
                submission.identity == record.identity
                    && submission.action == Some(UserActionResponse::Completed)
            }
            _ => false,
        })
        .unwrap_or(events.len());
    let mut verification_calls = HashSet::new();
    let mut dispatched = HashSet::new();
    let mut handles = HashSet::new();
    let mut readiness_rejected = false;
    let mut attempted = false;
    let mut failed = false;
    let is_verification = |name: &str, arguments: &Value| {
        name == "run_terminal_command"
            && arguments.get("command").and_then(Value::as_str)
                == Some(&action.verification_command)
            && arguments.get("background").and_then(Value::as_bool) != Some(true)
            && arguments.get("handoffToUser").and_then(Value::as_bool) != Some(true)
    };
    for event in events.iter().skip(confirmed + 1) {
        match &event.payload {
            AgentSessionEventPayload::ToolCall { call }
                if is_verification(&call.name, &call.arguments) =>
            {
                verification_calls.insert((event.step_id.clone(), call.call_id.clone()));
            }
            AgentSessionEventPayload::ToolExecution { call_id, .. }
                if verification_calls.contains(&(event.step_id.clone(), call_id.clone())) =>
            {
                dispatched.insert((event.step_id.clone(), call_id.clone()));
            }
            AgentSessionEventPayload::ToolCall { call }
                if call.name == "wait_process"
                    && call
                        .arguments
                        .get("processHandle")
                        .and_then(Value::as_str)
                        .is_some_and(|h| handles.contains(h)) =>
            {
                verification_calls.insert((event.step_id.clone(), call.call_id.clone()));
            }
            AgentSessionEventPayload::ToolResult {
                call_id,
                status,
                data,
                ..
            } if verification_calls.contains(&(event.step_id.clone(), call_id.clone())) => {
                if *status == super::super::AgentToolResultStatus::Rejected {
                    continue;
                }
                dispatched.remove(&(event.step_id.clone(), call_id.clone()));
                // A readiness rejection happens before native submission. Allow one
                // new verification call after it, without relaxing the exit-code gate.
                if !readiness_rejected
                    && *status == super::super::AgentToolResultStatus::Failed
                    && data.as_ref().is_some_and(|data| {
                        data.get("execution").and_then(Value::as_str) == Some("notStarted")
                            && data
                                .get("error")
                                .and_then(Value::as_str)
                                .is_some_and(|error| {
                                    error.starts_with("TERMINAL_FRONTEND_PENDING_INPUT:")
                                        || error.starts_with("TERMINAL_FRONTEND_UNVERIFIED_INPUT:")
                                })
                    })
                {
                    readiness_rejected = true;
                    continue;
                }
                attempted = true;
                if *status == super::super::AgentToolResultStatus::Completed {
                    if data
                        .as_ref()
                        .and_then(|d| d.get("exitCode"))
                        .and_then(Value::as_i64)
                        == Some(0)
                    {
                        return Ok(());
                    }
                    if let Some(handle) = data
                        .as_ref()
                        .and_then(|d| d.get("processHandle"))
                        .and_then(Value::as_str)
                    {
                        handles.insert(handle.to_owned());
                    }
                }
                failed = !matches!(
                    status,
                    super::super::AgentToolResultStatus::Completed
                        | super::super::AgentToolResultStatus::Uncertain
                ) || data
                    .as_ref()
                    .and_then(|d| d.get("exitCode"))
                    .and_then(Value::as_i64)
                    .is_some_and(|code| code != 0);
            }
            _ => {}
        }
    }
    if !failed
        && call.name == "wait_process"
        && call
            .arguments
            .get("processHandle")
            .and_then(Value::as_str)
            .is_some_and(|h| handles.contains(h))
    {
        return Ok(());
    }
    if failed {
        return Err("USER_ACTION_VERIFICATION_FAILED: explain the failed verification and request user action again; do not poll or repeat the plan question".into());
    }
    if !attempted
        && dispatched.is_empty()
        && batch_len == 1
        && is_verification(&call.name, &call.arguments)
    {
        Ok(())
    } else {
        Err(format!("USER_ACTION_VERIFICATION_REQUIRED: run this exact command alone in foreground and confirm exitCode=0 before dependent work: {}", action.verification_command))
    }
}

#[cfg(test)]
mod tests {
    include!("../tests/user_question_workflow.rs");
}
