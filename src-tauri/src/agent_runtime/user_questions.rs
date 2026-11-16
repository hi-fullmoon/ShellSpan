//! Durable user input, separate from native authorization.
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{AgentSessionEvent, AgentSessionEventPayload};

pub(crate) const TOOL_NAME: &str = "ask_user_question";
pub(crate) const ACTION_TOOL_NAME: &str = "request_user_action";
pub(crate) const MODEL_INSTRUCTIONS: &str = concat!(
    "Whenever you need clarification, missing information, or a user decision, you must call ask_user_question and wait for its answer. This tool displays a question card and pauses the task until the user submits an answer. Do not substitute a question in ordinary chat, a final response, or a simulated card. Do not continue dependent actions, guess an answer, or treat silence as consent. Ask only when a user decision is necessary; do not ask again when the current task already supplies the answer or authorization. ",
    "Only the live root Agent may call these tools; child Agents must report the unresolved decision to their parent. Answers never grant native tool permissions or bypass approval or recovery checks. Collect non-sensitive information only; never request passwords or other credentials."
);
pub(crate) const WORKFLOW_INSTRUCTIONS: &str = concat!(
    "Never solicit passwords, private keys, API keys, tokens or recovery codes in questions, options, free text or chat, or embed secrets in commands/scripts. For remote sudo select a configured sudoOperationId when supplied by run_terminal_command; ShellSpan handles credentials separately. Otherwise hand sensitive work to the user. Never ask the user to edit sudoers or grant passwordless sudo. ",
    "A selected option is a decision, not missing text or proof of completion. Reuse decision_key and decision_context while target/account/prerequisites remain unchanged. ",
    "Options requiring user work must attach user_action with instructions and a non-interactive verification_command, in one single-select question. Use request_user_action for standalone work only when supplied. Selection pauses until explicit completion, cancellation or change of plan. For work on the bound terminal, ShellSpan hands input to the user during the pause; ask them to finish at the shell prompt before choosing Continue verification. Do not re-ask the plan for completion or poll while waiting. ",
    "After completion, run the exact verification_command alone in foreground run_terminal_command; require confirmed exitCode=0 before dependent work. On failure, explain it and request fresh user action, keeping the chosen plan. Never request broader privileges or unrestricted passwordless sudo."
);
pub(crate) const TOOL_INSTRUCTIONS: &str = "When clarification or a decision is necessary, you must call ask_user_question and wait for its answer. It displays a question card and pauses the task. Do not substitute a question in ordinary chat. Do not continue dependent actions. Ask only when necessary; do not ask again when the task supplies the answer. Answers never grant native tool permissions. Non-sensitive inputs only; never request credentials.";
mod workflow;
pub(crate) use workflow::{
    check_call, check_queue, check_target, is_question_tool, standalone_schema,
    supports_user_action,
};
pub(crate) use workflow::{UserAction, UserActionResponse};
const MAX_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct QuestionOption {
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) user_action: Option<UserAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Question {
    pub(crate) id: String,
    pub(crate) question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) input_kind: Option<workflow::QuestionInputKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) options: Option<Vec<QuestionOption>>,
    #[serde(default)]
    pub(crate) multi_select: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) decision_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) decision_context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) user_action: Option<UserAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct QuestionArguments {
    pub(crate) questions: Vec<Question>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct QuestionAnswer {
    pub(crate) id: String,
    pub(crate) selected: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) custom: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuestionIdentity {
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) question_request_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalManualHandoff {
    pub(crate) session_id: String,
    pub(crate) agent_session_id: String,
    pub(crate) task_id: String,
    pub(crate) turn_id: String,
    pub(crate) through_seq: u64,
    pub(crate) acquired_at_unix_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveTerminalManualHandoff {
    pub(crate) handoff: TerminalManualHandoff,
    pub(crate) terminal: crate::models::SessionSummary,
    pub(crate) profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnswerQuestionInput {
    pub(crate) identity: QuestionIdentity,
    pub(crate) client_operation_id: String,
    pub(crate) answers: Vec<QuestionAnswer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) action: Option<UserActionResponse>,
}

#[derive(Debug, Clone)]
pub(crate) struct QuestionRecord {
    pub(crate) identity: QuestionIdentity,
    pub(crate) arguments: QuestionArguments,
    pub(crate) provider: super::AgentSubagentModel,
    pub(crate) answer: Option<AnswerQuestionInput>,
    pub(crate) cancelled: bool,
    pub(crate) has_result: bool,
    pub(crate) fingerprint: Option<String>,
    pub(crate) action_answer: Option<AnswerQuestionInput>,
    pub(crate) action_fingerprint: Option<String>,
    pub(crate) tool_name: String,
    pub(crate) target: Option<super::AgentSessionTarget>,
    pub(crate) reuse_allowed: bool,
}

fn text(value: &str, limit: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > limit {
        return Err("question text is empty or outside byte limits".into());
    }
    Ok(())
}

fn bounded(value: &impl Serialize) -> Result<(), String> {
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("question payload exceeds 32768 bytes".into());
    }
    Ok(())
}

pub(crate) fn is_same_submission(
    record: &QuestionRecord,
    input: &AnswerQuestionInput,
) -> Result<bool, String> {
    let fingerprint = hex::encode(Sha256::digest(
        serde_json::to_vec(input).map_err(|e| e.to_string())?,
    ));
    let (answer, committed_fingerprint) =
        if input.action.is_some() && record.action_answer.is_some() {
            (&record.action_answer, &record.action_fingerprint)
        } else {
            (&record.answer, &record.fingerprint)
        };
    Ok(answer
        .as_ref()
        .is_some_and(|a| a.client_operation_id == input.client_operation_id)
        && committed_fingerprint.as_deref() == Some(&fingerprint))
}

impl QuestionArguments {
    pub(crate) fn parse(value: Value) -> Result<Self, String> {
        bounded(&value)?;
        let value: Self = serde_json::from_value(value).map_err(|e| e.to_string())?;
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        bounded(self)?;
        if !(1..=3).contains(&self.questions.len()) {
            return Err("questions must contain 1 to 3 items".into());
        }
        let mut ids = HashSet::new();
        for q in &self.questions {
            workflow::validate_question(self, q)?;
            text(&q.id, 64)?;
            text(&q.question, 2048)?;
            if !ids.insert(&q.id) {
                return Err("duplicate question id".into());
            }
            if let Some(header) = &q.header {
                text(header, 128)?;
            }
            if let Some(options) = &q.options {
                if !(2..=7).contains(&options.len()) {
                    return Err("options must contain 2 to 7 items".into());
                }
                let mut labels = HashSet::new();
                for option in options {
                    text(&option.label, 256)?;
                    if !labels.insert(&option.label) {
                        return Err("duplicate option label".into());
                    }
                    if let Some(description) = &option.description {
                        text(description, 1024)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn normalize_answers(
        &self,
        answers: &[QuestionAnswer],
    ) -> Result<Vec<QuestionAnswer>, String> {
        bounded(&answers)?;
        if answers.len() != self.questions.len() {
            return Err("answer every question exactly once".into());
        }
        let mut seen = HashSet::new();
        let mut normalized = Vec::new();
        for answer in answers {
            if !seen.insert(&answer.id) {
                return Err("duplicate answer id".into());
            }
            let q = self
                .questions
                .iter()
                .find(|q| q.id == answer.id)
                .ok_or("unknown answer id")?;
            if answer.selected.len() > 7 {
                return Err("too many selected options".into());
            }
            let mut selected = HashSet::new();
            for label in &answer.selected {
                if !selected.insert(label)
                    || !q
                        .options
                        .as_ref()
                        .is_some_and(|opts| opts.iter().any(|o| &o.label == label))
                {
                    return Err("unknown or duplicate selected option".into());
                }
            }
            if let Some(custom) = &answer.custom {
                text(custom, 8192)?;
            }
            if !q.multi_select && answer.custom.is_none() && answer.selected.len() > 1 {
                return Err("single-select question has multiple answers".into());
            }
            if answer.selected.is_empty() && answer.custom.is_none() {
                return Err("blank answers cannot be submitted".into());
            }
            let mut answer = answer.clone();
            if !q.multi_select && answer.custom.is_some() {
                answer.selected.clear();
            }
            normalized.push(answer);
        }
        normalized.sort_by_key(|a| self.questions.iter().position(|q| q.id == a.id));
        Ok(normalized)
    }
}

impl QuestionIdentity {
    pub(crate) fn validate(&self) -> Result<(), String> {
        for id in [
            &self.session_id,
            &self.turn_id,
            &self.step_id,
            &self.request_id,
            &self.call_id,
            &self.question_request_id,
        ] {
            text(id, 128)?;
        }
        Ok(())
    }
}

impl AnswerQuestionInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.identity.validate()?;
        text(&self.client_operation_id, 128)?;
        bounded(self)
    }
}

pub(crate) fn records(events: &[AgentSessionEvent]) -> Vec<QuestionRecord> {
    let mut records: Vec<QuestionRecord> = Vec::new();
    let calls: HashMap<_, _> = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::ToolCall { call } => {
                Some(((event.step_id.as_deref(), call.call_id.as_str()), call))
            }
            _ => None,
        })
        .collect();
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::QuestionRequested {
                identity,
                arguments,
                provider,
            } => records.push(QuestionRecord {
                identity: identity.clone(),
                arguments: arguments.clone(),
                provider: provider.clone(),
                answer: None,
                cancelled: false,
                has_result: false,
                fingerprint: None,
                action_answer: None,
                action_fingerprint: None,
                reuse_allowed: true,
                tool_name: calls
                    .get(&(event.step_id.as_deref(), identity.call_id.as_str()))
                    .map(|call| call.name.clone())
                    .unwrap_or_else(|| TOOL_NAME.into()),
                target: calls
                    .get(&(event.step_id.as_deref(), identity.call_id.as_str()))
                    .and_then(|call| call.target.clone()),
            }),
            AgentSessionEventPayload::QuestionAnswered {
                submission,
                fingerprint,
            } => {
                if let Some(record) = records
                    .iter_mut()
                    .find(|r| r.identity == submission.identity)
                {
                    record.answer = Some(submission.clone());
                    record.fingerprint = Some(fingerprint.clone());
                }
                if submission.action == Some(UserActionResponse::ChangePlan) {
                    for record in &mut records {
                        record.reuse_allowed = false;
                    }
                }
            }
            AgentSessionEventPayload::QuestionCancelled { identity } => {
                if let Some(record) = records.iter_mut().find(|r| &r.identity == identity) {
                    record.cancelled = true;
                }
            }
            AgentSessionEventPayload::QuestionActionAnswered {
                submission,
                fingerprint,
            } => {
                if let Some(record) = records
                    .iter_mut()
                    .find(|r| r.identity == submission.identity)
                {
                    record.action_answer = Some(submission.clone());
                    record.action_fingerprint = Some(fingerprint.clone());
                }
                if submission.action == Some(UserActionResponse::ChangePlan) {
                    for record in &mut records {
                        record.reuse_allowed = false;
                    }
                }
            }
            AgentSessionEventPayload::UserMessage { message }
                if message.source.kind == super::AgentMessageSourceKind::User =>
            {
                for record in &mut records {
                    record.reuse_allowed = false;
                }
            }
            AgentSessionEventPayload::ToolResult { call_id, .. } => {
                if let Some(record) = records.iter_mut().find(|r| {
                    r.identity.call_id == *call_id
                        && event.step_id.as_deref() == Some(&r.identity.step_id)
                }) {
                    record.has_result = true;
                }
            }
            _ => {}
        }
    }
    records
}

