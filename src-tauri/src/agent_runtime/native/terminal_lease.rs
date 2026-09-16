use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::models::SessionManager;
use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind, TerminalSessionBroker};

pub(crate) const AGENT_TERMINAL_LEASE_EVENT: &str = "agent-terminal-lease";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalLease {
    pub(crate) session_id: String,
    pub(crate) agent_session_id: String,
    pub(crate) task_id: String,
    pub(crate) operation_id: String,
    pub(crate) acquired_at_unix_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalLeaseReleaseReason {
    Completed,
    Cancelled,
    TimedOut,
    Failed,
    TakenOver,
    TerminalClosed,
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalLeaseEventState {
    Acquired,
    Released,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalLeaseEvent {
    pub(crate) session_id: String,
    pub(crate) agent_session_id: String,
    pub(crate) task_id: String,
    pub(crate) operation_id: String,
    pub(crate) acquired_at_unix_ms: u64,
    pub(crate) state: TerminalLeaseEventState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) command_display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<TerminalLeaseReleaseReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalLeaseError {
    Busy,
    NotFound,
    OwnerMismatch,
    OperationMismatch,
    UserInputBlocked,
    AlreadyTerminal,
    Unavailable,
}

impl TerminalLeaseError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Busy => "TERMINAL_LEASE_BUSY",
            Self::NotFound => "TERMINAL_LEASE_NOT_FOUND",
            Self::OwnerMismatch => "TERMINAL_LEASE_OWNER_MISMATCH",
            Self::OperationMismatch => "TERMINAL_LEASE_OPERATION_MISMATCH",
            Self::UserInputBlocked => "TERMINAL_INPUT_BLOCKED_BY_AGENT",
            Self::AlreadyTerminal => "TERMINAL_LEASE_ALREADY_TERMINAL",
            Self::Unavailable => "TERMINAL_LEASE_UNAVAILABLE",
        }
    }
}

impl fmt::Display for TerminalLeaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Busy => "terminal already has an Agent owner",
            Self::NotFound => "terminal has no active Agent lease",
            Self::OwnerMismatch => "Agent Session or task does not own the terminal lease",
            Self::OperationMismatch => "operation does not own the terminal lease",
            Self::UserInputBlocked => "user input is blocked while an Agent owns the terminal",
            Self::AlreadyTerminal => "the terminal operation already reached a terminal state",
            Self::Unavailable => "terminal lease state is unavailable",
        };
        write!(formatter, "{}: {message}", self.code())
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum TerminalInputSource<'a> {
    User,
    Agent {
        agent_session_id: &'a str,
        task_id: &'a str,
        operation_id: &'a str,
    },
    System {
        operation_id: Option<&'a str>,
    },
}

#[derive(Debug, Clone)]
struct LeaseRecord {
    lease: AgentTerminalLease,
    frontend_ready: FrontendReadyState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FrontendReadyState {
    Pending,
    Ready,
    Rejected(String),
}

type LeasePublisher = Arc<dyn Fn(&AgentTerminalLeaseEvent) + Send + Sync>;

#[derive(Clone)]
pub(crate) struct TerminalLeaseManager {
    leases: Arc<Mutex<HashMap<String, LeaseRecord>>>,
    turn_guards: Arc<Mutex<HashMap<String, String>>>,
    changed: Arc<Condvar>,
    publisher: Arc<Mutex<Option<LeasePublisher>>>,
    broker: TerminalSessionBroker,
}

impl Default for TerminalLeaseManager {
    fn default() -> Self {
        Self {
            leases: Arc::new(Mutex::new(HashMap::new())),
            turn_guards: Arc::new(Mutex::new(HashMap::new())),
            changed: Arc::new(Condvar::new()),
            publisher: Arc::new(Mutex::new(None)),
            broker: TerminalSessionBroker::default(),
        }
    }
}

impl TerminalLeaseManager {
    pub(crate) fn new(broker: TerminalSessionBroker) -> Self {
        Self {
            broker,
            ..Self::default()
        }
    }

    pub(crate) fn begin_turn(
        &self,
        session_id: &str,
        agent_session_id: &str,
    ) -> Result<(), String> {
        let mut turn_guards = self
            .turn_guards
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        if turn_guards
            .get(session_id)
            .is_some_and(|owner| owner != agent_session_id)
        {
            return Err(TerminalLeaseError::Busy.to_string());
        }
        let leases = self
            .leases
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        if leases
            .get(session_id)
            .is_some_and(|record| record.lease.agent_session_id != agent_session_id)
        {
            return Err(TerminalLeaseError::Busy.to_string());
        }
        turn_guards.insert(session_id.to_string(), agent_session_id.to_string());
        Ok(())
    }

