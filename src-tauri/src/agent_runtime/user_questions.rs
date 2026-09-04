//! Durable user input, separate from native authorization.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2_compat::{Digest, Sha256};

use super::{AgentSessionEvent, AgentSessionEventPayload};

pub(crate) const TOOL_NAME: &str = "ask_user_question";
const MAX_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct QuestionOption {
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Question {
    pub(crate) id: String,
    pub(crate) question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) options: Option<Vec<QuestionOption>>,
    #[serde(default)]
    pub(crate) multi_select: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnswerQuestionInput {
    pub(crate) identity: QuestionIdentity,
    pub(crate) client_operation_id: String,
    pub(crate) answers: Vec<QuestionAnswer>,
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
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(input).map_err(|e| e.to_string())?)
    );
    Ok(record
        .answer
        .as_ref()
        .is_some_and(|a| a.client_operation_id == input.client_operation_id)
        && record.fingerprint.as_deref() == Some(&fingerprint))
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
            }
            AgentSessionEventPayload::QuestionCancelled { identity } => {
                if let Some(record) = records.iter_mut().find(|r| &r.identity == identity) {
                    record.cancelled = true;
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
        if super::assistant_tool_calls(content).iter().any(|c| c.name == TOOL_NAME))
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
    json!({"type":"object","additionalProperties":false,"required":["questions"],"properties":{
        "questions":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["id","question"],"properties":{
            "id":{"type":"string","minLength":1,"maxLength":64},"question":{"type":"string","minLength":1,"maxLength":2048},
            "header":{"type":"string","minLength":1,"maxLength":128},"multi_select":{"type":"boolean"},
            "options":{"type":"array","minItems":2,"maxItems":7,"items":{"type":"object","additionalProperties":false,"required":["label"],"properties":{
                "label":{"type":"string","minLength":1,"maxLength":256},"description":{"type":"string","minLength":1,"maxLength":1024}
            }}}
        }}}
    }})
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

fn result(record: &QuestionRecord) -> AgentSessionEventPayload {
    AgentSessionEventPayload::ToolResult {
        call_id: record.identity.call_id.clone(),
        name: TOOL_NAME.into(),
        status: if record.answer.is_some() {
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
            .map(|answer| json!({"answers":answer.answers})),
        duration_ms: None,
        evidence_refs: Vec::new(),
    }
}

pub(crate) fn matches_result(record: &QuestionRecord, payload: &AgentSessionEventPayload) -> bool {
    (record.answer.is_some() || record.cancelled) && result(record) == *payload
}

pub(crate) fn validate_payload(event: &AgentSessionEvent) -> Result<(), String> {
    let identity = match &event.payload {
        AgentSessionEventPayload::QuestionRequested {
            identity,
            arguments,
            provider,
        } => {
            arguments.validate()?;
            let config = super::subagent::provider_config(provider)?;
            crate::ai::validate_provider_config(&config, true)?;
            identity
        }
        AgentSessionEventPayload::QuestionAnswered {
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
                    || (r.answer.is_none() && !r.cancelled)
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
            if call.name != TOOL_NAME
                || QuestionArguments::parse(call.arguments.clone())? != *arguments
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
                        .as_ref()
                        .is_some_and(|a| a.client_operation_id == submission.client_operation_id)
                })
            {
                return Err("question answer is duplicate, stale, or cancelled".into());
            }
            if record.arguments.normalize_answers(&submission.answers)? != submission.answers {
                return Err("answer is not canonical".into());
            }
        }
        AgentSessionEventPayload::QuestionCancelled { identity } => {
            let record = records
                .iter()
                .find(|r| &r.identity == identity)
                .ok_or("unknown question")?;
            if record.answer.is_some() || record.cancelled || record.has_result {
                return Err("question already settled".into());
            }
        }
        _ => {}
    }
    Ok(())
}