/// Only the most recent model Step can be resumed. Lifecycle-only waiting
/// StepEnd markers do not discard the assistant's unexecuted tool queue.
pub(crate) fn question_queue(events: &[AgentSessionEvent]) -> Option<(String, String, String)> {
    let start = events
        .iter()
        .rposition(|e| matches!(e.payload, AgentSessionEventPayload::StepStart))?;
    let window = &events[start..];
    if window.iter().any(|e| {
        matches!(
            e.payload,
            AgentSessionEventPayload::TurnEnd { .. }
                | AgentSessionEventPayload::SessionEnded { .. }
        )
    }) {
        return None;
    }
    if !window.iter().any(|e| {
        matches!(&e.payload, AgentSessionEventPayload::AssistantMessage { content, .. }
        if super::assistant_tool_calls(content).iter().any(|c| is_question_tool(&c.name)))
    }) {
        return None;
    }
    let request = window.iter().rev().find_map(|e| match &e.payload {
        AgentSessionEventPayload::RequestHeader { request_id, .. } => Some(request_id.clone()),
        _ => None,
    })?;
    Some((
        events[start].turn_id.clone()?,
        events[start].step_id.clone()?,
        request,
    ))
}

pub(crate) fn schema() -> Value {
    let mut schema = json!({"type":"object","additionalProperties":false,"required":["questions"],"properties":{
        "questions":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["id","question"],"properties":{
            "id":{"type":"string","minLength":1,"maxLength":64},"question":{"type":"string","minLength":1,"maxLength":2048},
            "header":{"type":"string","minLength":1,"maxLength":128},"multi_select":{"type":"boolean"},
            "decision_key":{"type":"string","minLength":1,"maxLength":128},
            "decision_context":{"type":"string","minLength":1,"maxLength":2048},
            "input_kind":{"type":"string","enum":["non_sensitive"],"description":"Only non-sensitive information is supported. Never request passwords or other credentials."},
            "options":{"type":"array","minItems":2,"maxItems":7,"items":{"type":"object","additionalProperties":false,"required":["label"],"properties":{
                "label":{"type":"string","minLength":1,"maxLength":256},"description":{"type":"string","minLength":1,"maxLength":1024}
            }}}
        }}}
    }});
    schema["properties"]["questions"]["items"]["properties"]["options"]["items"]["properties"]
        ["user_action"] = workflow::action_schema();
    schema
}

