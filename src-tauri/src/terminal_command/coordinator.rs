//! Protocol adapter onto the existing Broker-owned command. It owns no lifecycle
//! or lease facts and never writes a PTY implicitly. P2 supplies transport queues.
use super::*;
use crate::terminal_command::editors::{BASH_ACCEPT_KEY, ZLE_ACCEPT_KEY};
use nip::{Envelope, Payload};

#[cfg(test)]
#[path = "coordinator_interrupt_tests.rs"]
mod interrupt_tests;

pub(crate) struct NativeInputCoordinator {
    broker: TerminalSessionBroker,
    transport: String,
    accept_key: &'static [u8],
    pub(crate) operation: Arc<TerminalCommandOperation>,
    requests: HashMap<&'static str, String>,
    receipts: HashMap<&'static str, String>,
    deadline: Option<Instant>,
    interrupt_before_start_deadline: Option<Instant>,
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    readonly_first_partial: Option<String>,
}

impl PendingSshTerminal {
    pub(crate) fn register_native_channel(
        &mut self,
        profile: crate::terminal_command::registration::VerifiedNativeProfile,
    ) -> Result<nip::ConnectionEnvelope, String> {
        self.record.register_native_channel(profile)
    }

    pub(crate) fn accept_native_capabilities(
        &mut self,
        message: &nip::ConnectionEnvelope,
    ) -> Result<(), String> {
        self.record.accept_native_capabilities(message)
    }
}

impl SessionRecord {
    fn register_native_channel(
        &mut self,
        profile: crate::terminal_command::registration::VerifiedNativeProfile,
    ) -> Result<nip::ConnectionEnvelope, String> {
        let record = self;
        if record.input_mode != InputMode::NativeInline
            || record.integration_state != TerminalIntegrationState::Initializing
            || record.integration_id.is_some()
            || record.active_command.is_some()
        {
            return Err("TERMINAL_NATIVE_INITIALIZATION_REJECTED".into());
        }
        let connection = nip::ConnectionIdentity {
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            control_id: opaque_id("native-control"),
        };
        let request_id = opaque_id("native-probe");
        record.integration_id = Some(connection.control_id.clone());
        record.integration_shell = Some(profile.shell());
        record.native_profile = Some(profile);
        record.native_probe_request_id = Some(request_id.clone());
        Ok(nip::ConnectionEnvelope {
            protocol: nip::PROTOCOL.into(),
            request_id,
            connection,
            payload: nip::ConnectionPayload::Probe,
        })
    }

    fn accept_native_capabilities(
        &mut self,
        message: &nip::ConnectionEnvelope,
    ) -> Result<(), String> {
        message.validate().map_err(wire_error)?;
        let nip::ConnectionPayload::Capabilities {
            profile,
            native_inline,
            source_echo,
            atomic_handoff,
            complete_proof,
            draft_clear,
            inband_display,
            editor_empty,
        } = &message.payload
        else {
            return Err("TERMINAL_NATIVE_UNEXPECTED_MESSAGE".into());
        };
        let record = self;
        if record.input_mode != InputMode::NativeInline
            || record.integration_state != TerminalIntegrationState::Initializing
            || record.integration_id.as_ref() != Some(&message.connection.control_id)
            || record.native_probe_request_id.as_ref() != Some(&message.request_id)
            || record.terminal_session_id != message.connection.terminal_session_id
            || record.terminal_generation != message.connection.terminal_generation
        {
            return Err("TERMINAL_NATIVE_IDENTITY_MISMATCH".into());
        }
        let verified = record
            .native_profile
            .as_ref()
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let profile_matches = verified.matches(profile);
        let complete = [
            native_inline,
            source_echo,
            atomic_handoff,
            complete_proof,
            draft_clear,
            inband_display,
            editor_empty,
        ]
        .iter()
        .all(|flag| **flag);
        if !profile_matches || !complete {
            record.integration_state = TerminalIntegrationState::Unavailable;
            record.integration_reason = Some(
                if profile_matches {
                    "nativeCapabilityMissing"
                } else {
                    "nativeProfileMismatch"
                }
                .into(),
            );
            record.prompt_ready = false;
            record.native_input = false;
            advance_integration_state_revision(record)?;
            return Err(if profile_matches {
                "TERMINAL_NATIVE_CAPABILITY_UNAVAILABLE"
            } else {
                "TERMINAL_NATIVE_PROFILE_UNSUPPORTED"
            }
            .into());
        }
        record.integration_shell = Some(verified.shell());
        record.native_peer_profile = Some(profile.clone());
        record.integration_state = TerminalIntegrationState::Ready;
        record.prompt_ready = verified.shell() == TerminalShellKind::Bash;
        record.native_input = true;
        record.native_jobs = verified.supports_jobs();
        record.native_checkpoints = verified.capture_fence();
        record.native_typing = verified.capture_fence();
        record.native_private_control = verified.capture_fence();
        record.native_display_negotiated = true;
        advance_integration_state_revision(record)
    }
}