    pub(crate) fn set_publisher(&self, publisher: LeasePublisher) -> Result<(), String> {
        *self
            .publisher
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())? = Some(publisher);
        Ok(())
    }

    pub(crate) fn acquire(
        &self,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        command_display: Option<String>,
    ) -> Result<AgentTerminalLease, String> {
        let lease = AgentTerminalLease {
            session_id: session_id.to_string(),
            agent_session_id: agent_session_id.to_string(),
            task_id: task_id.to_string(),
            operation_id: operation_id.to_string(),
            acquired_at_unix_ms: super::current_unix_ms(),
        };
        {
            // The guard survives individual command leases until TurnEnd.
            // Acquire it before the lease mutex, matching the User write path.
            let mut turn_guards = self
                .turn_guards
                .lock()
                .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
            if turn_guards
                .get(session_id)
                .is_some_and(|owner| owner != agent_session_id)
            {
                return Err(TerminalLeaseError::Busy.to_string());
            }
            let mut leases = self
                .leases
                .lock()
                .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
            if leases.contains_key(session_id) {
                log::warn!(
                    "Agent terminal lease rejected as busy session_id={session_id} agent_session_id={agent_session_id} task_id={task_id} operation_id={operation_id}"
                );
                return Err(TerminalLeaseError::Busy.to_string());
            }
            self.broker
                .acquire_agent_lease(session_id, agent_session_id, task_id, operation_id)?;
            turn_guards.insert(session_id.to_string(), agent_session_id.to_string());
            leases.insert(
                session_id.to_string(),
                LeaseRecord {
                    lease: lease.clone(),
                    frontend_ready: FrontendReadyState::Pending,
                },
            );
        }
        log::info!(
            "Agent terminal lease acquired session_id={} agent_session_id={} task_id={} operation_id={}",
            lease.session_id,
            lease.agent_session_id,
            lease.task_id,
            lease.operation_id
        );
        self.publish(AgentTerminalLeaseEvent {
            session_id: lease.session_id.clone(),
            agent_session_id: lease.agent_session_id.clone(),
            task_id: lease.task_id.clone(),
            operation_id: lease.operation_id.clone(),
            acquired_at_unix_ms: lease.acquired_at_unix_ms,
            state: TerminalLeaseEventState::Acquired,
            command_display,
            reason: None,
        });
        Ok(lease)
    }