fn scoped(
    identity: &QuestionIdentity,
    payload: AgentSessionEventPayload,
) -> super::AgentScopedPayload {
    super::AgentScopedPayload {
        turn_id: Some(identity.turn_id.clone()),
        step_id: Some(identity.step_id.clone()),
        payload,
    }
}

pub(super) fn result(record: &QuestionRecord) -> AgentSessionEventPayload {
    AgentSessionEventPayload::ToolResult {
        call_id: record.identity.call_id.clone(),
        name: record.tool_name.clone(),
        status: if record.answer.is_some() && !record.cancelled {
            super::AgentToolResultStatus::Completed
        } else {
            super::AgentToolResultStatus::Cancelled
        },
        summary: if record.answer.is_some() {
            "User answered"
        } else {
            "ASK_ABORTED: user question cancelled"
        }
        .into(),
        data: record
            .answer
            .as_ref()
            .map(|answer| {
                let mut data = json!({"answers":answer.answers});
                if let Some(action) = record.user_action() {
                    data["userAction"] = json!({
                        "instructions":action.instructions,
                        "verificationCommand":action.verification_command,
                        "response":record.action_response(),
                        "verificationRequired":record.action_response() == Some(UserActionResponse::Completed)
                    });
                }
                data
            }),
        duration_ms: None,
        evidence_refs: Vec::new(),
    }
}

