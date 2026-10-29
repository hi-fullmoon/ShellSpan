use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use unicode_segmentation::UnicodeSegmentation;

use crate::agent_runtime::validate_visible_command_input;
use crate::models::{SessionManager, SessionStatus};
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
const TYPING_INTERVAL: Duration = Duration::from_millis(35);
const TYPING_MAX_STEPS: usize = 48;
const POWERSHELL_EDITOR_BATCH_BYTES: usize = 8192;
pub(super) const TYPING_SUBMIT_PAUSE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalExecuteValidationStage {
    LeaseAcquisition,
    CommandCreation,
    InputWrite,
}

#[derive(Clone)]
struct TerminalExecuteRegistration {
    native_editor: bool,
    native_clear: bool,
    agent_session_id: String,
    task_id: String,
    operation_id: String,
    operation: Arc<TerminalCommandOperation>,
    // Serializes each enqueue with cancellation. Receiver/clear acknowledgements
    // can be awaited under this gate to prevent a concurrent accept-line.
    submitted: Arc<Mutex<bool>>,
    editor_batch_pending: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(crate) struct TerminalExecuteRegistry {
    operations: Arc<Mutex<HashMap<String, TerminalExecuteRegistration>>>,
    leases: TerminalLeaseManager,
    broker: TerminalSessionBroker,
}

impl TerminalExecuteRegistry {
    #[cfg(all(test, windows))]
    pub(crate) fn native_editor_batches_for_test(
        command: &str,
        shell: TerminalShellKind,
    ) -> Vec<(String, String)> {
        native_editor_chunks(command, shell)
    }

