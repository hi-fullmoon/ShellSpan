//! Observe durable lifecycle boundaries under the Session store lock. A driver
//! lease can end while a question/approval still owns the admitted turn.
use std::collections::HashMap;

use super::{
    derive_recovery_checkpoint, AgentRecoveryCheckpointKind, AgentSessionEvent,
    AgentSessionEventPayload as Payload, AgentSessionStatus,
};
use crate::petdex::types::{ActivityKind, ActivityOwner, WaitReason};
use crate::petdex::{ActivityGuard, ActivityPhase, ActivitySource, PetdexAdapter};

#[derive(Default)]
pub(super) struct PetdexActivities {
    adapter: Option<PetdexAdapter>,
    turns: HashMap<String, (String, ActivityGuard)>,
    drivers: HashMap<String, u64>,
    next_driver: u64,
}

impl PetdexActivities {
    pub(super) fn begin_driver(&mut self, session: &str) -> u64 {
        self.next_driver = self
            .next_driver
            .checked_add(1)
            .expect("Agent observer generations exhausted");
        let generation = self.next_driver;
        self.drivers.insert(session.to_owned(), generation);
        if self.adapter.is_some() && !self.turns.contains_key(session) {
            self.turns.insert(
                session.to_owned(),
                (
                    String::new(),
                    ActivityGuard::owned(
                        self.adapter.clone(),
                        ActivitySource::Ai,
                        ActivityPhase::Running,
                        ActivityOwner::Ai(session.to_owned()),
                        ActivityKind::AiPreparing,
                    ),
                ),
            );
        }
        generation
    }

    pub(super) fn settle_driver(
        &mut self,
        session: &str,
        generation: u64,
        settlement: super::AgentDriverSettlement,
    ) {
        if self.drivers.get(session) != Some(&generation) {
            return;
        }
        self.drivers.remove(session);
        let phase = match settlement {
            super::AgentDriverSettlement::Failed => ActivityPhase::Failed,
            super::AgentDriverSettlement::Cancelled | super::AgentDriverSettlement::Idle => {
                ActivityPhase::Cancelled
            }
            super::AgentDriverSettlement::Waiting => return,
        };
        if let Some((_, mut guard)) = self.turns.remove(session) {
            guard.transition(phase);
        }
    }
    pub(super) fn attach(&mut self, adapter: PetdexAdapter) -> bool {
        if self.adapter.is_some() {
            return false;
        }
        self.adapter = Some(adapter);
        true
    }

    pub(super) fn observe(
        &mut self,
        session: &str,
        events: &[AgentSessionEvent],
        committed: &[AgentSessionEvent],
        status: AgentSessionStatus,
        restoring: bool,
    ) {
        if self.adapter.is_none() {
            return;
        }
        if !restoring
            && !committed.iter().any(|e| {
                matches!(
                    e.payload,
                    Payload::TurnStart
                        | Payload::TurnEnd { .. }
                        | Payload::StepStart
                        | Payload::AgentStatus { .. }
                        | Payload::SessionEnded { .. }
                        | Payload::ToolApproval { .. }
                        | Payload::QuestionAnswered { .. }
                        | Payload::QuestionCancelled { .. }
                        | Payload::ToolExecution { .. }
                        | Payload::ToolResult { .. }
                        | Payload::SessionRenamed { .. }
                )
            })
        {
            return;
        }

        let mut open_turn = None;
        for event in events.iter().rev() {
            match &event.payload {
                Payload::TurnStart => {
                    open_turn = event.turn_id.as_deref();
                    break;
                }
                Payload::TurnEnd { .. } => break,
                Payload::SessionResumed {} => break,
                _ => {}
            }
        }
        // Never apply the previous turn's historical terminal to a driver
        // admitted before its own TurnStart. Only this committed batch ends it.
        let terminal = committed
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                Payload::AgentStatus { status, .. } | Payload::SessionEnded { status, .. }
                    if event.turn_id.as_deref().is_none_or(|turn| {
                        self.turns
                            .get(session)
                            .is_some_and(|(current, _)| current == turn)
                    }) =>
                {
                    match status {
                        AgentSessionStatus::Cancelled => Some(ActivityPhase::Cancelled),
                        AgentSessionStatus::Failed => Some(ActivityPhase::Failed),
                        AgentSessionStatus::Completed => Some(ActivityPhase::Succeeded),
                        _ => None,
                    }
                }
                Payload::TurnEnd { reason }
                    if self.turns.get(session).is_some_and(|(turn, _)| {
                        event.turn_id.as_deref() == Some(turn.as_str())
                    }) =>
                {
                    match reason.as_str() {
                        "completed" => Some(ActivityPhase::Succeeded),
                        "cancelled" => Some(ActivityPhase::Cancelled),
                        _ => None,
                    }
                }
                _ => None,
            })
            .or_else(|| {
                (open_turn.is_none()
                    && committed.iter().any(|event| {
                        matches!(
                            event.payload,
                            Payload::AgentStatus {
                                status: AgentSessionStatus::Idle,
                                ..
                            }
                        )
                    }))
                .then_some(ActivityPhase::Cancelled)
            });
        if let Some(phase) = terminal {
            if let Some((turn, mut guard)) = self.turns.remove(session) {
                if phase == ActivityPhase::Succeeded && !restoring {
                    guard.details(|details| {
                        if let Some(reply) = completed_reply(events, &turn) {
                            details.final_reply(&reply);
                        }
                    });
                }
                guard.transition(phase);
            }
            return;
        }
        if status.is_terminal() {
            return;
        }
        let Some(turn) = open_turn else {
            return;
        };
        let checkpoint = derive_recovery_checkpoint(events);
        let phase = match checkpoint.kind {
            AgentRecoveryCheckpointKind::WaitingApproval => {
                ActivityPhase::Waiting(WaitReason::Approval)
            }
            AgentRecoveryCheckpointKind::WaitingQuestion => {
                ActivityPhase::Waiting(WaitReason::Answer)
            }
            _ => ActivityPhase::Running,
        };
        // A log with an interrupted request is not a running worker after
        // restart. Register it only when recovery actually commits progress.
        if restoring && !matches!(phase, ActivityPhase::Waiting(_)) {
            return;
        }
        let kind = current_tool_kind(events, turn);
        if let Some((current, guard)) = self.turns.get_mut(session) {
            if current.is_empty() || current == turn {
                *current = turn.to_owned();
                guard.transition_with_kind(phase, kind);
                session_title(guard, events);
                return;
            }
            guard.transition(ActivityPhase::Cancelled);
        }
        self.turns.insert(
            session.to_owned(),
            (
                turn.to_owned(),
                ActivityGuard::owned(
                    self.adapter.clone(),
                    ActivitySource::Ai,
                    phase,
                    ActivityOwner::Ai(session.to_owned()),
                    kind,
                ),
            ),
        );
        if let Some((_, guard)) = self.turns.get(session) {
            session_title(guard, events);
        }
    }
}

