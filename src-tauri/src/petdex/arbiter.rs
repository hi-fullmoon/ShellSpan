use std::{
    collections::{HashMap, VecDeque},
    time::Instant,
};

use super::types::{
    ActivityEvent, ActivityPhase, ActivitySource, PetdexCategories, PetdexState, StateCommand,
};

const TERMINAL_HISTORY_LIMIT: usize = 512;

#[derive(Clone, Copy)]
struct TemporaryState {
    state: PetdexState,
    expires_at: Instant,
}

#[cfg(test)]
mod tests {
    use super::super::types::{FAILURE_TTL, SUCCESS_TTL};
    use super::*;

    #[test]
    fn unknown_terminal_and_evicted_history_never_resurrect_old_runs() {
        let now = Instant::now();
        let mut arbiter = PetdexArbiter::default();
        arbiter.apply(
            ActivityEvent::new(ActivitySource::Sftp, 1, 1, ActivityPhase::Failed, now),
            now,
        );
        arbiter.apply(
            ActivityEvent::new(ActivitySource::Sftp, 1, 0, ActivityPhase::Running, now),
            now,
        );
        assert_eq!(arbiter.target(now).state, PetdexState::Idle);
        for id in 2..1026 {
            arbiter.apply(
                ActivityEvent::new(ActivitySource::Sftp, id, 0, ActivityPhase::Running, now),
                now,
            );
            arbiter.apply(
                ActivityEvent::new(ActivitySource::Sftp, id, 1, ActivityPhase::Cancelled, now),
                now,
            );
        }
        assert_eq!(arbiter.finished.len(), TERMINAL_HISTORY_LIMIT);
        assert_eq!(arbiter.watermarks.len(), 1);
        arbiter.apply(
            ActivityEvent::new(ActivitySource::Sftp, 2, 0, ActivityPhase::Running, now),
            now,
        );
        arbiter.apply(
            ActivityEvent::new(ActivitySource::Sftp, 2, 2, ActivityPhase::Failed, now),
            now,
        );
        assert_eq!(arbiter.target(now).state, PetdexState::Idle);
        assert!(arbiter.activities.is_empty());
    }

    #[test]
    fn late_expired_terminal_does_not_replace_current_result_or_extend_its_ttl() {
        let start = Instant::now();
        let now = start + FAILURE_TTL;
        let mut arbiter = PetdexArbiter::default();
        for id in 1..=3 {
            arbiter.apply(
                ActivityEvent::new(ActivitySource::Sftp, id, 0, ActivityPhase::Running, start),
                start,
            );
        }
        arbiter.apply(
            ActivityEvent::new(ActivitySource::Sftp, 2, 1, ActivityPhase::Succeeded, now),
            now,
        );
        arbiter.apply(
            ActivityEvent::new(ActivitySource::Sftp, 1, 1, ActivityPhase::Failed, start),
            now,
        );
        assert_eq!(arbiter.target(now).state, PetdexState::Jumping);
        arbiter.apply(
            ActivityEvent::new(ActivitySource::Sftp, 3, 1, ActivityPhase::Succeeded, start),
            now,
        );
        assert_eq!(arbiter.target(now).expires_at, Some(now + SUCCESS_TTL));
        assert_eq!(arbiter.target(now + SUCCESS_TTL).state, PetdexState::Idle);
    }

    #[test]
    fn preview_preserves_a_newer_business_result_and_expires_independently() {
        let start = Instant::now();
        let result_at = start + std::time::Duration::from_millis(500);
        let mut arbiter = PetdexArbiter::default();
        arbiter.start_preview(start);
        arbiter.apply(
            ActivityEvent::new(ActivitySource::Sftp, 1, 0, ActivityPhase::Running, start),
            start,
        );
        arbiter.apply(
            ActivityEvent::new(
                ActivitySource::Sftp,
                1,
                1,
                ActivityPhase::Succeeded,
                result_at,
            ),
            result_at,
        );
        assert_eq!(arbiter.target(result_at).state, PetdexState::Waving);
        assert_eq!(
            arbiter.target(start + SUCCESS_TTL).state,
            PetdexState::Jumping
        );
        assert_eq!(
            arbiter.target(result_at + SUCCESS_TTL).state,
            PetdexState::Idle
        );
    }
}

#[derive(Clone, Copy)]
pub(super) struct ArbitrationTarget {
    pub(super) state: PetdexState,
    pub(super) expires_at: Option<Instant>,
}

impl ArbitrationTarget {
    pub(super) fn command(self) -> StateCommand {
        StateCommand {
            state: self.state,
            expires_at: self.expires_at,
        }
    }
}

#[derive(Default)]
pub(super) struct PetdexArbiter {
    activities: HashMap<(ActivitySource, u64), ActivityEvent>,
    finished: VecDeque<(ActivitySource, u64)>,
    watermarks: HashMap<ActivitySource, u64>,
    next_run_id: u64,
    pub(super) categories: PetdexCategories,
    success: HashMap<ActivitySource, TemporaryState>,
    failed: HashMap<ActivitySource, TemporaryState>,
    preview: Option<TemporaryState>,
    message_results: Vec<ActivityEvent>,
    pub(super) slots: super::slots::Slots,
    pub(super) message_preferences: super::message_content::MessagePreferences,
    pub(super) message_cancellation: tokio_util::sync::CancellationToken,
}