    #[cfg(all(test, windows))]
    pub(crate) fn editor_batch_pending_for_test(
        &self,
        session: &str,
        operation: &str,
    ) -> Result<bool, String> {
        Ok(self
            .registration(session, operation)?
            .editor_batch_pending
            .load(Ordering::Acquire))
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
        // Keep the transport boundary consistent with terminal_execute policy.
        // Reject unsupported input before acquiring a lease or touching the PTY.
        validate_visible_command_input(command)?;
        let shell = self.broker.command_shell(session_id)?;
        if self
            .broker
            .execution_capabilities(session_id)?
            .input_recovery_required
        {
            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: terminal input is quarantined; reconnect before further input; no automatic replay".into());
        }
        let powershell = matches!(
            shell,
            TerminalShellKind::WindowsPowerShell | TerminalShellKind::PowerShell7
        );
        if !powershell && super::command_contains_background_operator_native(command) {
            return Err("TERMINAL_BACKGROUND_UNSUPPORTED: shell background management requires stage three; no command was executed".into());
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
        let native_input = job_submission.is_some()
            || powershell
            || command.len() > 512
            || command.contains(['\n', '\r', '\t'])
            || (matches!(shell, TerminalShellKind::Zsh | TerminalShellKind::Bash)
                && self.broker.has_active_shell_jobs(session_id)?);
        let submission = if let Some(line) = job_submission {
            Some(line.to_string())
        } else if shell == TerminalShellKind::Bash {
            // Programmatic commands are literal shell source, including short
            // lines. Readline history expansion can reject an unquoted `!`
            // before Bash runs any command or prompt lifecycle hooks.
            Some(crate::terminal_integration::bash_native_submission(
                command,
            )?)
        } else {
            None
        };
        let private_job_control = job_submission.is_some_and(|line| line == command);
        let editor_input = if private_job_control {
            ""
        } else {
            submission.as_deref().unwrap_or(command)
        };
        let native_editor_data = native_input.then(|| native_editor_chunks(editor_input, shell));
        let wire_limit = if shell == TerminalShellKind::Bash {
            131_072
        } else {
            65_536
        };
        if native_editor_data.as_ref().is_some_and(|data| {
            data.iter()
                .map(|(wire, _)| wire.len())
                .sum::<usize>()
                .saturating_add(4)
                > wire_limit
        }) {
            return Err(format!("TERMINAL_INPUT_UNSUPPORTED: native editor input exceeds {wire_limit} UTF-8 bytes; no input was sent"));
        }
        if native_input {
            if !self.broker.native_input_enabled(session_id)? {
                return Err("TERMINAL_INPUT_UNSUPPORTED: complete script input requires the native Readline (Bash 4.1+), ZLE or PSReadLine integration; this shell/editor has not advertised that capability; no input was sent".into());
            }
        }
        revalidate(TerminalExecuteValidationStage::LeaseAcquisition)?;
        self.leases.acquire_command(
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            !private_job_control,
        )?;
        let ready_deadline = deadline
            .unwrap_or_else(|| Instant::now() + FRONTEND_READY_TIMEOUT)
            .min(Instant::now() + FRONTEND_READY_TIMEOUT);
        let ready_result = loop {
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
        if let Err(error) = ready_result {
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
        if let Err(error) = revalidate(TerminalExecuteValidationStage::CommandCreation) {
            let _ = self.leases.release(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err(error);
        }

        let operation = match self.broker.begin_command_with_submission(
            session_id,
            operation_id,
            command,
            submission.as_deref(),
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
        let submitted = Arc::new(Mutex::new(false));
        let editor_batch_pending = Arc::new(AtomicBool::new(false));
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
                    native_editor: native_input,
                    native_clear: native_input
                        && matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh),
                    agent_session_id: agent_session_id.to_string(),
                    task_id: task_id.to_string(),
                    operation_id: operation_id.to_string(),
                    operation: Arc::clone(&operation),
                    submitted: Arc::clone(&submitted),
                    editor_batch_pending: Arc::clone(&editor_batch_pending),
                },
            );
        }

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
        let write_result = (|| {
            let reduced_motion = self.leases.reduced_motion(session_id, operation_id)?;
            let bracketed = self
                .broker
                .bracketed_paste_enabled(session_id)
                .unwrap_or(false);
            let input = editor_input;
            let chunks = if native_input {
                vec![command]
            } else {
                typing_chunks(input, reduced_motion)
            };
            let animated = !reduced_motion && chunks.len() > 1;
            if native_input {
                self.leases.publish_command_phase(
                    session_id,
                    agent_session_id,
                    operation_id,
                    TerminalCommandPhase::Typing,
                )?;
                {
                    let _gate = submitted
                        .lock()
                        .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
                    if operation.snapshot()?.state != TerminalCommandState::Submitted {
                        return interrupted_typing_result(operation.snapshot()?.state);
                    }
                    revalidate(TerminalExecuteValidationStage::InputWrite)?;
                    operation.begin_native_read_only_probe()?;
                    self.leases.write(
                        sessions,
                        session_id,
                        "\u{18}\u{1}".into(),
                        TerminalInputSource::Agent {
                            agent_session_id,
                            task_id,
                            operation_id,
                        },
                    )?;
                }
                let initial_timeout = deadline.map_or(FRONTEND_READY_TIMEOUT, |deadline| {
                    FRONTEND_READY_TIMEOUT.min(deadline.saturating_duration_since(Instant::now()))
                });
                let initial_deadline = Instant::now() + initial_timeout;
                loop {
                    let confirmed = operation.wait_native_checkpoint(
                        initial_deadline.saturating_duration_since(Instant::now()),
                    )?;
                    let _gate = submitted
                        .lock()
                        .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
                    let state = operation.snapshot()?.state;
                    if matches!(
                        state,
                        TerminalCommandState::Cancelled | TerminalCommandState::TakenOver
                    ) {
                        return interrupted_typing_result(state);
                    }
                    if confirmed && operation.finish_native_read_only_probe()? {
                        break;
                    }
                    if Instant::now() < initial_deadline {
                        if operation.refresh_native_read_only_probe()? {
                            revalidate(TerminalExecuteValidationStage::InputWrite)?;
                            self.leases.write(
                                sessions,
                                session_id,
                                "\u{18}\u{1}".into(),
                                TerminalInputSource::Agent {
                                    agent_session_id,
                                    task_id,
                                    operation_id,
                                },
                            )?;
                            continue;
                        }
                        if confirmed {
                            // A real P raced the acknowledgement. Wait for Q
                            // and the old probe's A before requesting fresh A.
                            continue;
                        }
                    }
                    return Err("TERMINAL_FRONTEND_PENDING_INPUT: empty native editor was not confirmed; no source was typed and any existing user draft was preserved".into());
                }
                if private_job_control {
                    let confirmation_deadline = deadline
                        .map_or(Instant::now() + FRONTEND_READY_TIMEOUT, |deadline| {
                            deadline.min(Instant::now() + FRONTEND_READY_TIMEOUT)
                        });
                    let private_line =
                        job_submission.expect("private control is a prepared operation");
                    let descriptor;
                    {
                        let _gate = submitted
                            .lock()
                            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
                        if operation.snapshot()?.state != TerminalCommandState::Submitted {
                            return interrupted_typing_result(operation.snapshot()?.state);
                        }
                        descriptor = self
                            .broker
                            .private_shell_job_control_descriptor(
                                session_id,
                                operation_id,
                                command,
                                private_line,
                            )?
                            .ok_or("TERMINAL_PRIVATE_CONTROL_UNAVAILABLE")?;
                        revalidate(TerminalExecuteValidationStage::InputWrite)?;
                        if shell == TerminalShellKind::Zsh {
                            operation.expect_native_checkpoint("")?;
                        } else {
                            operation.expect_native_private_ready()?;
                        }
                        if powershell {
                            editor_batch_pending.store(true, Ordering::Release);
                        }
                        self.leases.write(
                            sessions,
                            session_id,
                            if shell == TerminalShellKind::Zsh {
                                "\u{18}\u{f}"
                            } else {
                                "\u{18}\u{12}"
                            }
                            .into(),
                            TerminalInputSource::Agent {
                                agent_session_id,
                                task_id,
                                operation_id,
                            },
                        )?;
                    }
                    let receiver_timeout =
                        confirmation_deadline.saturating_duration_since(Instant::now());
                    let receiver_ready = if shell == TerminalShellKind::Zsh {
                        operation.wait_native_checkpoint(receiver_timeout)?
                    } else {
                        operation.wait_native_private_ready(receiver_timeout)?
                    };
                    if !receiver_ready {
                        let _gate = submitted
                            .lock()
                            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
                        let state = operation.snapshot()?.state;
                        if matches!(
                            state,
                            TerminalCommandState::Cancelled | TerminalCommandState::TakenOver
                        ) {
                            return interrupted_typing_result(state);
                        }
                        self.broker
                            .require_native_input_recovery(session_id, operation_id)?;
                        return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: private receiver was not ready; no automatic replay".into());
                    }
                    {
                        let _gate = submitted
                            .lock()
                            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
                        if operation.snapshot()?.state != TerminalCommandState::Submitted {
                            return interrupted_typing_result(operation.snapshot()?.state);
                        }
                        revalidate(TerminalExecuteValidationStage::InputWrite)?;
                        self.broker.validate_shell_job_input(
                            session_id,
                            operation_id,
                            command,
                            private_line,
                        )?;
                        operation.expect_native_private_checkpoint(&descriptor)?;
                        let private_wire = if powershell {
                            use base64::Engine;
                            format!(
                                "{}\u{18}\u{6}",
                                base64::engine::general_purpose::STANDARD
                                    .encode(descriptor.as_bytes())
                            )
                        } else {
                            descriptor.clone()
                        };
                        self.leases.write(
                            sessions,
                            session_id,
                            private_wire,
                            TerminalInputSource::Agent {
                                agent_session_id,
                                task_id,
                                operation_id,
                            },
                        )?;
                    }
                    if !operation.wait_native_private_checkpoint(
                        confirmation_deadline.saturating_duration_since(Instant::now()),
                    )? {
                        let _gate = submitted
                            .lock()
                            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
                        let state = operation.snapshot()?.state;
                        if matches!(
                            state,
                            TerminalCommandState::Cancelled | TerminalCommandState::TakenOver
                        ) {
                            return interrupted_typing_result(state);
                        }
                        self.broker
                            .require_native_input_recovery(session_id, operation_id)?;
                        return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: private descriptor was not confirmed; no automatic replay".into());
                    }
                    let mut gate = submitted
                        .lock()
                        .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
                    if operation.snapshot()?.state != TerminalCommandState::Submitted {
                        return interrupted_typing_result(operation.snapshot()?.state);
                    }
                    revalidate(TerminalExecuteValidationStage::InputWrite)?;
                    if Instant::now() >= confirmation_deadline {
                        self.broker
                            .require_native_input_recovery(session_id, operation_id)?;
                        return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: private control deadline elapsed before dispatch; no automatic replay".into());
                    }
                    self.broker.validate_shell_job_input(
                        session_id,
                        operation_id,
                        command,
                        private_line,
                    )?;
                    self.leases.write(
                        sessions,
                        session_id,
                        "\u{18}\u{b}".into(),
                        TerminalInputSource::Agent {
                            agent_session_id,
                            task_id,
                            operation_id,
                        },
                    )?;
                    editor_batch_pending.store(false, Ordering::Release);
                    *gate = true;
                    self.leases.publish_command_phase(
                        session_id,
                        agent_session_id,
                        operation_id,
                        TerminalCommandPhase::Running,
                    )?;
                    return Ok(());
                }
                let native_animation = !reduced_motion
                    && matches!(shell, TerminalShellKind::Zsh | TerminalShellKind::Bash)
                    && self.broker.native_typing_enabled(session_id)?;
                let animated_data;
                let editor_data = if native_animation {
                    animated_data = native_editor_typing_chunks(input, shell);
                    &animated_data
                } else {
                    native_editor_data
                        .as_ref()
                        .expect("native input prepared before lease")
                };
                let mut zsh_frame_deadline = None;
                let mut previous_prefix = String::new();
                for (index, (wire, prefix)) in editor_data.iter().enumerate() {
                    if native_animation && index > 0 {
                        std::thread::sleep(deadline.map_or(TYPING_INTERVAL, |deadline| {
                            TYPING_INTERVAL.min(deadline.saturating_duration_since(Instant::now()))
                        }));
                    }
                    zsh_frame_deadline = matches!(
                        shell,
                        TerminalShellKind::Zsh | TerminalShellKind::Bash
                    )
                    .then(|| {
                        deadline.map_or(Instant::now() + FRONTEND_READY_TIMEOUT, |deadline| {
                            deadline.min(Instant::now() + FRONTEND_READY_TIMEOUT)
                        })
                    });
                    let partial = native_animation && index + 1 < editor_data.len();
                    let posix_frame =
                        matches!(shell, TerminalShellKind::Zsh | TerminalShellKind::Bash);
                    // Keep readiness and the complete data enqueue atomic with
                    // stop/takeover. Once queued, stop may await this frame's
                    // exact acknowledgement with its bounded receipt timeout.
                    let mut frame_gate = if posix_frame {
                        Some(
                            submitted
                                .lock()
                                .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?,
                        )
                    } else {
                        None
                    };
                    // PSReadLine consumes each bounded data batch in one native
                    // Replace call. Its unchanged-buffer A is a readiness fence:
                    // payload is never queued where ReadLine could accept it.
                    let phases = if powershell
                        || matches!(shell, TerminalShellKind::Zsh | TerminalShellKind::Bash)
                    {
                        vec![
                            ("\u{18}\u{2}".to_string(), previous_prefix.clone()),
                            (wire.clone(), prefix.clone()),
                        ]
                    } else {
                        vec![(wire.clone(), prefix.clone())]
                    };
                    for (phase_index, (phase_wire, phase_prefix)) in phases.into_iter().enumerate()
                    {
                        let zsh_data =
                            matches!(shell, TerminalShellKind::Zsh | TerminalShellKind::Bash)
                                && phase_index == 1;
                        {
                            let _gate = if frame_gate.is_none() {
                                Some(
                                    submitted
                                        .lock()
                                        .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?,
                                )
                            } else {
                                None
                            };
                            if operation.snapshot()?.state != TerminalCommandState::Submitted {
                                return interrupted_typing_result(operation.snapshot()?.state);
                            }
                            if zsh_frame_deadline.is_some_and(|deadline| Instant::now() >= deadline)
                            {
                                self.broker
                                    .require_native_input_recovery(session_id, operation_id)?;
                                return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native source frame deadline elapsed before input; no automatic replay".into());
                            }
                            if !self.broker.native_input_enabled(session_id)? {
                                return Err(
                            "TERMINAL_INPUT_RECOVERY_REQUIRED: native editor capability was lost"
                                .into(),
                        );
                            }
                            if let Some(line) = job_submission {
                                self.broker.validate_shell_job_input(
                                    session_id,
                                    operation_id,
                                    command,
                                    line,
                                )?;
                            }
                            revalidate(TerminalExecuteValidationStage::InputWrite)?;
                            if posix_frame && phase_index == 0 {
                                operation.begin_native_frame()?;
                            }
                            if powershell && phase_index == 0 {
                                editor_batch_pending.store(true, Ordering::Release);
                            }
                            if zsh_data {
                                let descriptor = if shell == TerminalShellKind::Bash {
                                    let source_length = if partial {
                                        0
                                    } else {
                                        crate::terminal_integration::bash_native_eval_source(
                                            &phase_prefix,
                                        )
                                        .map_or(0, |source| source.len() * 4)
                                    };
                                    let geometry = self
                                        .broker
                                        .snapshot(Some(session_id))?
                                        .session
                                        .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?
                                        .geometry;
                                    format!(
                                        "{}{:05x}{:04x}{:04x}{:04x}{}{}",
                                        if partial { 'c' } else { 'b' },
                                        phase_wire.len(),
                                        source_length,
                                        geometry.rows,
                                        geometry.columns,
                                        &uuid::Uuid::new_v4().simple().to_string()[..15],
                                        uuid::Uuid::new_v4().simple()
                                    )
                                } else {
                                    format!(
                                        "{}{:04x}{}{}",
                                        if partial { 'f' } else { 'e' },
                                        phase_wire.len(),
                                        &uuid::Uuid::new_v4().simple().to_string()[..28],
                                        uuid::Uuid::new_v4().simple()
                                    )
                                };
                                operation
                                    .expect_native_data_checkpoint(&descriptor, &phase_prefix)?;
                                self.leases.write(
                                    sessions,
                                    session_id,
                                    descriptor,
                                    TerminalInputSource::Agent {
                                        agent_session_id,
                                        task_id,
                                        operation_id,
                                    },
                                )?;
                                revalidate(TerminalExecuteValidationStage::InputWrite)?;
                                if zsh_frame_deadline
                                    .is_some_and(|deadline| Instant::now() >= deadline)
                                {
                                    self.broker
                                        .require_native_input_recovery(session_id, operation_id)?;
                                    return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native source frame deadline elapsed before payload; no automatic replay".into());
                                }
                                if let Some(line) = job_submission {
                                    self.broker.validate_shell_job_input(
                                        session_id,
                                        operation_id,
                                        command,
                                        line,
                                    )?;
                                }
                            } else {
                                operation.expect_native_checkpoint(&phase_prefix)?;
                            }
                            self.leases.write(
                                sessions,
                                session_id,
                                phase_wire,
                                TerminalInputSource::Agent {
                                    agent_session_id,
                                    task_id,
                                    operation_id,
                                },
                            )?;
                        }
                        if zsh_data {
                            drop(frame_gate.take());
                        }
                        let acknowledgement_timeout = zsh_frame_deadline.or(deadline).map_or(
                            FRONTEND_READY_TIMEOUT,
                            |deadline| {
                                FRONTEND_READY_TIMEOUT
                                    .min(deadline.saturating_duration_since(Instant::now()))
                            },
                        );
                        let confirmed = if zsh_data {
                            operation.wait_native_private_checkpoint(acknowledgement_timeout)?
                        } else {
                            operation.wait_native_checkpoint(acknowledgement_timeout)?
                        };
                        if !confirmed {
                            let _gate = if frame_gate.is_none() {
                                Some(
                                    submitted
                                        .lock()
                                        .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?,
                                )
                            } else {
                                None
                            };
                            let snapshot = operation.snapshot()?;
                            let state = snapshot.state;
                            if shell == TerminalShellKind::Bash
                                && state == TerminalCommandState::Failed
                                && snapshot.input_rejection.is_some()
                            {
                                editor_batch_pending.store(false, Ordering::Release);
                                return Ok(());
                            }
                            if matches!(
                                state,
                                TerminalCommandState::Cancelled | TerminalCommandState::TakenOver
                            ) {
                                return interrupted_typing_result(state);
                            }
                            self.broker
                                .require_native_input_recovery(session_id, operation_id)?;
                            if state != TerminalCommandState::Submitted {
                                return interrupted_typing_result(state);
                            }
                            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native editor checkpoint was not confirmed; no automatic replay".into());
                        }
                    }
                    drop(frame_gate);
                    {
                        let _gate = submitted
                            .lock()
                            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
                        editor_batch_pending.store(false, Ordering::Release);
                    }
                    previous_prefix.clone_from(prefix);
                }
                // Keep a cancellation boundary after the whole edit buffer has
                // arrived and before its single native accept-line invocation.
                std::thread::sleep(deadline.map_or(TYPING_SUBMIT_PAUSE, |deadline| {
                    TYPING_SUBMIT_PAUSE.min(deadline.saturating_duration_since(Instant::now()))
                }));
                let mut gate = submitted
                    .lock()
                    .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
                if operation.snapshot()?.state != TerminalCommandState::Submitted {
                    return interrupted_typing_result(operation.snapshot()?.state);
                }
                revalidate(TerminalExecuteValidationStage::InputWrite)?;
                if zsh_frame_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    self.broker
                        .require_native_input_recovery(session_id, operation_id)?;
                    return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native source frame deadline elapsed; no automatic replay".into());
                }
                if !self.broker.native_input_enabled(session_id)? {
                    return Err(
                        "TERMINAL_INPUT_RECOVERY_REQUIRED: native editor capability was lost"
                            .into(),
                    );
                }
                if let Some(line) = job_submission {
                    self.broker.validate_shell_job_input(
                        session_id,
                        operation_id,
                        command,
                        line,
                    )?;
                }
                if native_animation {
                    operation.finish_typing_capture()?;
                }
                self.leases.write(
                    sessions,
                    session_id,
                    "\u{18}\u{5}".into(),
                    TerminalInputSource::Agent {
                        agent_session_id,
                        task_id,
                        operation_id,
                    },
                )?;
                *gate = true;
                self.leases.publish_command_phase(
                    session_id,
                    agent_session_id,
                    operation_id,
                    TerminalCommandPhase::Running,
                )?;
                return Ok(());
            }
            if !animated {
                let mut gate = submitted
                    .lock()
                    .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
                if operation.snapshot()?.state != TerminalCommandState::Submitted {
                    return interrupted_typing_result(operation.snapshot()?.state);
                }
                let data = if bracketed {
                    format!("\u{1b}[200~{input}\u{1b}[201~{enter}")
                } else {
                    format!("{input}{enter}")
                };
                self.leases.write(
                    sessions,
                    session_id,
                    data,
                    TerminalInputSource::Agent {
                        agent_session_id,
                        task_id,
                        operation_id,
                    },
                )?;
                *gate = true;
                self.leases.publish_command_phase(
                    session_id,
                    agent_session_id,
                    operation_id,
                    TerminalCommandPhase::Running,
                )?;
                return Ok(());
            }
            if animated {
                self.leases.publish_command_phase(
                    session_id,
                    agent_session_id,
                    operation_id,
                    TerminalCommandPhase::Typing,
                )?;
            }
            let started = Instant::now();
            for (index, chunk) in chunks.iter().enumerate() {
                if animated {
                    std::thread::sleep(
                        (started + TYPING_INTERVAL * index as u32)
                            .saturating_duration_since(Instant::now()),
                    );
                }
                let _gate = submitted
                    .lock()
                    .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
                if operation.snapshot()?.state != TerminalCommandState::Submitted {
                    return interrupted_typing_result(operation.snapshot()?.state);
                }
                // Animated input is ordinary typing. Repeated bracketed pastes
                // toggle ZLE's paste highlight and repaint wrapped input lines.
                // The shared command validator has already rejected all control
                // characters, so no paste envelope is needed for these chunks.
                self.leases.write(
                    sessions,
                    session_id,
                    chunk.to_string(),
                    TerminalInputSource::Agent {
                        agent_session_id,
                        task_id,
                        operation_id,
                    },
                )?;
            }
            if animated {
                std::thread::sleep(TYPING_SUBMIT_PAUSE);
            }
            let mut gate = submitted
                .lock()
                .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
            if operation.snapshot()?.state != TerminalCommandState::Submitted {
                return interrupted_typing_result(operation.snapshot()?.state);
            }
            revalidate(TerminalExecuteValidationStage::InputWrite)?;
            self.leases.write(
                sessions,
                session_id,
                enter.to_string(),
                TerminalInputSource::Agent {
                    agent_session_id,
                    task_id,
                    operation_id,
                },
            )?;
            *gate = true;
            self.leases.publish_command_phase(
                session_id,
                agent_session_id,
                operation_id,
                TerminalCommandPhase::Running,
            )?;
            Ok::<(), String>(())
        })();
        if let Err(error) = write_result {
            // Discard partially typed input before releasing ownership. Never
            // touch a replacement operation or a terminal already taken over.
            let _gate = submitted
                .lock()
                .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
            if editor_batch_pending.load(Ordering::Acquire) {
                let _ = self
                    .broker
                    .require_native_input_recovery(session_id, operation_id);
            }
            // Cancellation/takeover already interrupted under this same gate.
            // A native receive that became uncertain also stays fenced: do not
            // send another Ctrl-C into the shell's next prompt lifecycle.
            let state_before_failure = operation.snapshot()?.state;
            let native_receive_uncertain = powershell
                && editor_batch_pending.load(Ordering::Acquire)
                && state_before_failure == TerminalCommandState::Uncertain;
            let skip_repeated_interrupt = !*_gate
                && (native_receive_uncertain
                    || matches!(
                        state_before_failure,
                        TerminalCommandState::Cancelled
                            | TerminalCommandState::TakenOver
                            | TerminalCommandState::TimedOut
                    ));
            let command_id = operation.command_id()?;
            let _ = self.broker.mark_command_uncertain(session_id, &command_id);
            if !*_gate {
                if native_input && !operation.native_empty_confirmed()? {
                    let _ = self.broker.reject_unsubmitted_shell_job(operation_id);
                }
                let _ = self.broker.retire_command(session_id, &command_id);
            }
            if !skip_repeated_interrupt
                && self
                    .leases
                    .validate_control_owner(session_id, agent_session_id, operation_id)
                    .is_ok()
            {
                if native_input && !*_gate && !operation.native_empty_confirmed()? {
                    // The read-only probe never typed source; preserve a user draft.
                } else if native_input
                    && matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh)
                    && !*_gate
                    && !editor_batch_pending.load(Ordering::Acquire)
                {
                    let _ = self.discard_native_input(sessions, session_id, operation_id);
                } else {
                    let _ = self.leases.write(
                        sessions,
                        session_id,
                        "\u{3}".into(),
                        TerminalInputSource::System {
                            operation_id: Some(operation_id),
                        },
                    );
                }
            }
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
        self.wait_bounded(sessions, session_id, operation, timeout, false)
    }

