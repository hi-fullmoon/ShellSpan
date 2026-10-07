//! Restricted SSH Direct: encrypted startup input, signed ready receipt and
//! source-bound lifetime. Host Direct retains its existing worker.
use super::*;
use std::collections::VecDeque;

fn queued_control(
    process: &ManagedProcessNative,
    controls: &mpsc::Receiver<ProcessControlNative>,
    pending: &mut VecDeque<ProcessControlNative>,
    deadline: Instant,
) -> Option<ProcessLifecycleNative> {
    while let Ok(control) = controls.try_recv() {
        match control {
            ProcessControlNative::Kill { signal } => {
                if let Some(job) = process.remote_sandbox.get() {
                    job.select_signal(signal);
                }
                return Some(ProcessLifecycleNative::Cancelled);
            }
            ProcessControlNative::Write { ref input, .. }
                if pending.len() < 2 && input.len() <= 64 * 1024 =>
            {
                pending.push_back(control)
            }
            ProcessControlNative::Write { response, .. } => {
                let _ = response.send(Err("Remote startup input capacity reached".into()));
            }
        }
    }
    if Instant::now() >= deadline {
        return Some(ProcessLifecycleNative::TimedOut);
    }
    if process.snapshot().is_err() {
        return Some(ProcessLifecycleNative::Failed);
    }
    None
}

fn reject_pending(pending: VecDeque<ProcessControlNative>) {
    for control in pending {
        if let ProcessControlNative::Write { response, .. } = control {
            let _ = response.send(Err("Remote startup stopped before input delivery".into()));
        }
    }
}

