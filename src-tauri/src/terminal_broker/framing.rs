use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RawFrameAcceptance {
    Accepted,
    Duplicate,
}

pub(super) fn accept_raw_frame(
    record: &mut SessionRecord,
    frame: TerminalRawOutputFrame,
    config: TerminalBrokerConfig,
    counters: &TerminalRolloutCounters,
) -> Result<RawFrameAcceptance, String> {
    if !record.open {
        return Err("TERMINAL_BROKER_GENERATION_CLOSED".into());
    }
    if frame.protocol_version != 1
        || frame.frame_type != "rawOutput"
        || frame.terminal_session_id != record.terminal_session_id
        || frame.terminal_generation != record.terminal_generation
    {
        return Err("TERMINAL_BROKER_FRAME_IDENTITY_MISMATCH".into());
    }
    if frame.bytes.is_empty() || frame.bytes.len() > MAX_FRAME_BYTES {
        return Err("TERMINAL_BROKER_FRAME_SIZE_INVALID".into());
    }
    if frame.sequence < record.next_output_sequence {
        let replay = replay_from_record(record, frame.sequence, 1, MAX_FRAME_BYTES, config)
            .map_err(|error| {
                if error.starts_with("TERMINAL_BROKER_REPLAY_UNAVAILABLE:") {
                    "TERMINAL_BROKER_DUPLICATE_OUTSIDE_REPLAY_WINDOW".to_string()
                } else {
                    error
                }
            })?;
        return match replay.frames.first() {
            Some(retained) if retained == &frame => Ok(RawFrameAcceptance::Duplicate),
            Some(_) => Err("TERMINAL_BROKER_CONFLICTING_DUPLICATE".into()),
            None => Err("TERMINAL_BROKER_DUPLICATE_OUTSIDE_REPLAY_WINDOW".into()),
        };
    }
    if frame.sequence > record.next_output_sequence {
        record.subscribers.display.status = TerminalSubscriberStatus::Gap;
        record.subscribers.capture.status = TerminalSubscriberStatus::Gap;
        record.subscribers.integration.status = TerminalSubscriberStatus::Gap;
        record.subscribers.screen.status = TerminalSubscriberStatus::Gap;
        return Err(format!(
            "TERMINAL_BROKER_OUTPUT_GAP: expected sequence {}, received {}",
            record.next_output_sequence, frame.sequence
        ));
    }
    if frame.byte_offset != record.next_byte_offset {
        return Err(format!(
            "TERMINAL_BROKER_BYTE_OFFSET_MISMATCH: expected offset {}, received {}",
            record.next_byte_offset, frame.byte_offset
        ));
    }

    let next_output_sequence = record
        .next_output_sequence
        .checked_add(1)
        .ok_or_else(counter_exhausted)?;
    let next_byte_offset = record
        .next_byte_offset
        .checked_add(frame.bytes.len() as u64)
        .ok_or_else(counter_exhausted)?;
    if next_output_sequence > JAVASCRIPT_MAX_SAFE_INTEGER
        || next_byte_offset > JAVASCRIPT_MAX_SAFE_INTEGER
    {
        return Err(counter_exhausted());
    }

    // The display branch is recorded first and receives only the immutable
    // frame bytes. Derived subscribers own separate state and cannot replace
    // the bytes already assigned to display.
    record.subscribers.display.observe(&frame)?;

    record.subscribers.capture.observe(&frame)?;
    if !record.capture_truncated {
        let remaining = config
            .capture_max_bytes
            .saturating_sub(record.capture.len());
        let accepted = remaining.min(frame.bytes.len());
        record.capture.extend_from_slice(&frame.bytes[..accepted]);
        if accepted < frame.bytes.len() {
            record.capture_truncated = true;
            record.subscribers.capture.status = TerminalSubscriberStatus::Truncated;
            TerminalRolloutCounters::increment(&counters.truncation);
        }
    }
    record.subscribers.integration.observe(&frame)?;
    record.subscribers.screen.observe(&frame)?;
    if let Some(screen) = &mut record.screen_model {
        screen.observe(&frame)?;
    }
    record.last_output_at = Instant::now();
    if let Some(command) = &record.active_command {
        command.capture(&frame)?;
    }

    record.next_output_sequence = next_output_sequence;
    record.next_byte_offset = next_byte_offset;

    record.replay_bytes = record.replay_bytes.saturating_add(frame.bytes.len());
    record.replay.push_back(frame);
    while record.replay.len() > config.replay_max_frames
        || record.replay_bytes > config.replay_max_bytes
    {
        if let Some(evicted) = record.replay.pop_front() {
            record.replay_bytes = record.replay_bytes.saturating_sub(evicted.bytes.len());
        } else {
            break;
        }
    }
    Ok(RawFrameAcceptance::Accepted)
}

