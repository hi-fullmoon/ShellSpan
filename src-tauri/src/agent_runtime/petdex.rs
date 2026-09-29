//! Observe durable lifecycle boundaries under the Session store lock. A driver
//! lease can end while a question/approval still owns the admitted turn.
use std::collections::HashMap;

use super::{
    derive_recovery_checkpoint, AgentRecoveryCheckpointKind, AgentSessionEvent,
    AgentSessionEventPayload as Payload, AgentSessionStatus,
};
use crate::petdex::types::WaitReason;
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
                    ActivityGuard::new(
                        self.adapter.clone(),
                        ActivitySource::Ai,
                        ActivityPhase::Running,
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
                Payload::AgentStatus { status, .. } | Payload::SessionEnded { status, .. } => {
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
            if let Some((_, mut guard)) = self.turns.remove(session) {
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
        if let Some((current, guard)) = self.turns.get_mut(session) {
            if current.is_empty() || current == turn {
                *current = turn.to_owned();
                guard.transition(phase);
                return;
            }
            guard.transition(ActivityPhase::Cancelled);
        }
        self.turns.insert(
            session.to_owned(),
            (
                turn.to_owned(),
                ActivityGuard::new(self.adapter.clone(), ActivitySource::Ai, phase),
            ),
        );
    }
}

impl Drop for PetdexActivities {
    fn drop(&mut self) {
        for (_, guard) in self.turns.values_mut() {
            guard.transition(ActivityPhase::Cancelled);
        }
    }
}
