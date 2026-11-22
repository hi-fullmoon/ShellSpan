use super::*;

#[derive(Debug)]
pub(super) struct TerminalCommandData {
    pub(super) lifecycle: CommandLifecycle,
    pub(super) intent: CommandIntent,
    pub(super) plan: ExecutionPlan,
    pub(super) has_submission_envelope: bool,
    pub(super) submission_intent_recorded: bool,
    pub(super) requires_complete_proof: bool,
    pub(super) input_proof: Option<FullInputProof>,
    pub(super) native_protocol: bool,
    pub(super) native_capabilities_confirmed: bool,
    pub(super) native_commit_armed: bool,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Read by the P1 native adapter, not wired to production until P2"
        )
    )]
    pub(super) native_coordinator_claimed: bool,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Read by the P1 native adapter, not wired to production until P2"
        )
    )]
    pub(super) native_editor_ready_confirmed: bool,
    pub(super) native_prepare_rejected: bool,
    pub(super) native_empty_confirmed: bool,
    pub(super) native_checkpoint: Option<(String, bool)>,
    pub(super) native_private_checkpoint: Option<(String, String, bool)>,
    pub(super) native_private_ready: Option<bool>,
    pub(super) native_read_only_probe: bool,
    pub(super) native_probe_refresh: bool,
    pub(super) native_probe_waiting_prompt: bool,
    pub(super) native_probe_outstanding: bool,
    pub(super) source_may_be_enqueued: bool,
    pub(super) integration_id: Option<String>,
    pub(super) revision: u64,
    pub(super) takeover_pending: bool,
    pub(super) handed_off: bool,
    pub(super) handoff_screen: Option<TerminalScreenModel>,
    pub(super) interrupt_sent: bool,
    pub(super) input_rejection: Option<String>,
    pub(super) interrupt_uncertain: bool,
    pub(super) exit_code: Option<i32>,
    pub(super) cwd: Option<String>,
    pub(super) capture: Vec<u8>,
    pub(super) capture_truncated: bool,
    pub(super) capture_limit: usize,
    pub(super) capture_start_sequence: u64,
    pub(super) capture_end_sequence: Option<u64>,
    pub(super) capture_open: bool,
    pub(super) native_capture: Option<crate::terminal_command::capture::CaptureFence>,
}

