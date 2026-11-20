use std::time::{Duration, Instant};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::native::{shell_guard, terminal_execute, ProcessLifecycleNative};
use crate::agent_runtime::{
    AgentObservedEffectNative, AgentToolCallNative, AgentToolResultNative,
    AgentToolResultStatusNative, AgentToolTargetNative, KillProcessArgumentsNative,
    WaitProcessArgumentsNative, WriteStdinArgumentsNative,
};

use super::*;

impl NativeToolEngine {
    pub(super) fn write_process(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: WriteStdinArgumentsNative =
            serde_json::from_value(call.arguments.clone())
                .map_err(|error| format!("Invalid write_stdin arguments: {error}"))?;
        if process_handle(&call.target)?.starts_with("job-") {
            return Err("TERMINAL_JOB_STDIN_UNSUPPORTED: native background jobs share the terminal; per-job stdin is unavailable".into());
        }
        if let AgentToolTargetNative::Process {
            owner_target_id, ..
        } = &call.target
        {
            if context.request.targets.iter().any(|target| {
                matches!(target, AgentToolTargetNative::Remote { target_id, .. } if target_id == owner_target_id)
            }) {
                shell_guard::reject_remote_privilege_command(&arguments.input)?;
            }
        }
        let accepted = self
            .processes
            .get(process_handle(&call.target)?)?
            .write_stdin(arguments.input, arguments.close.unwrap_or(false))?;
        Ok(completed_result(
            &context.request,
            call,
            effect,
            "Process input was accepted.",
            json!({ "acceptedBytes": accepted, "closed": arguments.close.unwrap_or(false) }),
            false,
        ))
    }

    pub(super) fn wait_process(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        cancellation: &CancellationToken,
        dispatch_policy: Option<&VisibleTerminalDispatch<'_>>,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: WaitProcessArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("Invalid wait_process arguments: {error}"))?;
        let handle = process_handle(&call.target)?;
        if handle.starts_with("job-") {
            return self.manage_shell_job(
                context,
                call,
                effect,
                sessions,
                false,
                arguments.timeout_ms.unwrap_or(30_000),
                cancellation,
                dispatch_policy,
            );
        }
        let snapshot = self.processes.get(handle)?.wait(Duration::from_millis(
            arguments.timeout_ms.unwrap_or(30_000),
        ))?;
        self.processes.remove_terminal(handle, snapshot.state)?;
        let limit = arguments.max_output_bytes.unwrap_or(1_048_576) as usize;
        let (stdout, stdout_cut) = truncate_utf8(&snapshot.stdout, limit.saturating_mul(3) / 4);
        let (stderr, stderr_cut) = truncate_utf8(&snapshot.stderr, limit / 4);
        let truncated =
            snapshot.stdout_truncated || snapshot.stderr_truncated || stdout_cut || stderr_cut;
        Ok(completed_result(
            &context.request,
            call,
            effect,
            if snapshot.state == ProcessLifecycleNative::Running {
                "Process is still running."
            } else {
                "Process reached a terminal state."
            },
            json!({
                "state": if snapshot.state == ProcessLifecycleNative::Running { "running" } else { "exited" },
                "terminationConfirmed": snapshot.termination_confirmed,
                "exitCode": snapshot.exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "truncated": truncated,
            }),
            truncated,
        ))
    }