impl PetdexArbiter {
    pub(super) fn discard_message_results(&mut self) {
        self.message_results.clear();
    }
    pub(super) fn allocate_run_id(&mut self) -> u64 {
        self.next_run_id = self
            .next_run_id
            .checked_add(1)
            .expect("Petdex run IDs exhausted");
        self.next_run_id
    }

    pub(super) fn apply(&mut self, mut event: ActivityEvent, now: Instant) {
        let key = (event.source, event.run_id);
        if self.finished.contains(&key) {
            return;
        }
        if let Some(current) = self.activities.get(&key) {
            if event.revision <= current.revision {
                return;
            }
            event.details = current.details.clone();
        } else {
            let watermark = self.watermarks.entry(event.source).or_default();
            if event.run_id <= *watermark {
                return;
            }
            *watermark = event.run_id;
            self.next_run_id = self.next_run_id.max(event.run_id);
            // Unknown updates/terminals retire their generation too. Starts
            // are registered synchronously in monotonic order under the lock.
            if event.revision != 0
                || matches!(
                    event.phase,
                    ActivityPhase::Succeeded | ActivityPhase::Failed | ActivityPhase::Cancelled
                )
            {
                return;
            }
        }
        if !self.message_preferences.petdex_messages_enabled
            || !self.message_preferences.petdex_message_details_enabled
            || !self.categories.includes(event.source)
        {
            event.details = Default::default();
        }
        if event.phase != ActivityPhase::Succeeded {
            event.details.clear_reply();
        }
        self.message_results
            .retain(|result| message_expiry(result).is_some_and(|deadline| deadline > now));
        if matches!(
            event.phase,
            ActivityPhase::Cancelled | ActivityPhase::Succeeded | ActivityPhase::Failed
        ) {
            self.message_results
                .retain(|result| (result.source, result.run_id) != key);
        }
        if event.revision == 0 && event.source == ActivitySource::Ai {
            self.message_results
                .retain(|result| result.owner != event.owner);
        }
        if self.categories.includes(event.source)
            && event.owner.is_some()
            && matches!(
                event.phase,
                ActivityPhase::Succeeded | ActivityPhase::Failed | ActivityPhase::Connected
            )
            && !self
                .activities
                .get(&key)
                .is_some_and(|current| current.phase == event.phase)
            && message_expiry(&event).is_some_and(|deadline| deadline > now)
        {
            self.message_results.push(event.clone());
        }
        match event.phase {
            ActivityPhase::Succeeded | ActivityPhase::Failed | ActivityPhase::Cancelled => {
                self.activities.remove(&key);
                self.finished.push_back(key);
                if self.finished.len() > TERMINAL_HISTORY_LIMIT {
                    self.finished.pop_front();
                }
                match event.phase {
                    ActivityPhase::Succeeded => {
                        self.pulse_at(event.source, PetdexState::Jumping, event.occurred_at, now)
                    }
                    ActivityPhase::Failed => {
                        self.pulse_at(event.source, PetdexState::Failed, event.occurred_at, now)
                    }
                    _ => {}
                }
            }
            _ => {
                if event.phase == ActivityPhase::Connected
                    && self
                        .activities
                        .get(&key)
                        .is_some_and(|a| a.phase == ActivityPhase::Connecting)
                {
                    self.pulse_at(event.source, PetdexState::Waving, event.occurred_at, now);
                }
                self.activities.insert(key, event);
            }
        }
    }

    fn pulse_at(
        &mut self,
        source: ActivitySource,
        state: PetdexState,
        occurred_at: Instant,
        now: Instant,
    ) {
        if !self.categories.includes(source) {
            return;
        }
        let Some(ttl) = state.ttl() else {
            return;
        };
        let expires_at = occurred_at + ttl;
        if expires_at <= now {
            return;
        }
        let slot = if state == PetdexState::Failed {
            &mut self.failed
        } else {
            &mut self.success
        };
        if slot
            .get(&source)
            .is_some_and(|current| current.expires_at > now)
        {
            return;
        }
        slot.insert(source, TemporaryState { state, expires_at });
    }

    pub(super) fn set_categories(&mut self, categories: PetdexCategories) -> bool {
        if self.categories == categories {
            return false;
        }
        self.categories = categories;
        for event in self
            .activities
            .values_mut()
            .filter(|e| !categories.includes(e.source))
        {
            event.details = Default::default();
        }
        self.message_results
            .retain(|event| categories.includes(event.source));
        self.success
            .retain(|source, _| categories.includes(*source));
        self.failed.retain(|source, _| categories.includes(*source));
        true
    }

    // Source state survives transport shutdown. Enabling reads it under the
    // same coordinator lock as every synchronous lifecycle publication.
    pub(super) fn clear_presentation(&mut self) {
        self.clear_details();
        self.message_results.clear();
        self.success.clear();
        self.failed.clear();
        self.preview = None;
        self.project_slots(Instant::now());
    }

