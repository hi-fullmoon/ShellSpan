use super::protocol::{AgentEventTypeV1, AgentEventV1, AgentSchemaVersionV1};
use serde::Serialize;

pub(crate) const AGENT_EVENT_NAME_V1: &str = "agent-event";

#[derive(Debug)]
pub(crate) enum AgentEventJournalError {
    SequenceExhausted,
    Serialize(serde_json::Error),
}

impl From<serde_json::Error> for AgentEventJournalError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialize(error)
    }
}

/// The journal is the only allocator for Agent event sequence numbers.
/// Callers provide typed payloads; no external event or sequence is accepted.
#[derive(Debug, Clone)]
pub(crate) struct AgentEventJournalV1 {
    run_id: String,
    next_sequence: u64,
    events: Vec<AgentEventV1>,
}

impl AgentEventJournalV1 {
    pub(crate) fn new(run_id: String) -> Self {
        Self {
            run_id,
            next_sequence: 1,
            events: Vec::new(),
        }
    }

    pub(crate) fn append<T: Serialize>(
        &mut self,
        occurred_at: u64,
        event_type: AgentEventTypeV1,
        payload: &T,
    ) -> Result<AgentEventV1, AgentEventJournalError> {
        let sequence = self.next_sequence;
        let next_sequence = sequence
            .checked_add(1)
            .ok_or(AgentEventJournalError::SequenceExhausted)?;
        let event = AgentEventV1 {
            schema_version: AgentSchemaVersionV1,
            run_id: self.run_id.clone(),
            sequence,
            occurred_at,
            event_type,
            payload: serde_json::to_value(payload)?,
        };
        self.next_sequence = next_sequence;
        self.events.push(event.clone());
        Ok(event)
    }

    pub(crate) fn last_sequence(&self) -> u64 {
        self.next_sequence.saturating_sub(1)
    }

    pub(crate) fn events_after(&self, sequence: u64) -> Vec<AgentEventV1> {
        self.events
            .iter()
            .filter(|event| event.sequence > sequence)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn journal_allocates_strictly_monotonic_sequences() {
        let mut journal = AgentEventJournalV1::new("run-1".to_string());
        let first = journal
            .append(
                10,
                AgentEventTypeV1::RunCreated,
                &json!({ "state": "created" }),
            )
            .expect("append first event");
        let second = journal
            .append(
                11,
                AgentEventTypeV1::RunStateChanged,
                &json!({ "state": "thinking" }),
            )
            .expect("append second event");

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(journal.last_sequence(), 2);
        assert_eq!(journal.events_after(1), vec![second]);

        journal.next_sequence = u64::MAX;
        assert!(matches!(
            journal.append(12, AgentEventTypeV1::RunWarning, &json!({})),
            Err(AgentEventJournalError::SequenceExhausted)
        ));
        assert_eq!(journal.events.len(), 2);
    }
}
