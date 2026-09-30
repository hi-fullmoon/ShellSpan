//! Versioned internal handoff to the content and transport stages. Snapshots
//! are copied under the action coordinator lock; consumers do I/O after release.
use super::{
    slots::{MessageLocale, Slot},
    PetdexAdapter,
};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct MessageSnapshot {
    pub action: super::types::StateCommand,
    pub slots: [Slot; 3],
    pub(super) cancellation: CancellationToken,
    pub(super) service_generation: u64,
    pub(super) messages_enabled: bool,
    pub(super) message_cancellation: CancellationToken,
}

impl MessageSnapshot {
    /// Only this finite safe content is eligible for the stage 9 wire boundary.
    pub(super) fn message(&self, slot: usize) -> Option<super::message_content::SafeMessage> {
        if !self.messages_enabled
            || self.cancellation.is_cancelled()
            || self.message_cancellation.is_cancelled()
        {
            return None;
        }
        self.slots
            .get(slot)?
            .content
            .as_ref()
            .map(super::message_content::SafeMessage::from_content)
    }
}

impl PetdexAdapter {
    pub(crate) fn set_message_preferences(
        &self,
        preferences: super::message_content::MessagePreferences,
    ) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        control.arbiter.set_message_preferences(preferences);
    }
    pub(super) fn message_snapshot(
        &self,
        now: Instant,
        service_generation: u64,
        locale: MessageLocale,
    ) -> MessageSnapshot {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        control.arbiter.slots.locale = locale;
        let action = control.arbiter.target(now).command();
        MessageSnapshot {
            message_cancellation: control.arbiter.message_cancellation.clone(),
            messages_enabled: self
                .inner
                .enabled
                .load(std::sync::atomic::Ordering::Acquire)
                && control.arbiter.message_preferences.petdex_messages_enabled,
            action,
            slots: control.arbiter.slots.slots.clone(),
            cancellation: control.cancellation.clone(),
            service_generation,
        }
    }

    pub(super) fn message_snapshot_is_current(
        &self,
        snapshot: &MessageSnapshot,
        slot: usize,
        service_generation: u64,
        now: Instant,
    ) -> bool {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if !self
            .inner
            .enabled
            .load(std::sync::atomic::Ordering::Acquire)
            || snapshot.cancellation.is_cancelled()
            || snapshot.message_cancellation.is_cancelled()
            || snapshot.service_generation != service_generation
        {
            return false;
        }
        control.arbiter.project_slots(now);
        let Some(old) = snapshot.slots.get(slot) else {
            return false;
        };
        let current = &control.arbiter.slots.slots[slot];
        current.binding_generation == old.binding_generation && current.revision == old.revision
    }
}