    pub(crate) fn wait_management(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation: &Arc<TerminalCommandOperation>,
        timeout: Duration,
    ) -> Result<TerminalCommandSnapshot, String> {
        self.wait_bounded(sessions, session_id, operation, timeout, true)
    }

    fn wait_bounded(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation: &Arc<TerminalCommandOperation>,
        timeout: Duration,
        hard_deadline: bool,
    ) -> Result<TerminalCommandSnapshot, String> {
        let deadline = Instant::now() + timeout;
        let mut interrupt_deadline = None;
        loop {
            let slice = if hard_deadline {
                WAIT_SLICE.min(deadline.saturating_duration_since(Instant::now()))
            } else {
                WAIT_SLICE
            };
            let snapshot = operation.wait_until_terminal(slice)?;
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
            if hard_deadline && Instant::now() >= deadline {
                let _ = self
                    .broker
                    .mark_command_uncertain(session_id, &snapshot.command_id);
                break;
            }
        }

        if !hard_deadline {
            std::thread::sleep(CAPTURE_DRAIN_GRACE);
        }
        let mut snapshot = operation.snapshot()?;
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
        snapshot = operation.snapshot()?;
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
        self.leases
            .validate_control_owner(session_id, agent_session_id, operation_id)?;
        let registration = self.registration(session_id, operation_id)?;
        let submitted = registration
            .submitted
            .lock()
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
        self.wait_native_frame_before_stop(&registration, *submitted)?;
        let send = registration
            .operation
            .request_settlement(TerminalCommandRequestedSettlement::TakenOver)?;
        let receiver_pending = registration.editor_batch_pending.load(Ordering::Acquire)
            && !registration
                .operation
                .native_private_checkpoint_confirmed()?;
        if !*submitted && receiver_pending {
            self.broker
                .require_native_input_recovery(session_id, operation_id)?;
        }
        if !*submitted {
            self.broker.reject_unsubmitted_shell_job(operation_id)?;
            registration.operation.settle_unsubmitted()?;
            self.broker
                .retire_command(session_id, &registration.operation.command_id()?)?;
        }
        if send {
            let recovery = if registration.native_editor
                && !*submitted
                && !registration.operation.native_empty_confirmed()?
            {
                Ok(())
            } else if registration.native_clear && !*submitted && !receiver_pending {
                self.discard_native_input(sessions, session_id, operation_id)
            } else {
                self.leases
                    .write(
                        sessions,
                        session_id,
                        "\u{3}".to_string(),
                        TerminalInputSource::System {
                            operation_id: Some(operation_id),
                        },
                    )
                    .map(|_| ())
            };
            if let Err(error) = recovery {
                let _ = self
                    .broker
                    .require_native_input_recovery(session_id, operation_id);
                self.leases.release_after_takeover(
                    session_id,
                    &registration.agent_session_id,
                    &registration.task_id,
                    operation_id,
                )?;
                return Err(error);
            }
        }
        self.leases.release_after_takeover(
            session_id,
            &registration.agent_session_id,
            &registration.task_id,
            operation_id,
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
            let submitted = registration
                .submitted
                .lock()
                .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
            self.wait_native_frame_before_stop(&registration, *submitted)?;
            let send = registration.operation.request_settlement(requested)?;
            let receiver_pending = registration.editor_batch_pending.load(Ordering::Acquire)
                && !registration
                    .operation
                    .native_private_checkpoint_confirmed()?;
            if !*submitted && receiver_pending {
                self.broker
                    .require_native_input_recovery(&session_id, &registration.operation_id)?;
            }
            if !*submitted {
                self.broker
                    .reject_unsubmitted_shell_job(&registration.operation_id)?;
                registration.operation.settle_unsubmitted()?;
                // Bash emits a prompt-cycle lifecycle even when Ctrl-C only
                // clears the edit buffer. Detach this never-submitted command
                // before that lifecycle can be mistaken for its execution.
                self.broker
                    .retire_command(&session_id, &registration.operation.command_id()?)?;
            }
            if send {
                let recovery = if registration.native_editor
                    && !*submitted
                    && !registration.operation.native_empty_confirmed()?
                {
                    Ok(())
                } else if registration.native_clear && !*submitted && !receiver_pending {
                    self.discard_native_input(sessions, &session_id, &registration.operation_id)
                } else {
                    self.leases
                        .write(
                            sessions,
                            &session_id,
                            "\u{3}".to_string(),
                            TerminalInputSource::System {
                                operation_id: Some(&registration.operation_id),
                            },
                        )
                        .map(|_| ())
                };
                if let Err(error) = recovery {
                    let _ = self
                        .broker
                        .require_native_input_recovery(&session_id, &registration.operation_id);
                    errors.push(format!("TERMINAL_INPUT_RECOVERY_REQUIRED: scoped cancellation interrupt failed: {}",crate::redaction::redact_sensitive_text(&error)));
                }
                requested_count += 1;
            }
        }
        if errors.is_empty() {
            Ok(requested_count)
        } else {
            Err(errors.join("; "))
        }
    }