    pub(crate) fn release(
        &self,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        reason: TerminalLeaseReleaseReason,
    ) -> Result<bool, String> {
        let lease = {
            let mut leases = self
                .leases
                .lock()
                .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
            let Some(record) = leases.get(session_id) else {
                return Ok(false);
            };
            validate_owner(&record.lease, agent_session_id, Some(task_id), operation_id)?;
            self.broker
                .release_agent_lease(session_id, agent_session_id, task_id, operation_id)?;
            leases.remove(session_id).map(|record| record.lease)
        };
        if let Some(lease) = lease {
            self.changed.notify_all();
            log_release(&lease, reason);
            self.publish(released_event(lease, reason));
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) fn release_terminal(
        &self,
        session_id: &str,
        reason: TerminalLeaseReleaseReason,
    ) -> Result<bool, String> {
        self.turn_guards
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?
            .remove(session_id);
        let lease = {
            let mut leases = self
                .leases
                .lock()
                .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
            let lease = leases.get(session_id).map(|record| record.lease.clone());
            if let Some(lease) = lease.as_ref() {
                if let Err(error) = self.broker.release_agent_lease(
                    session_id,
                    &lease.agent_session_id,
                    &lease.task_id,
                    &lease.operation_id,
                ) {
                    // A reconnect or trusted rollback may already have
                    // invalidated the old broker generation. The lease must
                    // still be releasable.
                    log::warn!(
                        "Terminal broker lease was already unavailable while releasing lease session_id={session_id}: {error}"
                    );
                }
            }
            leases.remove(session_id).map(|record| record.lease)
        };
        if let Some(lease) = lease {
            self.changed.notify_all();
            log_release(&lease, reason);
            self.publish(released_event(lease, reason));
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) fn acknowledge_frontend_ready(
        &self,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
        terminal_connected: bool,
        output_listener_ready: bool,
        has_pending_user_input: bool,
        has_unverified_user_submission: bool,
        has_credential_prompt: bool,
    ) -> Result<bool, String> {
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        let record = leases
            .get_mut(session_id)
            .ok_or_else(|| TerminalLeaseError::NotFound.to_string())?;
        validate_owner(&record.lease, agent_session_id, None, operation_id)?;
        let changed = record.frontend_ready == FrontendReadyState::Pending;
        if changed {
            record.frontend_ready = if !terminal_connected {
                FrontendReadyState::Rejected(
                    "TERMINAL_FRONTEND_NOT_CONNECTED: terminal is not connected".into(),
                )
            } else if !output_listener_ready {
                FrontendReadyState::Rejected(
                    "TERMINAL_FRONTEND_OUTPUT_NOT_READY: terminal output listener is not ready"
                        .into(),
                )
            } else if has_pending_user_input {
                FrontendReadyState::Rejected(
                    "TERMINAL_FRONTEND_PENDING_INPUT: terminal has unsubmitted user input".into(),
                )
            } else if has_unverified_user_submission {
                FrontendReadyState::Rejected(
                    "TERMINAL_FRONTEND_UNVERIFIED_INPUT: terminal has a user submission awaiting output"
                        .into(),
                )
            } else if has_credential_prompt {
                FrontendReadyState::Rejected(
                    "TERMINAL_FRONTEND_CREDENTIAL_PROMPT: terminal is awaiting credentials or host-key confirmation"
                        .into(),
                )
            } else {
                FrontendReadyState::Ready
            };
            match &record.frontend_ready {
                FrontendReadyState::Ready => log::info!(
                    "Agent terminal frontend ready session_id={session_id} agent_session_id={agent_session_id} operation_id={operation_id}"
                ),
                FrontendReadyState::Rejected(error) => log::warn!(
                    "Agent terminal frontend rejected lease session_id={session_id} agent_session_id={agent_session_id} operation_id={operation_id} reason={error}"
                ),
                FrontendReadyState::Pending => {}
            }
            self.changed.notify_all();
        }
        Ok(changed)
    }

    pub(crate) fn wait_frontend_ready(
        &self,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let leases = self
            .leases
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        let (leases, timed) = self
            .changed
            .wait_timeout_while(leases, timeout, |leases| {
                leases.get(session_id).is_some_and(|record| {
                    record.lease.agent_session_id == agent_session_id
                        && record.lease.task_id == task_id
                        && record.lease.operation_id == operation_id
                        && record.frontend_ready == FrontendReadyState::Pending
                })
            })
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        let record = leases
            .get(session_id)
            .ok_or_else(|| TerminalLeaseError::NotFound.to_string())?;
        validate_owner(&record.lease, agent_session_id, Some(task_id), operation_id)?;
        match &record.frontend_ready {
            FrontendReadyState::Ready => Ok(()),
            FrontendReadyState::Rejected(error) => Err(error.clone()),
            FrontendReadyState::Pending if timed.timed_out() => Err(
                "TERMINAL_FRONTEND_READY_TIMEOUT: terminal frontend did not acknowledge the lease"
                    .into(),
            ),
            FrontendReadyState::Pending => Err(
                "TERMINAL_FRONTEND_READY_UNAVAILABLE: terminal frontend readiness is unavailable"
                    .into(),
            ),
        }
    }

    pub(crate) fn validate_control_owner(
        &self,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
    ) -> Result<AgentTerminalLease, String> {
        let leases = self
            .leases
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        let record = leases
            .get(session_id)
            .ok_or_else(|| TerminalLeaseError::NotFound.to_string())?;
        validate_owner(&record.lease, agent_session_id, None, operation_id)?;
        Ok(record.lease.clone())
    }

    pub(crate) fn write(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        data: String,
        source: TerminalInputSource<'_>,
    ) -> Result<(), String> {
        let input_kind = match source {
            TerminalInputSource::System { .. } if data.as_bytes() == [3] => {
                TerminalInputKind::Interrupt
            }
            TerminalInputSource::System { .. } => TerminalInputKind::SystemControl,
            TerminalInputSource::User | TerminalInputSource::Agent { .. } => {
                TerminalInputKind::Text
            }
        };
        self.write_with_kind(sessions, session_id, data, source, input_kind)
            .map(|_| ())
    }

    pub(crate) fn write_with_kind(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        data: String,
        source: TerminalInputSource<'_>,
        input_kind: TerminalInputKind,
    ) -> Result<Option<crate::terminal_broker::TerminalInputReceipt>, String> {
        // Keep authorization and enqueue in one lease critical section. Without
        // this, a User write could pass while Idle and race an Agent acquire
        // before its bytes reach the terminal command queue.
        let turn_guards = self
            .turn_guards
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        if matches!(source, TerminalInputSource::User) && turn_guards.contains_key(session_id) {
            return Err(TerminalLeaseError::UserInputBlocked.to_string());
        }
        let leases = self
            .leases
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        authorize_input(leases.get(session_id).map(|record| &record.lease), source)?;
        let broker_source = match source {
            TerminalInputSource::User => TerminalBrokerInputSource::User,
            TerminalInputSource::Agent {
                agent_session_id,
                task_id,
                operation_id,
            } => TerminalBrokerInputSource::Agent {
                agent_session_id: agent_session_id.to_string(),
                task_id: task_id.to_string(),
                operation_id: operation_id.to_string(),
            },
            TerminalInputSource::System {
                operation_id: Some(operation_id),
            } => TerminalBrokerInputSource::System {
                operation_id: operation_id.to_string(),
            },
            TerminalInputSource::System { operation_id: None } => {
                return Err(TerminalLeaseError::OperationMismatch.to_string());
            }
        };
        if matches!(source, TerminalInputSource::System { .. })
            && !matches!(
                input_kind,
                TerminalInputKind::Interrupt | TerminalInputKind::SystemControl
            )
        {
            return Err(TerminalLeaseError::OperationMismatch.to_string());
        }
        let bytes = data.as_bytes().to_vec();
        self.broker
            .admit_terminal_input(session_id, broker_source, input_kind, &bytes, || {
                sessions.write_session_input(session_id, data)
            })
    }

    pub(crate) fn release_turn(&self, agent_session_id: &str) -> Result<(), String> {
        self.turn_guards
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?
            .retain(|_, owner| owner != agent_session_id);
        Ok(())
    }

    pub(crate) fn has_lease(&self, session_id: &str) -> Result<bool, String> {
        if self
            .turn_guards
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?
            .contains_key(session_id)
        {
            return Ok(true);
        }
        Ok(self
            .leases
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?
            .contains_key(session_id))
    }

    #[cfg(test)]
    pub(crate) fn lease(&self, session_id: &str) -> Option<AgentTerminalLease> {
        self.leases
            .lock()
            .ok()
            .and_then(|leases| leases.get(session_id).map(|record| record.lease.clone()))
    }

    fn publish(&self, event: AgentTerminalLeaseEvent) {
        let publisher = self
            .publisher
            .lock()
            .ok()
            .and_then(|publisher| publisher.clone());
        if let Some(publisher) = publisher {
            publisher(&event);
        }
    }
}

fn validate_owner(
    lease: &AgentTerminalLease,
    agent_session_id: &str,
    task_id: Option<&str>,
    operation_id: &str,
) -> Result<(), String> {
    if lease.operation_id != operation_id {
        return Err(TerminalLeaseError::OperationMismatch.to_string());
    }
    if lease.agent_session_id != agent_session_id
        || task_id.is_some_and(|task_id| lease.task_id != task_id)
    {
        return Err(TerminalLeaseError::OwnerMismatch.to_string());
    }
    Ok(())
}

fn authorize_input(
    lease: Option<&AgentTerminalLease>,
    source: TerminalInputSource<'_>,
) -> Result<(), String> {
    match (source, lease) {
        (TerminalInputSource::User, Some(_)) => {
            Err(TerminalLeaseError::UserInputBlocked.to_string())
        }
        (TerminalInputSource::User, None) => Ok(()),
        (
            TerminalInputSource::Agent {
                agent_session_id,
                task_id,
                operation_id,
            },
            Some(lease),
        ) => validate_owner(lease, agent_session_id, Some(task_id), operation_id),
        (TerminalInputSource::Agent { .. }, None) => Err(TerminalLeaseError::NotFound.to_string()),
        (TerminalInputSource::System { operation_id: None }, _) => {
            Err(TerminalLeaseError::OperationMismatch.to_string())
        }
        (
            TerminalInputSource::System {
                operation_id: Some(operation_id),
            },
            Some(lease),
        ) if lease.operation_id == operation_id => Ok(()),
        (TerminalInputSource::System { .. }, _) => {
            Err(TerminalLeaseError::OperationMismatch.to_string())
        }
    }
}

fn released_event(
    lease: AgentTerminalLease,
    reason: TerminalLeaseReleaseReason,
) -> AgentTerminalLeaseEvent {
    AgentTerminalLeaseEvent {
        session_id: lease.session_id,
        agent_session_id: lease.agent_session_id,
        task_id: lease.task_id,
        operation_id: lease.operation_id,
        acquired_at_unix_ms: lease.acquired_at_unix_ms,
        state: TerminalLeaseEventState::Released,
        command_display: None,
        reason: Some(reason),
    }
}

fn log_release(lease: &AgentTerminalLease, reason: TerminalLeaseReleaseReason) {
    log::info!(
        "Agent terminal lease released session_id={} agent_session_id={} task_id={} operation_id={} reason={reason:?}",
        lease.session_id,
        lease.agent_session_id,
        lease.task_id,
        lease.operation_id
    );
}

#[cfg(test)]
mod tests {
    include!("../tests/native/terminal_lease.rs");
}
