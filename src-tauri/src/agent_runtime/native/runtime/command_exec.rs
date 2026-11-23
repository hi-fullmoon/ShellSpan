use std::time::{Duration, Instant};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::native::{
    current_unix_ms, literal_sudo_command, spawn_local_process_native, spawn_remote_process_native,
    spawn_reviewed_local_process_native, ProcessLifecycleNative, ProcessSnapshotNative,
    RemoteProcessStartNative, ReviewedReadCommand,
};
use crate::agent_runtime::{
    AgentObservedEffectNative, AgentRequestNative, AgentToolCallNative, AgentToolResultNative,
    AgentToolResultStatusNative, AgentToolTargetNative, ExecCommandArgumentsNative,
};

use super::*;

impl NativeToolEngine {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn execute_command(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        default_timeout_ms: u64,
        max_concurrency: u16,
        reviewed_command: Option<&ReviewedReadCommand>,
        cancellation: &CancellationToken,
        runner_journal: Option<crate::agent_runtime::RunnerDispatchJournal>,
        sandbox: Option<&crate::remote_sandbox::Binding>,
        #[cfg(windows)] windows_sandbox: Option<
            crate::agent_runtime::native::windows_sandbox::Workspace,
        >,
        #[cfg(target_os = "macos")] mac_sandbox: Option<
            &crate::agent_runtime::native::mac_sandbox::Workspace,
        >,
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        desktop_sandbox: Option<&mac_sandbox_acceptance::Binding>,
        #[cfg(all(test, target_os = "linux"))] local_sandbox: Option<
            &local_sandbox_acceptance::Binding,
        >,
    ) -> Result<AgentToolResultNative, String> {
        let arguments: ExecCommandArgumentsNative = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("Invalid exec_command arguments: {error}"))?;
        if arguments.elevated == Some(true) {
            return self.execute_elevated_sudo_command(
                context,
                call,
                effect,
                &arguments,
                sessions,
                database,
                credentials,
                known_hosts_path,
                cancellation,
                runner_journal,
            );
        }
        let timeout = Duration::from_millis(arguments.timeout_ms.unwrap_or(default_timeout_ms));
        let timeout = if reviewed_command.is_some() {
            timeout.min(Duration::from_secs(30))
        } else {
            timeout
        };
        if let Some(binding) = sandbox.filter(|b| b.state.policy.is_some()) {
            return self.execute_remote_sandbox_command(
                context,
                call,
                effect,
                &arguments.command,
                database,
                credentials,
                known_hosts_path,
                binding,
                timeout,
                cancellation,
            );
        }
        if self.processes.running_count()? >= max_concurrency as usize {
            return Err("exec_command native concurrency limit was reached".into());
        }
        self.processes.ensure_capacity()?;
        validate_frozen_cwd(&call.target, arguments.cwd.as_deref())?;
        #[cfg(target_os = "macos")]
        let mut mac_launch = None;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let mut desktop_launch = None;
        let process = match &call.target {
            #[cfg(windows)]
            AgentToolTargetNative::Local { target_id, .. } if windows_sandbox.is_some() => {
                let launch = database.with_local_sandbox_dispatch(|| {
                    if cancellation.is_cancelled() {
                        return Err("Local sandbox launch cancelled".into());
                    }
                    let journal =
                        runner_journal.ok_or("Missing Windows sandbox dispatch journal")?;
                    let workspace = windows_sandbox.expect("Windows sandbox binding");
                    let child = crate::agent_runtime::native::windows_sandbox::prepare(
                        workspace,
                        &arguments.command,
                    )
                    .map_err(|error| format!("WINDOWS_SANDBOX_START_FAILED: {error}"))?;
                    crate::agent_runtime::native::process::run_windows_sandbox_process(
                        &self.processes,
                        &context.request,
                        target_id,
                        child,
                        timeout,
                        cancellation.clone(),
                        |child| {
                            journal(&mut || {
                                if cancellation.is_cancelled() {
                                    return Err("Local sandbox launch cancelled".into());
                                }
                                child.start().map_err(|error| {
                                    format!("WINDOWS_SANDBOX_START_FAILED: {error}")
                                })
                            })
                        },
                    )
                });
                match launch {
                    Ok(process) => {
                        let mut progress = self.tool_progress.begin(
                            context.request.user_session_id.clone(),
                            call.call_id.clone(),
                        );
                        let snapshot = if progress.has_publisher() {
                            process.wait_with_progress(
                                timeout.saturating_add(Duration::from_secs(4)),
                                TOOL_PROGRESS_THROTTLE_INTERVAL,
                                |stdout, stderr, total_bytes, truncated| {
                                    progress.publish_direct(stdout, stderr, total_bytes, truncated);
                                },
                            )
                        } else {
                            process.wait(timeout.saturating_add(Duration::from_secs(4)))
                        }?;
                        progress.finish();
                        self.processes
                            .remove_terminal(&snapshot.process_handle, snapshot.state)?;
                        let termination_confirmed = snapshot.termination_confirmed;
                        let mut result =
                            exec_process_result(&context.request, call, effect, snapshot, false);
                        let data = result.data.as_mut().expect("Direct process result data");
                        data["sandbox"] =
                            json!(crate::agent_runtime::native::windows_sandbox::EXECUTOR);
                        data["started"] = json!(true);
                        if !termination_confirmed {
                            result.status = AgentToolResultStatusNative::Uncertain;
                            result.summary =
                                "Sandbox process termination could not be confirmed.".into();
                        }
                        return Ok(result);
                    }
                    Err(error) => {
                        let mut result = completed_result(
                            &context.request,
                            call,
                            effect,
                            &error,
                            json!({"sandbox": crate::agent_runtime::native::windows_sandbox::EXECUTOR, "started": false}),
                            false,
                        );
                        result.status = if cancellation.is_cancelled() {
                            AgentToolResultStatusNative::Cancelled
                        } else {
                            AgentToolResultStatusNative::Failed
                        };
                        return Ok(result);
                    }
                }
            }
            #[cfg(target_os = "macos")]
            AgentToolTargetNative::Local { target_id, .. } if mac_sandbox.is_some() => {
                use std::io::Write;

                let binding = mac_sandbox.expect("macOS sandbox binding");
                let launch = database.with_local_sandbox_dispatch(|| {
                    if cancellation.is_cancelled() {
                        return Err("Local sandbox launch cancelled".into());
                    }
                    let mut lease = binding.acquire_lease()?;
                    let admitted = (|| {
                        let journal =
                            runner_journal.ok_or("Missing macOS sandbox dispatch journal")?;
                        binding.revalidate()?;
                        let (process, receipt, mut gate) =
                            crate::agent_runtime::native::process::prepare_mac_sandbox_process(
                                &context.request,
                                target_id,
                                &arguments.command,
                                reviewed_command,
                                &binding.workspace,
                                &binding.launcher,
                                timeout,
                                &mut lease,
                            )?;
                        let mut registered = false;
                        let dispatched = journal(&mut || {
                            if cancellation.is_cancelled() {
                                return Err("Local sandbox launch cancelled".into());
                            }
                            self.processes.insert(Arc::clone(&process))?;
                            registered = true;
                            gate.write_all(b"G").map_err(|error| error.to_string())
                        });
                        drop(gate);
                        if let Err(error) = dispatched {
                            let snapshot = process.wait(Duration::from_secs(3))?;
                            if registered {
                                self.processes
                                    .remove_terminal(&snapshot.process_handle, snapshot.state)?;
                            }
                            return Err(error);
                        }
                        Ok((process, receipt))
                    })();
                    match admitted {
                        Ok((process, receipt)) => Ok((process, receipt, lease)),
                        Err(error) => {
                            match lease.release() {
                                Ok(true) => {}
                                Ok(false) => log::warn!(
                                    "Managed macOS sandbox recovery is waiting for the previous process group"
                                ),
                                Err(cleanup) => log::warn!(
                                    "Managed macOS sandbox recovery retained directory protection: {cleanup}"
                                ),
                            }
                            Err(error)
                        }
                    }
                });
                match launch {
                    Ok((process, receipt, lease)) => {
                        mac_launch = Some((receipt, lease));
                        process
                    }
                    Err(error) => {
                        let mut result = completed_result(
                            &context.request,
                            call,
                            effect,
                            &error,
                            json!({"sandbox": crate::agent_runtime::native::mac_sandbox::EXECUTOR, "started": false}),
                            false,
                        );
                        result.status = if cancellation.is_cancelled() {
                            AgentToolResultStatusNative::Cancelled
                        } else {
                            AgentToolResultStatusNative::Failed
                        };
                        return Ok(result);
                    }
                }
            }
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            AgentToolTargetNative::Local { target_id, .. } if desktop_sandbox.is_some() => {
                use std::io::Write;

                let binding = desktop_sandbox.expect("desktop sandbox binding");
                binding.wait_for_gate_case(&arguments.command, cancellation)?;
                let launch = database.with_local_sandbox_dispatch(|| {
                    if cancellation.is_cancelled() {
                        return Err("Local sandbox launch cancelled".into());
                    }
                    let mut lease =
                        crate::agent_runtime::native::mac_sandbox_workspace::Lease::acquire(
                            &binding.directory,
                        )
                        .map_err(|error| error.to_string())?;
                    let admitted = (|| {
                        binding.hold_crash_cut(&arguments.command, "before", cancellation)?;
                        let journal = runner_journal.ok_or("Missing acceptance dispatch journal")?;
                        binding.revalidate()?;
                        let (process, receipt, mut gate) =
                            crate::agent_runtime::native::process::prepare_mac_sandbox_acceptance_process(
                                &context.request,
                                target_id,
                                &arguments.command,
                                reviewed_command,
                                &binding.workspace,
                                &binding.launcher,
                                timeout,
                                &mut lease,
                            )?;
                        let mut registered = false;
                        let dispatched = binding
                            .wait_for_launch_cancellation_case(&arguments.command, cancellation)
                            .and_then(|()| {
                                journal(&mut || {
                                    if cancellation.is_cancelled() {
                                        return Err("Local sandbox launch cancelled".into());
                                    }
                                    self.processes.insert(Arc::clone(&process))?;
                                    registered = true;
                                    gate.write_all(b"G").map_err(|error| error.to_string())
                                })
                            });
                        drop(gate);
                        if let Err(error) = dispatched {
                            let snapshot = process.wait(Duration::from_secs(3))?;
                            if registered {
                                self.processes
                                    .remove_terminal(&snapshot.process_handle, snapshot.state)?;
                            }
                            return Err(error);
                        }
                        Ok((process, receipt))
                    })();
                    match admitted {
                        Ok((process, receipt)) => Ok((process, receipt, lease)),
                        Err(error) => {
                            match lease.release() {
                                Ok(true) => {}
                                Ok(false) => log::warn!("Managed sandbox recovery is waiting for the previous process group"),
                                Err(cleanup) => log::warn!("Managed sandbox recovery retained directory protection: {cleanup}"),
                            }
                            Err(error)
                        }
                    }
                });
                match launch {
                    Ok((process, receipt, lease)) => {
                        desktop_launch = Some((receipt, lease));
                        process
                    }
                    Err(error) => {
                        let mut result = completed_result(
                            &context.request,
                            call,
                            effect,
                            &error,
                            json!({"sandbox":mac_sandbox_acceptance::EXECUTOR,"started":false}),
                            false,
                        );
                        result.status = if cancellation.is_cancelled() {
                            AgentToolResultStatusNative::Cancelled
                        } else {
                            AgentToolResultStatusNative::Failed
                        };
                        return Ok(result);
                    }
                }
            }
            #[cfg(all(test, target_os = "linux"))]
            AgentToolTargetNative::Local { target_id, .. } if local_sandbox.is_some() => {
                let binding = local_sandbox.expect("local sandbox binding");
                if reviewed_command.is_some() {
                    return Err("Local sandbox acceptance requires manual authorization".into());
                }
                database.with_local_sandbox_dispatch(|| {
                    if cancellation.is_cancelled() {
                        return Err("Local sandbox launch was cancelled".into());
                    }
                    binding.revalidate()?;
                    crate::agent_runtime::native::process::spawn_sandbox_acceptance_process(
                        &context.request,
                        target_id,
                        &arguments.command,
                        &binding.workspace,
                        &binding.launcher.executable,
                        &binding.launcher.node,
                        timeout,
                    )
                })?
            }
            AgentToolTargetNative::Local { target_id, .. } if reviewed_command.is_some() => {
                spawn_reviewed_local_process_native(
                    context.request.task_id.clone(),
                    context.request.request_id.clone(),
                    target_id.clone(),
                    reviewed_command.expect("reviewed local read"),
                    timeout,
                )?
            }
            AgentToolTargetNative::Local { target_id, cwd, .. } => spawn_local_process_native(
                context.request.task_id.clone(),
                context.request.request_id.clone(),
                target_id.clone(),
                &arguments.command,
                cwd.as_deref().map(Path::new),
                timeout,
            )?,
            AgentToolTargetNative::Remote {
                target_id,
                session_id,
                ..
            } => {
                let connection = connection_for_remote_target(&call.target, database, credentials)?;
                let binding =
                    sandbox.ok_or("Remote Direct requires a current SSH profile binding")?;
                let command =
                    if context.bound_terminal_surface && arguments.background == Some(true) {
                        let terminal = self
                            .terminal_broker
                            .snapshot(Some(session_id))
                            .ok()
                            .and_then(|snapshot| snapshot.session);
                        let remote_cwd = terminal
                            .as_ref()
                            .and_then(|session| session.current_directory.as_deref());
                        let shell = terminal
                            .as_ref()
                            .and_then(|session| session.integration_shell);
                        remote_command_with_cwd(&arguments.command, remote_cwd, shell)
                    } else {
                        arguments.command
                    };
                spawn_remote_process_native(
                    RemoteProcessStartNative {
                        task_id: context.request.task_id.clone(),
                        request_id: context.request.request_id.clone(),
                        owner_target_id: target_id.clone(),
                        command,
                        connection,
                        known_hosts_path: known_hosts_path.to_path_buf(),
                        timeout,
                    },
                    database.clone(),
                    binding.clone(),
                )?
            }
            _ => return Err("Direct Exec requires a local or remote target".into()),
        };
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let process_registered = desktop_launch.is_some();
        #[cfg(not(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        )))]
        let process_registered = false;
        if !process_registered {
            self.processes.insert(Arc::clone(&process))?;
        }
        if cancellation.is_cancelled() {
            let _ = self.processes.cancel_task(&context.request.task_id);
        }
        let background = arguments.background.unwrap_or(false);
        let snapshot = if background {
            process.snapshot()?
        } else {
            let mut progress = self.tool_progress.begin(
                context.request.user_session_id.clone(),
                call.call_id.clone(),
            );
            let snapshot = if progress.has_publisher() {
                process.wait_with_progress(
                    timeout.saturating_add(Duration::from_secs(1)),
                    TOOL_PROGRESS_THROTTLE_INTERVAL,
                    |stdout, stderr, total_bytes, truncated| {
                        progress.publish_direct(stdout, stderr, total_bytes, truncated);
                    },
                )?
            } else {
                process.wait(timeout.saturating_add(Duration::from_secs(1)))?
            };
            progress.finish();
            snapshot
        };
        if !background {
            self.processes
                .remove_terminal(&snapshot.process_handle, snapshot.state)?;
        }
        let mut result = exec_process_result(&context.request, call, effect, snapshot, background);
        #[cfg(target_os = "macos")]
        if let Some((receipt, mut lease)) = mac_launch {
            use std::os::unix::fs::FileExt;
            let mut evidence = [0];
            let data = result.data.as_mut().expect("Direct result data");
            data["sandbox"] = json!(crate::agent_runtime::native::mac_sandbox::EXECUTOR);
            match (receipt.read_at(&mut evidence, 0).ok(), evidence[0]) {
                (Some(1), b'S') => data["started"] = json!(true),
                (Some(1), b'F') => {
                    result.status = AgentToolResultStatusNative::Failed;
                    result.summary =
                        "LOCAL_SANDBOX_START_FAILED: launcher rejected the command before it started"
                            .into();
                    data["started"] = json!(false);
                    data["launcherExitCode"] = data["exitCode"].take();
                }
                _ => {
                    result.status = AgentToolResultStatusNative::Uncertain;
                    result.summary =
                        "LOCAL_SANDBOX_START_UNCONFIRMED: no trusted launch evidence".into();
                    data["started"] = Value::Null;
                }
            }
            let cleanup = (|| {
                lease.record_ended().map_err(|error| error.to_string())?;
                if !lease.release().map_err(|error| error.to_string())? {
                    return Err("Previous sandbox process group is still active".to_string());
                }
                Ok(())
            })();
            if let Err(error) = cleanup {
                result.status = AgentToolResultStatusNative::Uncertain;
                result.summary =
                    format!("Managed sandbox directory retained its protection: {error}");
                data["terminationConfirmed"] = json!(false);
            }
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if let Some((receipt, mut lease)) = desktop_launch {
            use std::os::unix::fs::FileExt;
            let mut evidence = [0];
            let data = result.data.as_mut().expect("Direct result data");
            data["sandbox"] = json!(mac_sandbox_acceptance::EXECUTOR);
            match (receipt.read_at(&mut evidence, 0).ok(), evidence[0]) {
                (Some(1), b'S') => data["started"] = json!(true),
                (Some(1), b'F') => {
                    result.status = AgentToolResultStatusNative::Failed;
                    result.summary =
                        "LOCAL_SANDBOX_START_FAILED: launcher rejected the command before it started"
                            .into();
                    data["started"] = json!(false);
                    data["launcherExitCode"] = data["exitCode"].take();
                }
                _ => {
                    result.status = AgentToolResultStatusNative::Uncertain;
                    result.summary =
                        "LOCAL_SANDBOX_START_UNCONFIRMED: no trusted launch evidence".into();
                    data["started"] = Value::Null;
                }
            }
            let cleanup = (|| {
                lease.record_ended().map_err(|error| error.to_string())?;
                desktop_sandbox
                    .expect("desktop sandbox binding")
                    .hold_crash_cut(
                        call.arguments["command"].as_str().unwrap_or_default(),
                        "after",
                        cancellation,
                    )?;
                if !lease.release().map_err(|error| error.to_string())? {
                    return Err("Previous sandbox process group is still active".to_string());
                }
                Ok(())
            })();
            if let Err(error) = cleanup {
                result.status = AgentToolResultStatusNative::Uncertain;
                result.summary =
                    format!("Managed sandbox directory retained its protection: {error}");
                data["terminationConfirmed"] = json!(false);
            }
        }
        #[cfg(all(test, target_os = "linux"))]
        if local_sandbox.is_some() {
            result.data.as_mut().expect("Direct process result data")["sandbox"] =
                json!("nonoLinuxSeccompAcceptance");
        }
        if reviewed_command.is_some() {
            if let Some(Value::Object(data)) = result.data.as_mut() {
                data.insert("approvalReview".into(), json!("boundedLocalRead"));
            }
        }
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_elevated_sudo_command(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        arguments: &ExecCommandArgumentsNative,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        cancellation: &CancellationToken,
        runner_journal: Option<crate::agent_runtime::RunnerDispatchJournal>,
    ) -> Result<AgentToolResultNative, String> {
        let mut runner_journal =
            Some(runner_journal.ok_or("Restricted runner dispatch requires a durable journal")?);
        let revalidate_sudo_operation = || {
            self.revalidate_target(context, &call.target, sessions, database)?;
            crate::sudo_policy::verify_grant(database, &call.target, arguments)
        };
        revalidate_sudo_operation()?;
        let policy = crate::sudo_policy::policy_for_target(database, &call.target)?;
        let AgentToolTargetNative::Remote {
            profile_id: Some(profile_id),
            ..
        } = &call.target
        else {
            return Err("A saved SSH profile is required for the restricted runner".into());
        };
        let mut jump =
            resolve_profile_jump_host(profile_id, policy.jump_host_config.as_deref(), credentials)?;
        if let Some(jump) = jump.as_mut() {
            crate::commands::resolve_keychain_key_for_jump_host(credentials, jump)?;
        }
        let runner = policy
            .runner
            .ok_or("A trusted restricted SSH runner is required")?;
        let operation = arguments
            .sudo_operation
            .as_ref()
            .ok_or("A configured operation is required")?;
        let command = literal_sudo_command(&arguments.command)?;
        let deadline =
            Instant::now() + Duration::from_millis(arguments.timeout_ms.unwrap_or(120_000));
        use crate::execution::{execute_restricted_sudo, RunnerOutcome};
        use std::io::Write;
        let mut result = completed_result(
            &context.request,
            call,
            effect,
            "Remote sudo command exited.",
            json!({ "channel": "direct", "state": "exited", "stdout": "", "stderr": "", "truncated": false }),
            false,
        );
        let outcome = execute_restricted_sudo(
            &policy.host,
            &runner,
            jump.as_ref().map(|jump| (jump, known_hosts_path)),
            &operation.id,
            &command,
            cancellation,
            deadline,
            || {
                revalidate_sudo_operation()?;
                let reply = self.sudo_prompts.request(
                    &policy.host,
                    &runner,
                    &command,
                    cancellation,
                    deadline,
                )?;
                if reply.is_some() {
                    revalidate_sudo_operation()?;
                }
                Ok(reply)
            },
            |channel, bytes| {
                self.revalidate_target(context, &call.target, sessions, database)?;
                database.with_sudo_dispatch(&call.target, arguments, || {
                    if cancellation.is_cancelled() || Instant::now() >= deadline {
                        return Err("Restricted runner was cancelled before dispatch".into());
                    }
                    if let Some(journal) = runner_journal.take() {
                        journal(&mut || Ok(()))?;
                    }
                    if cancellation.is_cancelled() || Instant::now() >= deadline {
                        return Err("Restricted runner was cancelled before sending".into());
                    }
                    Ok(channel.write(bytes))
                })?
            },
        );
        match outcome {
            RunnerOutcome::Completed {
                exit_code,
                stdout,
                stderr,
                truncated,
            } => {
                result.status = if exit_code == 0 {
                    AgentToolResultStatusNative::Completed
                } else {
                    AgentToolResultStatusNative::Failed
                };
                result.summary = format!("Remote sudo command exited with status {exit_code}.");
                result.data = Some(json!({
                    "channel": "direct", "state": "exited", "terminationConfirmed": true,
                    "stdout": stdout, "stderr": stderr, "exitCode": exit_code,
                    "truncated": truncated,
                }));
                result.truncated = Some(truncated);
            }
            RunnerOutcome::Cancelled => {
                result.status = AgentToolResultStatusNative::Cancelled;
                result.summary = "Remote sudo was cancelled before command dispatch.".into();
                result.data = None;
            }
            RunnerOutcome::Uncertain => {
                result.status = AgentToolResultStatusNative::Uncertain;
                result.summary = "Remote sudo may have executed without a confirmed result. Reconcile the operation before continuing.".into();
                result.data = None;
            }
            RunnerOutcome::NotStarted(message) => {
                result.status = AgentToolResultStatusNative::Failed;
                result.summary = message;
                result.data = None;
            }
        }
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_remote_sandbox_command(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        command: &str,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        binding: &crate::remote_sandbox::Binding,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<AgentToolResultNative, String> {
        use crate::remote_sandbox::{CommandOutcome, CommandState};
        let connection = connection_for_remote_target(&call.target, database, credentials)?;
        let outcome = crate::remote_sandbox::execute_command(
            database,
            binding,
            &connection,
            known_hosts_path,
            command,
            timeout,
            cancellation,
        );
        let mut result = completed_result(&context.request, call, effect, "", json!(null), false);
        match outcome {
            CommandOutcome::Confirmed {
                state,
                exit_code,
                stdout,
                stderr,
                truncated,
            } => {
                (result.status, result.summary) = match state {
                    CommandState::Exited => (
                        if exit_code == 0 {
                            AgentToolResultStatusNative::Completed
                        } else {
                            AgentToolResultStatusNative::Failed
                        },
                        format!("Remote sandbox command exited with status {exit_code}."),
                    ),
                    CommandState::Cancelled => (
                        AgentToolResultStatusNative::Cancelled,
                        "Remote sandbox cancellation and termination confirmed.".into(),
                    ),
                    CommandState::TimedOut => (
                        AgentToolResultStatusNative::TimedOut,
                        "Remote sandbox command timed out and termination was confirmed.".into(),
                    ),
                    CommandState::OutputLimit => (
                        AgentToolResultStatusNative::Failed,
                        "Remote sandbox command exceeded the output limit and was stopped.".into(),
                    ),
                };
                result.truncated = Some(truncated);
                result.data = Some(
                    json!({"channel":"direct","sandbox":"bubblewrap","state":state,"exitCode":exit_code,"stdout":stdout,"stderr":stderr,"terminationConfirmed":true,"truncated":truncated}),
                );
            }
            CommandOutcome::NotStarted(error) => {
                result.status = if cancellation.is_cancelled() {
                    AgentToolResultStatusNative::Cancelled
                } else {
                    AgentToolResultStatusNative::Failed
                };
                result.summary = error;
                result.data = Some(json!({"started":false,"sandbox":"bubblewrap"}));
            }
            CommandOutcome::Uncertain => {
                result.status = AgentToolResultStatusNative::Uncertain;
                result.summary = "SANDBOX_TERMINATION_UNCONFIRMED: the command may have started; inspect the remote workspace before continuing. Do not retry automatically.".into();
                result.data = Some(
                    json!({"sandbox":"bubblewrap","terminationConfirmed":false,"doNotRetry":true}),
                );
            }
        }
        Ok(result)
    }

    #[cfg(windows)]
    pub(super) fn windows_sandbox_binding(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        database: &Database,
    ) -> Result<Option<crate::agent_runtime::native::windows_sandbox::Workspace>, String> {
        if !context.windows_sandbox_required {
            return Ok(None);
        }
        database.require_agent_sandbox_enabled()?;
        let AgentToolTargetNative::Local { cwd: Some(cwd), .. } = &call.target else {
            return Err("WINDOWS_SANDBOX_DIRECT_REQUIRED".into());
        };
        if !is_allowed_local_sandbox_native_tool(call) {
            return Err("WINDOWS_SANDBOX_DIRECT_REQUIRED".into());
        }
        crate::agent_runtime::native::windows_sandbox::Workspace::open(
            &self.checkpoint_root()?,
            Path::new(cwd),
        )
        .map(Some)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn mac_sandbox_binding(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        database: &Database,
    ) -> Result<Option<crate::agent_runtime::native::mac_sandbox::Workspace>, String> {
        if !context.mac_sandbox_required {
            return Ok(None);
        }
        database.require_agent_sandbox_enabled()?;
        let AgentToolTargetNative::Local { cwd: Some(cwd), .. } = &call.target else {
            return Err("MAC_SANDBOX_DIRECT_REQUIRED".into());
        };
        if !is_allowed_local_sandbox_native_tool(call) {
            return Err("MAC_SANDBOX_DIRECT_REQUIRED".into());
        }
        let (home, resource_dir) = self.mac_sandbox_paths()?;
        crate::agent_runtime::native::mac_sandbox::Workspace::open(
            &home,
            Path::new(cwd),
            resource_dir.as_deref(),
        )
        .map(Some)
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn is_allowed_local_sandbox_native_tool(call: &AgentToolCallNative) -> bool {
    if call.tool_name == "exec_command" {
        return call.arguments["background"] != true && call.arguments["elevated"] != true;
    }
    matches!(
        call.tool_name.as_str(),
        "read_file"
            | "list_directory"
            | "search_text"
            | "write_file"
            | "edit_file"
            | "apply_patch"
            | "trash_file"
    )
}

fn remote_command_with_cwd(
    command: &str,
    cwd: Option<&str>,
    shell: Option<crate::terminal_integration::TerminalShellKind>,
) -> String {
    let Some(cwd) = cwd.filter(|value| {
        !value.is_empty() && !value.contains('\0') && !value.contains('\n') && !value.contains('\r')
    }) else {
        return command.to_string();
    };
    if matches!(
        shell,
        Some(
            crate::terminal_integration::TerminalShellKind::WindowsPowerShell
                | crate::terminal_integration::TerminalShellKind::PowerShell7
        )
    ) {
        let literal = cwd.replace('\'', "''");
        return format!("Set-Location -LiteralPath '{literal}'; if ($?) {{\n{command}\n}}");
    }
    if matches!(
        shell,
        Some(crate::terminal_integration::TerminalShellKind::Unsupported)
    ) {
        return command.to_string();
    }
    // Avoid quoting unexpanded tilde paths (`cd -- '~'` fails) or Windows drive paths when shell is unknown.
    let looks_like_windows_drive = cwd.len() >= 3
        && cwd.as_bytes()[0].is_ascii_alphabetic()
        && cwd.as_bytes()[1] == b':'
        && matches!(cwd.as_bytes()[2], b'\\' | b'/');
    if cwd.starts_with('~') || (shell.is_none() && looks_like_windows_drive) {
        return command.to_string();
    }
    let Ok(quoted) = shlex::try_quote(cwd) else {
        return command.to_string();
    };
    format!("cd -- {quoted} && {{\n{command}\n}}")
}

fn validate_frozen_cwd(
    target: &AgentToolTargetNative,
    argument_cwd: Option<&str>,
) -> Result<(), String> {
    match target {
        AgentToolTargetNative::Local { cwd, .. } if cwd.as_deref() != argument_cwd => {
            Err("exec_command cwd differs from the frozen target".into())
        }
        AgentToolTargetNative::Remote { .. } if argument_cwd.is_some() => {
            Err("Native remote Direct Exec does not accept an unfrozen cwd".into())
        }
        _ => Ok(()),
    }
}

fn exec_process_result(
    request: &AgentRequestNative,
    call: &AgentToolCallNative,
    effect: &AgentObservedEffectNative,
    snapshot: ProcessSnapshotNative,
    background: bool,
) -> AgentToolResultNative {
    let status = if snapshot
        .error
        .as_deref()
        .is_some_and(|error| error.starts_with("EXECUTION_OUTCOME_UNKNOWN:"))
    {
        AgentToolResultStatusNative::Uncertain
    } else if background && snapshot.state == ProcessLifecycleNative::Running {
        AgentToolResultStatusNative::Completed
    } else {
        match snapshot.state {
            ProcessLifecycleNative::Running | ProcessLifecycleNative::Failed => {
                AgentToolResultStatusNative::Failed
            }
            ProcessLifecycleNative::Exited => AgentToolResultStatusNative::Completed,
            ProcessLifecycleNative::Cancelled => AgentToolResultStatusNative::Cancelled,
            ProcessLifecycleNative::TimedOut => AgentToolResultStatusNative::TimedOut,
        }
    };
    let truncated = snapshot.stdout_truncated || snapshot.stderr_truncated;
    AgentToolResultNative {
        request_id: request.request_id.clone(),
        call_id: call.call_id.clone(),
        tool_name: call.tool_name.clone(),
        target_id: call.target.target_id().to_string(),
        status,
        summary: snapshot.error.unwrap_or_else(|| {
            if snapshot.state == ProcessLifecycleNative::Running {
                "Direct command is running under a native process handle.".into()
            } else {
                format!("Direct command reached {:?}.", snapshot.state)
            }
        }),
        data: Some(json!({
            "channel": "direct",
            "state": if snapshot.state == ProcessLifecycleNative::Running { "running" } else { "exited" },
            "terminationConfirmed": snapshot.termination_confirmed,
            "exitCode": snapshot.exit_code,
            "stdout": snapshot.stdout,
            "stderr": snapshot.stderr,
            "processHandle": snapshot.process_handle,
            "durationMs": snapshot.completed_at_unix_ms.unwrap_or_else(current_unix_ms)
                .saturating_sub(snapshot.started_at_unix_ms),
            "truncated": truncated,
        })),
        artifacts: Vec::new(),
        effects: vec![effect.clone()],
        truncated: Some(truncated),
    }
}

#[cfg(test)]
mod tests {
    use super::remote_command_with_cwd;
    use crate::terminal_integration::TerminalShellKind;

    #[test]
    fn remote_command_with_cwd_quotes_posix_paths_and_preserves_multiline_scripts() {
        assert_eq!(
            remote_command_with_cwd(
                "sleep 1\nfind . -maxdepth 1",
                Some("/var/log/my app's dir"),
                Some(TerminalShellKind::Bash),
            ),
            "cd -- \"/var/log/my app's dir\" && {\nsleep 1\nfind . -maxdepth 1\n}"
        );
    }

    #[test]
    fn remote_command_with_cwd_supports_powershell_and_skips_invalid_values() {
        assert_eq!(
            remote_command_with_cwd(
                "Get-ChildItem",
                Some("C:\\Users\\O'Neil\\work"),
                Some(TerminalShellKind::PowerShell7),
            ),
            "Set-Location -LiteralPath 'C:\\Users\\O''Neil\\work'; if ($?) {\nGet-ChildItem\n}"
        );
        assert_eq!(
            remote_command_with_cwd("pwd", None, Some(TerminalShellKind::Bash)),
            "pwd"
        );
        assert_eq!(
            remote_command_with_cwd("pwd", Some("/tmp\nrm -rf /"), Some(TerminalShellKind::Bash)),
            "pwd"
        );
        assert_eq!(
            remote_command_with_cwd(
                "pwd",
                Some("/tmp/work"),
                Some(TerminalShellKind::Unsupported)
            ),
            "pwd"
        );
        assert_eq!(
            remote_command_with_cwd("pwd", Some("~/work"), Some(TerminalShellKind::Bash)),
            "pwd"
        );
        assert_eq!(
            remote_command_with_cwd("pwd", Some("C:\\Users\\work"), None),
            "pwd"
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn local_sandbox_tool_policy_allows_bounded_file_tools_and_blocks_unsafe_tools() {
        use super::{is_allowed_local_sandbox_native_tool, json};
        use crate::agent_runtime::{AgentToolCallNative, AgentToolTargetNative};
        let make_call = |tool_name: &str, arguments: serde_json::Value| AgentToolCallNative {
            request_id: "req-1".into(),
            call_id: "call-1".into(),
            tool_name: tool_name.into(),
            arguments,
            target: AgentToolTargetNative::Local {
                target_id: "local-1".into(),
                session_id: "term-1".into(),
                cwd: Some("/tmp/ws".into()),
            },
            capability_id: "cap-1".into(),
        };
        assert!(is_allowed_local_sandbox_native_tool(&make_call(
            "exec_command",
            json!({ "command": "git status" })
        )));
        for tool in [
            "read_file",
            "list_directory",
            "search_text",
            "write_file",
            "edit_file",
            "apply_patch",
            "trash_file",
        ] {
            assert!(
                is_allowed_local_sandbox_native_tool(&make_call(tool, json!({}))),
                "expected {tool} to be allowed in local sandbox"
            );
        }
        assert!(!is_allowed_local_sandbox_native_tool(&make_call(
            "exec_command",
            json!({ "command": "sleep 10", "background": true })
        )));
        assert!(!is_allowed_local_sandbox_native_tool(&make_call(
            "exec_command",
            json!({ "command": "id", "elevated": true })
        )));
        for blocked in ["probe_http", "transfer_file", "terminal_execute"] {
            assert!(
                !is_allowed_local_sandbox_native_tool(&make_call(blocked, json!({}))),
                "expected {blocked} to be rejected in local sandbox"
            );
        }
    }
}
