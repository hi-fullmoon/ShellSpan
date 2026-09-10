use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::models::SessionManager;

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
    changed: Arc<Condvar>,
    publisher: Arc<Mutex<Option<LeasePublisher>>>,
}

impl Default for TerminalLeaseManager {
    fn default() -> Self {
        Self {
            leases: Arc::new(Mutex::new(HashMap::new())),
            changed: Arc::new(Condvar::new()),
            publisher: Arc::new(Mutex::new(None)),
        }
    }
}

impl TerminalLeaseManager {
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
        let lease = self
            .leases
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?
            .remove(session_id)
            .map(|record| record.lease);
        if let Some(lease) = lease {
            self.changed.notify_all();
            log_release(&lease, reason);
            self.publish(released_event(lease, reason));
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) fn release_all(&self, reason: TerminalLeaseReleaseReason) -> Result<usize, String> {
        let leases = {
            let mut records = self
                .leases
                .lock()
                .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
            records
                .drain()
                .map(|(_, record)| record.lease)
                .collect::<Vec<_>>()
        };
        let count = leases.len();
        self.changed.notify_all();
        for lease in leases {
            log_release(&lease, reason);
            self.publish(released_event(lease, reason));
        }
        Ok(count)
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
        // Keep authorization and enqueue in one lease critical section. Without
        // this, a User write could pass while Idle and race an Agent acquire
        // before its bytes reach the terminal command queue.
        let leases = self
            .leases
            .lock()
            .map_err(|_| TerminalLeaseError::Unavailable.to_string())?;
        authorize_input(leases.get(session_id).map(|record| &record.lease), source)?;
        sessions.write_session_input(session_id, data)
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
        (TerminalInputSource::System { operation_id: None }, None) => Ok(()),
        (TerminalInputSource::System { operation_id: None }, Some(_)) => {
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
    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crossbeam_channel::{unbounded, Receiver};
    use std::sync::atomic::AtomicBool;

    fn sessions() -> (SessionManager, Receiver<SessionCommand>) {
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                "terminal-1".into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: "terminal-1".into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "Local".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        (sessions, receiver)
    }

    fn acquire(manager: &TerminalLeaseManager) {
        manager
            .acquire("terminal-1", "agent-1", "task-1", "operation-1", None)
            .unwrap();
    }

    #[test]
    fn single_owner_busy_wrong_owner_and_idempotent_release() {
        let manager = TerminalLeaseManager::default();
        acquire(&manager);
        assert!(manager
            .acquire("terminal-1", "agent-2", "task-2", "operation-2", None)
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_BUSY:"));
        assert!(manager
            .release(
                "terminal-1",
                "agent-2",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::Cancelled,
            )
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_OWNER_MISMATCH:"));
        assert!(manager
            .release(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::Completed,
            )
            .unwrap());
        assert!(!manager
            .release(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                TerminalLeaseReleaseReason::Completed,
            )
            .unwrap());
    }

    #[test]
    fn user_input_is_rejected_and_agent_operation_must_match() {
        let manager = TerminalLeaseManager::default();
        let (sessions, receiver) = sessions();
        manager
            .write(
                &sessions,
                "terminal-1",
                "before".into(),
                TerminalInputSource::User,
            )
            .unwrap();
        acquire(&manager);
        assert!(manager
            .write(
                &sessions,
                "terminal-1",
                "blocked".into(),
                TerminalInputSource::User,
            )
            .unwrap_err()
            .starts_with("TERMINAL_INPUT_BLOCKED_BY_AGENT:"));
        assert!(manager
            .write(
                &sessions,
                "terminal-1",
                "wrong".into(),
                TerminalInputSource::Agent {
                    agent_session_id: "agent-1",
                    task_id: "task-1",
                    operation_id: "operation-2",
                },
            )
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_OPERATION_MISMATCH:"));
        manager
            .write(
                &sessions,
                "terminal-1",
                "agent".into(),
                TerminalInputSource::Agent {
                    agent_session_id: "agent-1",
                    task_id: "task-1",
                    operation_id: "operation-1",
                },
            )
            .unwrap();
        let writes = receiver
            .try_iter()
            .filter_map(|command| match command {
                SessionCommand::Write(data) => Some(data),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(writes, vec!["before", "agent"]);
    }

    #[test]
    fn events_preserve_operation_identity_and_first_release_reason() {
        let manager = TerminalLeaseManager::default();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        manager
            .set_publisher(Arc::new(move |event| {
                captured.lock().unwrap().push(event.clone());
            }))
            .unwrap();
        acquire(&manager);
        manager
            .release_terminal("terminal-1", TerminalLeaseReleaseReason::Shutdown)
            .unwrap();
        manager
            .release_terminal("terminal-1", TerminalLeaseReleaseReason::Cancelled)
            .unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].state, TerminalLeaseEventState::Acquired);
        assert_eq!(events[1].state, TerminalLeaseEventState::Released);
        assert_eq!(events[1].reason, Some(TerminalLeaseReleaseReason::Shutdown));
        assert_eq!(events[1].operation_id, "operation-1");
        assert_eq!(
            serde_json::to_value(&events[1]).unwrap(),
            serde_json::json!({
                "sessionId": "terminal-1",
                "agentSessionId": "agent-1",
                "taskId": "task-1",
                "operationId": "operation-1",
                "acquiredAtUnixMs": events[1].acquired_at_unix_ms,
                "state": "released",
                "reason": "shutdown"
            })
        );
    }

    #[test]
    fn frontend_ready_gate_accepts_only_clean_connected_state() {
        let manager = TerminalLeaseManager::default();
        acquire(&manager);
        assert!(manager
            .acknowledge_frontend_ready(
                "terminal-1",
                "agent-1",
                "operation-1",
                true,
                true,
                false,
                false,
                false,
            )
            .unwrap());
        manager
            .wait_frontend_ready(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                Duration::ZERO,
            )
            .unwrap();
    }

    #[test]
    fn frontend_ready_gate_rejects_pending_input_and_times_out_boundedly() {
        let manager = TerminalLeaseManager::default();
        acquire(&manager);
        manager
            .acknowledge_frontend_ready(
                "terminal-1",
                "agent-1",
                "operation-1",
                true,
                true,
                true,
                false,
                false,
            )
            .unwrap();
        assert!(manager
            .wait_frontend_ready(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                Duration::ZERO,
            )
            .unwrap_err()
            .starts_with("TERMINAL_FRONTEND_PENDING_INPUT:"));
        manager
            .release_terminal("terminal-1", TerminalLeaseReleaseReason::Failed)
            .unwrap();

        acquire(&manager);
        assert!(manager
            .wait_frontend_ready(
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                Duration::ZERO,
            )
            .unwrap_err()
            .starts_with("TERMINAL_FRONTEND_READY_TIMEOUT:"));
    }

    #[test]
    fn runtime_restart_has_no_stale_in_memory_lease_or_input_block() {
        let before_restart = TerminalLeaseManager::default();
        acquire(&before_restart);
        assert!(before_restart.lease("terminal-1").is_some());
        drop(before_restart);

        let after_restart = TerminalLeaseManager::default();
        let (sessions, receiver) = sessions();
        assert!(after_restart.lease("terminal-1").is_none());
        after_restart
            .write(
                &sessions,
                "terminal-1",
                "user-after-restart".into(),
                TerminalInputSource::User,
            )
            .unwrap();
        assert!(matches!(
            receiver.recv().unwrap(),
            SessionCommand::Write(data) if data == "user-after-restart"
        ));
    }
}