pub(super) fn run(
    process: Arc<ManagedProcessNative>,
    start: RemoteProcessStartNative,
    controls: mpsc::Receiver<ProcessControlNative>,
) {
    let Some(job) = start.remote_sandbox.as_ref() else {
        return;
    };
    let deadline = Instant::now() + start.timeout;
    let admission = match start
        .admission
        .as_ref()
        .map(|gate| gate.enter())
        .transpose()
    {
        Ok(lease) => lease,
        Err(error) => {
            process.finish(ProcessLifecycleNative::Failed, None, true, Some(error));
            return;
        }
    };
    let mut pending = VecDeque::new();
    if let Some(lifecycle) = queued_control(&process, &controls, &mut pending, deadline) {
        reject_pending(pending);
        process.finish(lifecycle, None, true, None);
        return;
    }
    if !job.valid() {
        reject_pending(pending);
        process.finish(
            ProcessLifecycleNative::Failed,
            None,
            true,
            Some("sandboxAuthorizationInvalid: remote binding changed before startup".into()),
        );
        return;
    }
    let session = match job.open_session() {
        Ok(session) => session,
        Err(error) => {
            reject_pending(pending);
            process.finish(ProcessLifecycleNative::Failed, None, true, Some(error));
            return;
        }
    };
    if !job.valid()
        || start
            .admission
            .as_ref()
            .is_some_and(|gate| gate.ensure_open().is_err())
    {
        reject_pending(pending);
        process.finish(
            ProcessLifecycleNative::Failed,
            None,
            true,
            Some("sandboxAuthorizationInvalid: remote startup was revoked".into()),
        );
        return;
    }
    if let Some(lifecycle) = queued_control(&process, &controls, &mut pending, deadline) {
        reject_pending(pending);
        process.finish(lifecycle, None, true, None);
        return;
    }
    if let Err(error) = job.check_host_key(&session.target) {
        reject_pending(pending);
        process.finish(ProcessLifecycleNative::Failed, None, true, Some(error));
        return;
    }
    session.target.set_timeout(2000);
    let mut channel = match session.target.channel_session() {
        Ok(channel) => channel,
        Err(_) => {
            reject_pending(pending);
            process.finish(
                ProcessLifecycleNative::Failed,
                None,
                true,
                Some("sandboxRemoteChannelUnavailable".into()),
            );
            return;
        }
    };
    let command = match job.launch_command() {
        Ok(command) => command,
        Err(error) => {
            reject_pending(pending);
            process.finish(ProcessLifecycleNative::Failed, None, true, Some(error));
            return;
        }
    };
    let header = match job.launch_input() {
        Ok(header) => header,
        Err(error) => {
            reject_pending(pending);
            process.finish(ProcessLifecycleNative::Failed, None, true, Some(error));
            return;
        }
    };
    if crate::execution::start_ssh_exec_channel(&mut channel, &command).is_err() {
        reject_pending(pending);
        process.finish(
            ProcessLifecycleNative::Failed,
            None,
            true,
            Some("sandboxRemoteControllerStartFailed".into()),
        );
        return;
    }
    let _mode = RemoteBlockingModeGuard::nonblocking(&session.target);
    // No user command can start until the complete JSON line is delivered.
    // A partial transport result once delivery starts is deliberately unknown.
    process.mark_admission(AgentExecutionAdmission::Unknown);
    let mut offset = 0;
    while offset < header.len() {
        let stopped = queued_control(&process, &controls, &mut pending, deadline);
        if stopped.is_some()
            || !job.valid()
            || start
                .admission
                .as_ref()
                .is_some_and(|gate| gate.ensure_open().is_err())
        {
            let confirmed = job.cleanup(true);
            reject_pending(pending);
            process.finish(
                stopped.unwrap_or(ProcessLifecycleNative::Failed),
                None,
                confirmed,
                Some("sandboxRemoteStartupStopped".into()),
            );
            return;
        }
        match channel.write(&header[offset..]) {
            Ok(0) => break,
            Ok(n) => offset += n,
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) =>
            {
                thread::sleep(PROCESS_POLL_INTERVAL)
            }
            Err(_) => break,
        }
    }
    if offset != header.len() {
        let confirmed = job.cleanup(true);
        reject_pending(pending);
        process.finish(
            ProcessLifecycleNative::Failed,
            None,
            confirmed,
            Some("sandboxRemoteStartupInputUnconfirmed".into()),
        );
        return;
    }
    loop {
        let stopped = queued_control(&process, &controls, &mut pending, deadline);
        if stopped.is_some()
            || !job.valid()
            || start
                .admission
                .as_ref()
                .is_some_and(|gate| gate.ensure_open().is_err())
        {
            let confirmed = job.cleanup(true);
            reject_pending(pending);
            process.finish(
                stopped.unwrap_or(ProcessLifecycleNative::Failed),
                None,
                confirmed,
                Some("sandboxRemoteStartupStopped".into()),
            );
            return;
        }
        if job.ready().unwrap_or(false) {
            break;
        }
        if channel.eof() {
            let confirmed = job.cleanup(true);
            reject_pending(pending);
            process.finish(
                ProcessLifecycleNative::Failed,
                None,
                confirmed,
                Some("sandboxRemoteReadyReceiptMissing".into()),
            );
            return;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
    process.mark_admission(AgentExecutionAdmission::Started);
    drop(admission);
    loop {
        if !job.valid() {
            let confirmed = job.cleanup(true);
            reject_pending(pending);
            process.finish(
                ProcessLifecycleNative::Failed,
                None,
                confirmed,
                Some("sandboxAuthorizationInvalid: remote connection binding changed".into()),
            );
            return;
        }
        if Instant::now() >= deadline {
            let confirmed = job.cleanup(true);
            reject_pending(pending);
            process.finish(ProcessLifecycleNative::TimedOut, None, confirmed, None);
            return;
        }
        if start
            .admission
            .as_ref()
            .is_some_and(|gate| gate.ensure_open().is_err())
        {
            let confirmed = job.cleanup(true);
            reject_pending(pending);
            process.finish(
                ProcessLifecycleNative::Cancelled,
                None,
                confirmed,
                Some("agentRuntimeShuttingDown: remote execution stopped".into()),
            );
            return;
        }
        if let Some(lifecycle) = queued_control(&process, &controls, &mut pending, deadline) {
            let confirmed = job.cleanup(true);
            reject_pending(pending);
            process.finish(lifecycle, None, confirmed, None);
            return;
        }
        while let Some(control) = pending.pop_front().or_else(|| controls.try_recv().ok()) {
            match control {
                ProcessControlNative::Write {
                    input,
                    close,
                    response,
                } => {
                    let result = write_remote_input(&mut channel, input.as_bytes(), close);
                    let _ = response.send(result);
                }
                ProcessControlNative::Kill { signal } => {
                    let confirmed = job.cleanup_with_signal(true, signal);
                    let _ = channel.close();
                    process.finish(ProcessLifecycleNative::Cancelled, None, confirmed, None);
                    return;
                }
            }
        }
        if read_remote_stream(&mut channel, &process, true).is_err()
            || read_remote_stream(&mut channel.stderr(), &process, false).is_err()
        {
            let confirmed = job.cleanup(true);
            process.finish(
                ProcessLifecycleNative::Failed,
                None,
                confirmed,
                Some("sandboxRemoteTransportFailed".into()),
            );
            return;
        }
        if channel.eof() {
            let completion = job.completion();
            let confirmed = job.cleanup(false);
            match completion {
                Ok(data) if confirmed => {
                    let code = data["exitCode"]
                        .as_i64()
                        .and_then(|code| i32::try_from(code).ok());
                    let lifecycle = if data["state"] == "timedOut" {
                        ProcessLifecycleNative::TimedOut
                    } else if data["state"] == "cancelled" {
                        ProcessLifecycleNative::Cancelled
                    } else {
                        ProcessLifecycleNative::Exited
                    };
                    process.finish(lifecycle, code, true, None);
                }
                _ => process.finish(
                    ProcessLifecycleNative::Failed,
                    None,
                    false,
                    Some("sandboxRemoteCleanupUnconfirmed".into()),
                ),
            }
            return;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}
