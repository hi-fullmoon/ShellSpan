use std::{collections::HashSet, time::Instant};

use super::types::{PetdexEvent, PetdexState, StateCommand};

const SSH_CONNECTING_PRIORITY: u8 = 40;
const SFTP_ACTIVE_PRIORITY: u8 = 50;
const SUCCESS_PRIORITY: u8 = 80;
const FAILURE_PRIORITY: u8 = 100;

fn temporary_priority(state: PetdexState) -> u8 {
    match state {
        PetdexState::Failed => FAILURE_PRIORITY,
        PetdexState::Waving | PetdexState::Jumping => SUCCESS_PRIORITY,
        PetdexState::Idle | PetdexState::Waiting | PetdexState::Running => 0,
    }
}

#[derive(Clone, Copy)]
struct TemporaryState {
    state: PetdexState,
    expires_at: Instant,
    sequence: u64,
}

#[derive(Clone, Copy)]
pub(super) struct ArbitrationTarget {
    pub(super) state: PetdexState,
    pub(super) expires_at: Option<Instant>,
}

impl ArbitrationTarget {
    pub(super) fn command(self, now: Instant) -> StateCommand {
        StateCommand {
            state: self.state,
            duration: self
                .expires_at
                .and_then(|expires_at| expires_at.checked_duration_since(now)),
        }
    }
}

#[derive(Default)]
pub(super) struct PetdexArbiter {
    ssh_known: HashSet<String>,
    ssh_connecting: HashSet<String>,
    sftp_active: HashSet<String>,
    waving: Option<TemporaryState>,
    jumping: Option<TemporaryState>,
    failed: Option<TemporaryState>,
    sequence: u64,
}

impl PetdexArbiter {
    pub(super) fn apply(&mut self, event: PetdexEvent, now: Instant) {
        match event {
            PetdexEvent::SshConnecting(operation_id) => {
                self.ssh_known.insert(operation_id.clone());
                self.ssh_connecting.insert(operation_id);
            }
            PetdexEvent::SshConnected(operation_id) => {
                if self.ssh_connecting.remove(&operation_id) {
                    self.pulse(PetdexState::Waving, now);
                }
            }
            PetdexEvent::SshFailed(operation_id) => {
                self.ssh_connecting.remove(&operation_id);
                if self.ssh_known.remove(&operation_id) {
                    self.pulse(PetdexState::Failed, now);
                }
            }
            PetdexEvent::SshClosed(operation_id) => {
                self.ssh_connecting.remove(&operation_id);
                self.ssh_known.remove(&operation_id);
            }
            PetdexEvent::SftpStarted(operation_id) => {
                self.sftp_active.insert(operation_id);
            }
            PetdexEvent::SftpSucceeded(operation_id) => {
                if self.sftp_active.remove(&operation_id) {
                    self.pulse(PetdexState::Jumping, now);
                }
            }
            PetdexEvent::SftpFailed(operation_id) => {
                if self.sftp_active.remove(&operation_id) {
                    self.pulse(PetdexState::Failed, now);
                }
            }
            PetdexEvent::SftpCancelled(operation_id) => {
                self.sftp_active.remove(&operation_id);
            }
        }
    }

    pub(super) fn pulse(&mut self, state: PetdexState, now: Instant) {
        let Some(ttl) = state.ttl() else {
            return;
        };
        let slot = match state {
            PetdexState::Waving => &mut self.waving,
            PetdexState::Jumping => &mut self.jumping,
            PetdexState::Failed => &mut self.failed,
            PetdexState::Idle | PetdexState::Waiting | PetdexState::Running => return,
        };
        if slot.is_some_and(|current| current.expires_at > now) {
            return;
        }
        self.sequence = self.sequence.wrapping_add(1);
        *slot = Some(TemporaryState {
            state,
            expires_at: now + ttl,
            sequence: self.sequence,
        });
    }

    pub(super) fn clear_temporaries(&mut self) {
        self.waving = None;
        self.jumping = None;
        self.failed = None;
    }

    fn prune(&mut self, now: Instant) {
        for slot in [&mut self.waving, &mut self.jumping, &mut self.failed] {
            if slot.is_some_and(|temporary| temporary.expires_at <= now) {
                *slot = None;
            }
        }
    }

    pub(super) fn target(&mut self, now: Instant) -> ArbitrationTarget {
        self.prune(now);
        let temporary = [self.waving, self.jumping, self.failed]
            .into_iter()
            .flatten()
            .max_by_key(|temporary| (temporary_priority(temporary.state), temporary.sequence));
        if let Some(temporary) = temporary {
            return ArbitrationTarget {
                state: temporary.state,
                expires_at: Some(temporary.expires_at),
            };
        }

        // Persistent priorities are transfer running (50), then SSH connecting
        // (40). Separate sets preserve independent lifecycles.
        let state = [
            (
                !self.ssh_connecting.is_empty(),
                PetdexState::Waiting,
                SSH_CONNECTING_PRIORITY,
            ),
            (
                !self.sftp_active.is_empty(),
                PetdexState::Running,
                SFTP_ACTIVE_PRIORITY,
            ),
        ]
        .into_iter()
        .filter(|(active, _, _)| *active)
        .max_by_key(|(_, _, priority)| *priority)
        .map(|(_, state, _)| state)
        .unwrap_or(PetdexState::Idle);
        ArbitrationTarget {
            state,
            expires_at: None,
        }
    }

    pub(super) fn next_expiry(&self) -> Option<Instant> {
        [self.waving, self.jumping, self.failed]
            .into_iter()
            .flatten()
            .map(|temporary| temporary.expires_at)
            .min()
    }

    #[cfg(test)]
    pub(super) fn has_failure(&self) -> bool {
        self.failed.is_some()
    }

    #[cfg(test)]
    pub(super) fn active_sftp_operations(&self) -> usize {
        self.sftp_active.len()
    }
}
