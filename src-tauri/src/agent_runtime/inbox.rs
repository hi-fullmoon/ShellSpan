use std::collections::{HashSet, VecDeque};

use super::{
    AgentInboxLane, AgentInboxMessage, AgentInboxOperation, AgentSessionEvent,
    AgentSessionEventPayload,
};

#[derive(Debug, Clone, Default)]
pub(crate) struct AgentInbox {
    next_turn: VecDeque<AgentInboxMessage>,
    next_step: VecDeque<AgentInboxMessage>,
    seen_message_ids: HashSet<String>,
}

impl AgentInbox {
    pub(crate) fn replay(events: &[AgentSessionEvent]) -> Result<Self, String> {
        let mut inbox = Self::default();
        for event in events {
            match &event.payload {
                AgentSessionEventPayload::InboxSpliced {
                    operation,
                    lane,
                    messages,
                } => inbox.apply(*operation, *lane, messages)?,
                AgentSessionEventPayload::InboxItemUpdated {
                    item_id,
                    lane,
                    content,
                    ..
                } => inbox.update(*lane, item_id, content.clone())?,
                AgentSessionEventPayload::InboxItemRemoved { item_id, lane, .. } => {
                    inbox.remove(*lane, item_id)?
                }
                AgentSessionEventPayload::InboxReordered {
                    lane,
                    ordered_item_ids,
                    ..
                } => inbox.reorder(*lane, ordered_item_ids)?,
                _ => {}
            }
        }
        Ok(inbox)
    }

    pub(crate) fn apply(
        &mut self,
        operation: AgentInboxOperation,
        lane: AgentInboxLane,
        messages: &[AgentInboxMessage],
    ) -> Result<(), String> {
        if messages.is_empty() {
            return Err("Agent inbox splice must contain at least one message".into());
        }
        match operation {
            AgentInboxOperation::Enqueued => self.enqueue(lane, messages),
            AgentInboxOperation::Claimed => self.remove_claimed(lane, messages),
            AgentInboxOperation::Discarded => self.remove_discarded(lane, messages),
        }
    }

    fn enqueue(
        &mut self,
        lane: AgentInboxLane,
        messages: &[AgentInboxMessage],
    ) -> Result<(), String> {
        let mut incoming = HashSet::with_capacity(messages.len());
        if messages.iter().any(|message| {
            !incoming.insert(message.message_id.as_str())
                || self.seen_message_ids.contains(&message.message_id)
        }) {
            return Err("Agent inbox messageId was already used in this Session".into());
        }
        self.seen_message_ids
            .extend(messages.iter().map(|message| message.message_id.clone()));
        self.queue_mut(lane).extend(messages.iter().cloned());
        Ok(())
    }

    fn remove_claimed(
        &mut self,
        lane: AgentInboxLane,
        messages: &[AgentInboxMessage],
    ) -> Result<(), String> {
        let expected = match lane {
            AgentInboxLane::NextTurn => self.turn_claim(),
            AgentInboxLane::NextStep => self.step_claim(),
        };
        if messages != expected {
            return Err("Agent inbox claim did not match the next claimable messages".into());
        }
        self.remove_front(lane, messages.len());
        Ok(())
    }

    fn remove_discarded(
        &mut self,
        lane: AgentInboxLane,
        messages: &[AgentInboxMessage],
    ) -> Result<(), String> {
        if messages != self.lane(lane).iter().cloned().collect::<Vec<_>>() {
            return Err("Agent inbox discard must remove the complete lane in FIFO order".into());
        }
        self.queue_mut(lane).clear();
        Ok(())
    }

    fn remove_front(&mut self, lane: AgentInboxLane, count: usize) {
        let queue = self.queue_mut(lane);
        for _ in 0..count {
            queue.pop_front();
        }
    }

    fn lane(&self, lane: AgentInboxLane) -> &VecDeque<AgentInboxMessage> {
        match lane {
            AgentInboxLane::NextTurn => &self.next_turn,
            AgentInboxLane::NextStep => &self.next_step,
        }
    }

    fn queue_mut(&mut self, lane: AgentInboxLane) -> &mut VecDeque<AgentInboxMessage> {
        match lane {
            AgentInboxLane::NextTurn => &mut self.next_turn,
            AgentInboxLane::NextStep => &mut self.next_step,
        }
    }

    pub(crate) fn message(
        &self,
        lane: AgentInboxLane,
        item_id: &str,
    ) -> Option<&AgentInboxMessage> {
        self.lane(lane)
            .iter()
            .find(|message| message.message_id == item_id)
    }

    pub(crate) fn locate(&self, item_id: &str) -> Option<(AgentInboxLane, &AgentInboxMessage)> {
        [AgentInboxLane::NextTurn, AgentInboxLane::NextStep]
            .into_iter()
            .find_map(|lane| self.message(lane, item_id).map(|message| (lane, message)))
    }

    pub(crate) fn update(
        &mut self,
        lane: AgentInboxLane,
        item_id: &str,
        content: String,
    ) -> Result<(), String> {
        let message = self
            .queue_mut(lane)
            .iter_mut()
            .find(|message| message.message_id == item_id)
            .ok_or_else(|| "Agent inbox item is not queued in the requested lane".to_string())?;
        message.content = content;
        Ok(())
    }