impl TerminalSessionBroker {
    pub(crate) fn accept_native_observation(
        &self,
        transport: &str,
        message: &nip::ConnectionEnvelope,
    ) -> Result<(), String> {
        message.validate().map_err(wire_error)?;
        let (attachment, slot) = self.lookup_session_slot(transport)?;
        let mut record = slot.lock_current(transport, &attachment)?;
        if record.input_mode != InputMode::NativeInline
            || record.integration_id.as_ref() != Some(&message.connection.control_id)
            || record.terminal_generation != message.connection.terminal_generation
            || record.terminal_session_id != message.connection.terminal_session_id
            || record.native_probe_request_id.as_ref() != Some(&message.request_id)
        {
            return Err("TERMINAL_NATIVE_IDENTITY_MISMATCH".into());
        }
        match &message.payload {
            nip::ConnectionPayload::EditorOptions {
                interactive_comments,
                native_jobs,
            } => {
                if record.integration_shell == Some(TerminalShellKind::Bash)
                    || record.native_peer_profile.is_none()
                    || !record.native_input
                    || record.integration_state != TerminalIntegrationState::Ready
                {
                    return Err("TERMINAL_NATIVE_UNEXPECTED_MESSAGE".into());
                }
                record.native_comments = *interactive_comments;
                record.native_jobs = *native_jobs
                    && record
                        .native_profile
                        .as_ref()
                        .is_some_and(|p| p.capture_fence());
                // Optional native jobs do not grant/revoke the authenticated
                // NIP input channel. A non-monitor Zsh can still run a native
                // foreground command with its complete input proof.
                advance_integration_state_revision(&mut record)?;
                Ok(())
            }
            nip::ConnectionPayload::Directory { cwd } => {
                validate_cwd(cwd)?;
                record.current_directory = Some(cwd.clone());
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    data.cwd = Some(cwd.clone());
                    data.revision = next_command_revision(data.revision)?;
                }
                advance_integration_state_revision(&mut record)?;
                Ok(())
            }
            nip::ConnectionPayload::DisplayCommand {
                command_id,
                cwd,
                exit_code,
            } => {
                let display = &record.display_command_lifecycle;
                // This observation never participates in admission, editor
                // readiness, or the Agent command execution state machine.
                if exit_code.is_some()
                    && *command_id == display.sequence
                    && display.running.is_some()
                {
                    record.report_display_command(cwd, *exit_code);
                } else if exit_code.is_none() && *command_id > display.sequence {
                    record.display_command_lifecycle.sequence = command_id - 1;
                    record.report_display_command(cwd, None);
                }
                Ok(())
            }
            nip::ConnectionPayload::JobObservation {
                handle,
                state: observed,
                exit_code,
            } => {
                let id = message.connection.control_id.clone();
                let event = TerminalIntegrationControlEvent::Job {
                    handle: handle.clone(),
                    state: observed.clone(),
                    exit_code: *exit_code,
                };
                drop(record);
                slot.notify();
                // Reuse the existing native-job contract reducer only. This
                // never registers TSP or forwards legacy S/E lifecycle events.
                self.accept_integration_event(transport, &id, event)
            }
            _ => Err("TERMINAL_NATIVE_UNEXPECTED_MESSAGE".into()),
        }
    }
    pub(crate) fn register_native_channel(
        &self,
        transport: &str,
        profile: crate::terminal_command::registration::VerifiedNativeProfile,
    ) -> Result<nip::ConnectionEnvelope, String> {
        let (attachment, slot) = self.lookup_session_slot(transport)?;
        let mut record = slot.lock_current(transport, &attachment)?;
        record.register_native_channel(profile)
    }
    /// Real private-channel Readline observations, including ordinary user input.
    /// No operation/Agent/task is invented for connection initialization.
    pub(crate) fn accept_native_readiness(
        &self,
        transport: &str,
        message: &nip::ConnectionEnvelope,
    ) -> Result<(), String> {
        message.validate().map_err(wire_error)?;
        let nip::ConnectionPayload::EditorReady {
            editor_empty: true,
            owned_draft_absent: true,
            after_command,
        } = &message.payload
        else {
            return Ok(());
        };
        let (attachment, slot) = self.lookup_session_slot(transport)?;
        let mut record = slot.lock_current(transport, &attachment)?;
        if record.input_mode != InputMode::NativeInline
            || record.integration_id.as_ref() != Some(&message.connection.control_id)
            || record.terminal_session_id != message.connection.terminal_session_id
            || record.terminal_generation != message.connection.terminal_generation
        {
            return Err("TERMINAL_NATIVE_IDENTITY_MISMATCH".into());
        }
        let mut ready_operation = None;
        if let Some(command) = &record.active_command {
            let mut data = command.lock()?;
            let rejected_prepare = data.native_prepare_rejected
                && !data.lifecycle.may_have_submitted()
                && !data.native_commit_armed;
            let finished = data.lifecycle.ended()
                || data.lifecycle.draft_cleared()
                || rejected_prepare
                || data.lifecycle.phase() == CommandPhase::Cancelled
                    && !data.source_may_be_enqueued;
            if !finished {
                return Ok(());
            }
            if data.source_may_be_enqueued && after_command.as_ref() != Some(&data.intent.identity)
            {
                return Ok(());
            }
            if !data.source_may_be_enqueued && after_command != &record.last_native_prepared {
                return Ok(());
            }
            if rejected_prepare && !data.lifecycle.is_terminal() {
                // The refusal alone never returns editing. This is the real
                // editor's empty/owned-draft-absent fact for this exact identity.
                data.lifecycle.apply(CommandEvent::PreparationFailed)?;
            }
            data.native_editor_ready_confirmed = true;
            data.revision = next_command_revision(data.revision)?;
            ready_operation = Some(Arc::clone(command));
        } else if after_command != &record.last_native_prepared {
            return Ok(());
        }
        record.prompt_ready = !record.native_recovery_required;
        record.command_input_pending =
            record.native_recovery_required || record.native_clear_pending.is_some();
        advance_integration_state_revision(&mut record)?;
        if record.prompt_ready {
            record.prompt_ready_revision = record.integration_state_revision;
        }
        drop(record);
        slot.notify();
        if let Some(operation) = ready_operation {
            operation.notify();
        }
        self.changed.notify_all();
        Ok(())
    }
    pub(crate) fn accept_native_capabilities(
        &self,
        transport: &str,
        message: &nip::ConnectionEnvelope,
    ) -> Result<(), String> {
        let (attachment, slot) = self.lookup_session_slot(transport)?;
        let mut record = slot.lock_current(transport, &attachment)?;
        record.accept_native_capabilities(message)?;
        drop(record);
        slot.notify();
        self.changed.notify_all();
        Ok(())
    }
    #[cfg(unix)]
    pub(crate) fn wait_native_initialization(
        &self,
        transport: &str,
        timeout: Duration,
    ) -> Result<Option<nip::DisplayBinding>, String> {
        let deadline = Instant::now() + timeout;
        let (attachment, slot) = self.lookup_session_slot(transport)?;
        let mut record = slot.lock_current(transport, &attachment)?;
        loop {
            if !record.open
                || record.terminal_generation != attachment.terminal_generation
                || record.transport_session_id != transport
            {
                return Err("TERMINAL_BROKER_STALE_GENERATION".into());
            }
            if record.integration_state != TerminalIntegrationState::Initializing
                || Instant::now() >= deadline
            {
                return Ok(record.native_display_binding());
            }
            let (next, _) = slot
                .changed
                .wait_timeout(record, deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "TERMINAL_BROKER_UNAVAILABLE")?;
            record = next;
        }
    }
    pub(crate) fn native_input_coordinator(
        &self,
        transport: &str,
        operation_id: &str,
    ) -> Result<NativeInputCoordinator, String> {
        let (attachment, slot) = self.lookup_session_slot(transport)?;
        let record = slot.lock_current(transport, &attachment)?;
        if record.input_mode != InputMode::NativeInline {
            return Err("TERMINAL_NATIVE_MODE_NOT_NEGOTIATED".into());
        }
        let operation = record
            .active_command
            .clone()
            .ok_or("TERMINAL_COMMAND_NOT_FOUND")?;
        {
            let mut data = operation.lock()?;
            if data.intent.identity.operation_id != operation_id {
                return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
            }
            if data.native_coordinator_claimed {
                return Err("TERMINAL_NATIVE_COORDINATOR_ALREADY_BOUND".into());
            }
            data.native_coordinator_claimed = true;
        }
        Ok(NativeInputCoordinator {
            broker: self.clone(),
            transport: transport.into(),
            accept_key: if record.integration_shell == Some(TerminalShellKind::Zsh) {
                ZLE_ACCEPT_KEY
            } else {
                BASH_ACCEPT_KEY
            },
            operation,
            requests: HashMap::new(),
            receipts: HashMap::new(),
            deadline: None,
            interrupt_before_start_deadline: None,
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            readonly_first_partial: None,
        })
    }
}

