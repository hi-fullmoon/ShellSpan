use super::*;

#[derive(Debug)]
pub(super) struct SessionSlot {
    pub(super) record: Mutex<SessionRecord>,
    pub(super) changed: BrokerSignal,
}

impl SessionSlot {
    pub(super) fn new(record: SessionRecord) -> Self {
        Self {
            record: Mutex::new(record),
            changed: BrokerSignal::new(),
        }
    }

    pub(super) fn lock(&self) -> Result<std::sync::MutexGuard<'_, SessionRecord>, String> {
        self.record
            .lock()
            .map_err(|_| "TERMINAL_BROKER_UNAVAILABLE".to_string())
    }

    pub(super) fn lock_current(
        &self,
        transport_session_id: &str,
        attachment: &TransportAttachment,
    ) -> Result<std::sync::MutexGuard<'_, SessionRecord>, String> {
        let record = self.lock()?;
        if !record.open
            || record.terminal_generation != attachment.terminal_generation
            || record.transport_session_id != transport_session_id
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        Ok(record)
    }

    pub(super) fn notify(&self) {
        self.changed.notify_all();
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct TerminalBrokerConfig {
    pub(super) replay_max_frames: usize,
    pub(super) replay_max_bytes: usize,
    pub(super) capture_max_bytes: usize,
    pub(super) closed_session_capacity: usize,
}

impl Default for TerminalBrokerConfig {
    fn default() -> Self {
        Self {
            replay_max_frames: DEFAULT_REPLAY_MAX_FRAMES,
            replay_max_bytes: DEFAULT_REPLAY_MAX_BYTES,
            capture_max_bytes: DEFAULT_CAPTURE_MAX_BYTES,
            closed_session_capacity: DEFAULT_CLOSED_SESSION_CAPACITY,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct TransportAttachment {
    pub(super) terminal_session_id: String,
    pub(super) terminal_generation: u64,
    pub(super) active: bool,
}

#[derive(Debug, Clone)]
pub(super) struct SubscriberState {
    pub(super) status: TerminalSubscriberStatus,
    pub(super) next_sequence: u64,
    pub(super) observed_frames: u64,
    pub(super) observed_bytes: u64,
}

impl Default for SubscriberState {
    fn default() -> Self {
        Self {
            status: TerminalSubscriberStatus::Active,
            next_sequence: 1,
            observed_frames: 0,
            observed_bytes: 0,
        }
    }
}

impl SubscriberState {
    pub(super) fn observe(&mut self, frame: &TerminalRawOutputFrame) -> Result<(), String> {
        if self.status == TerminalSubscriberStatus::Closed {
            return Err("TERMINAL_BROKER_SUBSCRIBER_CLOSED".into());
        }
        if frame.sequence < self.next_sequence {
            return Ok(());
        }
        if frame.sequence > self.next_sequence {
            self.status = TerminalSubscriberStatus::Gap;
            return Err(format!(
                "TERMINAL_BROKER_OUTPUT_GAP: expected sequence {}, received {}",
                self.next_sequence, frame.sequence
            ));
        }
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        self.observed_frames = self
            .observed_frames
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        self.observed_bytes = self
            .observed_bytes
            .checked_add(frame.bytes.len() as u64)
            .ok_or_else(counter_exhausted)?;
        if self.status == TerminalSubscriberStatus::Gap {
            self.status = TerminalSubscriberStatus::Active;
        }
        Ok(())
    }

    pub(super) fn snapshot(&self) -> TerminalSubscriberSnapshot {
        TerminalSubscriberSnapshot {
            status: self.status,
            through_output_sequence: self.next_sequence.saturating_sub(1),
            observed_frames: self.observed_frames,
            observed_bytes: self.observed_bytes,
        }
    }

    pub(super) fn close(&mut self) {
        self.status = TerminalSubscriberStatus::Closed;
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct SubscriberSet {
    pub(super) display: SubscriberState,
    pub(super) capture: SubscriberState,
    pub(super) integration: SubscriberState,
    pub(super) screen: SubscriberState,
}

impl SubscriberSet {
    pub(super) fn snapshot(&self) -> TerminalSubscriberSetSnapshot {
        TerminalSubscriberSetSnapshot {
            display: self.display.snapshot(),
            capture: self.capture.snapshot(),
            integration: self.integration.snapshot(),
            screen: self.screen.snapshot(),
        }
    }

    pub(super) fn close(&mut self) {
        self.display.close();
        self.capture.close();
        self.integration.close();
        self.screen.close();
    }
}

#[derive(Debug)]
pub(super) struct SessionRecord {
    pub(super) snapshot_sequence: Mutex<(Option<String>, u64)>,
    pub(super) input_mode: InputMode,
    pub(super) native_display_negotiated: bool,
    pub(super) native_peer_profile: Option<nip::PeerProfile>,
    pub(super) last_native_prepared: Option<CommandIdentity>,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Read by the P1 native adapter, not wired to production until P2"
        )
    )]
    pub(super) native_profile: Option<crate::terminal_command::registration::VerifiedNativeProfile>,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Read by the P1 native adapter, not wired to production until P2"
        )
    )]
    pub(super) native_probe_request_id: Option<String>,
    pub(super) predecessor_transport_session_ids: Vec<String>,
    pub(super) terminal_session_id: String,
    pub(super) terminal_generation: u64,
    pub(super) transport_session_id: String,
    pub(super) transport_kind: TerminalTransportKind,
    pub(super) geometry: TerminalGeometry,
    pub(super) next_output_sequence: u64,
    pub(super) next_byte_offset: u64,
    pub(super) integration_state: TerminalIntegrationState,
    pub(super) integration_id: Option<String>,
    pub(super) integration_shell: Option<TerminalShellKind>,
    pub(super) integration_reason: Option<String>,
    pub(super) integration_event_sequence: u64,
    pub(super) integration_state_revision: u64,
    pub(super) prompt_started: bool,
    pub(super) prompt_ready: bool,
    pub(super) prompt_ready_revision: u64,
    pub(super) prompt_start_input_sequence: u64,
    pub(super) prompt_next_input_sequence: u64,
    pub(super) vim_attached: bool,
    pub(super) vim_editor: Option<crate::terminal_vim_bridge::EditorKind>,
    pub(super) interactive_input: Option<InteractiveInput>,
    pub(super) interactive_guard_buffer: String,
    pub(super) native_input: bool,
    pub(super) native_checkpoints: bool,
    pub(super) native_typing: bool,
    pub(super) native_private_control: bool,
    pub(super) native_recovery_required: bool,
    pub(super) native_clear_pending: Option<(String, Option<String>, u64, bool)>,
    pub(super) native_clear_sequence: u64,
    pub(super) native_clear_confirmed: Option<String>,
    pub(super) native_clear_scope: Option<(String, Option<String>)>,
    pub(super) native_jobs: bool,
    pub(super) native_comments: bool,
    pub(super) current_directory: Option<String>,
    pub(super) display_command_lifecycle: DisplayCommandLifecycle,
    pub(super) active_command: Option<Arc<TerminalCommandOperation>>,
    // Kept across lease release/retirement until a trusted shell event proves
    // the edit buffer was submitted or cleared. Never cleared by raw output.
    pub(super) command_input_pending: bool,
    pub(super) screen_model: Option<TerminalScreenModel>,
    pub(super) display_screen: Option<TerminalScreenModel>,
    pub(super) display_sequence: u64,
    pub(super) last_output_at: Instant,
    pub(super) lease: Option<TerminalLeaseSnapshot>,
    pub(super) next_input_sequence: u64,
    pub(super) output_listener_ready: bool,
    pub(super) output_paused: bool,
    pub(super) open: bool,
    pub(super) close_reason: Option<TerminalGenerationCloseReason>,
    pub(super) replay: VecDeque<TerminalRawOutputFrame>,
    pub(super) replay_bytes: usize,
    pub(super) capture: Vec<u8>,
    pub(super) capture_truncated: bool,
    pub(super) subscribers: SubscriberSet,
    #[cfg(unix)]
    pub(super) echo_probe: Option<crate::local_terminal_input::PtyEchoProbe>,
    pub(super) sandbox_binding: Option<crate::models::LocalSandboxPtyBinding>,
    pub(super) sandbox_blocked_domains: Option<Arc<Mutex<Vec<String>>>>,
}

