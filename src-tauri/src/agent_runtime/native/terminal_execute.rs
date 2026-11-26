use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::agent_runtime::validate_visible_command_input;
use crate::models::{SessionManager, SessionStatus};
use crate::remote_sandbox::VisibleTerminalDispatch;
use crate::terminal_broker::{
    TerminalCommandOperation, TerminalCommandRequestedSettlement, TerminalCommandSnapshot,
    TerminalCommandState, TerminalSessionBroker,
};
use crate::terminal_integration::TerminalShellKind;

use super::{
    TerminalCommandPhase, TerminalInputSource, TerminalLeaseError, TerminalLeaseManager,
    TerminalLeaseReleaseReason,
};

const FRONTEND_READY_TIMEOUT: Duration = Duration::from_secs(5);
const INTERRUPT_SETTLEMENT_TIMEOUT: Duration = Duration::from_secs(2);
const CAPTURE_DRAIN_GRACE: Duration = Duration::from_millis(25);
const WAIT_SLICE: Duration = Duration::from_millis(50);
pub(super) const TYPING_SUBMIT_PAUSE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalExecuteValidationStage {
    LeaseAcquisition,
    CommandCreation,
    InputWrite,
}

#[derive(Debug)]
pub(crate) struct TerminalSubmissionError {
    pub(crate) message: String,
    /// Set before attempting the executable write, since a failed transport
    /// write can still have delivered that input. Editor/probe writes do not
    /// cross this boundary.
    pub(crate) submission_attempted: bool,
}

#[derive(Clone)]
struct TerminalExecuteRegistration {
    native: Arc<Mutex<crate::terminal_broker::NativeInputCoordinator>>,
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

struct TerminalStartGuard {
    registry: TerminalExecuteRegistry,
    operation: Arc<TerminalCommandOperation>,
    session_id: String,
    agent_session_id: String,
    task_id: String,
    operation_id: String,
    armed: bool,
}
impl Drop for TerminalStartGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let changed = self.operation.fail_before_input().unwrap_or(false);
        let state = self
            .operation
            .snapshot()
            .map(|snapshot| snapshot.state)
            .unwrap_or(TerminalCommandState::Uncertain);
        if changed && state == TerminalCommandState::Uncertain {
            let _ = self
                .registry
                .broker
                .require_native_input_recovery(&self.session_id, &self.operation_id);
        }
        let _ = self.registry.finish_registration(
            &self.session_id,
            &self.agent_session_id,
            &self.task_id,
            &self.operation_id,
            release_reason(state),
        );
    }
}

struct TerminalWaitGuard<'a> {
    registry: &'a TerminalExecuteRegistry,
    session_id: &'a str,
    operation: &'a Arc<TerminalCommandOperation>,
    armed: bool,
}

impl Drop for TerminalWaitGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let registration = self.registry.operations.lock().ok().and_then(|operations| {
            operations
                .get(self.session_id)
                .filter(|registration| Arc::ptr_eq(&registration.operation, self.operation))
                .cloned()
        });
        if let Some(registration) = registration {
            let _ = self.registry.finish_registration(
                self.session_id,
                &registration.agent_session_id,
                &registration.task_id,
                &registration.operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
        }
    }
}

