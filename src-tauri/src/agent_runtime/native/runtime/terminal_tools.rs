use std::time::{Duration, Instant};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::native::{
    sanitize_terminal_screen, strip_ansi, strip_shell_control_osc, TerminalSubmissionError,
};
use crate::agent_runtime::{
    AgentObservedEffectNative, AgentToolCallNative, AgentToolResultNative,
    AgentToolResultStatusNative, ReadTerminalArgumentsNative, TerminalExecuteArgumentsNative,
    WaitTerminalArgumentsNative, WriteTerminalInputArgumentsNative,
};
use crate::terminal_broker::TerminalWaitReason;

use super::*;

impl NativeToolEngine {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn execute_terminal_command(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        database: Option<&Database>,
        default_timeout_ms: u64,
        cancellation: &CancellationToken,
        dispatch_policy: Option<&VisibleTerminalDispatch<'_>>,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: TerminalExecuteArgumentsNative =
            serde_json::from_value(call.arguments.clone())
                .map_err(|error| format!("Invalid terminal_execute arguments: {error}"))?;
        let session_id = self.terminal_target_session_id(&call.target, sessions)?;
        if arguments.handoff_to_user
            && self
                .terminal_leases
                .turn_owner(&session_id)?
                .is_some_and(|owner| owner != context.request.user_session_id)
        {
            return Err(
                "TERMINAL_HANDOFF_UNAVAILABLE: only the terminal turn owner can hand off input"
                    .into(),
            );
        }
        self.terminal_interactive.release_at_prompt(
            &session_id,
            &context.request.user_session_id,
            &context.request.task_id,
            false,
        )?;
        let broker_snapshot = self
            .terminal_broker
            .snapshot(Some(&session_id))?
            .session
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        let shell = broker_snapshot
            .integration_shell
            .ok_or_else(|| "TERMINAL_INTEGRATION_SHELL_UNKNOWN".to_string())?;
        let expected_terminal_session_id = broker_snapshot.terminal_session_id;
        let expected_terminal_generation = broker_snapshot.terminal_generation;
        let timeout = Duration::from_millis(arguments.timeout_ms.unwrap_or(default_timeout_ms));
        let launch_deadline = arguments.background.then(|| Instant::now() + timeout);
        let job = if arguments.background {
            Some(self.terminal_broker.prepare_shell_job(
                &session_id,
                &call.target,
                &context.request.user_session_id,
                &context.request.task_id,
                &call.call_id,
                &arguments.command,
            )?)
        } else {
            None
        };
        #[cfg(target_os = "macos")]
        if context.mac_sandbox_required {
            // Clear any proxy-blocked domains from prior manual or previous commands
            // so diagnostics reflect only this command's network attempts.
            let _ = self
                .terminal_broker
                .drain_local_sandbox_blocked_domains(&session_id);
        }
        let started = self.terminal_execute.start_native_submission_outcome_until(
            sessions,
            &session_id,
            &context.request.user_session_id,
            &context.request.task_id,
            &call.call_id,
            &arguments.command,
            shell.enter(),
            job.as_ref().map(|job| job.submitted_command_line.as_str()),
            launch_deadline,
            Some(crate::terminal_command::state::IntentAuthorization {
                request_id: call.request_id.clone(),
                capability_id: call.capability_id.clone(),
                approved_call_id: call.call_id.clone(),
                frozen_target: call.target.clone(),
            }),
            arguments.handoff_to_user,
            dispatch_policy,
            |stage| {
                if cancellation.is_cancelled() {
                    return Err(if arguments.background {
                        "TERMINAL_JOB_LAUNCH_CANCELLED"
                    } else {
                        "TERMINAL_SUBMISSION_CANCELLED"
                    }
                    .into());
                }
                if launch_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    return Err("TERMINAL_JOB_LAUNCH_DEADLINE: no automatic replay".into());
                }
                #[cfg(target_os = "macos")]
                if context.mac_sandbox_required {
                    let db = database.ok_or_else(|| {
                        "LOCAL_SANDBOX_TERMINAL_REQUIRED: database unavailable for sandbox policy verification"
                            .to_string()
                    })?;
                    let AgentToolTargetNative::Local { cwd: Some(cwd), .. } = &call.target else {
                        return Err("MAC_SANDBOX_DIRECT_REQUIRED".into());
                    };
                    self.validate_mac_sandbox_visible_terminal(
                        &context.request.user_session_id,
                        &session_id,
                        cwd,
                        db,
                    )?;
                }
                self.revalidate_terminal_execution(
                    &call.target,
                    sessions,
                    &expected_terminal_session_id,
                    expected_terminal_generation,
                    &context.request.user_session_id,
                    &context.request.task_id,
                    &call.call_id,
                    stage,
                )
            },
        );
        let operation = match started {
            Ok(operation) => operation,
            Err(error) => {
                return self.terminal_submission_failure(
                    context,
                    call,
                    effect,
                    &session_id,
                    job.as_ref(),
                    error,
                );
            }
        };
        let mut progress = self.tool_progress.begin(
            context.request.user_session_id.clone(),
            call.call_id.clone(),
        );
        let publish_enabled = progress.has_publisher();
        let is_native_protocol = operation.is_native_protocol().unwrap_or(false);
        let mut emit_progress = |snapshot: &crate::terminal_broker::TerminalCommandSnapshot| {
            progress.publish_terminal(
                &snapshot.combined_output,
                is_native_protocol,
                snapshot.capture_truncated,
            );
        };
        let waited = if arguments.handoff_to_user {
            self.terminal_execute.wait_foreground_handoff_with_progress(
                sessions,
                &session_id,
                &operation,
                timeout.min(Duration::from_secs(10)),
                || cancellation.is_cancelled(),
                publish_enabled.then_some(&mut emit_progress as &mut dyn FnMut(&_)),
            )
        } else if let Some(deadline) = launch_deadline {
            self.terminal_execute
                .wait_management(
                    sessions,
                    &session_id,
                    &operation,
                    deadline.saturating_duration_since(Instant::now()),
                )
                .map(|snapshot| (snapshot, false))
        } else if publish_enabled {
            self.terminal_execute
                .wait_with_progress(
                    sessions,
                    &session_id,
                    &operation,
                    timeout,
                    &mut emit_progress,
                )
                .map(|snapshot| (snapshot, false))
        } else {
            self.terminal_execute
                .wait(sessions, &session_id, &operation, timeout)
                .map(|snapshot| (snapshot, false))
        };
        progress.finish();
        let (snapshot, handed_off) = match waited {
            Ok(snapshot) => snapshot,
            Err(message) => {
                return self.terminal_submission_failure(
                    context,
                    call,
                    effect,
                    &session_id,
                    job.as_ref(),
                    TerminalSubmissionError {
                        message,
                        submission_attempted: true,
                    },
                )
            }
        };
        if let Some(job) = &job {
            let current = self.terminal_broker.shell_job(
                &job.process_handle,
                &job.owner_target_id,
                &context.request.user_session_id,
                &context.request.task_id,
            )?;
            if !current.launch_confirmed && current.state != "rejected" {
                self.terminal_broker
                    .mark_shell_job_uncertain(&job.process_handle)?;
            }
        }
        let plain_output = strip_ansi(&snapshot.combined_output);
        let redacted_plain = crate::redaction::redact_sensitive_text(&plain_output);
        // Native capture preserves real program controls. Keep the established
        // sensitive-output boundary, including secrets split by ANSI sequences,
        // while stripping shell-chrome OSC sequences (title/integration markers)
        // so models do not mistake them for truncated output.
        let violation_text = redacted_plain.clone();
        let model_output = if operation.is_native_protocol()? && redacted_plain == plain_output {
            let cleaned = strip_shell_control_osc(&snapshot.combined_output);
            crate::redaction::redact_sensitive_text(&cleaned)
        } else {
            redacted_plain
        };
        let state = terminal_command_wire_state(snapshot.state);
        let job = job
            .map(|job| {
                self.terminal_broker.shell_job(
                    &job.process_handle,
                    &job.owner_target_id,
                    &context.request.user_session_id,
                    &context.request.task_id,
                )
            })
            .transpose()?;
        let summary = crate::redaction::redact_sensitive_text(&match &snapshot.input_rejection {
            Some(reason) => format!("{reason}: native parser refused the approved source; no source statement was executed. Wait for the clean prompt before retrying."),
            None => match &job {
                Some(job) => format!("Native shell job launchConfirmed={}, jobState={}; output remains shared with the terminal.",job.launch_confirmed,job.state),
                None if handed_off => "The foreground command entered the alternate screen. Terminal input was handed to the user. Finish the turn without sending more terminal input.".into(),
                None => format!("Visible terminal command reached {state}."),
            },
        });
        let mut data = json!({
            "contractVersion": 1,
            "channel": "terminal",
            "state": state,
            "terminalSessionId": snapshot.terminal_session_id,
            "terminalGeneration": snapshot.terminal_generation,
            "operationId": snapshot.operation_id,
            "commandId": snapshot.command_id,
            "commandLine": snapshot.command_line,
            "submittedCommandLine": snapshot.submitted_command_line,
            "inputRejection": snapshot.input_rejection,
            "handedOffToUser": handed_off,
            "commandObservation": snapshot.command_observation,
            "execution": if !snapshot.may_have_submitted || snapshot.input_rejection.is_some() || job.as_ref().is_some_and(|job| job.state == "rejected") {
                "notStarted"
            } else if job.as_ref().is_some_and(|job| job.state == "exited") || (job.is_none() && snapshot.state == crate::terminal_broker::TerminalCommandState::Completed) {
                "completed"
            } else if handed_off || job.as_ref().is_some_and(|job| job.launch_confirmed && job.native_active == Some(true)) {
                "running"
            } else { "unknown" },
            "exitCode": snapshot.exit_code,
            "cwd": snapshot.cwd,
            "stdout": "",
            "stderr": "",
            "combinedOutput": model_output,
            "captureStartSequence": snapshot.capture_start_sequence,
            "captureEndSequence": snapshot.capture_end_sequence,
            "truncated": snapshot.capture_truncated,
            "noAutoReplay": snapshot.no_auto_replay,
            "processHandle": job.as_ref().map(|job| &job.process_handle),
            "launchState": job.as_ref().map(|job| if job.state == "rejected" { "rejected" } else if job.launch_confirmed { "confirmed" } else { "uncertain" }),
            "launchWaitTimedOut": launch_deadline.is_some_and(|deadline|Instant::now()>=deadline) && snapshot.state!=crate::terminal_broker::TerminalCommandState::Completed,
            "job": job,
            "outputScope": "sharedTerminal",
        });
        #[cfg(target_os = "macos")]
        if context.mac_sandbox_required {
            if let Some(obj) = data.as_object_mut() {
                obj.insert(
                    "sandbox".into(),
                    json!(crate::agent_runtime::native::mac_sandbox::EXECUTOR),
                );
                let blocked_domains = self
                    .terminal_broker
                    .drain_local_sandbox_blocked_domains(&session_id);
                let exit_code = snapshot.exit_code.unwrap_or(0);
                let classified = if !blocked_domains.is_empty() {
                    Some((
                        "networkBlocked",
                        "Outbound request was blocked by the sandbox filtering proxy; do not retry blocked hosts.",
                    ))
                } else {
                    super::command_exec::classify_sandbox_violation(exit_code, &violation_text, "")
                };
                if let Some((category, hint)) = classified {
                    let mut violation = json!({
                        "category": category,
                        "hint": hint,
                    });
                    if !blocked_domains.is_empty() {
                        violation["blockedDomains"] = json!(blocked_domains);
                    }
                    obj.insert("sandboxViolation".into(), violation);
                }
            }
        }
        Ok(AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: match snapshot.state {
                crate::terminal_broker::TerminalCommandState::Running if handed_off => {
                    AgentToolResultStatusNative::Completed
                }
                crate::terminal_broker::TerminalCommandState::Completed => {
                    match job.as_ref().map(|job| job.state.as_str()) {
                        Some("rejected") => AgentToolResultStatusNative::Failed,
                        Some("starting" | "uncertain") => AgentToolResultStatusNative::Uncertain,
                        _ => AgentToolResultStatusNative::Completed,
                    }
                }
                crate::terminal_broker::TerminalCommandState::Cancelled
                | crate::terminal_broker::TerminalCommandState::TakenOver => {
                    AgentToolResultStatusNative::Cancelled
                }
                crate::terminal_broker::TerminalCommandState::TimedOut => {
                    AgentToolResultStatusNative::TimedOut
                }
                crate::terminal_broker::TerminalCommandState::Uncertain => {
                    AgentToolResultStatusNative::Uncertain
                }
                crate::terminal_broker::TerminalCommandState::Submitted
                | crate::terminal_broker::TerminalCommandState::Running
                | crate::terminal_broker::TerminalCommandState::CancelRequested
                | crate::terminal_broker::TerminalCommandState::Failed => {
                    AgentToolResultStatusNative::Failed
                }
            },
            summary,
            data: Some(data),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(snapshot.capture_truncated),
        })
    }

    pub(super) fn terminal_submission_failure(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        session_id: &str,
        job: Option<&crate::terminal_jobs::NativeShellJob>,
        error: TerminalSubmissionError,
    ) -> Result<AgentToolResultNative, String> {
        let not_started = !error.submission_attempted
            && match job {
                Some(job) => self.terminal_broker.reject_shell_job_before_submission(
                    job,
                    "launch rejected before executable input was submitted; no source executed",
                )?,
                None => true,
            };
        self.terminal_broker
            .discard_shell_job_submission(&call.call_id)?;
        let job = job
            .map(|job| {
                if !not_started {
                    self.terminal_broker
                        .mark_shell_job_uncertain(&job.process_handle)?;
                }
                self.terminal_broker.shell_job(
                    &job.process_handle,
                    &job.owner_target_id,
                    &context.request.user_session_id,
                    &context.request.task_id,
                )
            })
            .transpose()?;
        let terminal_recovery_required = self
            .terminal_broker
            .execution_capabilities(session_id)
            .map_or(true, |state| !state.open || state.input_recovery_required)
            || crate::agent_runtime::is_terminal_call_blocked(&error.message);
        let message = crate::redaction::redact_sensitive_text(&error.message);
        let cancelled = not_started
            && matches!(
                error.message.as_str(),
                "TERMINAL_SUBMISSION_CANCELLED" | "TERMINAL_JOB_LAUNCH_CANCELLED"
            );
        let summary = if cancelled {
            format!("{message}; execution=notStarted. The request was cancelled before submission. No source was executed; do not automatically replay it.")
        } else if not_started {
            format!("{message}; execution=notStarted. No source was executed. Correct the request or inspect terminal readiness before a fresh call.")
        } else {
            format!("{message}; execution=unknown. Execution submission was attempted; retain the original operation identity and any process handle, and reconcile without replaying the source.")
        };
        let mut result = completed_result(
            &context.request,
            call,
            effect,
            &summary,
            json!({
                "contractVersion": 1, "channel": "terminal",
                "operationId": call.call_id,
                "state": if cancelled { "cancelled" } else if not_started { "failed" } else { "uncertain" },
                "execution": if not_started { "notStarted" } else { "unknown" },
                "processHandle": job.as_ref().map(|job| &job.process_handle),
                "launchState": job.as_ref().map(|_| if not_started { "rejected" } else { "uncertain" }),
                "job": job, "noAutoReplay": true, "error": message,
                "errorDetails": {
                    "code": if cancelled { "TERMINAL_SUBMISSION_CANCELLED" } else if not_started { "TERMINAL_SUBMISSION_REJECTED" } else { "TERMINAL_SUBMISSION_UNCONFIRMED" },
                    "phase": if not_started { "beforeSubmission" } else { "submission" },
                    "execution": if not_started { "notStarted" } else { "unknown" },
                    "terminalRecoveryRequired": terminal_recovery_required,
                    "nextAction": if !not_started { "reconcile" } else if terminal_recovery_required { "recoverTerminal" } else if cancelled { "none" } else { "correctRequest" },
                },
                "outputScope": "sharedTerminal",
            }),
            false,
        );
        result.status = if cancelled {
            AgentToolResultStatusNative::Cancelled
        } else if not_started {
            AgentToolResultStatusNative::Failed
        } else {
            AgentToolResultStatusNative::Uncertain
        };
        Ok(result)
    }

    pub(super) fn read_terminal(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
    ) -> Result<AgentToolResultNative, String> {
        let _: ReadTerminalArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("Invalid read_terminal arguments: {error}"))?;
        let session_id = self.interactive_terminal_session_id(context, call, sessions)?;
        let snapshot = self.terminal_interactive.read(&session_id)?;
        let (snapshot, credential_like_prompt) = sanitize_terminal_screen(snapshot);
        Ok(AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: AgentToolResultStatusNative::Completed,
            summary: if credential_like_prompt {
                "Terminal screen was read with credential-like content redacted.".into()
            } else {
                "Terminal screen was read.".into()
            },
            data: Some(json!({
                "contractVersion": 1,
                "snapshot": snapshot,
                "credentialLikePrompt": credential_like_prompt,
            })),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(false),
        })
    }

    pub(super) fn write_terminal_input(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: WriteTerminalInputArgumentsNative =
            serde_json::from_value(call.arguments.clone())
                .map_err(|error| format!("Invalid write_terminal_input arguments: {error}"))?;
        let session_id = self.interactive_terminal_session_id(context, call, sessions)?;
        let broker_snapshot = self
            .terminal_broker
            .snapshot(Some(&session_id))?
            .session
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        let expected_terminal_session_id = broker_snapshot.terminal_session_id;
        let expected_terminal_generation = broker_snapshot.terminal_generation;
        let result = self.terminal_interactive.write_with_revalidation(
            sessions,
            &session_id,
            &context.request.user_session_id,
            &context.request.task_id,
            arguments.input_kind,
            arguments.text.as_deref(),
            arguments.key,
            |stage| {
                self.revalidate_terminal_interactive_write(
                    &call.target,
                    sessions,
                    &expected_terminal_session_id,
                    expected_terminal_generation,
                    &context.request.user_session_id,
                    &context.request.task_id,
                    stage,
                )
            },
        )?;
        Ok(AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: AgentToolResultStatusNative::Completed,
            summary: "Terminal input was accepted by the active Agent lease.".into(),
            data: Some(json!({
                "contractVersion": 1,
                "receipt": result,
            })),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(false),
        })
    }

    pub(super) fn wait_terminal(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        default_timeout_ms: u64,
        cancellation: &CancellationToken,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: WaitTerminalArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("Invalid wait_terminal arguments: {error}"))?;
        let session_id = self.interactive_terminal_session_id(context, call, sessions)?;
        let timeout = Duration::from_millis(
            arguments
                .timeout_ms
                .unwrap_or(default_timeout_ms)
                .min(60_000),
        );
        let deadline = Instant::now() + timeout;
        let base_request = crate::terminal_broker::TerminalWaitRequest {
            after_screen_version: arguments.after_screen_version,
            after_output_sequence: arguments.after_output_sequence,
            after_lifecycle_sequence: arguments.after_lifecycle_sequence,
            text: arguments.text,
            case_sensitive: arguments.case_sensitive.unwrap_or(false),
            idle: arguments.idle_ms.map(Duration::from_millis),
            timeout,
        };
        let result = loop {
            if cancellation.is_cancelled() {
                return Ok(AgentToolResultNative {
                    request_id: context.request.request_id.clone(),
                    call_id: call.call_id.clone(),
                    tool_name: call.tool_name.clone(),
                    target_id: call.target.target_id().to_string(),
                    status: AgentToolResultStatusNative::Cancelled,
                    summary: "Terminal wait was cancelled.".into(),
                    data: None,
                    artifacts: Vec::new(),
                    effects: vec![effect.clone()],
                    truncated: Some(false),
                });
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let slice = remaining.min(Duration::from_millis(100));
            let mut request = base_request.clone();
            request.timeout = slice;
            let result =
                self.terminal_interactive
                    .wait_slice(&session_id, request, slice == remaining)?;
            if result.reason != TerminalWaitReason::TimedOut || slice == remaining {
                break result;
            }
        };
        let (snapshot, credential_like_prompt) = match result.snapshot {
            Some(snapshot) => {
                let (snapshot, credential_like_prompt) = sanitize_terminal_screen(snapshot);
                (Some(snapshot), credential_like_prompt)
            }
            None => (None, false),
        };
        Ok(AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: AgentToolResultStatusNative::Completed,
            summary: "Terminal wait reached a bounded observation condition.".into(),
            data: Some(json!({
                "contractVersion": 1,
                "reason": result.reason,
                "lifecycleSequence": result.lifecycle_sequence,
                "open": result.open,
                "snapshot": snapshot,
                "credentialLikePrompt": credential_like_prompt,
            })),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(false),
        })
    }

    pub(super) fn interactive_terminal_session_id(
        &self,
        _context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        sessions: &SessionManager,
    ) -> Result<String, String> {
        self.terminal_target_session_id(&call.target, sessions)
    }
}

fn terminal_command_wire_state(
    state: crate::terminal_broker::TerminalCommandState,
) -> &'static str {
    use crate::terminal_broker::TerminalCommandState;
    match state {
        TerminalCommandState::Submitted => "submitted",
        TerminalCommandState::Running => "running",
        TerminalCommandState::CancelRequested => "cancelRequested",
        TerminalCommandState::Completed => "completed",
        TerminalCommandState::Cancelled => "cancelled",
        TerminalCommandState::TimedOut => "timedOut",
        TerminalCommandState::TakenOver => "takenOver",
        TerminalCommandState::Uncertain => "uncertain",
        TerminalCommandState::Failed => "failed",
    }
}