pub(super) fn terminal_wait_scalar_reason(
    record: &SessionRecord,
    through_output_sequence: u64,
    screen_version: u64,
    request: &TerminalWaitRequest,
) -> Option<TerminalWaitReason> {
    if request
        .after_lifecycle_sequence
        .is_some_and(|sequence| record.integration_event_sequence > sequence)
    {
        return Some(TerminalWaitReason::LifecycleObserved);
    }
    if request
        .after_output_sequence
        .is_some_and(|sequence| through_output_sequence > sequence)
    {
        return Some(TerminalWaitReason::OutputObserved);
    }
    if request
        .after_screen_version
        .is_some_and(|version| screen_version > version)
    {
        return Some(TerminalWaitReason::ScreenChanged);
    }
    if request
        .idle
        .is_some_and(|idle| record.last_output_at.elapsed() >= idle)
    {
        return Some(TerminalWaitReason::Idle);
    }
    None
}

pub(super) fn terminal_wait_text_matches(
    snapshot: &TerminalScreenSnapshot,
    text: &str,
    case_sensitive: bool,
    needle_lower: Option<&str>,
) -> bool {
    if case_sensitive {
        snapshot.content.iter().any(|row| row.contains(text))
    } else {
        let owned;
        let needle = match needle_lower {
            Some(needle) => needle,
            None => {
                owned = text.to_lowercase();
                &owned
            }
        };
        snapshot
            .content
            .iter()
            .any(|row| row.to_lowercase().contains(needle))
    }
}

pub(super) fn replay_from_record(
    record: &SessionRecord,
    from_sequence: u64,
    max_frames: usize,
    max_bytes: usize,
    config: TerminalBrokerConfig,
) -> Result<TerminalReplayBatch, String> {
    let first_retained = record
        .replay
        .front()
        .map(|frame| frame.sequence)
        .unwrap_or(record.next_output_sequence);
    if from_sequence < first_retained {
        return Err(format!(
            "TERMINAL_BROKER_REPLAY_UNAVAILABLE: first retained sequence is {first_retained}"
        ));
    }
    if from_sequence > record.next_output_sequence {
        return Err(format!(
            "TERMINAL_BROKER_OUTPUT_GAP: next sequence is {}",
            record.next_output_sequence
        ));
    }
    let frame_limit = max_frames.max(1).min(config.replay_max_frames);
    let byte_limit = max_bytes.max(1).min(config.replay_max_bytes);
    let mut frames = Vec::new();
    let mut bytes = 0_usize;
    for frame in record
        .replay
        .iter()
        .filter(|frame| frame.sequence >= from_sequence)
    {
        if frames.len() >= frame_limit || bytes.saturating_add(frame.bytes.len()) > byte_limit {
            break;
        }
        bytes = bytes.saturating_add(frame.bytes.len());
        frames.push(frame.clone());
    }
    let through_sequence = frames
        .last()
        .map(|frame| frame.sequence)
        .unwrap_or(from_sequence.saturating_sub(1));
    Ok(TerminalReplayBatch {
        has_more: through_sequence.saturating_add(1) < record.next_output_sequence,
        frames,
        through_sequence,
    })
}