pub(crate) fn matches_result(record: &QuestionRecord, payload: &AgentSessionEventPayload) -> bool {
    (!record.waiting() || record.cancelled) && result(record) == *payload
}

pub(crate) fn validate_payload(event: &AgentSessionEvent) -> Result<(), String> {
    let identity = match &event.payload {
        AgentSessionEventPayload::QuestionRequested {
            identity,
            arguments,
            provider,
        } => {
            arguments.validate()?;
            if provider.route_id.trim().is_empty() || provider.model_id.trim().is_empty() {
                return Err("question model selection is invalid".into());
            }
            identity
        }
        AgentSessionEventPayload::QuestionAnswered {
            submission,
            fingerprint,
        }
        | AgentSessionEventPayload::QuestionActionAnswered {
            submission,
            fingerprint,
        } => {
            submission.validate()?;
            if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("invalid answer fingerprint".into());
            }
            &submission.identity
        }
        AgentSessionEventPayload::QuestionCancelled { identity } => identity,
        _ => return Ok(()),
    };
    identity.validate()?;
    if identity.session_id != event.session_id
        || event.turn_id.as_deref() != Some(&identity.turn_id)
        || event.step_id.as_deref() != Some(&identity.step_id)
    {
        return Err("question identity differs from event scope".into());
    }
    Ok(())
}

pub(crate) fn validate_transition(
    events: &[AgentSessionEvent],
    event: &AgentSessionEvent,
) -> Result<(), String> {
    validate_payload(event)?;
    let records = records(events);
    match &event.payload {
        AgentSessionEventPayload::QuestionRequested {
            identity,
            arguments,
            ..
        } => {
            if records.iter().any(|r| {
                r.identity.question_request_id == identity.question_request_id
                    || (r.identity.step_id == identity.step_id
                        && r.identity.call_id == identity.call_id)
                    || r.waiting()
            }) {
                return Err("question identity reused or another question remains pending".into());
            }
            let call = events
                .iter()
                .find_map(|e| match &e.payload {
                    AgentSessionEventPayload::ToolCall { call }
                        if e.step_id == event.step_id && call.call_id == identity.call_id =>
                    {
                        Some(call)
                    }
                    _ => None,
                })
                .ok_or("question has no durable tool call")?;
            if !is_question_tool(&call.name)
                || workflow::parse_call(&call.name, call.arguments.clone())? != *arguments
            {
                return Err("question differs from tool arguments".into());
            }
            if !events.iter().any(|e| e.step_id == event.step_id && matches!(&e.payload, AgentSessionEventPayload::RequestHeader { request_id, .. } if request_id == &identity.request_id)) {
                return Err("question model request identity mismatch".into());
            }
        }
        AgentSessionEventPayload::QuestionAnswered { submission, .. } => {
            let record = records
                .iter()
                .find(|r| r.identity == submission.identity)
                .ok_or("unknown question")?;
            if record.answer.is_some()
                || record.cancelled
                || record.has_result
                || records.iter().any(|r| {
                    r.answer
                        .iter()
                        .chain(r.action_answer.iter())
                        .any(|a| a.client_operation_id == submission.client_operation_id)
                })
            {
                return Err("question answer is duplicate, stale, or cancelled".into());
            }
            if record.validate_submission(submission)? != submission.answers {
                return Err("answer is not canonical".into());
            }
        }
        AgentSessionEventPayload::QuestionActionAnswered { submission, .. } => {
            let record = records
                .iter()
                .find(|r| r.identity == submission.identity)
                .ok_or("unknown question")?;
            if record.answer.is_none()
                || record.action_answer.is_some()
                || record.has_result
                || record.cancelled
                || submission.action.is_none()
                || records.iter().any(|r| {
                    r.answer
                        .iter()
                        .chain(r.action_answer.iter())
                        .any(|a| a.client_operation_id == submission.client_operation_id)
                })
            {
                return Err("user action response is duplicate, stale, or cancelled".into());
            }
            record.validate_submission(submission)?;
        }
        AgentSessionEventPayload::QuestionCancelled { identity } => {
            let record = records
                .iter()
                .find(|r| &r.identity == identity)
                .ok_or("unknown question")?;
            if !record.waiting() || record.has_result {
                return Err("question already settled".into());
            }
        }
        _ => {}
    }
    Ok(())
}

