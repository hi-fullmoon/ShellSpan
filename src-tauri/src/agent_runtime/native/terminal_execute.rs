use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::models::{SessionManager, SessionStatus};
use crate::terminal_broker::{
    TerminalCommandOperation, TerminalCommandRequestedSettlement, TerminalCommandSnapshot,
    TerminalCommandState, TerminalSessionBroker,
};

use super::{
    TerminalInputSource, TerminalLeaseError, TerminalLeaseManager, TerminalLeaseReleaseReason,
};

const FRONTEND_READY_TIMEOUT: Duration = Duration::from_secs(5);
const INTERRUPT_SETTLEMENT_TIMEOUT: Duration = Duration::from_secs(2);
const CAPTURE_DRAIN_GRACE: Duration = Duration::from_millis(25);
const WAIT_SLICE: Duration = Duration::from_millis(50);

#[derive(Clone)]
struct TerminalExecuteRegistration {
    agent_session_id: String,
    task_id: String,
    operation_id: String,
    operation: Arc<TerminalCommandOperation>,
}

#[derive(Clone)]
pub(crate) struct TerminalExecuteRegistry {
    operations: Arc<Mutex<HashMap<String, TerminalExecuteRegistration>>>,
    leases: TerminalLeaseManager,
    broker: TerminalSessionBroker,
}

impl TerminalExecuteRegistry {
    pub(crate) fn new(leases: TerminalLeaseManager, broker: TerminalSessionBroker) -> Self {
        Self {
            operations: Arc::new(Mutex::new(HashMap::new())),
            leases,
            broker,
        }
    }