    pub(super) fn update_details(
        &mut self,
        source: ActivitySource,
        run: u64,
        update: impl FnOnce(&mut super::message_content::SafeDetails),
    ) {
        if !self.message_preferences.petdex_messages_enabled
            || !self.message_preferences.petdex_message_details_enabled
            || !self.categories.includes(source)
        {
            return;
        }
        if let Some(event) = self.activities.get_mut(&(source, run)) {
            update(&mut event.details);
        }
        self.project_slots(Instant::now());
    }

    fn clear_details(&mut self) {
        for event in self
            .activities
            .values_mut()
            .chain(self.message_results.iter_mut())
        {
            event.details = Default::default();
        }
    }

    pub(super) fn set_message_preferences(
        &mut self,
        preferences: super::message_content::MessagePreferences,
    ) {
        if self.message_preferences == preferences {
            return;
        }
        self.message_preferences = preferences;
        self.message_cancellation.cancel();
        self.message_cancellation = tokio_util::sync::CancellationToken::new();
        self.clear_details();
        // Even toggling twice with no intervening snapshot invalidates pending work.
        for slot in &mut self.slots.slots {
            slot.revision += 1;
        }
        self.project_slots(Instant::now());
    }

    pub(super) fn start_preview(&mut self, now: Instant) {
        self.preview = Some(TemporaryState {
            state: PetdexState::Waving,
            expires_at: now + super::types::SUCCESS_TTL,
        });
    }

    pub(super) fn cancel_preview(&mut self, started_at: Instant) {
        if self
            .preview
            .is_some_and(|preview| preview.expires_at == started_at + super::types::SUCCESS_TTL)
        {
            self.preview = None;
        }
    }

    pub(super) fn preview_overridden(&mut self, now: Instant) -> bool {
        self.prune(now);
        !self.failed.is_empty()
            || self.activities.values().any(|a| {
                self.categories.includes(a.source) && matches!(a.phase, ActivityPhase::Waiting(_))
            })
    }

    fn prune(&mut self, now: Instant) {
        self.success
            .retain(|_, temporary| temporary.expires_at > now);
        self.failed
            .retain(|_, temporary| temporary.expires_at > now);
        if self
            .preview
            .is_some_and(|temporary| temporary.expires_at <= now)
        {
            self.preview = None;
        }
    }

    pub(super) fn target(&mut self, now: Instant) -> ArbitrationTarget {
        self.prune(now);
        self.project_slots(now);
        let waiting = self.activities.values().any(|a| {
            self.categories.includes(a.source) && matches!(a.phase, ActivityPhase::Waiting(_))
        });
        let temporary = self
            .failed
            .values()
            .min_by_key(|t| t.expires_at)
            .copied()
            .or_else(|| {
                if waiting {
                    None
                } else {
                    self.preview
                        .or_else(|| self.success.values().min_by_key(|t| t.expires_at).copied())
                }
            });
        if let Some(temporary) = temporary {
            return ArbitrationTarget {
                state: temporary.state,
                expires_at: Some(temporary.expires_at),
            };
        }
        let state = if waiting {
            PetdexState::Waiting
        } else if self
            .activities
            .values()
            .any(|a| self.categories.includes(a.source) && a.phase == ActivityPhase::Running)
        {
            PetdexState::Running
        } else if self
            .activities
            .values()
            .any(|a| self.categories.includes(a.source) && a.phase == ActivityPhase::Connecting)
        {
            PetdexState::Waiting
        } else {
            PetdexState::Idle
        };
        ArbitrationTarget {
            state,
            expires_at: None,
        }
    }

    pub(super) fn next_expiry(&self) -> Option<Instant> {
        self.success
            .values()
            .chain(self.failed.values())
            .chain(self.preview.iter())
            .map(|t| t.expires_at)
            .chain(self.message_results.iter().filter_map(message_expiry))
            .min()
    }

    pub(super) fn project_slots(&mut self, now: Instant) {
        self.message_results
            .retain(|event| message_expiry(event).is_some_and(|deadline| deadline > now));
        let events = self
            .activities
            .values()
            .filter(|e| self.categories.includes(e.source) && e.phase != ActivityPhase::Connected)
            .cloned()
            .map(|e| (e, None))
            .chain(self.message_results.iter().cloned().map(|e| {
                let expiry = message_expiry(&e);
                (e, expiry)
            }))
            .collect();
        self.slots.project(events);
    }

    #[cfg(test)]
    pub(super) fn has_failure(&self) -> bool {
        !self.failed.is_empty()
    }

    #[cfg(test)]
    pub(super) fn active_sftp_operations(&self) -> usize {
        self.activities
            .values()
            .filter(|a| a.source == ActivitySource::Sftp)
            .count()
    }
}

fn message_expiry(event: &ActivityEvent) -> Option<Instant> {
    match event.phase {
        ActivityPhase::Failed => Some(event.occurred_at + super::types::FAILURE_TTL),
        ActivityPhase::Succeeded | ActivityPhase::Connected => {
            Some(event.occurred_at + super::types::SUCCESS_TTL)
        }
        _ => None,
    }
}
