//! Latest-only scheduling and bounded settlement, owned by the action adapter.
use super::{
    installation::Usage,
    message_content::{MessagePreferences, SafeMessage},
    message_snapshot::MessageSnapshot,
    slots::MessageLocale,
    types::{ActivityPhase, RequestFailure, RequestResult},
    PetdexAdapter,
};
use serde::Serialize;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const COALESCE: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupOutcome {
    #[default]
    NotNeeded,
    Accepted,
    Unconfirmed,
}

struct CleanupProgress {
    remaining: usize,
    failed: bool,
}

impl CleanupProgress {
    fn record(&mut self, result: RequestResult) {
        self.remaining = self.remaining.saturating_sub(1);
        self.failed |= result != RequestResult::Applied;
    }

    fn outcome(&self) -> CleanupOutcome {
        if self.remaining == 0 && !self.failed {
            CleanupOutcome::Accepted
        } else {
            CleanupOutcome::Unconfirmed
        }
    }
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageDiagnostic {
    pub revision: u64,
    pub status: MessageStatus,
    pub accepted_count: u64,
    pub last_accepted_at: Option<u64>,
    pub used_slot_count: u8,
    pub error_reason: Option<super::types::PetdexErrorReason>,
    pub unsupported: bool,
    pub cleanup_outcome: CleanupOutcome,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MessageStatus {
    #[default]
    Disabled,
    Ready,
    Unavailable,
    Unsupported,
    Error,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageTestResult {
    pub diagnostic: MessageDiagnostic,
    pub outcome: MessageTestOutcome,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MessageTestOutcome {
    Accepted,
    Overridden,
    Failed,
    Disabled,
}

#[cfg(test)]
mod tests;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Backend contract; configuration IPC is migrated in stage 10.
pub(crate) struct MessageConfigurationResult {
    pub effective: MessagePreferences,
    pub cleanup_outcome: CleanupOutcome,
}

#[derive(Clone, PartialEq, Eq)]
struct Fingerprint {
    message: SafeMessage,
    binding: u64,
    generation: u64,
    locale: MessageLocale,
    runs: Vec<u64>,
}

#[derive(Clone)]
pub(super) struct Pending {
    snapshot: MessageSnapshot,
    slot: usize,
    fingerprint: Fingerprint,
    due: Instant,
    urgent: bool,
}

#[derive(Default)]
pub(super) struct MessageDelivery {
    preview_slot: Option<usize>,
    pub usage: [Usage; 3],
    pub locale: MessageLocale,
    pub diagnostic: MessageDiagnostic,
    accepted: [Option<Fingerprint>; 3],
    pending: [Option<Pending>; 3],
    phases: [Option<ActivityPhase>; 3],
    generation: u64,
    retry_at: Option<Instant>,
    failures: u32,
    pub offline: bool,
    pub writer_ready: bool,
}

impl MessageDelivery {
    fn refresh(&mut self, snapshot: MessageSnapshot, now: Instant) {
        if self.generation != snapshot.service_generation {
            self.generation = snapshot.service_generation;
            self.diagnostic.unsupported = false;
            self.accepted = Default::default();
        }
        for slot in 0..3 {
            if !snapshot.messages_enabled || snapshot.message_cancellation.is_cancelled() {
                self.pending[slot] = None;
                continue;
            }
            let content = snapshot.slots[slot].content.as_ref();
            let phase = content.map(|c| c.phase);
            let urgent = phase == Some(ActivityPhase::Failed)
                || matches!(phase, Some(ActivityPhase::Waiting(_)))
                || matches!(self.phases[slot], Some(ActivityPhase::Waiting(_)))
                || content.is_none();
            self.phases[slot] = phase;
            let message = snapshot.message(slot).or_else(|| {
                self.usage[slot]
                    .used
                    .then(|| SafeMessage::settled(self.locale))
            });
            let Some(message) = message else {
                self.pending[slot] = None;
                continue;
            };
            let fingerprint = Fingerprint {
                message,
                binding: snapshot.slots[slot].binding_generation,
                generation: snapshot.service_generation,
                locale: self.locale,
                runs: content.map(|c| c.runs.clone()).unwrap_or_default(),
            };
            if self.accepted[slot].as_ref() == Some(&fingerprint) {
                self.pending[slot] = None;
                continue;
            }
            let due = self.pending[slot]
                .as_ref()
                .filter(|p| p.fingerprint == fingerprint)
                .map(|p| p.due)
                .unwrap_or(now + if urgent { Duration::ZERO } else { COALESCE });
            let urgent = urgent
                || self.pending[slot]
                    .as_ref()
                    .is_some_and(|p| p.fingerprint == fingerprint && p.urgent);
            self.pending[slot] = Some(Pending {
                snapshot: snapshot.clone(),
                slot,
                fingerprint,
                due,
                urgent,
            });
        }
    }
    fn next(&self) -> Option<Pending> {
        if self.diagnostic.unsupported || !self.writer_ready {
            return None;
        }
        self.pending
            .iter()
            .flatten()
            .filter(|p| self.preview_slot != Some(p.slot))
            .min_by_key(|p| (!p.urgent, p.due))
            .cloned()
            .map(|mut p| {
                p.due = p.due.max(self.retry_at.unwrap_or(p.due));
                p
            })
    }
    fn record(&mut self, pending: &Pending, result: RequestResult, current: bool, now: Instant) {
        if !current {
            return;
        }
        self.diagnostic.error_reason = result.error_reason();
        if result == RequestResult::Applied {
            self.accepted[pending.slot] = Some(pending.fingerprint.clone());
            self.pending[pending.slot] = None;
            self.diagnostic.accepted_count += 1;
            self.diagnostic.last_accepted_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .and_then(|d| u64::try_from(d.as_millis()).ok());
            self.failures = 0;
            self.retry_at = None;
            self.offline = false;
        } else if result.should_retry() {
            self.offline = true;
            self.failures = self.failures.saturating_add(1);
            self.retry_at = Some(now + super::delivery::failure_backoff(self.failures));
        }
    }
}

impl PetdexAdapter {
    pub(crate) fn message_diagnostic(&self) -> MessageDiagnostic {
        let control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut messages = self
            .inner
            .messages
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        messages.diagnostic.revision += 1;
        let status = if !self.inner.enabled.load(Ordering::Acquire)
            || !control.arbiter.message_preferences.petdex_messages_enabled
        {
            MessageStatus::Disabled
        } else if !messages.writer_ready {
            MessageStatus::Unavailable
        } else if messages.diagnostic.unsupported {
            MessageStatus::Unsupported
        } else if messages.diagnostic.error_reason.is_some() {
            MessageStatus::Error
        } else {
            MessageStatus::Ready
        };
        MessageDiagnostic {
            status,
            used_slot_count: messages.usage.iter().filter(|u| u.used).count() as u8,
            ..messages.diagnostic
        }
    }

    pub(crate) async fn test_message(&self) -> MessageTestResult {
        let deadline = tokio::time::Instant::now() + super::STATE_ATTEMPT_TIMEOUT;
        let locale = self
            .inner
            .messages
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .locale;
        let snapshot = self.message_snapshot(Instant::now(), self.service_generation(), locale);
        if !snapshot.messages_enabled {
            return MessageTestResult {
                diagnostic: self.message_diagnostic(),
                outcome: MessageTestOutcome::Disabled,
            };
        }
        let slot = snapshot.slots.iter().position(|slot| {
            !slot.content.as_ref().is_some_and(|c| {
                matches!(c.phase, ActivityPhase::Failed | ActivityPhase::Waiting(_))
            })
        });
        let Some(slot) = slot else {
            return MessageTestResult {
                diagnostic: self.message_diagnostic(),
                outcome: MessageTestOutcome::Overridden,
            };
        };
        let reserved = {
            let mut messages = self
                .inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if messages.preview_slot.is_some() {
                false
            } else {
                messages.preview_slot = Some(slot);
                messages.diagnostic.unsupported = false;
                true
            }
        };
        if !reserved {
            return MessageTestResult {
                diagnostic: self.message_diagnostic(),
                outcome: MessageTestOutcome::Overridden,
            };
        }
        let restore = PreviewRestore {
            adapter: self.clone(),
            slot,
        };
        let message = SafeMessage::test(locale);
        let pending = Pending {
            fingerprint: Fingerprint {
                message: message.clone(),
                binding: snapshot.slots[slot].binding_generation,
                generation: snapshot.service_generation,
                locale,
                runs: Vec::new(),
            },
            snapshot,
            slot,
            due: Instant::now(),
            urgent: true,
        };
        let attempt = CancellationToken::new();
        let _guard = attempt.clone().drop_guard();
        let result = tokio::select! {
            biased;
            _ = pending.snapshot.cancellation.cancelled() => Err(RequestFailure::Disabled),
            _ = pending.snapshot.message_cancellation.cancelled() => Err(RequestFailure::Disabled),
            result = tokio::time::timeout_at(deadline, self.bubble_attempt(slot, &message, Some(&pending), &attempt)) => result.unwrap_or(Err(RequestFailure::Transport)),
        };
        attempt.cancel();
        let result = RequestResult::from_result(result);
        self.record_transport_result(result);
        let current = self.pending_current(&pending);
        self.inner
            .messages
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .record(&pending, result, current, Instant::now());
        drop(restore);
        MessageTestResult {
            diagnostic: self.message_diagnostic(),
            outcome: match result {
                RequestResult::Applied => MessageTestOutcome::Accepted,
                RequestResult::Disabled => MessageTestOutcome::Disabled,
                RequestResult::Expired => MessageTestOutcome::Overridden,
                _ => MessageTestOutcome::Failed,
            },
        }
    }

    pub(super) fn reconcile_message_connection(&self, result: RequestResult) {
        let generation = self.service_generation();
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut messages = self
            .inner
            .messages
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if result == RequestResult::Applied {
            if messages.offline || (messages.generation != 0 && messages.generation != generation) {
                control.arbiter.discard_message_results();
            }
            if messages.generation != generation {
                messages.generation = generation;
                messages.accepted = Default::default();
                messages.pending = Default::default();
                messages.diagnostic.unsupported = false;
            }
            messages.offline = false;
        } else if result.should_retry() {
            messages.offline = true;
            control.arbiter.discard_message_results();
        }
    }

    pub(super) fn next_message(&self, now: Instant) -> Option<Pending> {
        let generation = self.service_generation();
        let (locale, offline) = {
            let m = self
                .inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            (
                m.locale,
                m.offline || (m.generation != 0 && m.generation != generation),
            )
        };
        if offline {
            self.inner
                .coordinator
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .arbiter
                .discard_message_results();
        }
        let snapshot = self.message_snapshot(now, self.service_generation(), locale);
        let mut messages = self
            .inner
            .messages
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        messages.refresh(snapshot, now);
        messages.next()
    }

    pub(super) fn message_due(pending: &Pending) -> Instant {
        pending.due
    }

    // All filesystem work executes on a blocking worker, outside snapshot locks.
    // The request lock serializes network and durable usage updates together.
    async fn installation_attempt(
        &self,
        slot: usize,
        busy: bool,
        epoch: u64,
        cancellation: CancellationToken,
    ) -> Result<String, RequestFailure> {
        let adapter = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut installation = adapter
                .inner
                .message_installation
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if cancellation.is_cancelled() {
                return Err(RequestFailure::Disabled);
            }
            let installation = installation.as_mut().ok_or(RequestFailure::Rejected)?;
            installation
                .attempt_version(slot, busy, epoch)
                .map_err(|_| RequestFailure::Rejected)?;
            adapter
                .inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .usage = installation.usage();
            installation.key(slot).ok_or(RequestFailure::Rejected)
        })
        .await
        .map_err(|_| RequestFailure::Transport)?
    }

    async fn installation_settled(
        &self,
        slot: usize,
        pending: Option<Pending>,
        epoch: u64,
        cancellation: CancellationToken,
    ) -> Result<(), RequestFailure> {
        let adapter = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut installation = adapter
                .inner
                .message_installation
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if cancellation.is_cancelled() {
                return Err(RequestFailure::Disabled);
            }
            if pending
                .as_ref()
                .is_some_and(|p| !adapter.pending_current(p))
            {
                return Err(RequestFailure::Expired);
            }
            let installation = installation.as_mut().ok_or(RequestFailure::Rejected)?;
            if !installation
                .settle_version(slot, epoch)
                .map_err(|_| RequestFailure::Rejected)?
            {
                return Err(RequestFailure::Expired);
            }
            adapter
                .inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .usage = installation.usage();
            Ok(())
        })
        .await
        .map_err(|_| RequestFailure::Transport)?
    }

