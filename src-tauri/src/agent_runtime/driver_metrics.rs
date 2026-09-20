use super::{AgentSessionEvent, AgentSessionEventPayload, AgentSessionStatus};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum TaskTokenBudgetDecision {
    Continue,
    Checkpoint,
    Stop,
}

/// Rebuilt from the durable log on startup and advanced only by committed events.
#[derive(Debug, Clone, Default)]
pub(super) struct DriverMetrics {
    pub(super) model_tokens: u64,
    pub(super) started_turns: usize,
    pub(super) turn_steps: usize,
    pub(super) turn_start: usize,
    active_ms: u64,
    running_since: Option<u64>,
    task_budget_checkpointed: bool,
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
            AgentSessionEventPayload::ContextArtifact { kind, .. }
                if kind == super::TASK_BUDGET_PROGRESS_KIND =>
            {
                self.task_budget_checkpointed = true;
            }
            AgentSessionEventPayload::AgentStatus { status, reason } => {
                if reason.as_deref() == Some("taskBudgetCheckpointUnavailable") {
                    self.task_budget_checkpointed = true;
                }
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

    pub(super) fn token_budget_decision(
        &self,
        next_request_tokens: u64,
        maximum: u64,
    ) -> TaskTokenBudgetDecision {
        let projected = self.model_tokens.saturating_add(next_request_tokens);
        if self.model_tokens >= maximum || projected > maximum {
            TaskTokenBudgetDecision::Stop
        } else if !self.task_budget_checkpointed
            && projected >= maximum.saturating_sub(maximum / 10)
        {
            TaskTokenBudgetDecision::Checkpoint
        } else {
            TaskTokenBudgetDecision::Continue
        }
    }
}