    pub(crate) fn has_operation(&self, session_id: &str) -> Result<bool, String> {
        Ok(self
            .operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE".to_string())?
            .contains_key(session_id))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        command: &str,
        enter: &str,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.leases
            .acquire(session_id, agent_session_id, task_id, operation_id, None)?;
        if let Err(error) = self.leases.wait_frontend_ready(
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            FRONTEND_READY_TIMEOUT,
        ) {
            let _ = self.leases.release(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err(error);
        }
        let terminal_connected = match sessions.target_state(session_id) {
            Ok(state) => state.status == SessionStatus::Connected,
            Err(error) => {
                let _ = self.leases.release(
                    session_id,
                    agent_session_id,
                    task_id,
                    operation_id,
                    TerminalLeaseReleaseReason::Failed,
                );
                return Err(error);
            }
        };
        if !terminal_connected {
            let _ = self.leases.release(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err("TERMINAL_EXECUTE_NOT_CONNECTED".into());
        }

        let operation = match self.broker.begin_command(session_id, operation_id, command) {
            Ok(operation) => operation,
            Err(error) => {
                let _ = self.leases.release(
                    session_id,
                    agent_session_id,
                    task_id,
                    operation_id,
                    TerminalLeaseReleaseReason::Failed,
                );
                return Err(error);
            }
        };
        {
            let mut operations = match self.operations.lock() {
                Ok(operations) => operations,
                Err(_) => {
                    let command_id = operation.command_id()?;
                    let _ = self.broker.mark_command_uncertain(session_id, &command_id);
                    let _ = self.broker.retire_command(session_id, &command_id);
                    let _ = self.leases.release(
                        session_id,
                        agent_session_id,
                        task_id,
                        operation_id,
                        TerminalLeaseReleaseReason::Failed,
                    );
                    return Err("TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE".into());
                }
            };
            if operations.contains_key(session_id) {
                let command_id = operation.command_id()?;
                let _ = self.broker.mark_command_uncertain(session_id, &command_id);
                let _ = self.broker.retire_command(session_id, &command_id);
                let _ = self.leases.release(
                    session_id,
                    agent_session_id,
                    task_id,
                    operation_id,
                    TerminalLeaseReleaseReason::Failed,
                );
                return Err(TerminalLeaseError::Busy.to_string());
            }
            operations.insert(
                session_id.to_string(),
                TerminalExecuteRegistration {
                    agent_session_id: agent_session_id.to_string(),
                    task_id: task_id.to_string(),
                    operation_id: operation_id.to_string(),
                    operation: Arc::clone(&operation),
                },
            );
        }

        let input = format!("{command}{enter}");
        if let Err(error) = self.leases.write(
            sessions,
            session_id,
            input,
            TerminalInputSource::Agent {
                agent_session_id,
                task_id,
                operation_id,
            },
        ) {
            let command_id = operation.command_id()?;
            let _ = self.broker.mark_command_uncertain(session_id, &command_id);
            let _ = self.finish_registration(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err(error);
        }
        Ok(operation)
    }

    pub(crate) fn wait(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation: &Arc<TerminalCommandOperation>,
        timeout: Duration,
    ) -> Result<TerminalCommandSnapshot, String> {
        let deadline = Instant::now() + timeout;
        let mut interrupt_deadline = None;
        loop {
            let snapshot = operation.wait_until_terminal(WAIT_SLICE)?;
            if snapshot.state.is_terminal() {
                break;
            }
            if snapshot.state == TerminalCommandState::CancelRequested
                && interrupt_deadline.is_none()
            {
                interrupt_deadline = Some(Instant::now() + INTERRUPT_SETTLEMENT_TIMEOUT);
            }
            if interrupt_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                let _ = self
                    .broker
                    .mark_command_uncertain(session_id, &snapshot.command_id);
                break;
            }
            if Instant::now() >= deadline && interrupt_deadline.is_none() {
                let send =
                    operation.request_settlement(TerminalCommandRequestedSettlement::TimedOut)?;
                if send {
                    let _ = self.leases.write(
                        sessions,
                        session_id,
                        "\u{3}".to_string(),
                        TerminalInputSource::System {
                            operation_id: Some(&snapshot.operation_id),
                        },
                    );
                }
                interrupt_deadline = Some(Instant::now() + INTERRUPT_SETTLEMENT_TIMEOUT);
            }
        }

        std::thread::sleep(CAPTURE_DRAIN_GRACE);
        let mut snapshot = operation.snapshot()?;
        let through_sequence = self
            .broker
            .snapshot(Some(session_id))?
            .session
            .map(|session| session.next_output_sequence.saturating_sub(1))
            .unwrap_or(snapshot.capture_end_sequence.unwrap_or(0));
        operation.finalize_capture(through_sequence)?;
        snapshot = operation.snapshot()?;
        let reason = release_reason(snapshot.state);
        let registration = self.registration(session_id, &snapshot.operation_id)?;
        let _ = self.finish_registration(
            session_id,
            &registration.agent_session_id,
            &registration.task_id,
            &snapshot.operation_id,
            reason,
        );
        Ok(snapshot)
    }

    pub(crate) fn cancel_task(
        &self,
        sessions: &SessionManager,
        task_id: &str,
    ) -> Result<usize, String> {
        self.request_where(
            sessions,
            TerminalCommandRequestedSettlement::Cancelled,
            |registration| registration.task_id == task_id,
        )
    }

    pub(crate) fn takeover(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        self.leases
            .validate_control_owner(session_id, agent_session_id, operation_id)?;
        let registration = self.registration(session_id, operation_id)?;
        let send = registration
            .operation
            .request_settlement(TerminalCommandRequestedSettlement::TakenOver)?;
        if send {
            let _ = self.leases.write(
                sessions,
                session_id,
                "\u{3}".to_string(),
                TerminalInputSource::System {
                    operation_id: Some(operation_id),
                },
            );
        }
        self.leases.release(
            session_id,
            &registration.agent_session_id,
            &registration.task_id,
            operation_id,
            TerminalLeaseReleaseReason::TakenOver,
        )?;
        Ok(true)
    }

    pub(crate) fn terminal_closed(&self, session_id: &str) -> Result<bool, String> {
        let registration = self
            .operations
            .lock()
            .ok()
            .and_then(|operations| operations.get(session_id).cloned());
        let Some(registration) = registration else {
            return Ok(false);
        };
        registration.operation.mark_uncertain()?;
        self.finish_registration(
            session_id,
            &registration.agent_session_id,
            &registration.task_id,
            &registration.operation_id,
            TerminalLeaseReleaseReason::TerminalClosed,
        )?;
        Ok(true)
    }

    pub(crate) fn shutdown_all(&self, sessions: &SessionManager) -> Result<usize, String> {
        self.request_where(
            sessions,
            TerminalCommandRequestedSettlement::Cancelled,
            |_| true,
        )
    }

    fn request_where(
        &self,
        sessions: &SessionManager,
        requested: TerminalCommandRequestedSettlement,
        predicate: impl Fn(&TerminalExecuteRegistration) -> bool,
    ) -> Result<usize, String> {
        let registrations = self
            .operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE".to_string())?
            .iter()
            .filter(|(_, registration)| predicate(registration))
            .map(|(session_id, registration)| (session_id.clone(), registration.clone()))
            .collect::<Vec<_>>();
        let mut requested_count = 0;
        for (session_id, registration) in registrations {
            let send = registration.operation.request_settlement(requested)?;
            if send {
                let _ = self.leases.write(
                    sessions,
                    &session_id,
                    "\u{3}".to_string(),
                    TerminalInputSource::System {
                        operation_id: Some(&registration.operation_id),
                    },
                );
                requested_count += 1;
            }
        }
        Ok(requested_count)
    }

    fn registration(
        &self,
        session_id: &str,
        operation_id: &str,
    ) -> Result<TerminalExecuteRegistration, String> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE".to_string())?;
        let registration = operations
            .get(session_id)
            .ok_or_else(|| TerminalLeaseError::AlreadyTerminal.to_string())?;
        if registration.operation_id != operation_id {
            return Err(TerminalLeaseError::OperationMismatch.to_string());
        }
        Ok(registration.clone())
    }

    fn finish_registration(
        &self,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        reason: TerminalLeaseReleaseReason,
    ) -> Result<(), String> {
        let command_id = self
            .operations
            .lock()
            .ok()
            .and_then(|operations| operations.get(session_id).cloned())
            .filter(|registration| registration.operation_id == operation_id)
            .and_then(|registration| registration.operation.command_id().ok());
        if let Some(command_id) = command_id {
            let _ = self.broker.retire_command(session_id, &command_id);
        }
        self.operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE".to_string())?
            .remove(session_id);
        let _ = self
            .leases
            .release(session_id, agent_session_id, task_id, operation_id, reason);
        Ok(())
    }
}

fn release_reason(state: TerminalCommandState) -> TerminalLeaseReleaseReason {
    match state {
        TerminalCommandState::Completed => TerminalLeaseReleaseReason::Completed,
        TerminalCommandState::Cancelled => TerminalLeaseReleaseReason::Cancelled,
        TerminalCommandState::TimedOut => TerminalLeaseReleaseReason::TimedOut,
        TerminalCommandState::TakenOver => TerminalLeaseReleaseReason::TakenOver,
        TerminalCommandState::Submitted
        | TerminalCommandState::Running
        | TerminalCommandState::CancelRequested
        | TerminalCommandState::Uncertain
        | TerminalCommandState::Failed => TerminalLeaseReleaseReason::Failed,
    }
}

#[cfg(test)]
mod tests {
    include!("../tests/native/terminal_execute.rs");
}