impl super::AgentToolPipeline {
    pub(crate) fn terminal_manual_handoffs(
        &self,
        terminals: &crate::models::SessionManager,
    ) -> Result<Vec<LiveTerminalManualHandoff>, String> {
        use crate::models::{SessionPtyInfo, SessionStatus, SessionSummary};

        let mut handoffs = Vec::new();
        for session_id in self.native_engine.terminal_leases.manual_input_sessions()? {
            let Ok(state) = terminals.target_state(&session_id) else {
                continue;
            };
            if state.status != SessionStatus::Connected {
                continue;
            }
            let Some(binding) = self
                .native_engine
                .terminal_broker_snapshot(Some(&session_id))?
                .session
                .filter(|session| session.open)
            else {
                continue;
            };
            let Some(handoff) = self.terminal_manual_handoff(&session_id)? else {
                continue;
            };
            let profile_id = self
                .sessions
                .snapshot(&handoff.agent_session_id)?
                .header
                .target
                .and_then(|target| target.profile_id);
            let mut pty_info = match binding.transport_kind {
                crate::terminal_broker::TerminalTransportKind::SshPty => SessionPtyInfo::ssh(),
                _ => SessionPtyInfo::local(),
            };
            pty_info.deferred_startup = None;
            pty_info.input_mode = Some(binding.input_mode);
            pty_info.native_display_binding = binding.native_display_binding;
            let terminal = SessionSummary {
                session_id,
                title: state.identity.title,
                host: state.identity.host,
                port: state.identity.port,
                username: state.identity.username,
                terminal_session_id: Some(binding.terminal_session_id),
                terminal_generation: Some(binding.terminal_generation),
                pty_info,
            };
            handoffs.push(LiveTerminalManualHandoff {
                handoff,
                terminal,
                profile_id,
            });
        }
        handoffs.sort_by_key(|entry| entry.handoff.acquired_at_unix_ms);
        Ok(handoffs)
    }

    pub(crate) fn terminal_manual_handoff(
        &self,
        session_id: &str,
    ) -> Result<Option<TerminalManualHandoff>, String> {
        let Some(owner) = self
            .native_engine
            .terminal_leases
            .manual_input_owner(session_id)?
        else {
            return Ok(None);
        };
        let gate = self.question_gate(&owner)?;
        let _gate = gate.lock().map_err(|_| "question gate unavailable")?;
        if self
            .native_engine
            .terminal_leases
            .manual_input_owner(session_id)?
            .as_deref()
            != Some(owner.as_str())
        {
            return Ok(None);
        }
        let snapshot = self.sessions.snapshot(&owner)?;
        if snapshot.ended
            || snapshot.header.execution_surface != super::AgentExecutionSurface::BoundTerminal
            || snapshot
                .header
                .target
                .as_ref()
                .is_none_or(|target| target.session_id != session_id)
        {
            return Ok(None);
        }
        self.sessions.read_events(&owner, |events| {
            let (turn_id, step_id, _) = question_queue(events)?;
            records(events).into_iter().rev().find(|record| {
                record.identity.step_id == step_id
                    && record.waiting()
                    && record.user_action().is_some()
            })?;
            let last = events.last()?;
            Some(TerminalManualHandoff {
                session_id: session_id.into(),
                agent_session_id: owner.clone(),
                task_id: snapshot.header.task_id,
                turn_id,
                through_seq: last.seq,
                acquired_at_unix_ms: last.time_unix_ms,
            })
        })
    }

    fn commit_question_events(
        &self,
        session_id: &str,
        mut payloads: Vec<super::AgentScopedPayload>,
        manual_input: Option<bool>,
    ) -> Result<(), String> {
        if let Some(waiting) = manual_input {
            payloads.push(super::AgentScopedPayload {
                turn_id: None,
                step_id: None,
                payload: AgentSessionEventPayload::AgentStatus {
                    status: if waiting {
                        super::AgentSessionStatus::Waiting
                    } else {
                        super::AgentSessionStatus::Running
                    },
                    reason: Some(
                        if waiting {
                            "waitingForUserAction"
                        } else {
                            "userActionSubmitted"
                        }
                        .into(),
                    ),
                },
            });
            let header = self.sessions.snapshot(session_id)?.header;
            if let Some(target) = header
                .target
                .filter(|_| header.execution_surface == super::AgentExecutionSurface::BoundTerminal)
            {
                let publish = self.native_engine.with_terminal_manual_input(
                    &target.session_id,
                    session_id,
                    &header.task_id,
                    waiting,
                    || self.sessions.append_batch_deferred(session_id, payloads),
                )?;
                publish();
                return Ok(());
            }
        }
        self.sessions.append_batch(session_id, payloads)?;
        Ok(())
    }