impl TerminalExecuteRegistry {
    #[allow(clippy::too_many_arguments)]
    fn start_native_inline(
        &self,
        sessions: &SessionManager,
        session: &str,
        agent: &str,
        operation_id: &str,
        operation: &Arc<TerminalCommandOperation>,
        coordinator: &Arc<Mutex<crate::terminal_broker::NativeInputCoordinator>>,
        deadline: Option<Instant>,
        reduced: bool,
        job_input: Option<(&str, &str)>,
        dispatch_policy: Option<&VisibleTerminalDispatch<'_>>,
        revalidate: &mut impl FnMut(TerminalExecuteValidationStage) -> Result<(), String>,
    ) -> Result<(), String> {
        let limit = deadline
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(5))
            .min(Instant::now() + Duration::from_secs(5));
        let check =
            |revalidate: &mut dyn FnMut(TerminalExecuteValidationStage) -> Result<(), String>| {
                revalidate(TerminalExecuteValidationStage::InputWrite)?;
                if let Some((source, line)) = job_input {
                    self.broker
                        .validate_shell_job_input(session, operation_id, source, line)?;
                }
                if Instant::now() >= limit {
                    return Err("TERMINAL_NATIVE_DEADLINE_EXPIRED".into());
                }
                let snapshot = operation.snapshot()?;
                if snapshot.phase.is_terminal() {
                    return Err(snapshot
                        .input_rejection
                        .unwrap_or_else(|| "TERMINAL_COMMAND_STOPPED_BEFORE_SUBMISSION".into()));
                }
                Ok(())
            };
        let submit = |coordinator: &crate::terminal_broker::NativeInputCoordinator,
                      revalidate: &mut dyn FnMut(
            TerminalExecuteValidationStage,
        ) -> Result<(), String>| {
            let mut send = || {
                coordinator.submit(
                    || check(revalidate),
                    |key| sessions.write_session_bytes(session, key.to_vec()),
                )
            };
            // Refuse a stale policy before the broker marks submission attempted.
            // Policy saves and the executable enqueue share the database lock.
            match dispatch_policy {
                Some(policy) => policy.write(send),
                None => send(),
            }
        };
        check(revalidate)?;
        self.leases.publish_command_phase(
            session,
            agent,
            operation_id,
            TerminalCommandPhase::Typing,
        )?;
        coordinator
            .lock()
            .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?
            .prepare(
                limit.saturating_duration_since(Instant::now()),
                reduced,
                |bytes| sessions.write_native_control(session, bytes, true),
            )?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref() == Ok("prepare") {
            let current = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
            crate::terminal_command::acceptance_trace::record(
                "prepare-input-enqueued",
                serde_json::json!({"identity":current.identity()?}),
            )?;
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let observe_partial = std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref()
            == Ok("input-in-progress");
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let mut test_incomplete_proof = observe_partial
            && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
                == Ok("incomplete-proof");
        loop {
            check(revalidate)?;
            let snapshot = operation.snapshot()?;
            if snapshot.phase == crate::terminal_command::state::CommandPhase::InputConfirmed {
                break;
            }
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if observe_partial
                && snapshot.phase == crate::terminal_command::state::CommandPhase::Typing
            {
                let mut current = coordinator
                    .lock()
                    .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
                if test_incomplete_proof
                    && operation.snapshot()?.phase
                        == crate::terminal_command::state::CommandPhase::Typing
                {
                    test_incomplete_proof = false;
                    let arm = current
                        .arm_commit(|bytes| sessions.write_native_control(session, bytes, false));
                    let submit = submit(&current, revalidate);
                    crate::terminal_command::acceptance_trace::record(
                        "incomplete-proof-attempt-returned",
                        serde_json::json!({
                            "identity":current.identity()?,
                            "phaseBefore":snapshot.phase,
                            "phaseAfter":operation.snapshot()?.phase,
                            "armAccepted":arm.is_ok(),
                            "armError":arm.err(),
                            "submitAccepted":submit.is_ok(),
                            "submitError":submit.err()
                        }),
                    )?;
                }
                let query = current.query()?;
                drop(current);
                sessions.write_native_control(session, &query, false)?;
            }
            operation.wait_until_terminal(
                WAIT_SLICE.min(limit.saturating_duration_since(Instant::now())),
            )?;
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref() == Ok("input-complete") {
            let current = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
            crate::terminal_command::acceptance_trace::record(
                "input-complete-observed",
                serde_json::json!({"identity":current.identity()?}),
            )?;
        }
        check(revalidate)?;
        coordinator
            .lock()
            .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?
            .persist_submission_intent()?;
        // Revalidate the original approval, role, frozen target, capability and
        // deadline after durable I/O, then again at the sole final admission.
        check(revalidate)?;
        coordinator
            .lock()
            .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?
            .arm_commit(|bytes| sessions.write_native_control(session, bytes, false))?;
        loop {
            check(revalidate)?;
            if coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?
                .commit_armed()?
            {
                break;
            }
            operation.wait_until_terminal(
                WAIT_SLICE.min(limit.saturating_duration_since(Instant::now())),
            )?;
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref() == Ok("armed") {
            let current = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
            crate::terminal_command::acceptance_trace::record(
                "armed-observed",
                serde_json::json!({"identity":current.identity()?}),
            )?;
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if crate::terminal_command::acceptance_trace::repeat_commit_enabled()? {
            let mut current = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
            let identity = current.identity()?;
            let repeated =
                current.arm_commit(|bytes| sessions.write_native_control(session, bytes, false));
            crate::terminal_command::acceptance_trace::record(
                "duplicate-arm-returned",
                serde_json::json!({"identity":identity,"admitted":repeated.is_ok(),"error":repeated.err()}),
            )?;
        }
        // The SSH worker must be free to close its coordinator while the
        // before-key barrier is held. submit() still rechecks every gate.
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if crate::terminal_command::acceptance_trace::ssh_recovery_enabled()
            && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref()
                == Ok("before-accept")
        {
            let identity = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?
                .identity()?;
            crate::terminal_command::acceptance_trace::record(
                "before-accept-observed",
                serde_json::json!({"identity":identity}),
            )?;
        }
        {
            let current = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
            submit(&current, revalidate)?;
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if crate::terminal_command::acceptance_trace::repeat_commit_enabled()? {
            let current = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
            let identity = current.identity()?;
            let repeated = submit(&current, revalidate);
            crate::terminal_command::acceptance_trace::record(
                "duplicate-submit-returned",
                serde_json::json!({"identity":identity,"admitted":repeated.is_ok(),"error":repeated.err()}),
            )?;
        }
        Ok(())
    }

    fn stop_native(
        &self,
        sessions: &SessionManager,
        session: &str,
        registration: &TerminalExecuteRegistration,
        reason: TerminalCommandRequestedSettlement,
    ) -> Result<(), String> {
        let coordinator = &registration.native;
        let stop_deadline = {
            let mut coordinator = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
            if registration.operation.handed_off()? {
                return Ok(());
            }
            if registration.operation.submission_may_have_occurred()? {
                let stop_deadline = Instant::now() + INTERRUPT_SETTLEMENT_TIMEOUT;
                coordinator.interrupt(reason, stop_deadline, || {
                    sessions.write_session_input(session, "\x03".into())
                })?;
                Some(stop_deadline)
            } else {
                coordinator.cancel_draft_for(reason, |bytes| {
                    // Arming ends the editor's polling widget. A later cancel
                    // needs its non-executable service wake to observe/clear
                    // the owned draft and produce the real acknowledgement.
                    sessions.write_native_control(session, bytes, true)
                })?;
                None
            }
        };
        let snapshot = if let Some(stop_deadline) = stop_deadline {
            loop {
                coordinator
                    .lock()
                    .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?
                    .interrupt_after_started(|| {
                        sessions.write_session_input(session, "\x03".into())
                    })?;
                let snapshot = registration.operation.wait_until_terminal(
                    WAIT_SLICE.min(stop_deadline.saturating_duration_since(Instant::now())),
                )?;
                if snapshot.phase.is_terminal() || Instant::now() >= stop_deadline {
                    break snapshot;
                }
            }
        } else {
            registration
                .operation
                .wait_until_terminal(INTERRUPT_SETTLEMENT_TIMEOUT)?
        };
        if !snapshot.phase.is_terminal() {
            self.broker
                .require_native_input_recovery(session, &registration.operation_id)?;
            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native stop was not confirmed; no automatic replay".into());
        }
        Ok(())
    }
    pub(crate) fn receive_native(
        &self,
        session: &str,
        message: crate::terminal_command::protocol::Envelope,
    ) -> Result<(), String> {
        let registration = self
            .operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE")?
            .get(session)
            .filter(|entry| entry.operation_id == message.identity.operation_id)
            .cloned();
        // Complete envelopes for retired/older operations are observations to
        // reject, never a reason to close a successor's private connection.
        let Some(registration) = registration else {
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if crate::terminal_command::acceptance_trace::observe_arm_binding(&message) {
                crate::terminal_command::acceptance_trace::record(
                    "arm-binding-no-current-operation",
                    serde_json::json!({"identity":message.identity,"requestId":message.request_id,"transport":session}),
                )?;
            }
            return Ok(());
        };
        let coordinator = &registration.native;
        let (result, phase_changed) = {
            let mut coordinator = coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
            let before = coordinator.operation.snapshot()?.phase;
            let result = coordinator.receive_envelope(message);
            let after = coordinator.operation.snapshot()?.phase;
            (
                result,
                before != after
                    && matches!(
                        after,
                        crate::terminal_command::state::CommandPhase::Preparing
                            | crate::terminal_command::state::CommandPhase::Typing
                            | crate::terminal_command::state::CommandPhase::InputConfirmed
                            | crate::terminal_command::state::CommandPhase::SubmissionAttempted
                            | crate::terminal_command::state::CommandPhase::Running
                    ),
            )
        };
        if result.is_ok() && phase_changed {
            // Keep the existing lease activity contract for delegated and
            // interactive consumers. publish_command_phase derives the phase
            // from this same Broker operation; it grants no new input rights.
            let published = self.leases.publish_command_phase(
                session,
                &registration.agent_session_id,
                &registration.operation_id,
                TerminalCommandPhase::Running,
            );
            if let Err(error) = published {
                // A concurrent stop may already have removed/replaced this
                // lease. A stale view notification cannot fail its successor's
                // private transport or acquire another operation's ownership.
                if ![
                    TerminalLeaseError::NotFound.to_string(),
                    TerminalLeaseError::OwnerMismatch.to_string(),
                    TerminalLeaseError::OperationMismatch.to_string(),
                ]
                .contains(&error)
                {
                    return Err(error);
                }
            }
        }
        if result.is_ok() {
            let _ = self.retire_foreground_handoff(session);
        }
        match result {
            Err(error)
                if error == "TERMINAL_NATIVE_IDENTITY_MISMATCH"
                    || error == "TERMINAL_NATIVE_REQUEST_MISMATCH"
                    || error.contains("STALE_GENERATION")
                    || error.contains("STALE_LEASE") =>
            {
                Ok(())
            }
            result => result,
        }
    }
    pub(crate) fn native_control_closed(&self, session: &str) -> Result<(), String> {
        let coordinator = self
            .operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE")?
            .get(session)
            .map(|entry| entry.native.clone());
        if let Some(coordinator) = coordinator {
            coordinator
                .lock()
                .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?
                .control_closed()?;
        }
        let _ = self.retire_foreground_handoff(session);
        Ok(())
    }

    pub(crate) fn retire_foreground_handoff(&self, session: &str) -> Result<(), String> {
        let registration = self
            .operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE")?
            .get(session)
            .cloned();
        if let Some(registration) = registration {
            if registration.operation.handed_off_and_ready()? {
                let _ = self.broker.settle_submission(&registration.operation);
                self.finish_registration(
                    session,
                    &registration.agent_session_id,
                    &registration.task_id,
                    &registration.operation_id,
                    TerminalLeaseReleaseReason::Completed,
                )?;
            } else if registration.operation.retained_and_settled()? {
                let _ = self.broker.settle_submission(&registration.operation);
                let reason = registration
                    .operation
                    .snapshot()
                    .map(|snapshot| release_reason(snapshot.state))
                    .unwrap_or(TerminalLeaseReleaseReason::Failed);
                self.finish_registration(
                    session,
                    &registration.agent_session_id,
                    &registration.task_id,
                    &registration.operation_id,
                    reason,
                )?;
            }
        }
        Ok(())
    }
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

    #[cfg(test)]
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
        self.start_with_revalidation(
            sessions,
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            command,
            enter,
            |_| Ok(()),
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_with_revalidation(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        command: &str,
        enter: &str,
        mut revalidate: impl FnMut(TerminalExecuteValidationStage) -> Result<(), String>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.start_native_submission(
            sessions,
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            command,
            enter,
            None,
            &mut revalidate,
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_native_submission(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        command: &str,
        enter: &str,
        job_submission: Option<&str>,
        mut revalidate: impl FnMut(TerminalExecuteValidationStage) -> Result<(), String>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.start_native_submission_until(
            sessions,
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            command,
            enter,
            job_submission,
            None,
            &mut revalidate,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_native_submission_until(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        command: &str,
        enter: &str,
        job_submission: Option<&str>,
        deadline: Option<Instant>,
        mut revalidate: impl FnMut(TerminalExecuteValidationStage) -> Result<(), String>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.start_native_submission_outcome_until(
            sessions,
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            command,
            enter,
            job_submission,
            deadline,
            None,
            false,
            None,
            &mut revalidate,
        )
        .map_err(|error| error.message)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_native_submission_outcome_until(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        command: &str,
        enter: &str,
        job_submission: Option<&str>,
        deadline: Option<Instant>,
        authorization: Option<crate::terminal_command::state::IntentAuthorization>,
        handoff_to_user: bool,
        dispatch_policy: Option<&VisibleTerminalDispatch<'_>>,
        revalidate: impl FnMut(TerminalExecuteValidationStage) -> Result<(), String>,
    ) -> Result<Arc<TerminalCommandOperation>, TerminalSubmissionError> {
        let mut submission_attempted = false;
        self.start_native_submission_inner(
            sessions,
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            command,
            enter,
            job_submission,
            deadline,
            authorization,
            handoff_to_user,
            dispatch_policy,
            revalidate,
            &mut submission_attempted,
        )
        .map_err(|message| TerminalSubmissionError {
            message,
            submission_attempted,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn start_native_submission_inner(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        command: &str,
        _enter: &str,
        job_submission: Option<&str>,
        deadline: Option<Instant>,
        authorization: Option<crate::terminal_command::state::IntentAuthorization>,
        handoff_to_user: bool,
        dispatch_policy: Option<&VisibleTerminalDispatch<'_>>,
        mut revalidate: impl FnMut(TerminalExecuteValidationStage) -> Result<(), String>,
        submission_attempted: &mut bool,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        // Keep the transport boundary consistent with terminal_execute policy.
        // Reject unsupported input before acquiring a lease or touching the PTY.
        validate_visible_command_input(command)?;
        if let Err(error) =
            self.broker
                .check_submission_replay(agent_session_id, task_id, operation_id)
        {
            // A prior durable intent (or an unreadable recovery boundary) is
            // historical uncertainty. No new draft, lease or PTY input is made.
            *submission_attempted = true;
            return Err(error);
        }
        let native_inline =
            self.broker
                .snapshot(Some(session_id))?
                .session
                .is_some_and(|session| {
                    session.input_mode == crate::terminal_command::protocol::InputMode::NativeInline
                });
        if self
            .broker
            .execution_capabilities(session_id)?
            .input_recovery_required
        {
            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: terminal input is quarantined; reconnect before further input; no automatic replay".into());
        }
        let private_job_control = job_submission.is_some_and(|line| line == command);
        if !native_inline {
            return Err("TERMINAL_NATIVE_INPUT_REQUIRED: this terminal generation cannot accept new Agent commands; no input was sent".into());
        }
        let shell = self.broker.command_shell(session_id)?;
        let powershell = matches!(
            shell,
            TerminalShellKind::WindowsPowerShell | TerminalShellKind::PowerShell7
        );
        if !powershell && super::command_contains_background_operator_native(command) {
            return Err("TERMINAL_BACKGROUND_UNSUPPORTED: submit foreground source with background=true; remove shell background operators (&), nohup and manual detachment; no command was executed".into());
        }
        if !powershell && super::shell_policy::has_incomplete_heredoc(command) {
            return Err("TERMINAL_INPUT_UNSUPPORTED: heredoc has no explicit grammar end node; no input was sent".into());
        }
        if shell == TerminalShellKind::Zsh
            && (job_submission.is_some()
                || command.len() > 512
                || command.contains(['\n', '\r', '\t']))
            && !self.broker.native_comments_enabled(session_id)?
            && super::shell_policy::contains_shell_comment(command)
        {
            return Err("TERMINAL_INPUT_UNSUPPORTED: current Zsh has INTERACTIVE_COMMENTS disabled; comment scripts require that native option to be enabled explicitly; no input was sent".into());
        }
        let submission = Some({
            if let Some(line) = job_submission {
                self.broker
                    .native_job_plan(session_id, operation_id, command, line)?
            } else {
                crate::terminal_command::protocol::native_foreground_plan(
                    command,
                    crate::terminal_command::registration::shell_family(shell)?,
                )
                .map_err(|_| "TERMINAL_NATIVE_PLAN_INVALID")?
            }
        });
        revalidate(TerminalExecuteValidationStage::LeaseAcquisition)?;
        self.leases.acquire_command(
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            (!private_job_control).then_some(command),
            None,
        )?;
        let operation = match self.broker.begin_waiting_command_with_context(
            session_id,
            operation_id,
            command,
            submission.as_deref(),
            authorization,
            handoff_to_user,
            agent_session_id,
            task_id,
        ) {
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
        let native_coordinator = match self
            .broker
            .native_input_coordinator(session_id, operation_id)
            .and_then(|coordinator| {
                operation.require_complete_input_proof()?;
                Ok(coordinator)
            }) {
            Ok(coordinator) => Arc::new(Mutex::new(coordinator)),
            Err(error) => {
                if let Ok(command_id) = operation.command_id() {
                    let _ = self.broker.mark_command_uncertain(session_id, &command_id);
                    let _ = self.broker.retire_command(session_id, &command_id);
                }
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
        let registration = TerminalExecuteRegistration {
            native: native_coordinator.clone(),
            agent_session_id: agent_session_id.to_string(),
            task_id: task_id.to_string(),
            operation_id: operation_id.to_string(),
            operation: Arc::clone(&operation),
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
            operations.insert(session_id.to_string(), registration.clone());
        }
        let mut pending_registration = TerminalStartGuard {
            registry: self.clone(),
            operation: Arc::clone(&operation),
            session_id: session_id.into(),
            agent_session_id: agent_session_id.into(),
            task_id: task_id.into(),
            operation_id: operation_id.into(),
            armed: true,
        };
        let ready_deadline = deadline
            .unwrap_or_else(|| Instant::now() + FRONTEND_READY_TIMEOUT)
            .min(Instant::now() + FRONTEND_READY_TIMEOUT);
        let ready_result = loop {
            if operation.snapshot()?.phase.is_terminal() {
                break Err("TERMINAL_COMMAND_STOPPED_BEFORE_READY".into());
            }
            let result = self.leases.wait_frontend_ready(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                WAIT_SLICE.min(ready_deadline.saturating_duration_since(Instant::now())),
            );
            if result
                .as_ref()
                .is_err_and(|error| error.starts_with("TERMINAL_FRONTEND_READY_TIMEOUT"))
                && Instant::now() < ready_deadline
            {
                if let Err(error) = revalidate(TerminalExecuteValidationStage::CommandCreation) {
                    break Err(error);
                }
                continue;
            }
            break result;
        };
        ready_result?;
        let terminal_connected = match sessions.target_state(session_id) {
            Ok(state) => state.status == SessionStatus::Connected,
            Err(error) => {
                return Err(error);
            }
        };
        if !terminal_connected {
            return Err("TERMINAL_EXECUTE_NOT_CONNECTED".into());
        }
        let command_creation = dispatch_policy
            .map_or(Ok(()), |policy| policy.write(|| Ok(())))
            .and_then(|()| revalidate(TerminalExecuteValidationStage::CommandCreation));
        command_creation?;

        self.broker
            .activate_waiting_command(session_id, &operation)?;
        if let Err(error) = revalidate(TerminalExecuteValidationStage::InputWrite) {
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
        let write_result = self.start_native_inline(
            sessions,
            session_id,
            agent_session_id,
            operation_id,
            &operation,
            &native_coordinator,
            deadline,
            self.leases.reduced_motion(session_id, operation_id)?,
            job_submission.map(|line| (command, line)),
            dispatch_policy,
            &mut revalidate,
        );
        *submission_attempted = operation.submission_may_have_occurred()?;
        if let Err(error) = write_result {
            if operation.submission_may_have_occurred()? {
                let _ = native_coordinator
                    .lock()
                    .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?
                    .control_closed();
            } else if !operation.takeover_settled_before_submission()?
                && self
                    .stop_native(
                        sessions,
                        session_id,
                        &registration,
                        TerminalCommandRequestedSettlement::Cancelled,
                    )
                    .is_err()
            {
                let _ = self
                    .broker
                    .require_native_input_recovery(session_id, operation_id);
            }
            // Takeover revokes the lease before the editor replies. Report the
            // exact operation's settlement after clearing its draft, even if
            // revalidation first returned a lease or lifecycle error.
            let taken_over = operation.takeover_settled_before_submission()?;
            let _ = self.finish_registration(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                if taken_over {
                    TerminalLeaseReleaseReason::TakenOver
                } else {
                    TerminalLeaseReleaseReason::Failed
                },
            );
            if taken_over {
                return Err(if job_submission.is_some() {
                    "TERMINAL_JOB_LAUNCH_CANCELLED"
                } else {
                    "TERMINAL_SUBMISSION_CANCELLED"
                }
                .into());
            }
            return Err(error);
        }
        pending_registration.armed = false;
        Ok(operation)
    }

    pub(crate) fn wait(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation: &Arc<TerminalCommandOperation>,
        timeout: Duration,
    ) -> Result<TerminalCommandSnapshot, String> {
        self.wait_bounded(sessions, session_id, operation, timeout, false, None)
    }

    pub(crate) fn wait_with_progress(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation: &Arc<TerminalCommandOperation>,
        timeout: Duration,
        on_progress: &mut dyn FnMut(&TerminalCommandSnapshot),
    ) -> Result<TerminalCommandSnapshot, String> {
        self.wait_bounded(
            sessions,
            session_id,
            operation,
            timeout,
            false,
            Some(on_progress),
        )
    }

    pub(crate) fn wait_management(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation: &Arc<TerminalCommandOperation>,
        timeout: Duration,
    ) -> Result<TerminalCommandSnapshot, String> {
        self.wait_bounded(sessions, session_id, operation, timeout, true, None)
    }

    pub(crate) fn wait_foreground_handoff_with_progress(
        &self,
        sessions: &SessionManager,
        session: &str,
        operation: &Arc<TerminalCommandOperation>,
        timeout: Duration,
        cancelled: impl Fn() -> bool,
        mut on_progress: Option<&mut dyn FnMut(&TerminalCommandSnapshot)>,
    ) -> Result<(TerminalCommandSnapshot, bool), String> {
        let mut guard = TerminalWaitGuard {
            registry: self,
            session_id: session,
            operation,
            armed: true,
        };
        let deadline = Instant::now() + timeout;
        let mut last_revision = 0u64;
        loop {
            let snapshot = operation.snapshot()?;
            if snapshot.phase.is_terminal()
                || snapshot.state == TerminalCommandState::CancelRequested
                || cancelled()
                || Instant::now() >= deadline
            {
                break;
            }
            if snapshot.revision != last_revision {
                last_revision = snapshot.revision;
                if let Some(callback) = on_progress.as_deref_mut() {
                    callback(&snapshot);
                }
            }
            if snapshot.state == TerminalCommandState::Running {
                // Serialize giving away input with the old owner's scoped stop.
                if let Ok(registration) = self.registration(session, &snapshot.operation_id) {
                    let _coordinator = registration
                        .native
                        .lock()
                        .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
                    if !cancelled() {
                        if let Some(snapshot) = self.leases.release_for_foreground_handoff(
                            session,
                            &registration.agent_session_id,
                            &registration.task_id,
                            &registration.operation_id,
                            operation,
                        )? {
                            guard.armed = false;
                            return Ok((snapshot, true));
                        }
                    }
                }
            }
            operation.wait_until_terminal(
                WAIT_SLICE.min(deadline.saturating_duration_since(Instant::now())),
            )?;
        }
        let wait = if cancelled() {
            INTERRUPT_SETTLEMENT_TIMEOUT
        } else {
            Duration::ZERO
        };
        guard.armed = false;
        self.wait_bounded(sessions, session, operation, wait, false, on_progress)
            .map(|snapshot| (snapshot, false))
    }

    fn wait_bounded(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation: &Arc<TerminalCommandOperation>,
        timeout: Duration,
        hard_deadline: bool,
        mut on_progress: Option<&mut dyn FnMut(&TerminalCommandSnapshot)>,
    ) -> Result<TerminalCommandSnapshot, String> {
        let mut guard = TerminalWaitGuard {
            registry: self,
            session_id,
            operation,
            armed: true,
        };
        let deadline = Instant::now() + timeout;
        let mut interrupt_deadline = None;
        let mut capture_drain_deadline = None;
        let mut last_revision = 0u64;
        loop {
            let slice = if hard_deadline {
                WAIT_SLICE.min(deadline.saturating_duration_since(Instant::now()))
            } else {
                WAIT_SLICE
            };
            let snapshot = operation.wait_until_terminal(slice)?;
            if snapshot.phase.is_terminal() && operation.native_capture_complete()? {
                break;
            }
            if !snapshot.phase.is_terminal() && snapshot.revision != last_revision {
                last_revision = snapshot.revision;
                if let Some(callback) = on_progress.as_deref_mut() {
                    callback(&snapshot);
                }
            }
            if snapshot.phase.is_terminal() {
                let drain_until = *capture_drain_deadline
                    .get_or_insert_with(|| Instant::now() + INTERRUPT_SETTLEMENT_TIMEOUT);
                let remaining = drain_until.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                operation.wait_native_capture(slice.min(remaining))?;
                continue;
            }
            if snapshot.state == TerminalCommandState::CancelRequested
                && interrupt_deadline.is_none()
            {
                interrupt_deadline = Some(Instant::now() + INTERRUPT_SETTLEMENT_TIMEOUT);
            }
            if interrupt_deadline.is_some() && operation.is_native_protocol()? {
                let coordinator = self.operations.lock().ok().and_then(|operations| {
                    operations
                        .get(session_id)
                        .filter(|entry| Arc::ptr_eq(&entry.operation, operation))
                        .map(|entry| entry.native.clone())
                });
                if let Some(coordinator) = coordinator {
                    if let Ok(mut coordinator) = coordinator.lock() {
                        let _ = coordinator.interrupt_after_started(|| {
                            sessions.write_session_input(session_id, "\u{3}".to_string())
                        });
                    }
                }
            }
            if interrupt_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                let _ = self
                    .broker
                    .mark_command_uncertain(session_id, &snapshot.command_id);
                break;
            }
            if Instant::now() >= deadline && interrupt_deadline.is_none() {
                let stop_deadline = Instant::now() + INTERRUPT_SETTLEMENT_TIMEOUT;
                let routed_native = if operation.is_native_protocol()? {
                    let coordinator = self.operations.lock().ok().and_then(|operations| {
                        operations
                            .get(session_id)
                            .filter(|entry| Arc::ptr_eq(&entry.operation, operation))
                            .map(|entry| entry.native.clone())
                    });
                    if let Some(coordinator) = coordinator {
                        let mut coordinator = coordinator
                            .lock()
                            .map_err(|_| "TERMINAL_NATIVE_COORDINATOR_UNAVAILABLE")?;
                        if !operation.handed_off()? {
                            if operation.submission_may_have_occurred()? {
                                let _ = coordinator.interrupt(
                                    TerminalCommandRequestedSettlement::TimedOut,
                                    stop_deadline,
                                    || {
                                        sessions
                                            .write_session_input(session_id, "\u{3}".to_string())
                                    },
                                );
                            } else {
                                let _ = coordinator.cancel_draft_for(
                                    TerminalCommandRequestedSettlement::TimedOut,
                                    |bytes| sessions.write_native_control(session_id, bytes, true),
                                );
                            }
                        }
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if !routed_native {
                    let send = operation
                        .request_settlement(TerminalCommandRequestedSettlement::TimedOut)?;
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
                }
                interrupt_deadline = Some(stop_deadline);
            }
            if hard_deadline && Instant::now() >= deadline {
                let _ = self
                    .broker
                    .mark_command_uncertain(session_id, &snapshot.command_id);
                break;
            }
        }

        if !hard_deadline && !operation.is_native_protocol()? {
            std::thread::sleep(CAPTURE_DRAIN_GRACE);
        }
        let mut snapshot = operation.snapshot_for_result()?;
        if operation.native_observation_pending()? {
            // Unknown is a completed wait, not a completed operation. Keep its
            // capture fence, coordinator and revoking lease for late receipts.
            let _ = operation.mark_retained_for_late_receipts();
            guard.armed = false;
            return Ok(snapshot);
        }
        self.broker.settle_submission(operation)?;
        let through_sequence = self
            .broker
            .snapshot(Some(session_id))?
            .session
            .filter(|session| {
                session.terminal_session_id == snapshot.terminal_session_id
                    && session.terminal_generation == snapshot.terminal_generation
            })
            .map(|session| session.next_output_sequence.saturating_sub(1))
            .unwrap_or(snapshot.capture_end_sequence.unwrap_or(0));
        operation.finalize_capture(through_sequence)?;
        snapshot = operation.snapshot_for_result()?;
        let reason = release_reason(snapshot.state);
        // Closing a terminal may already have retired this registration. The
        // operation still owns its final result, even if a new command exists.
        let registration = self
            .operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE".to_string())?
            .get(session_id)
            .filter(|registration| Arc::ptr_eq(&registration.operation, operation))
            .cloned();
        if let Some(registration) = registration {
            let _ = self.finish_registration(
                session_id,
                &registration.agent_session_id,
                &registration.task_id,
                &snapshot.operation_id,
                reason,
            );
        }
        guard.armed = false;
        if hard_deadline && snapshot.state == TerminalCommandState::Completed {
            self.broker.wait_command_prompt(
                operation,
                deadline.saturating_duration_since(Instant::now()),
            )?;
        }
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
        let lease =
            self.leases
                .validate_control_owner(session_id, agent_session_id, operation_id)?;
        let registration = self.registration(session_id, operation_id)?;
        if registration.agent_session_id != lease.agent_session_id
            || registration.task_id != lease.task_id
        {
            return Err(TerminalLeaseError::OwnerMismatch.to_string());
        }
        registration.operation.fence_takeover()?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        crate::terminal_command::acceptance_trace::record(
            "takeover-runtime-entered",
            serde_json::json!({"agentSessionId":agent_session_id,"operationId":operation_id,"transportSessionId":session_id,"commandId":registration.operation.command_id()?}),
        )?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        crate::terminal_command::acceptance_trace::control_request(
            agent_session_id,
            Some(operation_id),
            "takeover-owner-validated",
        )?;
        let result = self.stop_native(
            sessions,
            session_id,
            &registration,
            TerminalCommandRequestedSettlement::TakenOver,
        );
        self.leases.release_after_takeover(
            session_id,
            &registration.agent_session_id,
            &registration.task_id,
            operation_id,
        )?;
        result?;
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

    pub(crate) fn cleanup_shell_jobs(
        &self,
        sessions: &SessionManager,
        task: Option<&str>,
    ) -> Result<usize, String> {
        let jobs = self.broker.shell_jobs_for_cleanup(task)?;
        let count = jobs.len();
        let deadline = Instant::now() + Duration::from_secs(5);
        for initial in jobs {
            let mut stop_sent = false;
            loop {
                let job = self.broker.shell_job(
                    &initial.process_handle,
                    &initial.owner_target_id,
                    &initial.agent_session_id,
                    &initial.task_id,
                )?;
                if matches!(job.state.as_str(), "exited" | "rejected")
                    || job.native_active == Some(false)
                {
                    break;
                }
                if job.control_lost || Instant::now() >= deadline {
                    self.broker.record_shell_job_cleanup(&job.process_handle, "task cleanup could not confirm native job termination within the current binding and deadline")?;
                    log::warn!(
                        "Native shell job cleanup uncertain handle={}",
                        job.process_handle
                    );
                    break;
                }
                if job.state == "starting" && job.accepted_command_line.is_none() {
                    self.broker.wait_shell_job_change(
                        &job,
                        WAIT_SLICE.min(deadline.saturating_duration_since(Instant::now())),
                    )?;
                    continue;
                }
                // Never steal the active foreground/launch operation's lease.
                if self.has_operation(&job.transport_session_id)? {
                    std::thread::sleep(
                        WAIT_SLICE.min(deadline.saturating_duration_since(Instant::now())),
                    );
                    continue;
                }
                if self
                    .broker
                    .snapshot(Some(&job.transport_session_id))?
                    .session
                    .is_some_and(|terminal| {
                        !terminal.prompt_ready || terminal.active_command_id.is_some()
                    })
                {
                    self.broker.wait_shell_job_prompt(
                        &job,
                        WAIT_SLICE.min(deadline.saturating_duration_since(Instant::now())),
                    )?;
                    continue;
                }
                let id = format!("job-cleanup-{}", uuid::Uuid::new_v4());
                let source = self
                    .broker
                    .prepare_shell_job_control(&job, &id, !stop_sent)?;
                let started = self.start_native_submission_until(
                    sessions,
                    &job.transport_session_id,
                    &job.agent_session_id,
                    &job.task_id,
                    &id,
                    &source,
                    "\n",
                    Some(&source),
                    Some(deadline),
                    |stage| {
                        if Instant::now() >= deadline {
                            return Err("TERMINAL_JOB_CLEANUP_DEADLINE".into());
                        }
                        let terminal = self
                            .broker
                            .snapshot(Some(&job.transport_session_id))?
                            .session
                            .ok_or("TERMINAL_JOB_STALE_BINDING")?;
                        if terminal.terminal_generation != job.terminal_generation
                            || terminal.terminal_session_id != job.terminal_session_id
                            || !terminal.open
                            || terminal.integration_id != job.integration_id
                        {
                            return Err("TERMINAL_JOB_STALE_BINDING".into());
                        }
                        if stage == TerminalExecuteValidationStage::LeaseAcquisition
                            && (!terminal.prompt_ready || terminal.active_command_id.is_some())
                        {
                            return Err("TERMINAL_VISIBLE_COMMAND_BUSY".into());
                        }
                        if sessions.target_state(&job.transport_session_id)?.status
                            != SessionStatus::Connected
                        {
                            return Err("TERMINAL_EXECUTE_NOT_CONNECTED".into());
                        }
                        Ok(())
                    },
                );
                let failure = match started {
                    Ok(operation) => {
                        let result = self.wait_management(
                            sessions,
                            &job.transport_session_id,
                            &operation,
                            deadline.saturating_duration_since(Instant::now()),
                        )?;
                        let observed = self.broker.shell_job(
                            &job.process_handle,
                            &job.owner_target_id,
                            &job.agent_session_id,
                            &job.task_id,
                        )?;
                        if result.state == TerminalCommandState::Completed
                            && result.exit_code == Some(0)
                            && observed.observation_revision > job.observation_revision
                        {
                            if observed.state == "uncertain" {
                                if observed.native_active != Some(false) {
                                    self.broker.record_shell_job_cleanup(&job.process_handle,"native job observation remained uncertain; source was not replayed")?;
                                }
                                break;
                            }
                            stop_sent |= observed.stop_requested;
                            continue;
                        }
                        format!("management settlement {:?}, exit={:?}; native acknowledgement was not confirmed",result.state,result.exit_code)
                    }
                    Err(error) => {
                        self.broker.discard_shell_job_submission(&id)?;
                        crate::redaction::redact_sensitive_text(&error)
                    }
                };
                self.broker.record_shell_job_cleanup(
                    &job.process_handle,
                    &format!("task cleanup unconfirmed: {failure}"),
                )?;
                log::warn!(
                    "Native shell job cleanup blocked handle={} reason={failure}",
                    job.process_handle
                );
                break;
            }
        }
        Ok(count)
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
        let mut errors = Vec::new();
        for (session_id, registration) in registrations {
            match self.stop_native(sessions, &session_id, &registration, requested) {
                Ok(()) => requested_count += 1,
                Err(error) => errors.push(error),
            }
        }
        if errors.is_empty() {
            Ok(requested_count)
        } else {
            Err(errors.join("; "))
        }
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
        if reason != TerminalLeaseReleaseReason::TerminalClosed {
            let registration = self
                .operations
                .lock()
                .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE".to_string())?
                .get(session_id)
                .filter(|registration| {
                    registration.operation_id == operation_id
                        && registration.agent_session_id == agent_session_id
                        && registration.task_id == task_id
                })
                .cloned();
            if let Some(registration) = registration {
                if registration.operation.native_observation_pending()? {
                    let _ = registration.operation.mark_retained_for_late_receipts();
                    return Ok(());
                }
            }
        }
        self.broker.discard_shell_job_submission(operation_id)?;
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "TERMINAL_EXECUTE_REGISTRY_UNAVAILABLE".to_string())?;
        if !operations.get(session_id).is_some_and(|registration| {
            registration.operation_id == operation_id
                && registration.agent_session_id == agent_session_id
                && registration.task_id == task_id
        }) {
            return Ok(());
        }
        let registration = operations.remove(session_id);
        drop(operations);
        if let Some(command_id) =
            registration.and_then(|registration| registration.operation.command_id().ok())
        {
            let _ = self.broker.retire_command(session_id, &command_id);
        }
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