impl NativeInputCoordinator {
    fn stop_wait_finished(&self) -> Result<bool, String> {
        let data = self.operation.lock()?;
        let lifecycle = &data.lifecycle;
        // Takeover can release the lease after the stop wait times out. The
        // retained operation still accepts late receipts, but a later Agent
        // stop must not require the old lease or send any further input.
        Ok(lifecycle.ended()
            || lifecycle.draft_cleared()
            || lifecycle.is_terminal() && lifecycle.requested_settlement().is_some())
    }

    fn verify_stop_scope(&self) -> Result<(), String> {
        let mut state = self.broker.lock()?;
        let attachment = current_attachment(&state, &self.transport)?.clone();
        let record = current_record_mut(&mut state, &self.transport, &attachment)?;
        let data = self.operation.lock()?;
        if record.terminal_generation != data.intent.identity.terminal_generation
            || record.terminal_session_id != data.intent.identity.terminal_session_id
            || !record
                .active_command
                .as_ref()
                .is_some_and(|command| Arc::ptr_eq(command, &self.operation))
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        let owner_matches = record
            .lease
            .as_ref()
            .is_some_and(|lease| match &lease.owner {
                TerminalLeaseOwner::Agent {
                    agent_session_id,
                    task_id,
                    operation_id,
                    ..
                } => {
                    lease.lease_id == data.intent.identity.lease_id
                        && lease.revision == data.intent.identity.lease_generation
                        && agent_session_id == &data.intent.identity.agent_session_id
                        && task_id == &data.intent.identity.task_id
                        && operation_id == &data.intent.identity.operation_id
                }
                TerminalLeaseOwner::Revoking {
                    agent_session_id,
                    task_id,
                    operation_id,
                    ..
                } => {
                    agent_session_id == &data.intent.identity.agent_session_id
                        && task_id == &data.intent.identity.task_id
                        && operation_id == &data.intent.identity.operation_id
                }
                _ => false,
            });
        if !owner_matches {
            return Err("TERMINAL_BROKER_STALE_LEASE".into());
        }
        Ok(())
    }
    pub(crate) fn identity(&self) -> Result<CommandIdentity, String> {
        Ok(self.operation.lock()?.intent.identity.clone())
    }
    #[cfg(unix)]
    pub(crate) fn editor_ready_confirmed(&self) -> Result<bool, String> {
        Ok(self.operation.lock()?.native_editor_ready_confirmed)
    }
    #[cfg(unix)]
    pub(crate) fn capabilities_confirmed(&self) -> Result<bool, String> {
        Ok(self.operation.lock()?.native_capabilities_confirmed)
    }
    pub(crate) fn commit_armed(&self) -> Result<bool, String> {
        Ok(self.operation.lock()?.native_commit_armed)
    }
    fn verify_current(&self, require_lease: bool) -> Result<(), String> {
        let mut state = self.broker.lock()?;
        let attachment = current_attachment(&state, &self.transport)?.clone();
        let record = current_record_mut(&mut state, &self.transport, &attachment)?;
        let data = self.operation.lock()?;
        if record.integration_id != data.integration_id {
            return Err("TERMINAL_NATIVE_IDENTITY_MISMATCH".into());
        }
        if record.terminal_generation != data.intent.identity.terminal_generation
            || record.terminal_session_id != data.intent.identity.terminal_session_id
            || !record
                .active_command
                .as_ref()
                .is_some_and(|command| Arc::ptr_eq(command, &self.operation))
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        if require_lease && data.takeover_pending {
            return Err("TERMINAL_LEASE_TAKEN_OVER".into());
        }
        if require_lease && !record.lease.as_ref().is_some_and(|lease|lease.lease_id == data.intent.identity.lease_id
            && lease.revision == data.intent.identity.lease_generation
            && matches!(&lease.owner, TerminalLeaseOwner::Agent {agent_session_id, task_id, operation_id,..}
                if agent_session_id==&data.intent.identity.agent_session_id && task_id==&data.intent.identity.task_id && operation_id==&data.intent.identity.operation_id)) {
            return Err("TERMINAL_BROKER_STALE_LEASE".into());
        }
        Ok(())
    }