    fn fail_question_call(
        &self,
        identity: &QuestionIdentity,
        name: String,
        mut payloads: Vec<super::AgentScopedPayload>,
        reason: String,
    ) -> Result<super::ToolPipelineSettlement, String> {
        payloads.push(scoped(
            identity,
            AgentSessionEventPayload::ToolResult {
                call_id: identity.call_id.clone(),
                name,
                status: super::AgentToolResultStatus::Failed,
                summary: reason,
                data: None,
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
        ));
        self.sessions.append_batch(&identity.session_id, payloads)?;
        Ok(super::ToolPipelineSettlement::Completed)
    }

    pub(crate) fn request_question(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
        turn: &str,
        step: &str,
        request: &str,
        call: super::ModelToolCall,
    ) -> Result<super::ToolPipelineSettlement, String> {
        let gate = self.question_gate(&entry.session_id)?;
        let _gate = gate.lock().map_err(|_| "question gate unavailable")?;
        if entry.cancellation().is_cancelled() {
            return Ok(super::ToolPipelineSettlement::Cancelled);
        }
        let parsed = self.agents.require_live_root(entry).and_then(|()| {
            if crate::redaction::redact_json_value(&call.arguments) != call.arguments {
                return Err(
                    "question text requires redaction; use non-sensitive questions and labels"
                        .into(),
                );
            }
            let args = workflow::parse_call(&call.name, call.arguments.clone())?;
            if args.questions.iter().any(|q| q.user_action.is_some() || q.options.iter().flatten().any(|o|o.user_action.is_some()))
                && !supports_user_action(&self.sessions.snapshot(&entry.session_id)?.header) {
                return Err("user action requires an available native command verification capability; do not collect credentials or promise automatic continuation".into());
            }
            Ok(args)
        });
        let identity = QuestionIdentity {
            session_id: entry.session_id.clone(),
            turn_id: turn.into(),
            step_id: step.into(),
            request_id: request.into(),
            call_id: call.call_id.clone(),
            question_request_id: format!("question-{}", uuid::Uuid::new_v4().simple()),
        };
        let tool_name = call.name.clone();
        let recorded = super::RecordedToolCall {
            call_id: call.call_id,
            provider_call_id: call.provider_call_id,
            name: call.name.clone(),
            native_name: None,
            arguments: call.arguments,
            title: None,
            effect: Some(super::AgentSessionEffect::ReadOnly),
            target: self.sessions.snapshot(&entry.session_id)?.header.target,
        };
        let mut payloads = Vec::new();
        let existing = self
            .sessions
            .all_events(&entry.session_id)?
            .into_iter()
            .find_map(|e| match e.payload {
                AgentSessionEventPayload::ToolCall { call }
                    if e.step_id.as_deref() == Some(step) && call.call_id == recorded.call_id =>
                {
                    Some(call)
                }
                _ => None,
            });
        if let Some(existing) = existing {
            if existing != recorded {
                return Err("recovered question call drifted".into());
            }
        } else {
            payloads.push(scoped(
                &identity,
                AgentSessionEventPayload::ToolCall { call: recorded },
            ));
        }
        match parsed {
            Ok(arguments) => {
                let manual = tool_name == ACTION_TOOL_NAME;
                let rejected_payloads = manual.then(|| payloads.clone());
                let previous = records(&self.sessions.all_events(&entry.session_id)?);
                let target = self.sessions.snapshot(&entry.session_id)?.header.target;
                let reused = workflow::reusable(&previous, turn, &arguments, target.as_ref())
                    .map(|record| workflow::reused_answers(record, &arguments))
                    .transpose()?;
                let is_reused = reused.is_some();
                payloads.push(scoped(
                    &identity,
                    AgentSessionEventPayload::QuestionRequested {
                        identity: identity.clone(),
                        arguments,
                        provider: super::subagent::provider_descriptor(&entry.model()?.provider),
                    },
                ));
                if !manual {
                    payloads.push(super::AgentScopedPayload {
                        turn_id: None,
                        step_id: None,
                        payload: AgentSessionEventPayload::AgentStatus {
                            status: super::AgentSessionStatus::Waiting,
                            reason: Some("waitingForUserQuestion".into()),
                        },
                    });
                }
                if let Some(answers) = reused {
                    let submission = AnswerQuestionInput {
                        identity: identity.clone(),
                        client_operation_id: format!("reused-{}", identity.question_request_id),
                        answers,
                        action: None,
                    };
                    let fingerprint = hex::encode(Sha256::digest(
                        serde_json::to_vec(&submission).map_err(|e| e.to_string())?,
                    ));
                    payloads.push(scoped(
                        &identity,
                        AgentSessionEventPayload::QuestionAnswered {
                            submission,
                            fingerprint,
                        },
                    ));
                }
                if let Err(reason) =
                    self.commit_question_events(&entry.session_id, payloads, manual.then_some(true))
                {
                    if let Some(payloads) =
                        rejected_payloads.filter(|_| reason == super::TERMINAL_MANUAL_HANDOFF_BUSY)
                    {
                        return self.fail_question_call(&identity, tool_name, payloads, reason);
                    }
                    return Err(reason);
                }
                if is_reused {
                    let record = records(&self.sessions.all_events(&entry.session_id)?)
                        .into_iter()
                        .find(|r| r.identity == identity)
                        .ok_or("reused question disappeared")?;
                    self.sessions.append_batch(
                        &entry.session_id,
                        vec![scoped(&identity, result(&record))],
                    )?;
                    entry.set_phase(super::AgentLifecyclePhase::Running)?;
                    return Ok(super::ToolPipelineSettlement::Completed);
                }
                // An earlier native approval may have cleared the in-memory Step.
                // The question still belongs to that original assistant tool queue.
                entry.set_scope(Some(super::AgentActiveScope {
                    turn_id: turn.into(),
                    step_id: Some(step.into()),
                }))?;
                entry.set_phase(super::AgentLifecyclePhase::Waiting)?;
                Ok(super::ToolPipelineSettlement::Waiting)
            }
            Err(reason) => self.fail_question_call(&identity, tool_name, payloads, reason),
        }
    }

    pub(crate) fn submit_question_answer(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
        mut input: AnswerQuestionInput,
    ) -> Result<(), String> {
        input.validate()?;
        let fingerprint = hex::encode(Sha256::digest(
            serde_json::to_vec(&input).map_err(|e| e.to_string())?,
        ));
        let gate = self.question_gate(&entry.session_id)?;
        let _gate = gate.lock().map_err(|_| "question gate unavailable")?;
        self.agents.require_live_root(entry)?;
        let events = self.sessions.all_events(&entry.session_id)?;
        let records = records(&events);
        let record = records
            .iter()
            .find(|r| r.identity == input.identity)
            .ok_or("unknown or cross-Session question")?;
        input.answers = record.validate_submission(&input)?;
        if record.waiting()
            && matches!(
                self.sessions.snapshot(&entry.session_id)?.recovery.status,
                super::AgentRecoveryStatus::Required | super::AgentRecoveryStatus::Reconciling
            )
        {
            return Err("question cannot bypass required recovery reconciliation".into());
        }
        if record.cancelled || entry.cancellation().is_cancelled() {
            return Err("question was cancelled".into());
        }
        let committed = if input.action.is_some()
            && record.answer.as_ref().is_some_and(|a| a.action.is_none())
        {
            &record.action_answer
        } else {
            &record.answer
        };
        if let Some(existing) = committed {
            let committed_fingerprint = if input.action.is_some()
                && record.answer.as_ref().is_some_and(|a| a.action.is_none())
            {
                &record.action_fingerprint
            } else {
                &record.fingerprint
            };
            return if existing.client_operation_id == input.client_operation_id
                && committed_fingerprint.as_deref() == Some(&fingerprint)
            {
                Ok(())
            } else {
                Err("question answer conflicts with its committed answer".into())
            };
        }
        if record.cancelled
            || entry.cancellation().is_cancelled()
            || self.sessions.snapshot(&entry.session_id)?.ended
        {
            return Err("question was cancelled or Session ended".into());
        }
        let waiting = input.action.is_none()
            && record
                .arguments
                .selected_user_action(&input.answers)
                .is_some();
        let manual_input = if waiting {
            Some(true)
        } else {
            input.action.map(|_| false)
        };
        self.commit_question_events(
            &entry.session_id,
            vec![scoped(
                &input.identity,
                if record.answer.is_some() {
                    AgentSessionEventPayload::QuestionActionAnswered {
                        submission: input.clone(),
                        fingerprint,
                    }
                } else {
                    AgentSessionEventPayload::QuestionAnswered {
                        submission: input.clone(),
                        fingerprint,
                    }
                },
            )],
            manual_input,
        )?;
        entry.set_phase(if waiting {
            super::AgentLifecyclePhase::Waiting
        } else {
            super::AgentLifecyclePhase::Running
        })?;
        Ok(())
    }

    // Caller holds question_gate. Cancellation and answer acceptance have one commit order.
    pub(crate) fn cancel_questions(&self, session_id: &str) -> Result<(), String> {
        for mut record in records(&self.sessions.all_events(session_id)?) {
            if record.has_result {
                continue;
            }
            let mut payloads = Vec::new();
            if record.waiting() {
                payloads.push(scoped(
                    &record.identity,
                    AgentSessionEventPayload::QuestionCancelled {
                        identity: record.identity.clone(),
                    },
                ));
                record.cancelled = true;
            }
            payloads.push(scoped(&record.identity, result(&record)));
            self.sessions.append_batch(session_id, payloads)?;
        }
        Ok(())
    }

    pub(crate) fn restore_question_phase(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
    ) -> Result<(), String> {
        // Keep the journal, terminal reservation and in-memory phase in the
        // same order as a concurrent answer or cancellation.
        let gate = self.question_gate(&entry.session_id)?;
        let _gate = gate.lock().map_err(|_| "question gate unavailable")?;
        // Cancellation recovery belongs to the current run. An explicit resume
        // or a fully settled interruption leaves cancelled questions in history;
        // those records must never cancel a fresh Entry attached to this Session.
        let events = self.sessions.all_events(&entry.session_id)?;
        if events
            .iter()
            .rev()
            .take_while(|event| {
                !matches!(event.payload, AgentSessionEventPayload::SessionResumed {})
                    && !matches!(&event.payload,
                        AgentSessionEventPayload::AgentStatus { status: super::AgentSessionStatus::Idle, reason }
                            if reason.as_deref() == Some("stoppedByUser"))
            })
            .any(|event| matches!(event.payload, AgentSessionEventPayload::QuestionCancelled { .. }))
        {
            entry.cancel();
            self.cancel_questions(&entry.session_id)?;
            super::driver::close_open_scope(&self.sessions, entry, "cancelled")?;
            self.sessions.cancel(&entry.session_id)?;
            return entry.set_phase(super::AgentLifecyclePhase::Stopping);
        }
        // A crash may leave a reusable request committed before its auto-answer.
        // Repair it from the earlier durable decision rather than asking again.
        let stored_questions = records(&events);
        if let Some(pending) = stored_questions
            .iter()
            .find(|r| r.waiting() && r.answer.is_none())
        {
            if let Some(previous) = workflow::reusable(
                &stored_questions,
                &pending.identity.turn_id,
                &pending.arguments,
                pending.target.as_ref(),
            ) {
                let submission = AnswerQuestionInput {
                    identity: pending.identity.clone(),
                    client_operation_id: format!("reused-{}", pending.identity.question_request_id),
                    answers: workflow::reused_answers(previous, &pending.arguments)?,
                    action: None,
                };
                let fingerprint = hex::encode(Sha256::digest(
                    serde_json::to_vec(&submission).map_err(|e| e.to_string())?,
                ));
                self.sessions.append_batch(
                    &entry.session_id,
                    vec![scoped(
                        &submission.identity,
                        AgentSessionEventPayload::QuestionAnswered {
                            submission: submission.clone(),
                            fingerprint,
                        },
                    )],
                )?;
            }
        }
        let snapshot = self.sessions.snapshot(&entry.session_id)?;
        let checkpoint = snapshot.recovery;
        if matches!(
            checkpoint.kind,
            super::AgentRecoveryCheckpointKind::WaitingQuestion
                | super::AgentRecoveryCheckpointKind::QuestionContinuation
        ) {
            let events = self.sessions.all_events(&entry.session_id)?;
            if let Some((turn_id, step_id, _)) = question_queue(&events) {
                if snapshot.header.execution_surface == super::AgentExecutionSurface::BoundTerminal
                {
                    if let Some(target) = snapshot.header.target {
                        if let Some(record) = records(&events).into_iter().rev().find(|record| {
                            record.identity.step_id == step_id
                                && !record.cancelled
                                && record.user_action().is_some()
                        }) {
                            self.native_engine.terminal_leases.with_manual_input(
                                &target.session_id,
                                &entry.session_id,
                                record.waiting(),
                                || Ok(()),
                            )?;
                        }
                    }
                }
                let finished = events.iter().any(|e| e.step_id.as_ref() == Some(&step_id) && matches!(&e.payload, AgentSessionEventPayload::StepEnd { reason } if reason == "toolsCompleted"));
                entry.set_scope(Some(super::AgentActiveScope {
                    turn_id,
                    step_id: (!finished).then_some(step_id),
                }))?;
            }
        }
        match checkpoint.kind {
            super::AgentRecoveryCheckpointKind::WaitingQuestion => {
                entry.set_phase(super::AgentLifecyclePhase::Waiting)
            }
            super::AgentRecoveryCheckpointKind::QuestionContinuation => {
                entry.set_phase(super::AgentLifecyclePhase::Running)
            }
            _ => Ok(()),
        }
    }

    pub(crate) async fn continue_questions(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
    ) -> Result<Option<super::ToolPipelineSettlement>, String> {
        let Some(scope) = entry.scope()? else {
            return Ok(None);
        };
        let Some(step_id) = scope.step_id else {
            return Ok(None);
        };
        let events = self.sessions.all_events(&entry.session_id)?;
        let record = records(&events)
            .into_iter()
            .rev()
            .find(|r| r.identity.step_id == step_id);
        let Some((_, queue_step, request_id)) = question_queue(&events) else {
            return Ok(None);
        };
        if queue_step != step_id {
            return Ok(None);
        }
        if let Some(record) = record {
            let gate = self.question_gate(&entry.session_id)?;
            let _gate = gate.lock().map_err(|_| "question gate unavailable")?;
            // Re-read after taking the gate: an answer may have arrived during projection.
            let record = records(&self.sessions.all_events(&entry.session_id)?)
                .into_iter()
                .find(|r| r.identity == record.identity)
                .ok_or("question disappeared")?;
            if record.waiting() {
                return Ok(Some(super::ToolPipelineSettlement::Waiting));
            }
            if !record.has_result {
                self.sessions.append_batch(
                    &entry.session_id,
                    vec![scoped(&record.identity, result(&record))],
                )?;
            }
            if entry.cancellation().is_cancelled() || record.cancelled {
                return Ok(Some(super::ToolPipelineSettlement::Cancelled));
            }
            self.sessions.append(
                &entry.session_id,
                None,
                None,
                AgentSessionEventPayload::AgentStatus {
                    status: super::AgentSessionStatus::Running,
                    reason: Some("userQuestionAnswered".into()),
                },
            )?;
        }
        let events = self.sessions.all_events(&entry.session_id)?;
        let calls = events
            .iter()
            .filter(|e| e.step_id.as_deref() == Some(&step_id))
            .find_map(|e| match &e.payload {
                AgentSessionEventPayload::AssistantMessage { content, .. } => {
                    Some(super::assistant_tool_calls(content))
                }
                _ => None,
            })
            .ok_or("question lost original assistant calls")?;
        let remaining = calls.into_iter().filter(|call| !events.iter().any(|e| e.step_id.as_deref() == Some(&step_id) && matches!(&e.payload, AgentSessionEventPayload::ToolResult { call_id, .. } if call_id == &call.call_id))).map(|call| super::ModelToolCall { call_id: call.call_id, provider_call_id: call.provider_call_id, name: call.name, arguments: call.arguments }).collect();
        self.process_model_calls(entry, &scope.turn_id, &step_id, &request_id, remaining)
            .await
            .map(Some)
    }
}