    pub(crate) fn remove(&mut self, lane: AgentInboxLane, item_id: &str) -> Result<(), String> {
        let queue = self.queue_mut(lane);
        let index = queue
            .iter()
            .position(|message| message.message_id == item_id)
            .ok_or_else(|| "Agent inbox item is not queued in the requested lane".to_string())?;
        queue.remove(index);
        Ok(())
    }

    pub(crate) fn reorder(
        &mut self,
        lane: AgentInboxLane,
        ordered_item_ids: &[String],
    ) -> Result<(), String> {
        let queue = self.lane(lane);
        if ordered_item_ids.len() != queue.len() {
            return Err("Agent inbox reorder must include every queued item in the lane".into());
        }
        let mut requested = HashSet::with_capacity(ordered_item_ids.len());
        if ordered_item_ids
            .iter()
            .any(|item_id| !requested.insert(item_id))
        {
            return Err("Agent inbox reorder contains duplicate item identities".into());
        }
        let current = queue
            .iter()
            .map(|message| &message.message_id)
            .collect::<HashSet<_>>();
        if requested != current {
            return Err("Agent inbox reorder identities do not match the queued lane".into());
        }
        let by_id = queue
            .iter()
            .cloned()
            .map(|message| (message.message_id.clone(), message))
            .collect::<std::collections::HashMap<_, _>>();
        *self.queue_mut(lane) = ordered_item_ids
            .iter()
            .map(|item_id| by_id[item_id].clone())
            .collect();
        Ok(())
    }

    pub(crate) fn next_turn(&self) -> Vec<AgentInboxMessage> {
        self.next_turn.iter().cloned().collect()
    }

    pub(crate) fn next_step(&self) -> Vec<AgentInboxMessage> {
        self.next_step.iter().cloned().collect()
    }

    pub(crate) fn turn_claim(&self) -> Vec<AgentInboxMessage> {
        self.next_turn.front().cloned().into_iter().collect()
    }

    pub(crate) fn step_claim(&self) -> Vec<AgentInboxMessage> {
        self.next_step.iter().cloned().collect()
    }

    pub(crate) fn discard(&self, lane: AgentInboxLane) -> Vec<AgentInboxMessage> {
        self.lane(lane).iter().cloned().collect()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.next_turn.is_empty() && self.next_step.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{AgentMessageSource, AgentSessionEvent};

    fn message(id: &str) -> AgentInboxMessage {
        AgentInboxMessage {
            images: Vec::new(),
            message_id: id.into(),
            client_submission_id: Some(id.into()),
            content: id.into(),
            source: AgentMessageSource::user(),
        }
    }

    fn event(
        seq: u64,
        operation: AgentInboxOperation,
        lane: AgentInboxLane,
        messages: Vec<AgentInboxMessage>,
    ) -> AgentSessionEvent {
        AgentSessionEvent::new(
            "session".into(),
            seq,
            1_000 + seq,
            None,
            None,
            AgentSessionEventPayload::InboxSpliced {
                operation,
                lane,
                messages,
            },
        )
    }

    #[test]
    fn replay_preserves_fifo_turn_and_batch_step_semantics() {
        let turn_a = message("turn-a");
        let turn_b = message("turn-b");
        let step_a = message("step-a");
        let step_b = message("step-b");
        let events = vec![
            event(
                0,
                AgentInboxOperation::Enqueued,
                AgentInboxLane::NextTurn,
                vec![turn_a.clone(), turn_b.clone()],
            ),
            event(
                1,
                AgentInboxOperation::Enqueued,
                AgentInboxLane::NextStep,
                vec![step_a.clone(), step_b.clone()],
            ),
            event(
                2,
                AgentInboxOperation::Claimed,
                AgentInboxLane::NextTurn,
                vec![turn_a],
            ),
            event(
                3,
                AgentInboxOperation::Claimed,
                AgentInboxLane::NextStep,
                vec![step_a, step_b],
            ),
        ];

        let inbox = AgentInbox::replay(&events).unwrap();
        assert_eq!(inbox.turn_claim(), vec![turn_b]);
        assert!(inbox.step_claim().is_empty());
    }

    #[test]
    fn replay_rejects_reuse_after_claim_and_out_of_order_claims() {
        let first = message("same");
        let reused = vec![
            event(
                0,
                AgentInboxOperation::Enqueued,
                AgentInboxLane::NextTurn,
                vec![first.clone()],
            ),
            event(
                1,
                AgentInboxOperation::Claimed,
                AgentInboxLane::NextTurn,
                vec![first.clone()],
            ),
            event(
                2,
                AgentInboxOperation::Enqueued,
                AgentInboxLane::NextStep,
                vec![first],
            ),
        ];
        assert!(AgentInbox::replay(&reused).is_err());

        let first = message("first");
        let second = message("second");
        let out_of_order = vec![
            event(
                0,
                AgentInboxOperation::Enqueued,
                AgentInboxLane::NextTurn,
                vec![first, second.clone()],
            ),
            event(
                1,
                AgentInboxOperation::Claimed,
                AgentInboxLane::NextTurn,
                vec![second],
            ),
        ];
        assert!(AgentInbox::replay(&out_of_order).is_err());
    }
}