/// Only an exact shell command start followed by its end can acknowledge
/// a submitted interactive line. A prompt alone cannot acknowledge PTY input.
#[derive(Debug)]
pub(super) enum InteractiveInput {
    Draft(String),
    Submitted { line: String, through: u64 },
    Running { through: u64 },
    Unconfirmed,
}

impl SessionRecord {
    pub(super) fn report_display_command(&mut self, cwd: &str, exit_code: Option<i32>) {
        let lifecycle = &mut self.display_command_lifecycle;
        let (started, started_at) = if exit_code.is_some() {
            let Some(start) = lifecycle.running.take() else {
                return;
            };
            start
        } else {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            lifecycle.sequence += 1;
            let start = (Instant::now(), now);
            lifecycle.running = Some(start);
            start
        };
        if lifecycle.pending.len() >= 32 {
            lifecycle.pending.pop_front();
        }
        lifecycle.pending.push_back(TerminalCommandLifecycleEvent {
            session_id: self.transport_session_id.clone(),
            terminal_session_id: self.terminal_session_id.clone(),
            terminal_generation: self.terminal_generation,
            command_id: lifecycle.sequence,
            phase: if exit_code.is_some() {
                "completed"
            } else {
                "running"
            },
            started_at,
            duration_ms: exit_code.map(|_| started.elapsed().as_millis() as u64),
            exit_code,
            cwd: cwd.to_string(),
        });
    }

