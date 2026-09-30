//! Internal projection of the arbiter's accepted lifecycle snapshot. No I/O,
//! serializable identity, independent event queue, or second lifecycle store.
use std::time::Instant;

use super::types::{ActivityEvent, ActivityKind, ActivityOwner, ActivityPhase, WaitReason};

#[derive(Clone, PartialEq, Eq)]
pub(super) enum Binding {
    Owner(ActivityOwner),
    Summary,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Content {
    pub details: super::message_content::SafeDetails,
    pub locale: MessageLocale,
    pub members: Vec<ActivityOwner>,
    /// Internal generations protect equal-looking consecutive turns/replies.
    pub runs: Vec<u64>,
    pub phase: ActivityPhase,
    pub kind: ActivityKind,
    /// Visible owners, including owners represented only by a valid result.
    pub owner_count: usize,
    /// Active runs (SFTP batches), excluding results and connected SSH handles.
    pub active_run_count: usize,
    pub busy: bool,
    pub expires_at: Option<Instant>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum MessageLocale {
    #[default]
    EnUs,
    ZhCn,
}

impl MessageLocale {
    /// Consume ShellSpan's resolved application locale, never the OS locale.
    pub(super) fn from_app_locale(locale: &str) -> Self {
        match locale {
            "zh-CN" => Self::ZhCn,
            _ => Self::EnUs,
        }
    }
}

#[derive(Clone, Default)]
pub(super) struct Slot {
    pub binding: Option<Binding>,
    pub binding_generation: u64,
    pub revision: u64,
    pub content: Option<Content>,
}

#[derive(Default)]
pub(super) struct Slots {
    pub slots: [Slot; 3],
    pub locale: MessageLocale,
    owner_order: Vec<ActivityOwner>,
}

pub(super) fn priority(phase: ActivityPhase) -> u8 {
    match phase {
        ActivityPhase::Failed => 0,
        ActivityPhase::Waiting(WaitReason::Approval) => 1,
        ActivityPhase::Waiting(WaitReason::Answer) => 2,
        ActivityPhase::Succeeded | ActivityPhase::Connected => 3,
        ActivityPhase::Running => 4,
        ActivityPhase::Connecting => 5,
        ActivityPhase::Cancelled => 6,
    }
}

impl Slots {
    pub fn project(&mut self, mut events: Vec<(ActivityEvent, Option<Instant>)>) {
        events.sort_by_key(|(e, _)| e.run_id);
        let mut groups: Vec<(ActivityOwner, u64, Content)> = Vec::new();
        for (event, expires_at) in events {
            let Some(owner) = event.owner else { continue };
            let running = matches!(
                event.phase,
                ActivityPhase::Running | ActivityPhase::Connecting | ActivityPhase::Waiting(_)
            );
            if let Some((_, order, content)) = groups.iter_mut().find(|(o, _, _)| *o == owner) {
                *order = (*order).min(event.run_id);
                content.active_run_count += usize::from(running);
                content.runs.push(event.run_id);
                content.busy |= running;
                if priority(event.phase) < priority(content.phase) {
                    content.phase = event.phase;
                    content.kind = event.kind;
                    content.details = event.details;
                    content.expires_at = expires_at;
                } else if priority(event.phase) == priority(content.phase) {
                    content.expires_at = match (content.expires_at, expires_at) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        _ => None,
                    };
                }
            } else {
                groups.push((
                    owner.clone(),
                    event.run_id,
                    Content {
                        details: event.details,
                        locale: self.locale,
                        members: vec![owner],
                        runs: vec![event.run_id],
                        phase: event.phase,
                        kind: event.kind,
                        owner_count: 1,
                        active_run_count: usize::from(running),
                        busy: running,
                        expires_at,
                    },
                ));
            }
        }
        self.owner_order
            .retain(|owner| groups.iter().any(|(o, _, _)| o == owner));
        for (owner, _, _) in &groups {
            if !self.owner_order.contains(owner) {
                self.owner_order.push(owner.clone());
            }
        }
        let displayed = |owner: &ActivityOwner| {
            self.slots
                .iter()
                .position(|s| s.binding.as_ref() == Some(&Binding::Owner(owner.clone())))
        };
        groups.sort_by_key(|(owner, _, c)| {
            (
                priority(c.phase),
                displayed(owner).is_none(),
                self.owner_order.iter().position(|o| o == owner).unwrap(),
            )
        });
        let mut desired: Vec<(Binding, Content)> = Vec::new();
        if groups.len() > 3 {
            let rest = groups.split_off(2);
            let mut summary = rest[0].2.clone();
            summary.details = Default::default();
            summary.members = rest.iter().map(|(o, _, _)| o.clone()).collect();
            summary.runs = rest
                .iter()
                .flat_map(|(_, _, c)| c.runs.iter().copied())
                .collect();
            summary.owner_count = rest.len();
            summary.active_run_count = rest.iter().map(|(_, _, c)| c.active_run_count).sum();
            summary.busy = rest.iter().any(|(_, _, c)| c.busy);
            summary.expires_at = rest.iter().filter_map(|(_, _, c)| c.expires_at).min();
            desired.push((Binding::Summary, summary));
        }
        desired.extend(groups.into_iter().map(|(o, _, c)| (Binding::Owner(o), c)));
        let summary_mode = desired.iter().any(|(b, _)| *b == Binding::Summary);
        let mut next: [Option<(Binding, Content)>; 3] = [None, None, None];
        if summary_mode {
            let index = desired
                .iter()
                .position(|(b, _)| *b == Binding::Summary)
                .unwrap();
            next[2] = Some(desired.remove(index));
        }
        for (index, slot) in self.slots.iter().enumerate() {
            if next[index].is_some() {
                continue;
            }
            if let Some(position) = desired
                .iter()
                .position(|(b, _)| Some(b) == slot.binding.as_ref())
            {
                next[index] = Some(desired.remove(position));
            }
        }
        for value in desired {
            *next.iter_mut().find(|s| s.is_none()).unwrap() = Some(value);
        }
        for (slot, value) in self.slots.iter_mut().zip(next) {
            let (binding, content) = value
                .map(|(b, c)| (Some(b), Some(c)))
                .unwrap_or((None, None));
            if slot.binding != binding {
                slot.binding_generation += 1;
            }
            if slot.binding != binding || slot.content != content {
                slot.revision += 1;
            }
            slot.binding = binding;
            slot.content = content;
        }
    }
}