fn session_title(guard: &ActivityGuard, events: &[AgentSessionEvent]) {
    guard.details(|details| {
        // The task goal and user messages are deliberately not title fallbacks.
        if let Some(title) = events.iter().rev().find_map(|event| match &event.payload {
            Payload::SessionRenamed { title, .. } => Some(title.as_str()),
            _ => None,
        }) {
            details.title(title);
        }
    });
}

fn current_tool_kind(events: &[AgentSessionEvent], turn: &str) -> ActivityKind {
    // Metadata only: never examine arguments, results, chunks or logs.
    for event in events
        .iter()
        .rev()
        .filter(|e| e.turn_id.as_deref() == Some(turn))
    {
        if let Payload::ToolExecution { call_id, .. } = &event.payload {
            if events.iter().any(|e| {
                e.seq > event.seq && e.turn_id.as_deref() == Some(turn)
                    && e.step_id == event.step_id
                    && matches!(&e.payload, Payload::ToolResult { call_id: completed, .. } if completed == call_id)
            }) { continue; }
            if let Some(name) = events.iter().rev().find_map(|e| {
                if e.turn_id.as_deref() != Some(turn)
                    || e.step_id != event.step_id
                    || e.seq > event.seq
                {
                    return None;
                }
                match &e.payload {
                    Payload::ToolCall { call } if call.call_id == *call_id => {
                        Some(call.name.as_str())
                    }
                    _ => None,
                }
            }) {
                return ActivityKind::Tool(crate::petdex::message_content::ToolStage::from_name(
                    name,
                ));
            }
        }
    }
    ActivityKind::Ai
}

fn completed_reply(events: &[AgentSessionEvent], turn: &str) -> Option<String> {
    use super::{AgentAssistantContentBlock as Block, AgentStopReason};
    if turn.is_empty() {
        return None;
    }
    // Require the latest admitted turn and its authoritative successful ending.
    let latest = events
        .iter()
        .rev()
        .find(|e| matches!(e.payload, Payload::TurnStart))?;
    if latest.turn_id.as_deref() != Some(turn) {
        return None;
    }
    let end = events
        .iter()
        .rev()
        .find(|e| matches!(e.payload, Payload::TurnEnd { .. }))?;
    if end.turn_id.as_deref() != Some(turn)
        || !matches!(&end.payload, Payload::TurnEnd { reason } if reason == "completed")
    {
        return None;
    }
    let message = events.iter().rev().find(|e| {
        e.turn_id.as_deref() == Some(turn)
            && e.seq < end.seq
            && matches!(e.payload, Payload::AssistantMessage { .. })
    })?;
    let Payload::AssistantMessage {
        content,
        stop_reason: AgentStopReason::Stop,
        interrupted: false,
        ..
    } = &message.payload
    else {
        return None;
    };
    if content.iter().any(|b| matches!(b, Block::ToolCall { .. })) {
        return None;
    }
    // A tool dispatch or new model step after this message makes it intermediate.
    if events.iter().any(|e| {
        e.seq > message.seq
            && e.seq < end.seq
            && e.turn_id.as_deref() == Some(turn)
            && matches!(
                e.payload,
                Payload::ToolCall { .. }
                    | Payload::ToolExecution { .. }
                    | Payload::StepStart
                    | Payload::RequestStart { .. }
                    | Payload::AssistantChunk { .. }
            )
    }) {
        return None;
    }
    let mut reply = String::new();
    for block in content {
        if let Block::Text { text } = block {
            if reply.len().saturating_add(text.len()).saturating_add(1)
                > crate::petdex::message_content::MAX_CANDIDATE_BYTES
            {
                return None;
            }
            reply.push_str(text);
            reply.push('\n');
        }
    }
    Some(reply)
}

impl Drop for PetdexActivities {
    fn drop(&mut self) {
        for (_, guard) in self.turns.values_mut() {
            guard.transition(ActivityPhase::Cancelled);
        }
    }
}

#[cfg(test)]
mod tests;