#[cfg(test)]
pub(super) fn validate_input(
    record: &SessionRecord,
    request: &TerminalInputRequest,
) -> Result<TerminalInputReceipt, String> {
    validate_input_fields(
        record,
        &request.terminal_session_id,
        request.terminal_generation,
        &request.lease_id,
        request.input_sequence,
        &request.source,
        request.input_kind,
        request.bytes.len(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn validate_input_fields(
    record: &SessionRecord,
    terminal_session_id: &str,
    terminal_generation: u64,
    lease_id: &str,
    input_sequence: u64,
    source: &TerminalBrokerInputSource,
    input_kind: TerminalInputKind,
    byte_len: usize,
) -> Result<TerminalInputReceipt, String> {
    if !record.open {
        return Err("TERMINAL_BROKER_GENERATION_CLOSED".into());
    }
    if terminal_session_id != record.terminal_session_id
        || terminal_generation != record.terminal_generation
    {
        return Err("TERMINAL_BROKER_STALE_GENERATION".into());
    }
    let lease = record
        .lease
        .as_ref()
        .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
    if lease_id != lease.lease_id {
        return Err("TERMINAL_BROKER_STALE_LEASE".into());
    }
    if input_sequence != record.next_input_sequence {
        return Err(format!(
            "TERMINAL_BROKER_STALE_INPUT: expected sequence {}, received {}",
            record.next_input_sequence, input_sequence
        ));
    }
    if byte_len == 0 || byte_len > MAX_FRAME_BYTES {
        return Err("TERMINAL_BROKER_INPUT_SIZE_INVALID".into());
    }

    let source_owner_id = match (source, &lease.owner) {
        (TerminalBrokerInputSource::User, TerminalLeaseOwner::User { owner_id }) => {
            owner_id.clone()
        }
        (
            TerminalBrokerInputSource::Agent {
                agent_session_id,
                task_id,
                operation_id,
            },
            TerminalLeaseOwner::Agent {
                agent_session_id: expected_agent,
                task_id: expected_task,
                operation_id: expected_operation,
                owner_id,
            },
        ) if agent_session_id == expected_agent
            && task_id == expected_task
            && operation_id == expected_operation =>
        {
            owner_id.clone()
        }
        (
            TerminalBrokerInputSource::System { operation_id },
            TerminalLeaseOwner::Agent {
                operation_id: expected_operation,
                ..
            }
            | TerminalLeaseOwner::Revoking {
                operation_id: expected_operation,
                ..
            },
        ) if operation_id == expected_operation
            && matches!(
                input_kind,
                TerminalInputKind::Interrupt | TerminalInputKind::SystemControl
            ) =>
        {
            SYSTEM_OWNER_ID.to_string()
        }
        (
            TerminalBrokerInputSource::Agent {
                agent_session_id,
                task_id,
                operation_id,
            },
            TerminalLeaseOwner::Revoking {
                agent_session_id: expected_agent,
                task_id: expected_task,
                operation_id: expected_operation,
                owner_id,
            },
        ) if input_kind == TerminalInputKind::NativeDraftClear
            && agent_session_id == expected_agent
            && task_id == expected_task
            && operation_id == expected_operation =>
        {
            owner_id.clone()
        }
        (TerminalBrokerInputSource::System { .. }, _) => {
            return Err("TERMINAL_BROKER_SYSTEM_CONTROL_NOT_SCOPED".into());
        }
        _ => return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into()),
    };

    Ok(TerminalInputReceipt {
        terminal_session_id: record.terminal_session_id.clone(),
        terminal_generation: record.terminal_generation,
        lease_id: lease.lease_id.clone(),
        input_sequence,
        source_owner_id,
        accepted_bytes: byte_len,
    })
}

pub(super) fn user_lease(revision: u64) -> TerminalLeaseSnapshot {
    TerminalLeaseSnapshot {
        lease_id: opaque_id("lease"),
        revision,
        owner: TerminalLeaseOwner::User {
            owner_id: USER_OWNER_ID.to_string(),
        },
    }
}

pub(super) fn validate_prepared_shell_job(
    record: &SessionRecord,
    prepared: &crate::terminal_jobs::PreparedShellJob,
    operation: &str,
) -> Result<(), String> {
    validate_prepared_shell_job_binding(record, prepared, operation, true)
}
pub(super) fn validate_prepared_shell_job_binding(
    record: &SessionRecord,
    prepared: &crate::terminal_jobs::PreparedShellJob,
    operation: &str,
    require_owner: bool,
) -> Result<(), String> {
    let job = &prepared.job;
    let expected = if operation == job.operation_id && prepared.source == job.command_line {
        crate::terminal_jobs::shell_submission(&job.command_line, &job.process_handle, job.shell)?
    } else if prepared.source
        == crate::terminal_jobs::control_submission(&job.process_handle, job.shell, false)?
    {
        crate::terminal_jobs::control_submission(&job.process_handle, job.shell, false)?
    } else if prepared.source
        == crate::terminal_jobs::control_submission(&job.process_handle, job.shell, true)?
    {
        crate::terminal_jobs::control_submission(&job.process_handle, job.shell, true)?
    } else {
        return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
    };
    if prepared.line != expected {
        return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
    }
    require_ready_integration(record)?;
    if !record.native_jobs || !record.native_checkpoints {
        return Err("TERMINAL_BACKGROUND_UNSUPPORTED".into());
    }
    if record.transport_session_id != job.transport_session_id
        || record.terminal_session_id != job.terminal_session_id
        || record.terminal_generation != job.terminal_generation
        || record.integration_id != job.integration_id
    {
        return Err("TERMINAL_JOB_STALE_BINDING".into());
    }
    let owner_matches = record.lease.as_ref().is_some_and(|lease| matches!(&lease.owner,
        TerminalLeaseOwner::Agent { agent_session_id, task_id, operation_id, .. } | TerminalLeaseOwner::Revoking { agent_session_id, task_id, operation_id, .. }
        if agent_session_id == &job.agent_session_id && task_id == &job.task_id && operation_id == operation));
    if require_owner && !owner_matches {
        return Err("TERMINAL_JOB_OWNER_MISMATCH".into());
    }
    Ok(())
}

pub(super) fn prepared_native_job(
    prepared: &crate::terminal_jobs::PreparedShellJob,
) -> Result<nip::JobExecution, String> {
    let handle = prepared.job.process_handle.clone();
    if prepared.source != prepared.line {
        return Ok(nip::JobExecution::Launch { handle });
    }
    let stop = prepared.source
        == crate::terminal_jobs::control_submission(&handle, prepared.job.shell, true)?;
    if !stop
        && prepared.source
            != crate::terminal_jobs::control_submission(&handle, prepared.job.shell, false)?
    {
        return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
    }
    Ok(nip::JobExecution::Control {
        handle,
        stop,
        nonce: prepared
            .native_control_nonce
            .clone()
            .ok_or("TERMINAL_NATIVE_CONTROL_NONCE_REQUIRED")?,
    })
}

pub(super) fn require_ready_integration(record: &SessionRecord) -> Result<(), String> {
    if record.integration_state == TerminalIntegrationState::Ready {
        Ok(())
    } else {
        Err("TERMINAL_INTEGRATION_NOT_READY".into())
    }
}

pub(super) fn validate_cwd(cwd: &str) -> Result<(), String> {
    if cwd.is_empty() || cwd.len() > 16_384 {
        Err("TERMINAL_INTEGRATION_INVALID_CWD".into())
    } else {
        Ok(())
    }
}

pub(super) fn degrade_record(record: &mut SessionRecord, reason: &str) -> Result<(), String> {
    record.integration_state = TerminalIntegrationState::Degraded;
    record.integration_reason = Some(reason.to_string());
    record.integration_id = None;
    record.prompt_ready = false;
    record.prompt_started = false;
    if let Some(command) = &record.active_command {
        let data = command.lock()?;
        if record.command_input_pending
            || data.source_may_be_enqueued
                && !data.lifecycle.ended()
                && !data.lifecycle.draft_cleared()
                && !data.lifecycle.source_rejected()
        {
            record.native_recovery_required = true;
            record.command_input_pending = true;
        }
        drop(data);
        settle_command_uncertain(command, record.next_output_sequence.saturating_sub(1));
    }
    advance_integration_state_revision(record)
}

pub(super) fn advance_integration_state_revision(record: &mut SessionRecord) -> Result<(), String> {
    let revision = record
        .integration_state_revision
        .checked_add(1)
        .ok_or_else(counter_exhausted)?;
    if revision > JAVASCRIPT_MAX_SAFE_INTEGER {
        return Err(counter_exhausted());
    }
    record.integration_state_revision = revision;
    Ok(())
}

pub(super) fn settle_command_from_integration(
    command: &TerminalCommandOperation,
    exit_code: i32,
    cwd: String,
    through_output_sequence: u64,
) -> Result<bool, String> {
    let mut data = command.lock()?;
    if data.native_protocol
        || data.lifecycle.submission_revoked() && !data.lifecycle.may_have_submitted()
    {
        return Ok(false);
    }
    if data.lifecycle.is_terminal() {
        return Ok(false);
    }
    if !matches!(
        data.state(),
        TerminalCommandState::Running | TerminalCommandState::CancelRequested
    ) {
        return Err("TERMINAL_COMMAND_END_OUT_OF_ORDER".into());
    }
    if data.lifecycle.requested_settlement().is_some() && data.interrupt_uncertain {
        TerminalRolloutCounters::increment(&command.counters.uncertainty);
        data.lifecycle.apply(CommandEvent::SettledUncertain)?;
    } else {
        data.lifecycle.apply(CommandEvent::LegacySettled)?;
    }
    data.exit_code = Some(exit_code);
    data.cwd = Some(cwd);
    data.capture_end_sequence = Some(
        data.capture_end_sequence
            .unwrap_or(through_output_sequence)
            .max(through_output_sequence),
    );
    data.revision = next_command_revision(data.revision)?;
    drop(data);
    command.notify();
    Ok(true)
}

pub(super) fn settle_command_uncertain(
    command: &TerminalCommandOperation,
    through_output_sequence: u64,
) -> bool {
    settle_command_after_loss(command, through_output_sequence, CommandEvent::ControlLost)
}

pub(super) fn settle_command_after_loss(
    command: &TerminalCommandOperation,
    through_output_sequence: u64,
    event: CommandEvent,
) -> bool {
    let Ok(mut data) = command.data.lock() else {
        return false;
    };
    if data.lifecycle.is_terminal() {
        return false;
    }
    if data.lifecycle.apply(event).is_err() {
        return false;
    }
    data.revision = data
        .revision
        .saturating_add(1)
        .min(JAVASCRIPT_MAX_SAFE_INTEGER);
    data.capture_end_sequence = Some(
        data.capture_end_sequence
            .unwrap_or(through_output_sequence)
            .max(through_output_sequence),
    );
    TerminalRolloutCounters::increment(&command.counters.uncertainty);
    drop(data);
    command.notify();
    true
}

pub(super) fn opaque_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

pub(super) fn parse_rollout_value(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" => Some(true),
        "0" | "false" | "off" => Some(false),
        _ => None,
    }
}

pub(super) fn trusted_rollout_value(
    environment_variable: &str,
    default_enabled: bool,
) -> Result<(bool, TerminalBrokerRolloutSource), String> {
    rollout_value_from_environment_result(
        environment_variable,
        std::env::var(environment_variable),
        default_enabled,
    )
}

pub(super) fn rollout_value_from_environment_result(
    environment_variable: &str,
    value: Result<String, std::env::VarError>,
    default_enabled: bool,
) -> Result<(bool, TerminalBrokerRolloutSource), String> {
    match value {
        Ok(value) => Ok((
            parse_rollout_value(&value).ok_or_else(|| {
                format!("{environment_variable} must be one of 1, 0, true, false, on, or off")
            })?,
            TerminalBrokerRolloutSource::Environment,
        )),
        Err(std::env::VarError::NotPresent) => {
            Ok((default_enabled, TerminalBrokerRolloutSource::Default))
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(format!("{environment_variable} must be valid Unicode"))
        }
    }
}

pub(super) fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if !crate::terminal_command::protocol::valid_identifier(value) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

pub(super) fn counter_exhausted() -> String {
    "TERMINAL_BROKER_COUNTER_EXHAUSTED: reconnect before the IPC safe-integer limit".into()
}
