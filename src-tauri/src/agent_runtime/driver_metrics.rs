use super::{AgentSessionEvent, AgentSessionEventPayload, AgentSessionStatus};

/// Rebuilt from the durable log on startup and advanced only by committed events.
#[derive(Debug, Clone, Default)]
pub(super) struct DriverMetrics {
    pub(super) model_tokens: u64,
    pub(super) started_turns: usize,
    pub(super) turn_steps: usize,
    pub(super) turn_start: usize,
    active_ms: u64,
    running_since: Option<u64>,
}

impl DriverMetrics {
    pub(super) fn observe(&mut self, event: &AgentSessionEvent) {
        match &event.payload {
            AgentSessionEventPayload::SessionResumed {} => *self = Self::default(),
            AgentSessionEventPayload::TurnStart => {
                self.started_turns = self.started_turns.saturating_add(1);
                self.turn_steps = 0;
                self.turn_start = event.seq as usize;
            }
            AgentSessionEventPayload::StepStart => {
                self.turn_steps = self.turn_steps.saturating_add(1);
            }
            AgentSessionEventPayload::RequestContext { input_tokens, .. } => {
                self.model_tokens = self.model_tokens.saturating_add(input_tokens.unwrap_or(0));
            }
            AgentSessionEventPayload::RequestUsage { usage, .. } => {
                self.model_tokens = self
                    .model_tokens
                    .saturating_add(usage.output_tokens.unwrap_or(0));
            }
            AgentSessionEventPayload::AgentStatus { status, .. } => {
                if *status == AgentSessionStatus::Running {
                    self.running_since.get_or_insert(event.time_unix_ms);
                } else if let Some(start) = self.running_since.take() {
                    self.active_ms = self
                        .active_ms
                        .saturating_add(event.time_unix_ms.saturating_sub(start));
                }
            }
            _ => {}
        }
    }

    pub(super) fn active_duration_ms(&self, now: u64) -> u64 {
        self.active_ms.saturating_add(
            self.running_since
                .map_or(0, |start| now.saturating_sub(start)),
        )
    }
}