impl super::AgentToolPipeline {
    pub(crate) fn request_question(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
        turn: &str,
        step: &str,
        request: &str,
        call: super::ModelToolCall,
    ) -> Result<super::ToolPipelineSettlement, String> {
        let _gate = self
            .question_gate
            .lock()
            .map_err(|_| "question gate unavailable")?;
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
            QuestionArguments::parse(call.arguments.clone())
        });
        let identity = QuestionIdentity {
            session_id: entry.session_id.clone(),
            turn_id: turn.into(),
            step_id: step.into(),
            request_id: request.into(),
            call_id: call.call_id.clone(),
            question_request_id: format!("question-{}", uuid::Uuid::new_v4().simple()),
        };
        let recorded = super::RecordedToolCall {
            call_id: call.call_id,
            provider_call_id: call.provider_call_id,
            name: TOOL_NAME.into(),
            native_name: None,
            arguments: call.arguments,
            title: None,
            effect: Some(super::AgentSessionEffect::ReadOnly),
            target: None,
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
                payloads.push(scoped(
                    &identity,
                    AgentSessionEventPayload::QuestionRequested {
                        identity: identity.clone(),
                        arguments,
                        provider: super::subagent::provider_descriptor(&entry.model()?.provider),
                    },
                ));
                payloads.push(super::AgentScopedPayload {
                    turn_id: None,
                    step_id: None,
                    payload: AgentSessionEventPayload::AgentStatus {
                        status: super::AgentSessionStatus::Waiting,
                        reason: Some("waitingForUserQuestion".into()),
                    },
                });
                self.sessions.append_batch(&entry.session_id, payloads)?;
                // An earlier native approval may have cleared the in-memory Step.
                // The question still belongs to that original assistant tool queue.
                entry.set_scope(Some(super::AgentActiveScope {
                    turn_id: turn.into(),
                    step_id: Some(step.into()),
                }))?;
                entry.set_phase(super::AgentLifecyclePhase::Waiting)?;
                Ok(super::ToolPipelineSettlement::Waiting)
            }
            Err(reason) => {
                payloads.push(scoped(
                    &identity,
                    AgentSessionEventPayload::ToolResult {
                        call_id: identity.call_id.clone(),
                        name: TOOL_NAME.into(),
                        status: super::AgentToolResultStatus::Failed,
                        summary: reason,
                        data: None,
                        duration_ms: None,
                        evidence_refs: Vec::new(),
                    },
                ));
                self.sessions.append_batch(&entry.session_id, payloads)?;
                Ok(super::ToolPipelineSettlement::Completed)
            }
        }
    }

    pub(crate) fn submit_question_answer(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
        mut input: AnswerQuestionInput,
    ) -> Result<(), String> {
        input.validate()?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&input).map_err(|e| e.to_string())?)
        );
        let _gate = self
            .question_gate
            .lock()
            .map_err(|_| "question gate unavailable")?;
        self.agents.require_live_root(entry)?;
        let events = self.sessions.all_events(&entry.session_id)?;
        let records = records(&events);
        let record = records
            .iter()
            .find(|r| r.identity == input.identity)
            .ok_or("unknown or cross-Session question")?;
        input.answers = record.arguments.normalize_answers(&input.answers)?;
        if record.answer.is_none()
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
        if let Some(existing) = &record.answer {
            return if existing.client_operation_id == input.client_operation_id
                && record.fingerprint.as_deref() == Some(&fingerprint)
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
        self.sessions.append_batch(
            &entry.session_id,
            vec![scoped(
                &input.identity,
                AgentSessionEventPayload::QuestionAnswered {
                    submission: input.clone(),
                    fingerprint,
                },
            )],
        )?;
        entry.set_phase(super::AgentLifecyclePhase::Running)?;
        Ok(())
    }

    // Caller holds question_gate. Cancellation and answer acceptance have one commit order.
    pub(crate) fn cancel_questions(&self, session_id: &str) -> Result<(), String> {
        for mut record in records(&self.sessions.all_events(session_id)?) {
            if record.has_result {
                continue;
            }
            let mut payloads = Vec::new();
            if record.answer.is_none() && !record.cancelled {
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
        if records(&self.sessions.all_events(&entry.session_id)?)
            .iter()
            .any(|r| r.cancelled)
        {
            let _gate = self
                .question_gate
                .lock()
                .map_err(|_| "question gate unavailable")?;
            entry.cancel();
            self.cancel_questions(&entry.session_id)?;
            super::driver::close_open_scope(&self.sessions, entry, "cancelled")?;
            self.sessions.cancel(&entry.session_id)?;
            return entry.set_phase(super::AgentLifecyclePhase::Stopping);
        }
        let checkpoint = self.sessions.snapshot(&entry.session_id)?.recovery;
        if matches!(
            checkpoint.kind,
            super::AgentRecoveryCheckpointKind::WaitingQuestion
                | super::AgentRecoveryCheckpointKind::QuestionContinuation
        ) {
            let events = self.sessions.all_events(&entry.session_id)?;
            if let Some((turn_id, step_id, _)) = question_queue(&events) {
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
            let _gate = self
                .question_gate
                .lock()
                .map_err(|_| "question gate unavailable")?;
            // Re-read after taking the gate: an answer may have arrived during projection.
            let record = records(&self.sessions.all_events(&entry.session_id)?)
                .into_iter()
                .find(|r| r.identity == record.identity)
                .ok_or("question disappeared")?;
            if record.answer.is_none() && !record.cancelled {
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
