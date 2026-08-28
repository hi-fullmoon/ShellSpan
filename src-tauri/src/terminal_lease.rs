use serde::Serialize;
use std::fmt;

/// Classifies who a terminal was created for. Agent PTYs are registered
/// through a separate SessionManager path and can never be written through
/// the ordinary user-terminal input command.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionKind {
    UserTerminal,
    AgentPty,
}

/// Immutable identity of one dedicated Agent PTY. Both values are checked at
/// every Agent write so a token from another run or session cannot be reused.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalBinding {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalLeaseOwner {
    Agent,
    User,
    Unowned,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalLeaseState {
    Active,
    Revoked,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalLeaseRevocationReason {
    Paused,
    Stopped,
    HandoffRequired,
    UserReturnedControl,
    Disconnected,
    Closed,
    ApplicationExit,
    TransportUnavailable,
}

/// The fencing token required for one Agent input. A successful input advances
/// the revision, so replaying the same request or delivering it late fails
/// closed even while the ownership epoch is otherwise unchanged.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalLeaseToken {
    pub(crate) epoch: u64,
    pub(crate) revision: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalLeaseSnapshot {
    pub(crate) binding: AgentTerminalBinding,
    pub(crate) owner: TerminalLeaseOwner,
    pub(crate) epoch: u64,
    pub(crate) revision: u64,
    pub(crate) state: TerminalLeaseState,
    pub(crate) revocation_reason: Option<TerminalLeaseRevocationReason>,
}

impl TerminalLeaseSnapshot {
    pub(crate) fn token(&self) -> TerminalLeaseToken {
        TerminalLeaseToken {
            epoch: self.epoch,
            revision: self.revision,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalLeaseError {
    RegistryPoisoned,
    SessionNotFound {
        session_id: String,
    },
    LeaseNotFound {
        session_id: String,
    },
    SessionAlreadyRegistered {
        session_id: String,
    },
    NotAgentPty {
        session_id: String,
    },
    DedicatedAgentPtyRequiresTakeover {
        session_id: String,
    },
    SessionNotConnected {
        session_id: String,
    },
    BindingMismatch,
    StaleEpoch {
        supplied: u64,
        current: u64,
    },
    StaleRevision {
        supplied: u64,
        current: u64,
    },
    LeaseRevoked {
        reason: Option<TerminalLeaseRevocationReason>,
    },
    OwnerMismatch {
        owner: TerminalLeaseOwner,
    },
    AgentControlRequiresRevokedLease,
    TransportUnavailable {
        session_id: String,
    },
    AuthorityCounterExhausted,
}

impl fmt::Display for TerminalLeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RegistryPoisoned => write!(f, "terminal session registry poisoned"),
            Self::SessionNotFound { session_id } => write!(f, "session {session_id} not found"),
            Self::LeaseNotFound { session_id } => {
                write!(f, "terminal lease for session {session_id} not found")
            }
            Self::SessionAlreadyRegistered { session_id } => {
                write!(f, "session {session_id} is already registered")
            }
            Self::NotAgentPty { session_id } => {
                write!(f, "session {session_id} is not a dedicated Agent PTY")
            }
            Self::DedicatedAgentPtyRequiresTakeover { session_id } => write!(
                f,
                "session {session_id} is a dedicated Agent PTY; ordinary write_session input is forbidden"
            ),
            Self::SessionNotConnected { session_id } => {
                write!(f, "session {session_id} is not connected")
            }
            Self::BindingMismatch => write!(f, "Agent terminal binding does not match the lease"),
            Self::StaleEpoch { supplied, current } => write!(
                f,
                "stale terminal lease epoch {supplied}; current epoch is {current}"
            ),
            Self::StaleRevision { supplied, current } => write!(
                f,
                "stale terminal lease revision {supplied}; current revision is {current}"
            ),
            Self::LeaseRevoked { reason } => {
                write!(f, "terminal lease is revoked")?;
                if let Some(reason) = reason {
                    write!(f, " ({reason:?})")?;
                }
                Ok(())
            }
            Self::OwnerMismatch { owner } => {
                write!(f, "terminal lease is owned by {owner:?}, not the Agent")
            }
            Self::AgentControlRequiresRevokedLease => write!(
                f,
                "Agent control can only be granted from an explicitly revoked lease"
            ),
            Self::TransportUnavailable { session_id } => {
                write!(f, "session {session_id} input transport is unavailable")
            }
            Self::AuthorityCounterExhausted => {
                write!(f, "terminal lease authority counter exhausted")
            }
        }
    }
}

/// Backend-authoritative ownership and replay fence for one Agent PTY.
/// Mutation is intentionally crate-private and is serialized by
/// SessionManager's registry mutex together with command enqueueing.
#[derive(Debug, Clone)]
pub(crate) struct TerminalLease {
    snapshot: TerminalLeaseSnapshot,
}

impl TerminalLease {
    pub(crate) fn new(binding: AgentTerminalBinding) -> Self {
        Self {
            snapshot: TerminalLeaseSnapshot {
                binding,
                owner: TerminalLeaseOwner::Agent,
                epoch: 1,
                revision: 1,
                state: TerminalLeaseState::Active,
                revocation_reason: None,
            },
        }
    }

    pub(crate) fn snapshot(&self) -> TerminalLeaseSnapshot {
        self.snapshot.clone()
    }

    pub(crate) fn validate_binding(
        &self,
        binding: &AgentTerminalBinding,
    ) -> Result<(), TerminalLeaseError> {
        if self.snapshot.binding == *binding {
            Ok(())
        } else {
            Err(TerminalLeaseError::BindingMismatch)
        }
    }

    pub(crate) fn validate_agent_input(
        &self,
        binding: &AgentTerminalBinding,
        token: TerminalLeaseToken,
    ) -> Result<(), TerminalLeaseError> {
        self.validate_binding(binding)?;
        if token.epoch != self.snapshot.epoch {
            return Err(TerminalLeaseError::StaleEpoch {
                supplied: token.epoch,
                current: self.snapshot.epoch,
            });
        }
        if token.revision != self.snapshot.revision {
            return Err(TerminalLeaseError::StaleRevision {
                supplied: token.revision,
                current: self.snapshot.revision,
            });
        }
        if self.snapshot.state != TerminalLeaseState::Active {
            return Err(TerminalLeaseError::LeaseRevoked {
                reason: self.snapshot.revocation_reason,
            });
        }
        if self.snapshot.owner != TerminalLeaseOwner::Agent {
            return Err(TerminalLeaseError::OwnerMismatch {
                owner: self.snapshot.owner,
            });
        }
        Ok(())
    }

    pub(crate) fn next_revision(&self) -> Result<u64, TerminalLeaseError> {
        self.snapshot
            .revision
            .checked_add(1)
            .ok_or(TerminalLeaseError::AuthorityCounterExhausted)
    }

    pub(crate) fn commit_revision(&mut self, revision: u64) {
        debug_assert_eq!(revision, self.snapshot.revision + 1);
        self.snapshot.revision = revision;
    }

    /// Changes authority before the first user bytes are enqueued. The caller
    /// holds the same registry lock across this transition and the enqueue.
    pub(crate) fn take_over_by_user(&mut self) -> Result<(), TerminalLeaseError> {
        let next_epoch = self
            .snapshot
            .epoch
            .checked_add(1)
            .ok_or(TerminalLeaseError::AuthorityCounterExhausted)?;
        let next_revision = self.next_revision()?;
        self.snapshot.owner = TerminalLeaseOwner::User;
        self.snapshot.epoch = next_epoch;
        self.snapshot.revision = next_revision;
        self.snapshot.state = TerminalLeaseState::Active;
        self.snapshot.revocation_reason = None;
        Ok(())
    }

    pub(crate) fn revoke(
        &mut self,
        reason: TerminalLeaseRevocationReason,
    ) -> Result<bool, TerminalLeaseError> {
        // Closed is an absorbing terminal state. Later app/run lifecycle
        // notifications must not make a destroyed transport look resumable.
        if self.snapshot.state == TerminalLeaseState::Revoked
            && self.snapshot.revocation_reason == Some(TerminalLeaseRevocationReason::Closed)
        {
            return Ok(false);
        }
        if self.snapshot.state == TerminalLeaseState::Revoked
            && self.snapshot.owner == TerminalLeaseOwner::Unowned
            && self.snapshot.revocation_reason == Some(reason)
        {
            return Ok(false);
        }
        let next_epoch = self
            .snapshot
            .epoch
            .checked_add(1)
            .ok_or(TerminalLeaseError::AuthorityCounterExhausted)?;
        let next_revision = self.next_revision()?;
        self.snapshot.owner = TerminalLeaseOwner::Unowned;
        self.snapshot.epoch = next_epoch;
        self.snapshot.revision = next_revision;
        self.snapshot.state = TerminalLeaseState::Revoked;
        self.snapshot.revocation_reason = Some(reason);
        Ok(true)
    }

    /// Resume never calls this implicitly. A future caller must explicitly
    /// re-grant the exact run/session binding after policy/UI authorization.
    pub(crate) fn grant_agent_control(
        &mut self,
        binding: &AgentTerminalBinding,
    ) -> Result<TerminalLeaseToken, TerminalLeaseError> {
        self.validate_binding(binding)?;
        if self.snapshot.state != TerminalLeaseState::Revoked
            || self.snapshot.owner != TerminalLeaseOwner::Unowned
        {
            return Err(TerminalLeaseError::AgentControlRequiresRevokedLease);
        }
        let next_epoch = self
            .snapshot
            .epoch
            .checked_add(1)
            .ok_or(TerminalLeaseError::AuthorityCounterExhausted)?;
        let next_revision = self.next_revision()?;
        self.snapshot.owner = TerminalLeaseOwner::Agent;
        self.snapshot.epoch = next_epoch;
        self.snapshot.revision = next_revision;
        self.snapshot.state = TerminalLeaseState::Active;
        self.snapshot.revocation_reason = None;
        Ok(self.snapshot().token())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> AgentTerminalBinding {
        AgentTerminalBinding {
            run_id: "run-1".to_string(),
            session_id: "agent-session-1".to_string(),
        }
    }

    #[test]
    fn new_lease_is_agent_owned_and_fenced() {
        let lease = TerminalLease::new(binding());
        let snapshot = lease.snapshot();
        assert_eq!(snapshot.owner, TerminalLeaseOwner::Agent);
        assert_eq!(snapshot.state, TerminalLeaseState::Active);
        assert_eq!(snapshot.epoch, 1);
        assert_eq!(snapshot.revision, 1);
        lease
            .validate_agent_input(&binding(), snapshot.token())
            .unwrap();
    }

    #[test]
    fn revoke_is_idempotent_for_the_same_reason_and_requires_explicit_regrant() {
        let mut lease = TerminalLease::new(binding());
        assert!(lease.revoke(TerminalLeaseRevocationReason::Paused).unwrap());
        let revoked = lease.snapshot();
        assert!(!lease.revoke(TerminalLeaseRevocationReason::Paused).unwrap());
        assert_eq!(lease.snapshot(), revoked);

        let token = lease.grant_agent_control(&binding()).unwrap();
        assert!(token.epoch > revoked.epoch);
        assert_eq!(lease.snapshot().owner, TerminalLeaseOwner::Agent);
    }

    #[test]
    fn user_owned_lease_cannot_be_silently_regranted_to_agent() {
        let mut lease = TerminalLease::new(binding());
        lease.take_over_by_user().unwrap();
        assert_eq!(
            lease.grant_agent_control(&binding()).unwrap_err(),
            TerminalLeaseError::AgentControlRequiresRevokedLease
        );
    }

    #[test]
    fn closed_is_an_absorbing_revocation_state() {
        let mut lease = TerminalLease::new(binding());
        lease.revoke(TerminalLeaseRevocationReason::Closed).unwrap();
        let closed = lease.snapshot();

        assert!(!lease
            .revoke(TerminalLeaseRevocationReason::ApplicationExit)
            .unwrap());
        assert_eq!(lease.snapshot(), closed);
    }
}
