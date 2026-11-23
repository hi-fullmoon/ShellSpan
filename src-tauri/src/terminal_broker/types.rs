use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::enum_variant_names,
    reason = "Transport variants preserve the serialized PTY protocol names"
)]
pub(crate) enum TerminalTransportKind {
    LocalPty,
    WindowsConPty,
    SshPty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalIntegrationState {
    Initializing,
    Ready,
    Degraded,
    Unavailable,
    Invalidated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalFeatureRolloutDecision {
    pub(crate) name: &'static str,
    pub(crate) enabled: bool,
    pub(crate) requested: bool,
    pub(crate) default_enabled: bool,
    pub(crate) prerequisite_satisfied: bool,
    pub(crate) source: TerminalBrokerRolloutSource,
    pub(crate) persisted: bool,
    pub(crate) rollback: &'static str,
}

impl TerminalFeatureRolloutDecision {
    pub(super) fn new(
        name: &'static str,
        requested: bool,
        default_enabled: bool,
        prerequisite_satisfied: bool,
        source: TerminalBrokerRolloutSource,
        rollback: &'static str,
    ) -> Self {
        Self {
            name,
            enabled: requested && prerequisite_satisfied,
            requested,
            default_enabled,
            prerequisite_satisfied,
            source,
            persisted: false,
            rollback,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalGenerationCloseReason {
    UserClosed,
    RemoteExit,
    TransportDisconnected,
    Replaced,
    BrokerShutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalBrokerRolloutSource {
    Default,
    Environment,
    #[cfg(test)]
    Test,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalBrokerRolloutDecision {
    pub(crate) name: &'static str,
    pub(crate) enabled: bool,
    pub(crate) default_enabled: bool,
    pub(crate) source: TerminalBrokerRolloutSource,
    pub(crate) persisted: bool,
    pub(crate) mode: &'static str,
    pub(crate) rollback: &'static str,
}

impl Default for TerminalBrokerRolloutDecision {
    fn default() -> Self {
        Self {
            name: TERMINAL_BROKER_FLAG_NAME,
            enabled: TERMINAL_BROKER_DEFAULT_ENABLED,
            default_enabled: TERMINAL_BROKER_DEFAULT_ENABLED,
            source: TerminalBrokerRolloutSource::Default,
            persisted: false,
            mode: "cooperative",
            rollback: "disableDependentFlagsThenCloseBrokerGenerations",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalGeometry {
    pub(crate) rows: u32,
    pub(crate) columns: u32,
}

impl TerminalGeometry {
    pub(crate) fn new(columns: u32, rows: u32) -> Self {
        Self {
            rows: rows.clamp(1, TERMINAL_MAX_DIMENSION),
            columns: columns.clamp(1, TERMINAL_MAX_DIMENSION),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalBrokerAttachment {
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
}

/// An SSH generation under startup. It is invisible to callers until the
/// worker has checked the PTY and, when present, its native control channel.
pub(crate) struct PendingSshTerminal {
    pub(super) record: SessionRecord,
    pub(super) predecessor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TerminalLeaseOwner {
    User {
        owner_id: String,
    },
    Agent {
        owner_id: String,
        agent_session_id: String,
        task_id: String,
        operation_id: String,
    },
    Revoking {
        owner_id: String,
        agent_session_id: String,
        task_id: String,
        operation_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalLeaseSnapshot {
    pub(crate) lease_id: String,
    pub(crate) revision: u64,
    pub(crate) owner: TerminalLeaseOwner,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalRawOutputFrame {
    pub(crate) protocol_version: u8,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    #[serde(rename = "type")]
    pub(crate) frame_type: &'static str,
    pub(crate) sequence: u64,
    pub(crate) byte_offset: u64,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalDisplayFrame {
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) sequence: u64,
    pub(crate) text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalDisplaySnapshot {
    pub(crate) through_sequence: u64,
    pub(crate) rows: u32,
    pub(crate) columns: u32,
    pub(crate) contents: String,
}

#[cfg(any(
    test,
    all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    )
))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalAcceptanceRawOutput {
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) transport_session_id: String,
    pub(crate) open: bool,
    pub(crate) next_output_sequence: u64,
    pub(crate) next_byte_offset: u64,
    pub(crate) complete_from_start: bool,
    pub(crate) captured_bytes: Vec<u8>,
    pub(crate) capture_truncated: bool,
    pub(crate) capture_complete_from_start: bool,
    pub(crate) captured_frame_count: u64,
    pub(crate) captured_byte_count: u64,
    pub(crate) frames: Vec<TerminalRawOutputFrame>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalSubscriberStatus {
    Active,
    Truncated,
    Gap,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSubscriberSnapshot {
    pub(crate) status: TerminalSubscriberStatus,
    pub(crate) through_output_sequence: u64,
    pub(crate) observed_frames: u64,
    pub(crate) observed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSubscriberSetSnapshot {
    pub(crate) display: TerminalSubscriberSnapshot,
    pub(crate) capture: TerminalSubscriberSnapshot,
    pub(crate) integration: TerminalSubscriberSnapshot,
    pub(crate) screen: TerminalSubscriberSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalExecutionCapabilities {
    pub(crate) terminal_generation: u64,
    pub(crate) open: bool,
    pub(crate) shell: Option<TerminalShellKind>,
    pub(crate) prompt_ready: bool,
    pub(crate) integration_capabilities: Vec<&'static str>,
    pub(crate) input_recovery_required: bool,
}

/// Read-only result-capture observation for explicitly opted-in debug acceptance.
/// No private request IDs, control endpoints or authority are exposed.
#[cfg(all(feature = "native-input-acceptance", debug_assertions))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalAcceptanceCommandCapture {
    pub(super) command_id: String,
    pub(super) operation_id: String,
    pub(super) bytes: Vec<u8>,
    pub(super) capture_open: bool,
    pub(super) truncated: bool,
    pub(super) native_fence_registered: bool,
    pub(super) native_fence_complete: bool,
    pub(super) start_sequence: u64,
    pub(super) end_sequence: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalBrokerSessionSnapshot {
    #[cfg(all(feature = "native-input-acceptance", debug_assertions))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) acceptance_command_capture: Option<TerminalAcceptanceCommandCapture>,
    pub(crate) input_mode: InputMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) native_display_binding: Option<nip::DisplayBinding>,
    /// Accepted private-channel observation, exposed for diagnostics only.
    /// This DTO never grants input or submission authority.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) native_peer_profile: Option<nip::PeerProfile>,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) transport_session_id: String,
    pub(crate) transport_kind: TerminalTransportKind,
    pub(crate) geometry: TerminalGeometry,
    pub(crate) next_output_sequence: u64,
    pub(crate) next_byte_offset: u64,
    pub(crate) integration_state: TerminalIntegrationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) integration_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) integration_shell: Option<TerminalShellKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) integration_reason: Option<String>,
    pub(crate) integration_event_sequence: u64,
    pub(crate) integration_state_revision: u64,
    pub(crate) integration_capabilities: Vec<&'static str>,
    pub(crate) prompt_ready: bool,
    pub(crate) prompt_ready_revision: u64,
    /// Next admissible input when the integration most recently confirmed a prompt.
    #[cfg(test)]
    #[serde(skip)]
    pub(crate) prompt_next_input_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_command_id: Option<String>,
    pub(crate) input_observation: TerminalInputObservation,
    pub(crate) screen_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) lease: Option<TerminalLeaseSnapshot>,
    pub(crate) next_input_sequence: u64,
    pub(crate) output_listener_ready: bool,
    pub(crate) output_paused: bool,
    pub(crate) open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) close_reason: Option<TerminalGenerationCloseReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) replay_first_sequence: Option<u64>,
    pub(crate) replay_frame_count: usize,
    pub(crate) replay_byte_count: usize,
    pub(crate) capture_byte_count: usize,
    pub(crate) capture_truncated: bool,
    pub(crate) subscribers: TerminalSubscriberSetSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalBrokerSnapshot {
    pub(crate) rollout: TerminalBrokerRolloutDecision,
    pub(crate) shell_integration_rollout: TerminalFeatureRolloutDecision,
    pub(crate) terminal_execute_rollout: TerminalFeatureRolloutDecision,
    pub(crate) remote_bound_terminal_rollout: TerminalFeatureRolloutDecision,
    pub(crate) interactive_tools_rollout: TerminalFeatureRolloutDecision,
    pub(crate) remote_interactive_tools_rollout: TerminalFeatureRolloutDecision,
    pub(crate) counters: TerminalRolloutCountersSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session: Option<TerminalBrokerSessionSnapshot>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalRolloutCountersSnapshot {
    pub(crate) integration_ready: u64,
    pub(crate) lifecycle_matched: u64,
    pub(crate) uncertainty: u64,
    pub(crate) timeout: u64,
    pub(crate) takeover: u64,
    pub(crate) truncation: u64,
    pub(crate) backpressure: u64,
    pub(crate) transport_latency_samples: u64,
    pub(crate) transport_latency_total_micros: u64,
    pub(crate) transport_latency_max_micros: u64,
}

#[derive(Debug, Default)]
pub(super) struct TerminalRolloutCounters {
    pub(super) integration_ready: AtomicU64,
    pub(super) lifecycle_matched: AtomicU64,
    pub(super) uncertainty: AtomicU64,
    pub(super) timeout: AtomicU64,
    pub(super) takeover: AtomicU64,
    pub(super) truncation: AtomicU64,
    pub(super) backpressure: AtomicU64,
    pub(super) transport_latency_samples: AtomicU64,
    pub(super) transport_latency_total_micros: AtomicU64,
    pub(super) transport_latency_max_micros: AtomicU64,
}

impl TerminalRolloutCounters {
    pub(super) fn snapshot(&self) -> TerminalRolloutCountersSnapshot {
        TerminalRolloutCountersSnapshot {
            integration_ready: self.integration_ready.load(Ordering::Relaxed),
            lifecycle_matched: self.lifecycle_matched.load(Ordering::Relaxed),
            uncertainty: self.uncertainty.load(Ordering::Relaxed),
            timeout: self.timeout.load(Ordering::Relaxed),
            takeover: self.takeover.load(Ordering::Relaxed),
            truncation: self.truncation.load(Ordering::Relaxed),
            backpressure: self.backpressure.load(Ordering::Relaxed),
            transport_latency_samples: self.transport_latency_samples.load(Ordering::Relaxed),
            transport_latency_total_micros: self
                .transport_latency_total_micros
                .load(Ordering::Relaxed),
            transport_latency_max_micros: self.transport_latency_max_micros.load(Ordering::Relaxed),
        }
    }

    pub(super) fn increment(counter: &AtomicU64) {
        let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            Some(value.saturating_add(1).min(JAVASCRIPT_MAX_SAFE_INTEGER))
        });
    }

    pub(super) fn add(counter: &AtomicU64, amount: u64) {
        let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            Some(
                value
                    .saturating_add(amount)
                    .min(JAVASCRIPT_MAX_SAFE_INTEGER),
            )
        });
    }

    pub(super) fn observe_transport_latency(&self, elapsed: Duration) {
        let micros = u64::try_from(elapsed.as_micros())
            .unwrap_or(JAVASCRIPT_MAX_SAFE_INTEGER)
            .min(JAVASCRIPT_MAX_SAFE_INTEGER);
        Self::increment(&self.transport_latency_samples);
        Self::add(&self.transport_latency_total_micros, micros);
        let _ = self.transport_latency_max_micros.fetch_update(
            Ordering::Relaxed,
            Ordering::Relaxed,
            |value| Some(value.max(micros).min(JAVASCRIPT_MAX_SAFE_INTEGER)),
        );
    }
}

pub(crate) const TERMINAL_INTEGRATION_STATE_EVENT: &str = "terminal-integration-state";
pub(crate) const TERMINAL_COMMAND_LIFECYCLE_EVENT: &str = "terminal-command-lifecycle";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCommandLifecycleEvent {
    pub(crate) session_id: String,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) command_id: u64,
    pub(crate) phase: &'static str,
    pub(crate) started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i32>,
    pub(crate) cwd: String,
}

#[derive(Debug, Default)]
pub(super) struct DisplayCommandLifecycle {
    pub(super) sequence: u64,
    pub(super) running: Option<(Instant, u64)>,
    pub(super) pending: VecDeque<TerminalCommandLifecycleEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalIntegrationStateEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) input_observation: Option<TerminalInputObservation>,
    pub(crate) session_id: String,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) integration_state_revision: u64,
    pub(crate) state: TerminalIntegrationState,
    pub(crate) prompt_ready: bool,
    pub(crate) prompt_ready_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) shell: Option<TerminalShellKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalCommandState {
    Submitted,
    Running,
    CancelRequested,
    Completed,
    Cancelled,
    TimedOut,
    TakenOver,
    Uncertain,
    #[allow(dead_code)]
    Failed,
}

impl TerminalCommandState {
    #[cfg(test)]
    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed
                | Self::Cancelled
                | Self::TimedOut
                | Self::TakenOver
                | Self::Uncertain
                | Self::Failed
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalCommandRequestedSettlement {
    Cancelled,
    TimedOut,
    TakenOver,
}

/// Cooperative evidence only. Unknown never means that submission did not occur.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalCommandExecutionEvidence {
    Unknown,
    StartObserved,
    EndObserved,
}

/// A redacted projection of command data, never an input authorization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCommandObservation {
    pub(crate) submission_intent_durable: bool,
    pub(crate) draft_cleared: bool,
    pub(crate) phase: CommandPhase,
    pub(crate) may_have_submitted: bool,
    pub(crate) full_input_confirmed: bool,
    pub(crate) lease_generation: u64,
    pub(crate) source_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_source: Option<String>,
    pub(crate) safe_actions: Vec<&'static str>,
    pub(crate) agent_session_id: String,
    pub(crate) task_id: String,
    pub(crate) operation_id: String,
    pub(crate) command_id: String,
    pub(crate) legacy_state: TerminalCommandState,
    /// This is the legacy state revision, not a cursor for every observation field.
    pub(crate) legacy_revision: u64,
    pub(crate) source_may_be_enqueued: bool,
    pub(crate) execution_evidence: TerminalCommandExecutionEvidence,
    pub(crate) no_auto_replay: bool,
}

/// Gate facts survive command retirement. False flags do not grant permission:
/// turn guards, leases, frontend readiness and transport admission still apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalInputObservation {
    pub(crate) snapshot_sequence: u64,
    pub(crate) command_input_pending: bool,
    pub(crate) native_recovery_required: bool,
    pub(crate) native_clear_pending: bool,
    pub(crate) command_observation_unavailable: bool,
    pub(crate) foreground_handoff_active: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) vim_attached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vim_editor: Option<crate::terminal_vim_bridge::EditorKind>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) credential_prompt_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_command: Option<TerminalCommandObservation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalVisibleCommandRoute {
    TerminalExecute,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCommandSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) command_observation: Option<TerminalCommandObservation>,
    pub(crate) phase: CommandPhase,
    pub(crate) may_have_submitted: bool,
    pub(crate) protocol_version: u8,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) operation_id: String,
    pub(crate) command_id: String,
    pub(crate) command_line: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) submitted_command_line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) input_rejection: Option<String>,
    pub(crate) state: TerminalCommandState,
    pub(crate) revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cwd: Option<String>,
    pub(crate) combined_output: String,
    pub(crate) capture_truncated: bool,
    pub(crate) capture_start_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) capture_end_sequence: Option<u64>,
    pub(crate) no_auto_replay: bool,
}
