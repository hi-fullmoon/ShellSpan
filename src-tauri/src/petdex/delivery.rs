use std::time::{Duration, Instant};

use super::{
    arbiter::ArbitrationTarget,
    types::{PetdexState, RequestResult},
};

pub(super) const MIN_SEND_INTERVAL: Duration = Duration::from_millis(100);
pub(super) const INITIAL_FAILURE_BACKOFF: Duration = Duration::from_millis(250);
pub(super) const MAX_FAILURE_BACKOFF: Duration = Duration::from_secs(60);
pub(super) const INITIAL_RECOVERY_PROBE_INTERVAL: Duration = Duration::from_secs(5);
pub(super) const WARM_RECOVERY_PROBE_INTERVAL: Duration = Duration::from_secs(15);
pub(super) const ACTIVE_STEADY_RECOVERY_PROBE_INTERVAL: Duration = Duration::from_secs(30);
pub(super) const IDLE_STEADY_RECOVERY_PROBE_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(super) struct DeliveryPolicy {
    last_sent: Option<PetdexState>,
    last_attempted: Option<PetdexState>,
    last_success_at: Option<Instant>,
    pub(super) last_attempt_at: Option<Instant>,
    pub(super) retry_at: Option<Instant>,
    pub(super) consecutive_failures: u32,
    consecutive_same_state_successes: u32,
}

impl DeliveryPolicy {
    pub(super) fn attempt_deadline(
        &self,
        target: ArbitrationTarget,
        now: Instant,
    ) -> Option<Instant> {
        let state_changed = self.last_attempted != Some(target.state);
        if state_changed {
            return Some(self.minimum_attempt_deadline(now));
        }

        if let Some(retry_at) = self.retry_at {
            return Some(self.minimum_attempt_deadline(now).max(retry_at));
        }

        let recovery_interval = self.recovery_probe_interval(target.state);
        let recovery_due = self
            .last_success_at
            .is_some_and(|last_success| now >= last_success + recovery_interval);
        if !recovery_due {
            return Some(
                self.last_success_at
                    .map(|last_success| last_success + recovery_interval)
                    .unwrap_or_else(|| self.minimum_attempt_deadline(now)),
            );
        }

        Some(self.minimum_attempt_deadline(now))
    }

    pub(super) fn record(&mut self, state: PetdexState, result: RequestResult, now: Instant) {
        self.last_attempt_at = Some(now);
        self.last_attempted = Some(state);
        if result == RequestResult::Applied {
            if self.last_sent == Some(state) {
                self.consecutive_same_state_successes =
                    self.consecutive_same_state_successes.saturating_add(1);
            } else {
                self.consecutive_same_state_successes = 0;
            }
            self.last_sent = Some(state);
            self.last_success_at = Some(now);
            self.retry_at = None;
            self.consecutive_failures = 0;
            return;
        }

        self.last_sent = None;
        self.consecutive_same_state_successes = 0;
        if result.should_retry() {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            self.retry_at = Some(now + failure_backoff(self.consecutive_failures));
        }
    }

    pub(super) fn reset_backoff(&mut self) {
        self.retry_at = None;
        self.consecutive_failures = 0;
    }

    fn recovery_probe_interval(&self, state: PetdexState) -> Duration {
        match self.consecutive_same_state_successes {
            0 => INITIAL_RECOVERY_PROBE_INTERVAL,
            1 => WARM_RECOVERY_PROBE_INTERVAL,
            _ if state == PetdexState::Idle => IDLE_STEADY_RECOVERY_PROBE_INTERVAL,
            _ => ACTIVE_STEADY_RECOVERY_PROBE_INTERVAL,
        }
    }

    fn minimum_attempt_deadline(&self, now: Instant) -> Instant {
        self.last_attempt_at
            .map(|last_attempt| now.max(last_attempt + MIN_SEND_INTERVAL))
            .unwrap_or(now)
    }
}

pub(super) fn failure_backoff(consecutive_failures: u32) -> Duration {
    let exponent = consecutive_failures.saturating_sub(1).min(8);
    let multiplier = 1_u32 << exponent;
    (INITIAL_FAILURE_BACKOFF * multiplier).min(MAX_FAILURE_BACKOFF)
}