impl TerminalCommandData {
    pub(super) fn state(&self) -> TerminalCommandState {
        self.lifecycle.legacy_state()
    }
    pub(super) fn confirm_editor(&mut self, actual_buffer: &str) -> Result<(), String> {
        if actual_buffer == self.plan.submitted_line() && self.lifecycle.can_edit() {
            self.input_proof = Some(FullInputProof::verify_editor(
                &self.intent,
                &self.plan,
                actual_buffer,
            )?);
            self.lifecycle.apply(CommandEvent::ConfirmInput)?;
            self.revision = next_command_revision(self.revision)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct TerminalCommandOperation {
    pub(super) broker_state: std::sync::Weak<Mutex<BrokerState>>,
    pub(super) terminal_session_id: String,
    pub(crate) submission_gate: Arc<Mutex<()>>,
    pub(super) data: Mutex<TerminalCommandData>,
    pub(super) changed: Condvar,
    pub(super) counters: Arc<TerminalRolloutCounters>,
}

impl TerminalCommandOperation {
    #[cfg(test)]
    pub(super) fn new(
        terminal_session_id: String,
        terminal_generation: u64,
        operation_id: String,
        command_line: String,
        integration_id: Option<String>,
        capture_start_sequence: u64,
        capture_limit: usize,
        counters: Arc<TerminalRolloutCounters>,
    ) -> Self {
        let identity = CommandIdentity {
            terminal_session_id,
            terminal_generation,
            operation_id,
            command_id: opaque_id("command"),
            lease_id: "unit-lease".into(),
            lease_generation: 1,
            agent_session_id: "unit-agent".into(),
            task_id: "unit-task".into(),
            source_revision: 1,
        };
        let intent = CommandIntent::new(identity, command_line).expect("valid unit command");
        let plan = ExecutionPlan::new(
            &intent,
            intent.source().into(),
            None,
            crate::terminal_command::state::ExecutionMethod::LegacyEditor,
        );
        Self::from_intent(
            intent,
            plan,
            false,
            integration_id,
            capture_start_sequence,
            capture_limit,
            counters,
            false,
            std::sync::Weak::new(),
        )
    }

    pub(super) fn from_intent(
        intent: CommandIntent,
        plan: ExecutionPlan,
        has_submission_envelope: bool,
        integration_id: Option<String>,
        capture_start_sequence: u64,
        capture_limit: usize,
        counters: Arc<TerminalRolloutCounters>,
        awaiting_ready: bool,
        broker_state: std::sync::Weak<Mutex<BrokerState>>,
    ) -> Self {
        let mut lifecycle = CommandLifecycle::default();
        if !awaiting_ready {
            lifecycle
                .apply(CommandEvent::Ready)
                .expect("new command ready");
        }
        let terminal_session_id = intent.identity.terminal_session_id.clone();
        Self {
            broker_state,
            terminal_session_id,
            submission_gate: Arc::new(Mutex::new(())),
            data: Mutex::new(TerminalCommandData {
                lifecycle,
                intent,
                plan,
                has_submission_envelope,
                submission_intent_recorded: false,
                requires_complete_proof: false,
                input_proof: None,
                native_protocol: false,
                native_capabilities_confirmed: false,
                native_commit_armed: false,
                native_coordinator_claimed: false,
                native_editor_ready_confirmed: false,
                native_prepare_rejected: false,
                native_empty_confirmed: false,
                native_checkpoint: None,
                native_private_checkpoint: None,
                native_private_ready: None,
                native_read_only_probe: false,
                native_probe_refresh: false,
                native_probe_waiting_prompt: false,
                native_probe_outstanding: false,
                source_may_be_enqueued: false,
                integration_id,
                revision: 1,
                takeover_pending: false,
                handed_off: false,
                handoff_screen: None,
                interrupt_sent: false,
                input_rejection: None,
                interrupt_uncertain: false,
                exit_code: None,
                cwd: None,
                capture: Vec::new(),
                capture_truncated: false,
                capture_limit,
                capture_start_sequence,
                capture_end_sequence: None,
                capture_open: true,
                native_capture: None,
            }),
            changed: Condvar::new(),
            counters,
        }
    }

    pub(crate) fn command_id(&self) -> Result<String, String> {
        Ok(self.lock()?.intent.identity.command_id.clone())
    }

    pub(crate) fn submission_may_have_occurred(&self) -> Result<bool, String> {
        Ok(self.lock()?.lifecycle.may_have_submitted())
    }

    pub(crate) fn handed_off(&self) -> Result<bool, String> {
        Ok(self.lock()?.handed_off)
    }

    pub(crate) fn handed_off_and_ready(&self) -> Result<bool, String> {
        let data = self.lock()?;
        Ok(data.handed_off && data.lifecycle.ended() && data.native_editor_ready_confirmed)
    }

    pub(crate) fn takeover_settled_before_submission(&self) -> Result<bool, String> {
        let data = self.lock()?;
        Ok(data.lifecycle.phase() == CommandPhase::Cancelled
            && !data.lifecycle.may_have_submitted()
            && data.lifecycle.requested_settlement()
                == Some(TerminalCommandRequestedSettlement::TakenOver))
    }

    pub(crate) fn source_may_have_been_enqueued(&self) -> Result<bool, String> {
        Ok(self.lock()?.source_may_be_enqueued)
    }

    pub(crate) fn require_complete_input_proof(&self) -> Result<(), String> {
        let mut data = self.lock()?;
        if !data.lifecycle.can_edit() && data.lifecycle.phase() != CommandPhase::AwaitingReady {
            return Err("TERMINAL_COMMAND_EVENT_REJECTED".into());
        }
        data.requires_complete_proof = true;
        Ok(())
    }

    pub(crate) fn fail_before_input(&self) -> Result<bool, String> {
        let mut data = self.lock()?;
        if data.lifecycle.is_terminal() {
            return Ok(false);
        }
        if data.source_may_be_enqueued || data.lifecycle.may_have_submitted() {
            data.lifecycle.apply(CommandEvent::ControlLost)?;
        } else {
            data.lifecycle.apply(CommandEvent::PreparationFailed)?;
        }
        data.revision = next_command_revision(data.revision)?;
        drop(data);
        self.notify();
        Ok(true)
    }

    pub(crate) fn record_submission_intent(
        &self,
        journal: &SubmissionJournal,
    ) -> Result<(), String> {
        let identity = {
            let data = self.lock()?;
            if data.takeover_pending {
                return Err("TERMINAL_LEASE_TAKEN_OVER".into());
            }
            if !data.lifecycle.can_edit()
                || data.submission_intent_recorded
                || data.native_prepare_rejected
            {
                return Err("TERMINAL_SUBMISSION_ALREADY_RECORDED".into());
            }
            if data.requires_complete_proof
                && !data
                    .input_proof
                    .as_ref()
                    .is_some_and(|proof| proof.matches(&data.intent, &data.plan))
            {
                return Err("TERMINAL_INPUT_PROOF_REQUIRED".into());
            }
            data.intent.identity.clone()
        };
        // Caller owns the executor's serial gate; no Broker/operation lock spans fsync.
        journal.record(&identity)?;
        let mut data = self.lock()?;
        if !data.lifecycle.can_edit() {
            return Err("TERMINAL_COMMAND_EVENT_REJECTED".into());
        }
        data.submission_intent_recorded = true;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        {
            drop(data);
            crate::terminal_command::acceptance_trace::record(
                "intent-record-returned",
                serde_json::json!({"identity":identity}),
            )?;
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> Result<TerminalCommandSnapshot, String> {
        let data = self.lock()?;
        Ok(command_snapshot(&data))
    }

    pub(crate) fn snapshot_for_result(&self) -> Result<TerminalCommandSnapshot, String> {
        let data = self.lock()?;
        let mut snapshot = command_snapshot(&data);
        snapshot.command_observation = data.native_protocol.then(|| command_observation(&data));
        Ok(snapshot)
    }

    #[cfg(all(feature = "native-input-acceptance", debug_assertions))]
    pub(super) fn acceptance_capture(&self) -> Result<TerminalAcceptanceCommandCapture, String> {
        let data = self.lock()?;
        Ok(TerminalAcceptanceCommandCapture {
            command_id: data.intent.identity.command_id.clone(),
            operation_id: data.intent.identity.operation_id.clone(),
            bytes: data.capture.clone(),
            capture_open: data.capture_open,
            truncated: data.capture_truncated,
            native_fence_registered: data.native_capture.is_some(),
            native_fence_complete: data
                .native_capture
                .as_ref()
                .is_some_and(|fence| fence.complete()),
            start_sequence: data.capture_start_sequence,
            end_sequence: data.capture_end_sequence,
        })
    }

    pub(super) fn observation(&self) -> Result<TerminalCommandObservation, String> {
        let data = self.lock()?;
        Ok(command_observation(&data))
    }
    #[cfg(all(test, unix))]
    pub(crate) fn observation_for_test(&self) -> Result<TerminalCommandObservation, String> {
        self.observation()
    }

    pub(crate) fn wait_until_terminal(
        &self,
        timeout: Duration,
    ) -> Result<TerminalCommandSnapshot, String> {
        let deadline = Instant::now() + timeout;
        let mut data = self.lock()?;
        while !data.lifecycle.is_terminal() {
            let now = Instant::now();
            if now >= deadline {
                return Ok(command_snapshot(&data));
            }
            let (next, wait) = self
                .changed
                .wait_timeout(data, deadline.saturating_duration_since(now))
                .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
            data = next;
            if wait.timed_out() && !data.lifecycle.is_terminal() {
                return Ok(command_snapshot(&data));
            }
        }
        Ok(command_snapshot(&data))
    }

    /// Fence this exact operation before waiting for the native coordinator.
    /// Final admission checks the same data lock before marking an attempt.
    /// Only the later control path may claim the clear or interrupt.
    pub(crate) fn fence_takeover(&self) -> Result<(), String> {
        let mut data = self.lock()?;
        if !data.lifecycle.is_terminal()
            && !data.lifecycle.may_have_submitted()
            && data.lifecycle.requested_settlement().is_none()
        {
            data.takeover_pending = true;
        }
        Ok(())
    }

    pub(crate) fn request_settlement(
        &self,
        requested: TerminalCommandRequestedSettlement,
    ) -> Result<bool, String> {
        let slot = if let Some(broker) = self.broker_state.upgrade() {
            let state = broker
                .lock()
                .map_err(|_| "TERMINAL_BROKER_UNAVAILABLE".to_string())?;
            Some(state.sessions.get(&self.terminal_session_id).cloned())
        } else {
            None
        };
        let mut session_guard = match slot.as_ref() {
            Some(Some(slot)) => Some(slot.lock()?),
            Some(None) => return Ok(false),
            None => None,
        };
        let mut data = self.lock()?;
        if data.lifecycle.is_terminal()
            && !(data.native_protocol
                && matches!(
                    data.lifecycle.phase(),
                    CommandPhase::Uncertain | CommandPhase::RecoveryRequired
                )
                && !data.lifecycle.ended())
        {
            return Ok(false);
        }
        if data.lifecycle.requested_settlement().is_none() {
            let requested = if data.takeover_pending {
                TerminalCommandRequestedSettlement::TakenOver
            } else {
                requested
            };
            if let Some(record) = session_guard.as_deref_mut() {
                if record.terminal_generation != data.intent.identity.terminal_generation
                    || !record
                        .active_command
                        .as_ref()
                        .is_some_and(|command| std::ptr::eq(command.as_ref(), self))
                {
                    return Ok(false);
                }
                if let Some(lease) = &record.lease {
                    if let TerminalLeaseOwner::Agent {
                        owner_id,
                        agent_session_id,
                        task_id,
                        operation_id,
                    } = &lease.owner
                    {
                        if operation_id != &data.intent.identity.operation_id
                            || agent_session_id != &data.intent.identity.agent_session_id
                            || task_id != &data.intent.identity.task_id
                            || lease.lease_id != data.intent.identity.lease_id
                            || lease.revision != data.intent.identity.lease_generation
                        {
                            return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
                        }
                        record.lease = Some(TerminalLeaseSnapshot {
                            lease_id: opaque_id("lease"),
                            revision: next_command_revision(lease.revision)?,
                            owner: TerminalLeaseOwner::Revoking {
                                owner_id: owner_id.clone(),
                                agent_session_id: agent_session_id.clone(),
                                task_id: task_id.clone(),
                                operation_id: operation_id.clone(),
                            },
                        });
                    }
                }
            }
            data.lifecycle
                .apply(CommandEvent::RequestCancel(requested))?;
            data.revision = next_command_revision(data.revision)?;
            match requested {
                TerminalCommandRequestedSettlement::TimedOut => {
                    TerminalRolloutCounters::increment(&self.counters.timeout);
                }
                TerminalCommandRequestedSettlement::TakenOver => {
                    TerminalRolloutCounters::increment(&self.counters.takeover);
                }
                TerminalCommandRequestedSettlement::Cancelled => {}
            }
        }
        let send_interrupt = !data.interrupt_sent;
        data.interrupt_sent = true;
        drop(data);
        self.notify();
        Ok(send_interrupt)
    }

    pub(crate) fn mark_uncertain(&self) -> Result<bool, String> {
        let through_sequence = self.lock()?.capture_end_sequence.unwrap_or(0);
        let changed = settle_command_uncertain(self, through_sequence);
        Ok(changed)
    }

    /// Called under the executor's input gate, only when no submit key was sent.
    pub(crate) fn settle_unsubmitted(&self) -> Result<(), String> {
        let mut data = self.lock()?;
        if data.lifecycle.phase() != CommandPhase::CancelRequested {
            return Ok(());
        }
        data.lifecycle
            .apply(CommandEvent::WithdrawBeforeSubmission)?;
        if !data.source_may_be_enqueued {
            data.lifecycle.apply(CommandEvent::NoOwnedDraft)?;
        }
        data.revision = next_command_revision(data.revision)?;
        drop(data);
        self.notify();
        Ok(())
    }

    pub(crate) fn finalize_capture(&self, through_sequence: u64) -> Result<(), String> {
        let mut data = self.lock()?;
        if data
            .native_capture
            .as_ref()
            .is_some_and(|capture| !capture.complete())
        {
            let tail = data
                .native_capture
                .as_mut()
                .expect("native fence")
                .finish_incomplete();
            let remaining = data.capture_limit.saturating_sub(data.capture.len());
            data.capture
                .extend_from_slice(&tail[..remaining.min(tail.len())]);
            if data.lifecycle.may_have_submitted() {
                data.capture_truncated = true;
                data.lifecycle.apply(CommandEvent::CaptureIncomplete)?;
            }
            data.revision = next_command_revision(data.revision)?;
        }
        data.capture_open = false;
        data.capture_end_sequence = Some(
            data.capture_end_sequence
                .unwrap_or(through_sequence)
                .max(through_sequence),
        );
        Ok(())
    }

    pub(super) fn capture(&self, frame: &TerminalRawOutputFrame) -> Result<(), String> {
        let mut data = self.lock()?;
        if !data.capture_open || frame.sequence < data.capture_start_sequence {
            return Ok(());
        }
        let native_bytes = data
            .native_capture
            .as_mut()
            .map(|fence| fence.push(&frame.bytes));
        if let (Some(screen), Some(bytes)) = (&mut data.handoff_screen, &native_bytes) {
            if !bytes.is_empty() {
                screen.observe_bytes(frame.sequence, bytes)?;
            }
        }
        let bytes = native_bytes.as_deref().unwrap_or(&frame.bytes);
        if !data.handed_off && !data.capture_truncated {
            let remaining = data.capture_limit.saturating_sub(data.capture.len());
            let accepted = remaining.min(bytes.len());
            data.capture.extend_from_slice(&bytes[..accepted]);
            if accepted < bytes.len() {
                data.capture_truncated = true;
                TerminalRolloutCounters::increment(&self.counters.truncation);
            }
        }
        data.capture_end_sequence = Some(frame.sequence);
        let native_capture = data.native_capture.is_some();
        drop(data);
        if native_capture {
            self.notify();
        }
        Ok(())
    }

    pub(crate) fn native_observation_pending(&self) -> Result<bool, String> {
        let data = self.lock()?;
        Ok(data.native_protocol
            && ((matches!(
                data.lifecycle.phase(),
                CommandPhase::Uncertain | CommandPhase::RecoveryRequired
            ) && !data.lifecycle.ended()
                && !data.lifecycle.draft_cleared()
                && (data.lifecycle.may_have_submitted() || data.source_may_be_enqueued))
                || (data.native_prepare_rejected
                    && !data.native_editor_ready_confirmed
                    && data.source_may_be_enqueued)))
    }

    pub(crate) fn native_capture_complete(&self) -> Result<bool, String> {
        Ok(self
            .lock()?
            .native_capture
            .as_ref()
            .is_none_or(|capture| capture.finished()))
    }
    pub(crate) fn is_native_protocol(&self) -> Result<bool, String> {
        Ok(self.lock()?.native_protocol)
    }
    pub(crate) fn wait_native_capture(&self, timeout: Duration) -> Result<bool, String> {
        let data = self.lock()?;
        let (data, _) = self
            .changed
            .wait_timeout_while(data, timeout, |data| {
                data.native_capture
                    .as_ref()
                    .is_some_and(|capture| !capture.finished())
            })
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        Ok(data
            .native_capture
            .as_ref()
            .is_none_or(|capture| capture.finished()))
    }

    #[cfg(test)]
    pub(crate) fn expect_native_checkpoint(&self, prefix: &str) -> Result<(), String> {
        let mut data = self.lock()?;
        if data.state() != TerminalCommandState::Submitted {
            return Err("TERMINAL_NATIVE_EDIT_INTERRUPTED".into());
        }
        data.native_checkpoint = Some((prefix.into(), false));
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn begin_native_read_only_probe(&self) -> Result<(), String> {
        let mut data = self.lock()?;
        if data.state() != TerminalCommandState::Submitted || data.source_may_be_enqueued {
            return Err("TERMINAL_NATIVE_EDIT_INTERRUPTED".into());
        }
        data.native_read_only_probe = true;
        data.native_probe_refresh = false;
        data.native_probe_waiting_prompt = false;
        data.native_probe_outstanding = true;
        data.native_empty_confirmed = false;
        data.native_checkpoint = Some((String::new(), false));
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn refresh_native_read_only_probe(&self) -> Result<bool, String> {
        let mut data = self.lock()?;
        if data.state() != TerminalCommandState::Submitted
            || !data.native_read_only_probe
            || data.source_may_be_enqueued
            || !data.native_probe_refresh
            || data.native_probe_waiting_prompt
            || data.native_probe_outstanding
        {
            return Ok(false);
        }
        data.native_probe_refresh = false;
        data.native_probe_outstanding = true;
        data.native_empty_confirmed = false;
        data.native_checkpoint = Some((String::new(), false));
        Ok(true)
    }

    #[cfg(test)]
    pub(crate) fn finish_native_read_only_probe(&self) -> Result<bool, String> {
        let mut data = self.lock()?;
        if data.state() != TerminalCommandState::Submitted
            || !data.native_read_only_probe
            || data.source_may_be_enqueued
            || data.native_probe_refresh
            || !data
                .native_checkpoint
                .as_ref()
                .is_some_and(|(_, acknowledged)| *acknowledged)
        {
            return Ok(false);
        }
        data.native_read_only_probe = false;
        Ok(true)
    }

    #[cfg(test)]
    pub(crate) fn wait_native_checkpoint(&self, timeout: Duration) -> Result<bool, String> {
        let data = self.lock()?;
        let (data, _) = self
            .changed
            .wait_timeout_while(data, timeout, |data| {
                data.state() == TerminalCommandState::Submitted
                    && data
                        .native_checkpoint
                        .as_ref()
                        .is_some_and(|(_, acknowledged)| !acknowledged)
                    && (!data.native_read_only_probe
                        || !data.native_probe_refresh
                        || data.native_probe_waiting_prompt
                        || data.native_probe_outstanding)
            })
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        Ok(data.state() == TerminalCommandState::Submitted
            && !data.native_probe_refresh
            && data
                .native_checkpoint
                .as_ref()
                .is_some_and(|(_, acknowledged)| *acknowledged))
    }

    #[cfg(test)]
    pub(crate) fn expect_native_private_checkpoint(&self, descriptor: &str) -> Result<(), String> {
        self.expect_native_data_checkpoint(descriptor, "")
    }

    #[cfg(test)]
    pub(crate) fn expect_native_data_checkpoint(
        &self,
        descriptor: &str,
        buffer: &str,
    ) -> Result<(), String> {
        let mut data = self.lock()?;
        if data.state() != TerminalCommandState::Submitted || !data.native_empty_confirmed {
            return Err("TERMINAL_PRIVATE_CONTROL_NOT_READY".into());
        }
        data.native_private_checkpoint = Some((descriptor.to_string(), buffer.to_string(), false));
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn wait_native_private_checkpoint(&self, timeout: Duration) -> Result<bool, String> {
        let data = self.lock()?;
        let (data, _) = self
            .changed
            .wait_timeout_while(data, timeout, |data| {
                data.state() == TerminalCommandState::Submitted
                    && data
                        .native_private_checkpoint
                        .as_ref()
                        .is_some_and(|(_, _, ready)| !ready)
            })
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        Ok(data.state() == TerminalCommandState::Submitted
            && data
                .native_private_checkpoint
                .as_ref()
                .is_some_and(|(_, _, ready)| *ready))
    }

    pub(super) fn lock(&self) -> Result<std::sync::MutexGuard<'_, TerminalCommandData>, String> {
        self.data
            .lock()
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())
    }

    pub(super) fn notify(&self) {
        self.changed.notify_all();
    }
}

pub(super) fn next_command_revision(current: u64) -> Result<u64, String> {
    let next = current.checked_add(1).ok_or_else(counter_exhausted)?;
    if next > JAVASCRIPT_MAX_SAFE_INTEGER {
        return Err(counter_exhausted());
    }
    Ok(next)
}

pub(super) fn command_observation(data: &TerminalCommandData) -> TerminalCommandObservation {
    TerminalCommandObservation {
        submission_intent_durable: data.submission_intent_recorded,
        draft_cleared: data.lifecycle.draft_cleared(),
        phase: data.lifecycle.phase(),
        may_have_submitted: data.lifecycle.may_have_submitted(),
        full_input_confirmed: data.input_proof.is_some(),
        lease_generation: data.intent.identity.lease_generation,
        source_revision: data.intent.identity.source_revision,
        display_source: (!matches!(
            data.plan.native_job,
            Some(nip::JobExecution::Control { .. })
        ) && !matches!(
            data.plan.method,
            crate::terminal_command::state::ExecutionMethod::NativeJobControl
        ))
        .then(|| crate::redaction::redact_sensitive_text(data.intent.source())),
        safe_actions: if data.native_protocol
            && matches!(
                data.lifecycle.phase(),
                CommandPhase::Uncertain | CommandPhase::RecoveryRequired
            )
            && data.lifecycle.may_have_submitted()
            && !data.lifecycle.ended()
        {
            vec!["query", "requestStop"]
        } else if data.lifecycle.is_terminal() {
            vec!["query"]
        } else {
            vec!["query", "requestStop"]
        },
        agent_session_id: data.intent.identity.agent_session_id.clone(),
        task_id: data.intent.identity.task_id.clone(),
        operation_id: data.intent.identity.operation_id.clone(),
        command_id: data.intent.identity.command_id.clone(),
        legacy_state: data.state(),
        legacy_revision: data.revision,
        source_may_be_enqueued: data.source_may_be_enqueued,
        execution_evidence: if data.lifecycle.ended() && data.lifecycle.may_have_submitted() {
            TerminalCommandExecutionEvidence::EndObserved
        } else if data.lifecycle.started() {
            TerminalCommandExecutionEvidence::StartObserved
        } else {
            TerminalCommandExecutionEvidence::Unknown
        },
        no_auto_replay: true,
    }
}
pub(super) fn command_snapshot(data: &TerminalCommandData) -> TerminalCommandSnapshot {
    TerminalCommandSnapshot {
        command_observation: None,
        phase: data.lifecycle.phase(),
        may_have_submitted: data.lifecycle.may_have_submitted(),
        protocol_version: 1,
        terminal_session_id: data.intent.identity.terminal_session_id.clone(),
        terminal_generation: data.intent.identity.terminal_generation,
        operation_id: data.intent.identity.operation_id.clone(),
        command_id: data.intent.identity.command_id.clone(),
        command_line: data.intent.source().to_string(),
        submitted_command_line: (data.has_submission_envelope && !data.native_protocol)
            .then(|| data.plan.submitted_line().to_string()),
        input_rejection: data.input_rejection.clone(),
        state: data.state(),
        revision: data.revision,
        exit_code: data.exit_code,
        cwd: data.cwd.clone(),
        combined_output: String::from_utf8_lossy(&data.capture).into_owned(),
        capture_truncated: data.capture_truncated,
        capture_start_sequence: data.capture_start_sequence,
        capture_end_sequence: data.capture_end_sequence,
        no_auto_replay: true,
    }
}