    fn wait_native_frame_before_stop(
        &self,
        registration: &TerminalExecuteRegistration,
        submitted: bool,
    ) -> Result<(), String> {
        if registration.native_clear && !submitted {
            // Keep the operation attached and Submitted while its exact frame
            // acknowledgement arrives. Retiring it first discards that receipt;
            // sending a clear first can race the receiver's tty restoration.
            // The caller holds the submit gate, so this cannot accept the line.
            // If the receipt is lost, the existing scoped clear still requires
            // its own exact empty-buffer acknowledgement before input unlocks.
            registration
                .operation
                .wait_native_private_checkpoint(INTERRUPT_SETTLEMENT_TIMEOUT)?;
        }
        Ok(())
    }

    #[cfg(all(test, unix))]
    pub(crate) fn native_editor_confirmed_for_test(
        &self,
        session_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        self.registration(session_id, operation_id)?
            .operation
            .native_private_checkpoint_confirmed()
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

    fn discard_native_input(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation_id: &str,
    ) -> Result<(), String> {
        let result = (|| {
            self.broker.expect_native_clear(session_id, operation_id)?;
            self.leases.write(
                sessions,
                session_id,
                "\u{18}\u{4}".into(),
                TerminalInputSource::System {
                    operation_id: Some(operation_id),
                },
            )?;
            if !self.broker.wait_native_clear(
                session_id,
                operation_id,
                INTERRUPT_SETTLEMENT_TIMEOUT,
            )? {
                return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native edit clear was not confirmed; reconnect before further input".into());
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = self
                .broker
                .require_native_input_recovery(session_id, operation_id);
        }
        result
    }

    fn finish_registration(
        &self,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        reason: TerminalLeaseReleaseReason,
    ) -> Result<(), String> {
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

fn typing_chunks(input: &str, reduced_motion: bool) -> Vec<&str> {
    if reduced_motion || input.is_empty() {
        return vec![input];
    }
    let boundaries = input
        .grapheme_indices(true)
        .map(|(index, _)| index)
        .chain(std::iter::once(input.len()))
        .collect::<Vec<_>>();
    let count = boundaries.len() - 1;
    let step = count.div_ceil(TYPING_MAX_STEPS);
    (0..count)
        .step_by(step)
        .map(|index| &input[boundaries[index]..boundaries[(index + step).min(count)]])
        .collect()
}

// Readline/ZLE quoted-insert consumes exactly the following character. These
// owned key bindings are installed and advertised at each primary prompt.
// Neither a newline nor a Tab can invoke accept-line or completion here, and
// bracketed-paste state has no bearing on this native editor operation.
pub(crate) fn native_editor_input(command: &str) -> String {
    let mut input = String::with_capacity(command.len());
    for character in command.chars() {
        match character {
            '\n' => input.push_str("\u{18}n"),
            '\t' => input.push_str("\u{18}t"),
            '\r' => input.push_str("\u{18}r"),
            _ => input.push(character),
        }
    }
    input
}

pub(crate) fn native_editor_input_for_shell(command: &str, shell: TerminalShellKind) -> String {
    if !matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh) {
        return native_editor_input(command);
    }
    let mut input = String::with_capacity(command.len().saturating_mul(3));
    for character in command.chars() {
        match character {
            '\n' => input.push_str("\u{18}n"),
            '\t' => input.push_str("\u{18}t"),
            '\r' => input.push_str("\u{18}r"),
            _ => {
                input.push_str("\u{18}\u{16}");
                input.push(character);
            }
        }
    }
    input
}

// A bounded wire chunk is followed by an editor-owned checkpoint widget. The
// next chunk is sent only after its exact whole-buffer acknowledgement. This
// provides real backpressure even where a PTY write succeeds while its input
// line discipline would otherwise overflow during asynchronous redisplay.
pub(crate) fn native_editor_chunks(
    command: &str,
    shell: TerminalShellKind,
) -> Vec<(String, String)> {
    if matches!(shell, TerminalShellKind::Zsh | TerminalShellKind::Bash) {
        use std::fmt::Write;
        let mut encoded = String::with_capacity(command.len() * 4);
        if shell == TerminalShellKind::Bash {
            if let Some(source) = crate::terminal_integration::bash_native_eval_source(command) {
                for byte in source.as_bytes() {
                    write!(encoded, "\\x{byte:02x}")
                        .expect("writing original source into a String");
                }
            }
        }
        for byte in command.as_bytes() {
            write!(encoded, "\\x{byte:02x}").expect("writing source bytes into a String");
        }
        return vec![(encoded, command.to_string())];
    }
    if matches!(
        shell,
        TerminalShellKind::WindowsPowerShell | TerminalShellKind::PowerShell7
    ) {
        use base64::Engine;
        let mut chunks = Vec::new();
        let mut data = String::new();
        let mut prefix = String::new();
        for character in command.chars() {
            if !data.is_empty() && data.len() + character.len_utf8() > POWERSHELL_EDITOR_BATCH_BYTES
            {
                chunks.push((
                    format!(
                        "{}\u{18}\u{6}",
                        base64::engine::general_purpose::STANDARD.encode(data.as_bytes())
                    ),
                    prefix.clone(),
                ));
                data.clear();
            }
            data.push(character);
            prefix.push(character);
        }
        if !data.is_empty() {
            chunks.push((
                format!(
                    "{}\u{18}\u{6}",
                    base64::engine::general_purpose::STANDARD.encode(data.as_bytes())
                ),
                prefix,
            ));
        }
        return chunks;
    }
    let mut chunks = Vec::new();
    let mut wire = String::new();
    let mut prefix = String::new();
    for character in command.chars() {
        let encoded = native_editor_input_for_shell(&character.to_string(), shell);
        if !wire.is_empty() && wire.len() + encoded.len() > 512 {
            wire.push_str("\u{18}\u{1}");
            chunks.push((std::mem::take(&mut wire), prefix.clone()));
        }
        wire.push_str(&encoded);
        prefix.push(character);
    }
    if !wire.is_empty() {
        wire.push_str("\u{18}\u{1}");
        chunks.push((wire, prefix));
    }
    chunks
}

// Each intermediate frame replaces the real editor buffer with a grapheme-safe
// prefix. Only the final frame carries the complete source validation envelope.
// Receivers acknowledge every prefix before another frame or accept is sent.
fn native_editor_typing_chunks(command: &str, shell: TerminalShellKind) -> Vec<(String, String)> {
    let chunks = typing_chunks(command, false);
    let mut end = 0;
    chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            end += chunk.len();
            if index + 1 == chunks.len() {
                native_editor_chunks(command, shell).remove(0)
            } else {
                native_editor_chunks(&command[..end], TerminalShellKind::Zsh).remove(0)
            }
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn native_editor_final_chunk(command: &str, shell: TerminalShellKind) -> String {
    native_editor_chunks(command, shell)
        .pop()
        .map(|(wire, _)| wire)
        .unwrap_or_default()
}

fn interrupted_typing_result(state: TerminalCommandState) -> Result<(), String> {
    match state {
        TerminalCommandState::Cancelled | TerminalCommandState::TakenOver => Ok(()),
        _ => Err(
            "TERMINAL_INPUT_RECOVERY_REQUIRED: command input was interrupted before submission"
                .into(),
        ),
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