    fn pending_current(&self, pending: &Pending) -> bool {
        self.message_snapshot_is_current(
            &pending.snapshot,
            pending.slot,
            self.service_generation(),
            Instant::now(),
        )
    }

    async fn bubble_attempt(
        &self,
        slot: usize,
        message: &SafeMessage,
        pending: Option<&Pending>,
        cancellation: &CancellationToken,
    ) -> Result<(), RequestFailure> {
        let _guard = self.inner.request_lock.lock().await;
        let validate = || {
            if cancellation.is_cancelled() {
                Err(RequestFailure::Disabled)
            } else if pending.is_some_and(|p| !self.pending_current(p)) {
                Err(RequestFailure::Expired)
            } else {
                Ok(())
            }
        };
        validate()?;
        self.wait_write().await;
        validate()?;
        self.check_protocol_compatibility().await?;
        validate()?;
        let token = self.read_token().await?;
        let epoch = self.inner.write_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let key = self
            .installation_attempt(slot, message.busy(), epoch, cancellation.clone())
            .await?;
        let body = message.encode(&key).ok_or(RequestFailure::Rejected)?;
        self.wait_write().await;
        self.check_protocol_compatibility().await?;
        validate()?;
        let mut status = self.post_bytes("/bubble", body.clone(), &token).await?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            validate()?;
            let refreshed = self.refresh_token(&token).await?;
            self.wait_write().await;
            self.check_protocol_compatibility().await?;
            validate()?;
            status = self.post_bytes("/bubble", body, &refreshed).await?;
        }
        validate()?;
        if matches!(
            status,
            reqwest::StatusCode::NOT_FOUND
                | reqwest::StatusCode::METHOD_NOT_ALLOWED
                | reqwest::StatusCode::NOT_IMPLEMENTED
        ) {
            self.inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .diagnostic
                .unsupported = true;
        }
        Self::classify_status(status)?;
        if !message.busy() {
            self.installation_settled(slot, pending.cloned(), epoch, cancellation.clone())
                .await?;
        }
        Ok(())
    }

    pub(super) async fn deliver_message(&self, pending: Pending) {
        let attempt = CancellationToken::new();
        let _attempt_guard = attempt.clone().drop_guard();
        let result = tokio::select! {
            biased;
            _ = pending.snapshot.cancellation.cancelled() => Err(RequestFailure::Disabled),
            _ = pending.snapshot.message_cancellation.cancelled() => Err(RequestFailure::Disabled),
            result = tokio::time::timeout(super::STATE_ATTEMPT_TIMEOUT, self.bubble_attempt(pending.slot, &pending.fingerprint.message, Some(&pending), &attempt)) => result.unwrap_or(Err(RequestFailure::Transport)),
        };
        attempt.cancel();
        self.record_transport_result(RequestResult::from_result(result));
        let current = self.pending_current(&pending);
        self.inner
            .messages
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .record(
                &pending,
                RequestResult::from_result(result),
                current,
                Instant::now(),
            );
    }

    async fn settle_used(
        &self,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> CleanupOutcome {
        let _cleanup_guard = cancellation.clone().drop_guard();
        let (usage, locale) = {
            let m = self
                .inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            (m.usage, m.locale)
        };
        if !usage.iter().any(|u| u.used) {
            return CleanupOutcome::NotNeeded;
        }
        let operation = async {
            let mut progress = CleanupProgress {
                remaining: usage.iter().filter(|u| u.used).count(),
                failed: false,
            };
            for (slot, usage) in usage.iter().enumerate() {
                if usage.used {
                    let result = self
                        .bubble_attempt(slot, &SafeMessage::settled(locale), None, cancellation)
                        .await;
                    self.record_transport_result(RequestResult::from_result(result));
                    progress.record(RequestResult::from_result(result));
                }
            }
            progress.outcome()
        };
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return CleanupOutcome::Unconfirmed,
            result = tokio::time::timeout_at(deadline, operation) => result,
        };
        cancellation.cancel();
        result.unwrap_or(CleanupOutcome::Unconfirmed)
    }

    #[allow(dead_code)] // Consumed by the stage 10 configuration IPC.
    pub(crate) async fn configure_messages(
        &self,
        preferences: MessagePreferences,
        locale: &str,
    ) -> MessageConfigurationResult {
        let deadline = tokio::time::Instant::now() + super::STATE_ATTEMPT_TIMEOUT;
        self.configure_messages_until(preferences, locale, deadline)
            .await
    }

    pub(super) async fn configure_messages_until(
        &self,
        preferences: MessagePreferences,
        locale: &str,
        deadline: tokio::time::Instant,
    ) -> MessageConfigurationResult {
        let (epoch, cancellation, needs_cleanup) = {
            let mut control = self
                .inner
                .coordinator
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let (epoch, cancellation) = Self::begin_configuration_locked(&mut control);
            let old = control.arbiter.message_preferences;
            let needs_cleanup = self.inner.enabled.load(Ordering::Acquire)
                && (old.petdex_messages_enabled || control.cleanup_pending)
                && !preferences.petdex_messages_enabled;
            control.cleanup_pending = needs_cleanup;
            control.arbiter.set_message_preferences(preferences);
            let locale = MessageLocale::from_app_locale(locale);
            let locale_changed = control.arbiter.slots.locale != locale;
            if locale_changed {
                control.arbiter.message_cancellation.cancel();
                control.arbiter.message_cancellation = CancellationToken::new();
                control.arbiter.slots.locale = locale;
                control.arbiter.project_slots(Instant::now());
            }
            let mut messages = self
                .inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            messages.locale = locale;
            if old != preferences || locale_changed {
                messages.pending = Default::default();
            }
            if old.petdex_messages_enabled != preferences.petdex_messages_enabled {
                messages.accepted = Default::default();
            }
            (epoch, cancellation, needs_cleanup)
        };
        let outcome = if needs_cleanup {
            match tokio::time::timeout_at(deadline, self.inner.configuration_lock.lock()).await {
                Ok(_guard) if self.configuration_is_current(epoch) => {
                    self.settle_used(deadline, &cancellation).await
                }
                _ => {
                    cancellation.cancel();
                    CleanupOutcome::Unconfirmed
                }
            }
        } else {
            CleanupOutcome::NotNeeded
        };
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if control.configuration_epoch == epoch {
            control.cleanup_pending = false;
            self.inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .diagnostic
                .cleanup_outcome = outcome;
        }
        if let Some(sender) = &control.sender {
            let _ = sender.try_send(super::CoordinatorMessage::Wake);
        }
        MessageConfigurationResult {
            effective: control.arbiter.message_preferences,
            cleanup_outcome: outcome,
        }
    }

    pub(super) fn begin_message_configuration(&self) -> (u64, CancellationToken) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        Self::begin_configuration_locked(&mut control)
    }

    fn begin_configuration_locked(
        control: &mut super::CoordinatorControl,
    ) -> (u64, CancellationToken) {
        control.configuration_epoch += 1;
        control.cleanup_cancellation.cancel();
        control.cleanup_cancellation = CancellationToken::new();
        (
            control.configuration_epoch,
            control.cleanup_cancellation.clone(),
        )
    }

    pub(super) fn configuration_is_current(&self, epoch: u64) -> bool {
        self.inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .configuration_epoch
            == epoch
    }

    pub(crate) async fn shutdown_messages(&self) -> CleanupOutcome {
        let deadline = tokio::time::Instant::now() + super::STATE_ATTEMPT_TIMEOUT;
        self.shutdown_messages_until(deadline).await
    }

    pub(super) async fn shutdown_messages_until(
        &self,
        deadline: tokio::time::Instant,
    ) -> CleanupOutcome {
        let (epoch, cancellation, needs_cleanup) = {
            let mut control = self
                .inner
                .coordinator
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let (epoch, cancellation) = Self::begin_configuration_locked(&mut control);
            let was_enabled = self.inner.enabled.swap(false, Ordering::AcqRel);
            let needs_cleanup = was_enabled
                && (control.arbiter.message_preferences.petdex_messages_enabled
                    || control.cleanup_pending);
            control.cleanup_pending = needs_cleanup;
            control.cancellation.cancel();
            control.arbiter.message_cancellation.cancel();
            control.sender = None;
            (epoch, cancellation, needs_cleanup)
        };
        let outcome = if needs_cleanup {
            match tokio::time::timeout_at(deadline, self.inner.configuration_lock.lock()).await {
                Ok(_guard) if self.configuration_is_current(epoch) => {
                    self.settle_used(deadline, &cancellation).await
                }
                _ => {
                    cancellation.cancel();
                    CleanupOutcome::Unconfirmed
                }
            }
        } else {
            CleanupOutcome::NotNeeded
        };
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if control.configuration_epoch == epoch {
            control.cleanup_pending = false;
            self.stop_coordinator_locked(&mut control);
            let mut messages = self
                .inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            messages.diagnostic.cleanup_outcome = outcome;
            messages.accepted = Default::default();
            messages.pending = Default::default();
        }
        outcome
    }
}

struct PreviewRestore {
    adapter: PetdexAdapter,
    slot: usize,
}

impl Drop for PreviewRestore {
    fn drop(&mut self) {
        {
            let mut messages = self
                .adapter
                .inner
                .messages
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            messages.preview_slot = None;
            messages.accepted[self.slot] = None;
            messages.pending[self.slot] = None;
        }
        let control = self
            .adapter
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(sender) = &control.sender {
            let _ = sender.try_send(super::CoordinatorMessage::Wake);
        }
    }
}