    pub(super) fn kill_process(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        cancellation: &CancellationToken,
        dispatch_policy: Option<&VisibleTerminalDispatch<'_>>,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: KillProcessArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("Invalid kill_process arguments: {error}"))?;
        let handle = process_handle(&call.target)?;
        if handle.starts_with("job-") {
            if arguments.signal != crate::agent_runtime::ProcessSignalNative::Terminate {
                return Err(
                    "TERMINAL_JOB_SIGNAL_UNSUPPORTED: native job stop supports TERM only".into(),
                );
            }
            return self.manage_shell_job(
                context,
                call,
                effect,
                sessions,
                true,
                arguments.timeout_ms.unwrap_or(10_000),
                cancellation,
                dispatch_policy,
            );
        }
        let snapshot = self.processes.get(handle)?.kill(
            arguments.signal,
            Duration::from_millis(arguments.timeout_ms.unwrap_or(10_000)),
        )?;
        self.processes.remove_terminal(handle, snapshot.state)?;
        Ok(completed_result(
            &context.request,
            call,
            effect,
            "Process termination request was handled.",
            json!({ "state": snapshot.state, "terminationConfirmed": snapshot.termination_confirmed }),
            false,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn manage_shell_job(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        stop: bool,
        timeout_ms: u64,
        cancellation: &CancellationToken,
        dispatch_policy: Option<&VisibleTerminalDispatch<'_>>,
    ) -> Result<AgentToolResultNative, String> {
        let AgentToolTargetNative::Process {
            process_handle: handle,
            owner_target_id,
            ..
        } = &call.target
        else {
            return Err("TERMINAL_JOB_INVALID_TARGET".into());
        };
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut stop_sent = false;
        let mut blocked: Option<String> = None;
        let mut management_error = None;
        let mut observation_budget = terminal_execute::TYPING_SUBMIT_PAUSE.saturating_mul(2);
        let job = loop {
            let job = self.terminal_broker.shell_job(
                handle,
                owner_target_id,
                &context.request.user_session_id,
                &context.request.task_id,
            )?;
            if matches!(job.state.as_str(), "exited" | "rejected")
                || job.control_lost
                || job.native_active == Some(false)
                || timeout_ms == 0
                || cancellation.is_cancelled()
            {
                break job;
            }
            if Instant::now() >= deadline {
                break job;
            }
            if job.state == "starting" && job.accepted_command_line.is_none() {
                self.terminal_broker.wait_shell_job_change(
                    &job,
                    Duration::from_millis(25)
                        .min(deadline.saturating_duration_since(Instant::now())),
                )?;
                continue;
            }
            if self
                .terminal_broker
                .snapshot(Some(&job.transport_session_id))?
                .session
                .is_some_and(|terminal| {
                    !terminal.prompt_ready || terminal.active_command_id.is_some()
                })
            {
                blocked =
                    Some("terminal prompt is unavailable; no management input was admitted".into());
                self.terminal_broker.wait_shell_job_prompt(
                    &job,
                    Duration::from_millis(25)
                        .min(deadline.saturating_duration_since(Instant::now())),
                )?;
                continue;
            }
            blocked = None;
            if deadline.saturating_duration_since(Instant::now()) < observation_budget {
                blocked = Some("remaining deadline cannot admit another native observation; last confirmed observation retained".into());
                let mut observed = job;
                while Instant::now() < deadline
                    && !cancellation.is_cancelled()
                    && !observed.control_lost
                    && !matches!(observed.state.as_str(), "exited" | "uncertain" | "rejected")
                {
                    self.terminal_broker.wait_shell_job_change(
                        &observed,
                        Duration::from_millis(25)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    )?;
                    observed = self.terminal_broker.shell_job(
                        handle,
                        owner_target_id,
                        &context.request.user_session_id,
                        &context.request.task_id,
                    )?;
                }
                break observed;
            }
            let observation_started = Instant::now();
            let operation_id = format!("job-control-{}", uuid::Uuid::new_v4());
            let source = self.terminal_broker.prepare_shell_job_control(
                &job,
                &operation_id,
                stop && !stop_sent,
            )?;
            let start = self.terminal_execute.start_native_submission_outcome_until(
                sessions,
                &job.transport_session_id,
                &context.request.user_session_id,
                &context.request.task_id,
                &operation_id,
                &source,
                "\n",
                Some(&source),
                Some(deadline),
                Some(crate::terminal_command::state::IntentAuthorization {
                    request_id: call.request_id.clone(),
                    capability_id: call.capability_id.clone(),
                    approved_call_id: call.call_id.clone(),
                    frozen_target: call.target.clone(),
                }),
                false,
                dispatch_policy,
                |stage| {
                    if cancellation.is_cancelled() {
                        return Err("TERMINAL_JOB_WAIT_CANCELLED".into());
                    }
                    if Instant::now() >= deadline {
                        return Err("TERMINAL_JOB_WAIT_DEADLINE".into());
                    }
                    self.revalidate_terminal_execution(
                        &job.frozen_target,
                        sessions,
                        &job.terminal_session_id,
                        job.terminal_generation,
                        &context.request.user_session_id,
                        &context.request.task_id,
                        &operation_id,
                        stage,
                    )
                },
            );
            match start {
                Ok(operation) => {
                    let snapshot = self.terminal_execute.wait_management(
                        sessions,
                        &job.transport_session_id,
                        &operation,
                        deadline.saturating_duration_since(Instant::now()),
                    )?;
                    let observed = self.terminal_broker.shell_job(
                        handle,
                        owner_target_id,
                        &context.request.user_session_id,
                        &context.request.task_id,
                    )?;
                    if snapshot.state != crate::terminal_broker::TerminalCommandState::Completed
                        || snapshot.exit_code != Some(0)
                        || observed.observation_revision <= job.observation_revision
                    {
                        self.terminal_broker.mark_shell_job_uncertain(handle)?;
                        blocked = Some(
                            "management submission was not confirmed; no automatic replay".into(),
                        );
                        break self.terminal_broker.shell_job(
                            handle,
                            owner_target_id,
                            &context.request.user_session_id,
                            &context.request.task_id,
                        )?;
                    }
                    stop_sent |= stop && observed.stop_requested;
                }
                Err(error) => {
                    self.terminal_broker
                        .discard_shell_job_submission(&operation_id)?;
                    blocked = Some(format!(
                        "terminal management {}: {}; no automatic replay",
                        if error.submission_attempted {
                            "unconfirmed"
                        } else {
                            "not submitted"
                        },
                        crate::redaction::redact_sensitive_text(&error.message)
                    ));
                    management_error = Some(json!({
                        "code": if error.submission_attempted { "TERMINAL_SUBMISSION_UNCONFIRMED" } else { "TERMINAL_SUBMISSION_REJECTED" },
                        "execution": if error.submission_attempted { "unknown" } else { "notStarted" },
                        "phase": if error.submission_attempted { "submission" } else { "beforeSubmission" },
                        "terminalRecoveryRequired": self.terminal_broker.execution_capabilities(&job.transport_session_id)
                            .map_or(true, |state| state.input_recovery_required),
                        "nextAction": "reconcile",
                    }));
                    break job;
                }
            }
            let job = self.terminal_broker.shell_job(
                handle,
                owner_target_id,
                &context.request.user_session_id,
                &context.request.task_id,
            )?;
            if matches!(job.state.as_str(), "exited" | "uncertain" | "rejected")
                || Instant::now() >= deadline
            {
                break job;
            }
            // Reserve twice the largest confirmed round-trip in this call,
            // including native editing and its mandatory pre-submit pause.
            // A new poll must not borrow its checkpoint budget from a nearly
            // expired wait. Unexpected lost/mismatched A still quarantines.
            observation_budget =
                observation_budget.max(observation_started.elapsed().saturating_mul(2));
            std::thread::sleep(
                Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())),
            );
        };
        let uncertain = job.state == "uncertain";
        let finished =
            matches!(job.state.as_str(), "exited" | "rejected") || job.native_active == Some(false);
        let wait_timed_out = !finished && Instant::now() >= deadline;
        let mut result = completed_result(
            &context.request,
            call,
            effect,
            if job.state == "rejected" {
                "Native shell job did not start; no source was executed. Correct the launch request before a fresh call."
            } else {
                "Native shell job observation completed; output is shared with the terminal."
            },
            json!({
                "state": job.state, "exitCode": job.exit_code, "processHandle": job.process_handle,
                "job": job, "waitTimedOut": wait_timed_out,
                "stopRequested": stop_sent, "managementBlocked": blocked,
                "managementError": management_error,
                "waitCancelled": cancellation.is_cancelled(),
                "outputScope": "sharedTerminal", "stdout": "", "stderr": "",
                "noAutoReplay": true,
            }),
            false,
        );
        if job.state == "rejected" {
            result.status = AgentToolResultStatusNative::Failed;
        } else if uncertain {
            result.status = AgentToolResultStatusNative::Uncertain;
        } else if cancellation.is_cancelled() {
            result.status = AgentToolResultStatusNative::Cancelled;
        } else if stop && !finished {
            result.status = if wait_timed_out {
                AgentToolResultStatusNative::TimedOut
            } else {
                AgentToolResultStatusNative::Uncertain
            };
        }
        Ok(result)
    }
}

fn process_handle(target: &AgentToolTargetNative) -> Result<&str, String> {
    match target {
        AgentToolTargetNative::Process { process_handle, .. } => Ok(process_handle),
        _ => Err("Tool requires a frozen process target".into()),
    }
}

fn truncate_utf8(value: &str, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value.to_string(), false);
    }
    let mut boundary = limit;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    (value[..boundary].to_string(), true)
}