    pub(super) fn foreground_handoff_active(&self) -> bool {
        self.active_command.as_ref().is_some_and(|command| {
            command.lock().is_ok_and(|data| {
                data.handed_off && !(data.lifecycle.ended() && data.native_editor_ready_confirmed)
            })
        })
    }

    pub(super) fn credential_prompt_active(&self) -> bool {
        #[cfg(unix)]
        {
            self.echo_probe
                .as_ref()
                .is_some_and(crate::local_terminal_input::PtyEchoProbe::is_echo_disabled)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    pub(super) fn user_controls_foreground(&self) -> bool {
        self.foreground_handoff_active()
            || (self.vim_attached
                && !self.prompt_ready
                && self.active_command.is_none()
                && self.integration_state == TerminalIntegrationState::Ready)
    }

    pub(super) fn open(
        terminal_session_id: String,
        terminal_generation: u64,
        transport_session_id: String,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
        interactive_tools_enabled: bool,
    ) -> Self {
        Self {
            snapshot_sequence: Mutex::new((None, 0)),
            input_mode: InputMode::Raw,
            native_display_negotiated: false,
            native_peer_profile: None,
            last_native_prepared: None,
            native_profile: None,
            native_probe_request_id: None,
            predecessor_transport_session_ids: Vec::new(),
            terminal_session_id,
            terminal_generation,
            transport_session_id,
            transport_kind,
            geometry,
            next_output_sequence: 1,
            next_byte_offset: 0,
            integration_state: TerminalIntegrationState::Initializing,
            integration_id: None,
            integration_shell: None,
            integration_reason: None,
            integration_event_sequence: 0,
            integration_state_revision: 0,
            prompt_started: false,
            prompt_ready: false,
            prompt_ready_revision: 0,
            prompt_start_input_sequence: 0,
            prompt_next_input_sequence: 0,
            vim_attached: false,
            vim_editor: None,
            interactive_input: None,
            interactive_guard_buffer: String::new(),
            native_input: false,
            native_checkpoints: false,
            native_typing: false,
            native_private_control: false,
            native_recovery_required: false,
            native_clear_pending: None,
            native_clear_sequence: 0,
            native_clear_confirmed: None,
            native_clear_scope: None,
            native_jobs: false,
            native_comments: false,
            current_directory: None,
            display_command_lifecycle: DisplayCommandLifecycle::default(),
            active_command: None,
            command_input_pending: false,
            screen_model: interactive_tools_enabled.then(|| TerminalScreenModel::new(geometry)),
            last_output_at: Instant::now(),
            lease: Some(user_lease(1)),
            next_input_sequence: 1,
            output_listener_ready: false,
            output_paused: false,
            open: true,
            close_reason: None,
            replay: VecDeque::new(),
            display_screen: None,
            display_sequence: 0,
            replay_bytes: 0,
            capture: Vec::new(),
            capture_truncated: false,
            subscribers: SubscriberSet::default(),
            #[cfg(unix)]
            echo_probe: None,
            sandbox_binding: None,
            sandbox_blocked_domains: None,
        }
    }

    pub(super) fn close(&mut self, reason: TerminalGenerationCloseReason) -> Result<(), String> {
        self.open = false;
        self.close_reason = Some(reason);
        self.integration_state = TerminalIntegrationState::Invalidated;
        self.integration_id = None;
        self.integration_reason = Some("generationClosed".into());
        self.prompt_ready = false;
        self.prompt_started = false;
        self.display_command_lifecycle = DisplayCommandLifecycle::default();
        if let Some(command) = self.active_command.take() {
            if command.is_native_protocol()? {
                command.finalize_capture(self.next_output_sequence.saturating_sub(1))?;
            }
            settle_command_after_loss(
                &command,
                self.next_output_sequence.saturating_sub(1),
                if reason == TerminalGenerationCloseReason::BrokerShutdown {
                    CommandEvent::ApplicationExit
                } else {
                    CommandEvent::TransportClosed
                },
            );
        }
        self.lease = None;
        self.output_paused = false;
        self.subscribers.close();
        for frame in &mut self.replay {
            frame.bytes.fill(0);
        }
        self.replay = VecDeque::new();
        self.replay_bytes = 0;
        self.capture.fill(0);
        self.capture = Vec::new();
        self.screen_model = None;
        self.display_screen = None;
        #[cfg(unix)]
        {
            self.echo_probe = None;
        }
        advance_integration_state_revision(self)?;
        Ok(())
    }

    pub(super) fn native_display_binding(&self) -> Option<nip::DisplayBinding> {
        (self.input_mode == InputMode::NativeInline && self.native_display_negotiated).then(|| {
            self.native_profile
                .as_ref()
                .map_or_else(nip::DisplayBinding::native, |profile| {
                    profile.display_binding()
                })
        })
    }

    pub(super) fn integration_capabilities(&self) -> Vec<&'static str> {
        if self.integration_state == TerminalIntegrationState::Ready {
            let mut capabilities = vec![
                "promptLifecycle",
                "commandLifecycle",
                "exactCommandLine",
                "exitStatus",
                "currentDirectory",
            ];
            if self.native_input
                && self.native_checkpoints
                && !self.native_recovery_required
                && (!matches!(
                    self.integration_shell,
                    Some(TerminalShellKind::Bash | TerminalShellKind::Zsh)
                ) || self.native_private_control)
            {
                capabilities.push("nativeScriptInput");
            }
            if self.native_jobs && self.native_checkpoints && !self.native_recovery_required {
                capabilities.push("nativeJobControl");
            }
            capabilities
        } else {
            Vec::new()
        }
    }

    pub(super) fn snapshot(&self) -> Result<TerminalBrokerSessionSnapshot, String> {
        let command_observation = self
            .active_command
            .as_ref()
            .map(|command| command.observation())
            .transpose();
        let command_observation_unavailable = command_observation.is_err();
        let mut snapshot = TerminalBrokerSessionSnapshot {
            #[cfg(all(feature = "native-input-acceptance", debug_assertions))]
            acceptance_command_capture: self
                .active_command
                .as_ref()
                .map(|command| command.acceptance_capture())
                .transpose()?,
            input_mode: self.input_mode,
            native_peer_profile: self.native_peer_profile.clone(),
            native_display_binding: self.native_display_binding(),
            terminal_session_id: self.terminal_session_id.clone(),
            terminal_generation: self.terminal_generation,
            transport_session_id: self.transport_session_id.clone(),
            transport_kind: self.transport_kind,
            geometry: self.geometry,
            next_output_sequence: self.next_output_sequence,
            next_byte_offset: self.next_byte_offset,
            integration_state: self.integration_state,
            integration_id: self.integration_id.clone(),
            integration_shell: self.integration_shell,
            integration_reason: self.integration_reason.clone(),
            integration_event_sequence: self.integration_event_sequence,
            integration_state_revision: self.integration_state_revision,
            integration_capabilities: self.integration_capabilities(),
            prompt_ready: self.prompt_ready,
            prompt_ready_revision: self.prompt_ready_revision,
            #[cfg(test)]
            prompt_next_input_sequence: self.prompt_next_input_sequence,
            current_directory: self.current_directory.clone(),
            active_command_id: command_observation
                .as_ref()
                .ok()
                .and_then(|observation| observation.as_ref())
                .map(|observation| observation.command_id.clone()),
            input_observation: TerminalInputObservation {
                snapshot_sequence: 0,
                command_input_pending: self.command_input_pending,
                native_recovery_required: self.native_recovery_required,
                native_clear_pending: self.native_clear_pending.is_some(),
                command_observation_unavailable,
                foreground_handoff_active: self.user_controls_foreground(),
                vim_attached: self.vim_attached && !self.prompt_ready,
                vim_editor: if self.vim_attached && !self.prompt_ready {
                    self.vim_editor
                } else {
                    None
                },
                credential_prompt_active: self.credential_prompt_active(),
                active_command: command_observation.ok().flatten(),
            },
            screen_version: self
                .screen_model
                .as_ref()
                .map_or(0, TerminalScreenModel::version),
            lease: self.lease.clone(),
            next_input_sequence: self.next_input_sequence,
            output_listener_ready: self.output_listener_ready,
            output_paused: self.output_paused,
            open: self.open,
            close_reason: self.close_reason,
            replay_first_sequence: self.replay.front().map(|frame| frame.sequence),
            replay_frame_count: self.replay.len(),
            replay_byte_count: self.replay_bytes,
            capture_byte_count: self.capture.len(),
            capture_truncated: self.capture_truncated,
            subscribers: self.subscribers.snapshot(),
        };
        // Version the complete public projection, including every gate, lease,
        // proof and intent fact. Re-reading unchanged data does not manufacture
        // a state change; the legacy lifecycle revision is never used as a cursor.
        // Acceptance-only observations must not change the production cursor.
        #[cfg(all(feature = "native-input-acceptance", debug_assertions))]
        let acceptance_capture = snapshot.acceptance_command_capture.take();
        let digest = nip::sha(
            &serde_json::to_string(&snapshot).map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?,
        );
        #[cfg(all(feature = "native-input-acceptance", debug_assertions))]
        {
            snapshot.acceptance_command_capture = acceptance_capture;
        }
        let mut cursor = self
            .snapshot_sequence
            .lock()
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        if cursor.0.as_ref() != Some(&digest) {
            cursor.1 = next_command_revision(cursor.1)?;
            cursor.0 = Some(digest);
        }
        snapshot.input_observation.snapshot_sequence = cursor.1;
        Ok(snapshot)
    }
}