    fn request(&mut self, slot: &'static str, payload: Payload) -> Result<Envelope, String> {
        if slot != "query" && self.requests.contains_key(slot) {
            return Err("TERMINAL_NATIVE_DUPLICATE_REQUEST".into());
        }
        let identity = self.operation.lock()?.intent.identity.clone();
        let request_id = opaque_id("native-request");
        self.requests.insert(slot, request_id.clone());
        Ok(Envelope {
            protocol: nip::PROTOCOL.into(),
            identity,
            request_id,
            payload,
        })
    }

    pub(crate) fn prepare(
        &mut self,
        budget: Duration,
        reduced_motion: bool,
        enqueue: impl FnOnce(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let gate = self.operation.submission_gate.clone();
        let _gate = gate.lock().map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        self.verify_current(true)?;
        let payload = {
            let data = self.operation.lock()?;
            if !data.native_capabilities_confirmed
                || !data.lifecycle.can_edit()
                || self.deadline.is_some()
            {
                return Err("TERMINAL_NATIVE_NOT_PREPARED".into());
            }
            let budget_ms = u32::try_from(budget.as_millis())
                .map_err(|_| "TERMINAL_NATIVE_DEADLINE_INVALID")?;
            Payload::PrepareInput {
                job: data.plan.native_job.clone(),
                source: data.intent.source().into(),
                source_digest: data.intent.source_digest().into(),
                plan: data.plan.submitted_line().into(),
                plan_digest: data.plan.digest().into(),
                budget_ms,
                reduced_motion,
            }
        };
        let request = self.request("prepare", payload)?;
        let bytes = request.encode().map_err(wire_error)?;
        {
            let (_, slot) = self.broker.lookup_session_slot(&self.transport)?;
            let record = slot.lock()?;
            if record
                .native_profile
                .as_ref()
                .is_some_and(|profile| profile.capture_fence())
            {
                let mut data = self.operation.lock()?;
                data.capture.clear();
                data.capture_truncated = false;
                data.native_capture = Some(crate::terminal_command::capture::CaptureFence::new(
                    &request.request_id,
                ));
            }
        }
        self.deadline = Some(Instant::now() + budget);
        self.admit(TerminalInputKind::NativePrepare, &bytes, || enqueue(&bytes))
    }

    /// Arms the real native key without executing it. Fsync occurs outside the
    /// Broker lock. Receipt waiting is a separate step; neither lock spans it.
    pub(crate) fn arm_commit(
        &mut self,
        enqueue: impl FnOnce(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        {
            let data = self.operation.lock()?;
            if data.native_prepare_rejected
                || data.lifecycle.phase() != CommandPhase::InputConfirmed
                || data.input_proof.is_none()
            {
                return Err("TERMINAL_INPUT_PROOF_REQUIRED".into());
            }
        }
        if !self.operation.lock()?.submission_intent_recorded {
            self.persist_submission_intent()?;
        }
        let gate = self.operation.submission_gate.clone();
        let _gate = gate.lock().map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        self.verify_current(true)?;
        self.check_deadline()?;
        if self.requests.contains_key("commit") {
            return Err("TERMINAL_NATIVE_DUPLICATE_REQUEST".into());
        }
        let payload = {
            let data = self.operation.lock()?;
            if data.lifecycle.phase() != CommandPhase::InputConfirmed
                || !data
                    .input_proof
                    .as_ref()
                    .is_some_and(|proof| proof.matches(&data.intent, &data.plan))
            {
                return Err("TERMINAL_INPUT_PROOF_REQUIRED".into());
            }
            Payload::Commit {
                source_digest: data.intent.source_digest().into(),
                plan_digest: data.plan.digest().into(),
            }
        };
        let bytes = self
            .request("commit", payload)?
            .encode()
            .map_err(wire_error)?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        crate::terminal_command::acceptance_trace::record(
            "arm-preflight-returned",
            serde_json::json!({"identity":self.identity()?}),
        )?;
        self.admit(TerminalInputKind::NativeControl, &bytes, || enqueue(&bytes))
    }

    pub(crate) fn persist_submission_intent(&self) -> Result<(), String> {
        let gate = self.operation.submission_gate.clone();
        let _gate = gate.lock().map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        self.verify_current(true)?;
        self.check_deadline()?;
        let result = self
            .operation
            .record_submission_intent(&self.broker.submission_journal);
        if result
            .as_ref()
            .is_err_and(|error| error != "TERMINAL_LEASE_TAKEN_OVER")
        {
            let _ = self.control_closed();
        }
        result?;
        if let Err(error) = self.check_deadline() {
            let _ = self.control_closed();
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn submit(
        &self,
        revalidate: impl FnOnce() -> Result<(), String>,
        enqueue_key: impl FnOnce(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let gate = self.operation.submission_gate.clone();
        let _gate = gate.lock().map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        self.verify_current(true)?;
        self.check_deadline()?;
        {
            let data = self.operation.lock()?;
            if data.lifecycle.phase() != CommandPhase::InputConfirmed
                || !data.native_commit_armed
                || !data.submission_intent_recorded
            {
                return Err("TERMINAL_NATIVE_COMMIT_NOT_ARMED".into());
            }
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if !crate::terminal_command::acceptance_trace::ssh_recovery_enabled()
            && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref()
                == Ok("before-accept")
        {
            crate::terminal_command::acceptance_trace::record(
                "before-accept-observed",
                serde_json::json!({"identity":self.identity()?}),
            )?;
            self.check_deadline()?;
        }
        revalidate()?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        crate::terminal_command::acceptance_trace::record(
            "executable-preflight-returned",
            serde_json::json!({"identity":self.identity()?}),
        )?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        crate::terminal_command::acceptance_trace::observe_next_accept_key(
            &self.transport,
            self.identity()?,
            self.accept_key,
        )?;
        // Broker rechecks proof, durable intent, native arm and the same lease
        // under its final admission lock, before a single real accept-key enqueue.
        self.admit(TerminalInputKind::Executable, self.accept_key, || {
            enqueue_key(self.accept_key)
        })
    }

    #[cfg(unix)]
    pub(crate) fn cancel_draft(
        &mut self,
        enqueue: impl FnOnce(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        self.cancel_draft_for(TerminalCommandRequestedSettlement::Cancelled, enqueue)
    }
    pub(crate) fn cancel_draft_for(
        &mut self,
        reason: TerminalCommandRequestedSettlement,
        enqueue: impl FnOnce(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let gate = self.operation.submission_gate.clone();
        let _gate = gate.lock().map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        if self.stop_wait_finished()? {
            return Ok(());
        }
        self.verify_stop_scope()?;
        if self.operation.submission_may_have_occurred()? {
            return Err("TERMINAL_NATIVE_INTERRUPT_REQUIRED".into());
        }
        if !self.operation.request_settlement(reason)? {
            return Ok(());
        }
        if self.operation.lock()?.native_prepare_rejected {
            // The peer already refused preparation; an unrelated CancelDraft
            // cannot replace the pending exact EditorReady observation.
            return Ok(());
        }
        if !self.operation.source_may_have_been_enqueued()? {
            self.operation.settle_unsubmitted()?;
            return Ok(());
        }
        let bytes = self
            .request("cancel", Payload::CancelDraft)?
            .encode()
            .map_err(wire_error)?;
        // Scoped private clear remains allowed after cancellation; it never
        // injects an executable key or clears an unrelated user's draft.
        self.admit(TerminalInputKind::NativeDraftClear, &bytes, || {
            enqueue(&bytes)
        })
    }

    #[cfg(unix)]
    pub(crate) fn query(&mut self) -> Result<Vec<u8>, String> {
        self.verify_current(false)?;
        self.request("query", Payload::Query)?
            .encode()
            .map_err(wire_error)
    }

    /// Running programs may block the shell's native control reader. Stop uses
    /// the existing scoped PTY interrupt, never an unscoped kill or an Enter.
    pub(crate) fn interrupt(
        &mut self,
        reason: TerminalCommandRequestedSettlement,
        stop_deadline: Instant,
        enqueue: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        let gate = self.operation.submission_gate.clone();
        let _gate = gate.lock().map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        if self.stop_wait_finished()? {
            return Ok(false);
        }
        self.verify_stop_scope()?;
        if !self.operation.submission_may_have_occurred()? {
            return Err("TERMINAL_NATIVE_CANCEL_DRAFT_REQUIRED".into());
        }
        let send = self.operation.request_settlement(reason)?;
        if !send {
            return Ok(false);
        }
        let (id, started) = {
            let data = self.operation.lock()?;
            (
                data.intent.identity.operation_id.clone(),
                data.lifecycle.started(),
            )
        };
        self.broker.admit_terminal_input(
            &self.transport,
            TerminalBrokerInputSource::System { operation_id: id },
            TerminalInputKind::Interrupt,
            &[3],
            enqueue,
        )?;
        if !started {
            self.interrupt_before_start_deadline = Some(stop_deadline);
        }
        Ok(true)
    }

    /// A stop queued in the accepting editor can precede the actual program.
    /// Only its matching real Started permits one further scoped interrupt,
    /// within the first stop's deadline. This is never settlement evidence.
    pub(crate) fn interrupt_after_started(
        &mut self,
        enqueue: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        let Some(deadline) = self.interrupt_before_start_deadline else {
            return Ok(false);
        };
        let gate = self.operation.submission_gate.clone();
        let _gate = gate.lock().map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        let id = {
            let data = self.operation.lock()?;
            if Instant::now() >= deadline || data.lifecycle.is_terminal() || data.lifecycle.ended()
            {
                self.interrupt_before_start_deadline = None;
                return Ok(false);
            }
            if !data.lifecycle.started()
                || data.lifecycle.phase() != CommandPhase::CancelRequested
                || data.lifecycle.requested_settlement().is_none()
            {
                return Ok(false);
            }
            data.intent.identity.operation_id.clone()
        };
        // Consume before any fallible admission/write: partial delivery must
        // not create another retry. Recheck the original operation and owner.
        self.interrupt_before_start_deadline = None;
        self.verify_stop_scope()?;
        self.broker.admit_terminal_input(
            &self.transport,
            TerminalBrokerInputSource::System { operation_id: id },
            TerminalInputKind::Interrupt,
            &[3],
            enqueue,
        )?;
        Ok(true)
    }

    fn admit(
        &self,
        kind: TerminalInputKind,
        bytes: &[u8],
        write: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let id = self.operation.lock()?.intent.identity.clone();
        self.broker
            .admit_terminal_input(
                &self.transport,
                TerminalBrokerInputSource::Agent {
                    agent_session_id: id.agent_session_id,
                    task_id: id.task_id,
                    operation_id: id.operation_id,
                },
                kind,
                bytes,
                write,
            )
            .map(|_| ())
    }

    fn check_deadline(&self) -> Result<(), String> {
        if self
            .deadline
            .is_none_or(|deadline| Instant::now() >= deadline)
        {
            Err("TERMINAL_NATIVE_DEADLINE_EXPIRED".into())
        } else {
            Ok(())
        }
    }

    /// Connection readers keep one Decoder for the entire generation and route
    /// complete envelopes here. A command handoff must never reset framing.
    pub(crate) fn receive_envelope(&mut self, message: Envelope) -> Result<(), String> {
        self.verify_current(false)?;
        message.validate().map_err(wire_error)?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let partial = if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref()
            == Ok("input-in-progress")
            && self.requests.get("query") == Some(&message.request_id)
        {
            let data = self.operation.lock()?;
            match &message.payload {
                Payload::Snapshot {
                    phase,
                    may_have_submitted: false,
                    editor_utf8_valid: true,
                    cursor_utf8_bytes: Some(cursor),
                    end_utf8_bytes: Some(end),
                } if phase == "typing"
                    && data.lifecycle.phase() == CommandPhase::Typing
                    && *cursor <= *end
                    && *end > 0
                    && *end < data.intent.source().len() =>
                {
                    Some(serde_json::json!({
                        "identity":message.identity,"requestId":message.request_id,
                        "transportSessionId":self.transport,"cursorUtf8Bytes":cursor,
                        "endUtf8Bytes":end,"sourceUtf8Bytes":data.intent.source().len()
                    }))
                }
                _ => None,
            }
        } else {
            None
        };
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let observation = if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref()
            == Ok("after-accept")
        {
            match &message.payload {
                Payload::SubmissionAccepted => Some("submission-accepted-observed"),
                Payload::Started => Some("native-started-processed"),
                _ => None,
            }
        } else {
            None
        };
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let wrong_request =
            crate::terminal_command::acceptance_trace::wrong_settlement_request(&message)
                .then(|| (message.request_id.clone(), message.identity.clone()));
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let arm_candidate =
            crate::terminal_command::acceptance_trace::observe_arm_binding(&message)
                .then(|| (message.request_id.clone(), message.identity.clone()));
        let result = self.accept(message);
        if let Err(error) = &result {
            self.quarantine_protocol_error(error);
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if let Some((request_id, identity)) = arm_candidate {
            let data = self.operation.lock()?;
            crate::terminal_command::acceptance_trace::record(
                "arm-binding-result",
                serde_json::json!({
                    "identity":identity,"requestId":request_id,"error":result.as_ref().err(),
                    "phase":data.lifecycle.phase(),"armed":data.native_commit_armed
                }),
            )?;
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if let Some((request_id, identity)) = wrong_request {
            let snapshot = self.operation.snapshot()?;
            crate::terminal_command::acceptance_trace::record(
                "wrong-settlement-result",
                serde_json::json!({
                    "identity":identity,
                    "requestId":request_id,
                    "error":result.as_ref().err(),
                    "phase":snapshot.phase,
                    "executionEvidence":snapshot.command_observation.map(|state| state.execution_evidence)
                }),
            )?;
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if let Some(event) = observation.filter(|_| result.is_ok()) {
            crate::terminal_command::acceptance_trace::record(
                event,
                serde_json::json!({"identity":self.identity()?,"phase":self.operation.snapshot()?.phase}),
            )?;
        }
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if let Some(details) = partial.filter(|_| result.is_ok()) {
            if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
                == Ok("readonly-query-does-not-authorize")
            {
                let request = details["requestId"]
                    .as_str()
                    .ok_or("TERMINAL_ACCEPTANCE_TRACE_UNAVAILABLE")?;
                match self.readonly_first_partial.as_deref() {
                    None => {
                        self.readonly_first_partial = Some(request.into());
                        crate::terminal_command::acceptance_trace::record(
                            "readonly-first-partial-observed",
                            details,
                        )?;
                        return result;
                    }
                    Some(first) if first == request => return result,
                    _ => {}
                }
            }
            crate::terminal_command::acceptance_trace::record("input-progress-observed", details)?;
        }
        result
    }

    fn quarantine_protocol_error(&self, error: &str) {
        if error == "TERMINAL_NATIVE_IDENTITY_MISMATCH"
            || error == "TERMINAL_NATIVE_REQUEST_MISMATCH"
            || error.contains("STALE_GENERATION")
            || error.contains("STALE_LEASE")
        {
            return;
        }
        let done = self
            .operation
            .lock()
            .map(|data| {
                data.lifecycle.is_terminal()
                    && (data.native_editor_ready_confirmed
                        || data.lifecycle.draft_cleared()
                        || !data.source_may_be_enqueued)
            })
            .unwrap_or(false);
        if !done {
            let _ = self.control_closed();
        }
    }

    fn accept(&mut self, message: Envelope) -> Result<(), String> {
        let mut data = self.operation.lock()?;
        if message.identity != data.intent.identity {
            return Err("TERMINAL_NATIVE_IDENTITY_MISMATCH".into());
        }
        let (slot, receipt) = match &message.payload {
            Payload::Prepared { .. } => ("prepare", "prepared"),
            Payload::InputProgress { .. } => ("prepare", "progress"),
            Payload::InputConfirmed { .. } => ("prepare", "confirmed"),
            Payload::ControlInputConfirmed { .. } => ("prepare", "confirmed"),
            Payload::CommitArmed => ("commit", "armed"),
            Payload::SubmissionAccepted => ("commit", "accepted"),
            Payload::Started => ("prepare", "started"),
            Payload::Settled { .. } => ("prepare", "settled"),
            Payload::DraftCleared { .. } => ("cancel", "cleared"),
            Payload::Snapshot { .. } => ("query", "snapshot"),
            Payload::Rejected {
                code: nip::ErrorCode::Binding,
            } if self.requests.get("prepare") == Some(&message.request_id)
                && self.receipts.contains_key("prepared")
                && !data.lifecycle.may_have_submitted()
                && !data.native_commit_armed
                && data.input_proof.is_none()
                && (data.lifecycle.can_edit()
                    || data.lifecycle.phase() == CommandPhase::CancelRequested
                    || data.native_prepare_rejected) =>
            {
                ("prepare", "rejected")
            }
            Payload::Rejected { .. } => return Err("TERMINAL_NATIVE_REQUEST_REJECTED".into()),
            _ => return Err("TERMINAL_NATIVE_UNEXPECTED_MESSAGE".into()),
        };
        if self.requests.get(slot) != Some(&message.request_id) {
            // An older query response cannot regress the lifecycle or consume
            // safety-control slots. Other unmatched receipts are rejected.
            return if slot == "query" {
                Ok(())
            } else {
                Err("TERMINAL_NATIVE_REQUEST_MISMATCH".into())
            };
        }
        // In-flight preparatory receipts remain observations after cancellation
        // or completion. Validate their binding, then ignore them: they cannot
        // re-open input or poison a following legitimate clear receipt.
        match &message.payload {
            Payload::Prepared {
                source_digest,
                plan_digest,
            } => {
                if source_digest != data.intent.source_digest() || plan_digest != data.plan.digest()
                {
                    return Err("TERMINAL_INPUT_PROOF_MISMATCH".into());
                }
                if data.native_prepare_rejected
                    || !data.lifecycle.can_edit()
                    || data.lifecycle.phase() == CommandPhase::InputConfirmed
                {
                    return Ok(());
                }
            }
            Payload::InputProgress { applied_utf8_bytes } => {
                if *applied_utf8_bytes > data.intent.source().len() {
                    return Err("TERMINAL_INPUT_PROOF_MISMATCH".into());
                }
                if data.native_prepare_rejected || !data.lifecycle.can_edit() {
                    return Ok(());
                }
            }
            Payload::InputConfirmed {
                source_digest,
                plan_digest,
                utf8_bytes,
                cursor_utf8_bytes,
                end_utf8_bytes,
            } => {
                FullInputProof::verify_native(
                    &data.intent,
                    &data.plan,
                    source_digest,
                    plan_digest,
                    *utf8_bytes,
                    *cursor_utf8_bytes,
                    *end_utf8_bytes,
                )?;
                if data.native_prepare_rejected || !data.lifecycle.can_edit() {
                    return Ok(());
                }
            }
            Payload::CommitArmed
                if data.lifecycle.phase() != CommandPhase::InputConfirmed
                    && (data.lifecycle.requested_settlement().is_some()
                        || data.lifecycle.is_terminal()) =>
            {
                return Ok(())
            }
            Payload::Started if data.lifecycle.ended() => return Ok(()),
            _ => {}
        }
        if receipt != "progress" && receipt != "snapshot" {
            let digest = nip::sha(
                &serde_json::to_string(&message.payload).map_err(|_| "TERMINAL_NATIVE_ENCODING")?,
            );
            if let Some(previous) = self.receipts.get(receipt) {
                return if previous == &digest {
                    Ok(())
                } else {
                    Err("TERMINAL_NATIVE_CONFLICTING_RECEIPT".into())
                };
            }
            self.receipts.insert(receipt, digest);
        }
        match message.payload {
            Payload::Rejected { code } => {
                data.native_prepare_rejected = true;
                data.input_rejection =
                    Some(format!("TERMINAL_NATIVE_SOURCE_REJECTED: {}", code.code()));
            }
            Payload::ControlInputConfirmed {
                plan_digest,
                editor_empty,
            } => {
                let proof = FullInputProof::verify_native_control(
                    &data.intent,
                    &data.plan,
                    &plan_digest,
                    editor_empty,
                )?;
                if data.native_prepare_rejected || !data.lifecycle.can_edit() {
                    return Ok(());
                }
                data.input_proof = Some(proof);
                data.lifecycle.apply(CommandEvent::ConfirmInput)?;
            }
            Payload::Prepared {
                source_digest,
                plan_digest,
            } => {
                if source_digest != data.intent.source_digest() || plan_digest != data.plan.digest()
                {
                    return Err("TERMINAL_INPUT_PROOF_MISMATCH".into());
                }
                data.lifecycle.apply(CommandEvent::BeginInput)?;
            }
            Payload::InputProgress { applied_utf8_bytes } => {
                if applied_utf8_bytes > data.intent.source().len() || !data.lifecycle.can_edit() {
                    return Err("TERMINAL_INPUT_PROOF_MISMATCH".into());
                }
            }
            Payload::InputConfirmed {
                source_digest,
                plan_digest,
                utf8_bytes,
                cursor_utf8_bytes,
                end_utf8_bytes,
            } => {
                data.input_proof = Some(FullInputProof::verify_native(
                    &data.intent,
                    &data.plan,
                    &source_digest,
                    &plan_digest,
                    utf8_bytes,
                    cursor_utf8_bytes,
                    end_utf8_bytes,
                )?);
                data.lifecycle.apply(CommandEvent::ConfirmInput)?;
            }
            Payload::CommitArmed
                if data.submission_intent_recorded
                    && data.lifecycle.phase() == CommandPhase::InputConfirmed =>
            {
                data.native_commit_armed = true;
            }
            Payload::SubmissionAccepted if data.lifecycle.may_have_submitted() => {}
            Payload::Started if data.lifecycle.may_have_submitted() => {
                data.lifecycle.apply(CommandEvent::Started)?;
            }
            Payload::Settled { exit_code }
                if data.lifecycle.may_have_submitted()
                    && data.input_proof.is_some()
                    && data.native_commit_armed =>
            {
                data.lifecycle.apply(CommandEvent::Settled)?;
                data.exit_code = Some(exit_code);
            }
            Payload::DraftCleared { editor_empty: true } => {
                data.lifecycle.apply(CommandEvent::DraftCleared)?;
            }
            Payload::Snapshot { .. } => {} // Observation is never an execution receipt.
            _ => return Err("TERMINAL_NATIVE_UNEXPECTED_MESSAGE".into()),
        }
        data.revision = next_command_revision(data.revision)?;
        drop(data);
        if receipt == "started" {
            self.broker
                .native_job_started(&self.transport, &self.identity()?.operation_id)?;
        }
        if receipt == "cleared" {
            let (attachment, slot) = self.broker.lookup_session_slot(&self.transport)?;
            let mut record = slot.lock_current(&self.transport, &attachment)?;
            if record
                .active_command
                .as_ref()
                .is_some_and(|command| Arc::ptr_eq(command, &self.operation))
            {
                record.command_input_pending = record.native_recovery_required;
                record.prompt_ready = !record.native_recovery_required;
            }
            drop(record);
            slot.notify();
        }
        self.operation.notify();
        self.broker.settle_submission(&self.operation)?;
        Ok(())
    }

    pub(crate) fn control_closed(&self) -> Result<(), String> {
        self.connection_closed(false)
    }

    pub(crate) fn connection_closed(&self, partial: bool) -> Result<(), String> {
        self.verify_current(false)?;
        let mut data = self.operation.lock()?;
        let input_safe = data.native_editor_ready_confirmed
            || data.lifecycle.draft_cleared()
            || (!data.source_may_be_enqueued && !data.lifecycle.may_have_submitted());
        let event = if data.lifecycle.may_have_submitted() {
            CommandEvent::ControlLost
        } else if input_safe {
            CommandEvent::PreparationFailed
        } else {
            CommandEvent::InputLost
        };
        if !data.lifecycle.is_terminal() {
            data.lifecycle.apply(event)?;
        }
        if !data.lifecycle.may_have_submitted() {
            data.input_proof = None;
        }
        data.revision = next_command_revision(data.revision)?;
        drop(data);
        self.broker
            .close_native_protocol(&self.transport, &self.operation, input_safe)?;
        self.operation.notify();
        if partial {
            Err("TERMINAL_NATIVE_PARTIAL_FRAME_EOF".into())
        } else {
            Ok(())
        }
    }
}
impl Drop for NativeInputCoordinator {
    fn drop(&mut self) {
        let active = self
            .operation
            .lock()
            .map(|data| !data.lifecycle.is_terminal())
            .unwrap_or(true);
        if active {
            let _ = self.control_closed();
        }
    }
}
fn wire_error(code: nip::ErrorCode) -> String {
    format!("TERMINAL_NATIVE_PROTOCOL_{}", code.code())
}
