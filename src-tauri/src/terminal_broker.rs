use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;

use crate::models::{SessionManager, StatusEvent};
use crate::terminal_command::protocol::{self as nip, InputMode};
use crate::terminal_command::{
    journal::SubmissionJournal,
    state::{
        CommandEvent, CommandIdentity, CommandIntent, CommandLifecycle, CommandPhase,
        ExecutionPlan, FullInputProof,
    },
};
use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};
use crate::terminal_screen::{TerminalScreenModel, TerminalScreenSnapshot};

pub(crate) const TERMINAL_BROKER_FLAG_NAME: &str = "terminal_broker";
pub(crate) const TERMINAL_BROKER_ENVIRONMENT_VARIABLE: &str = "SHELLSPAN_TERMINAL_BROKER";
pub(crate) const TERMINAL_BROKER_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_SHELL_INTEGRATION_FLAG_NAME: &str = "terminal_shell_integration";
pub(crate) const TERMINAL_SHELL_INTEGRATION_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_SHELL_INTEGRATION";
pub(crate) const TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_EXECUTE_FLAG_NAME: &str = "terminal_execute";
pub(crate) const TERMINAL_EXECUTE_ENVIRONMENT_VARIABLE: &str = "SHELLSPAN_TERMINAL_EXECUTE";
pub(crate) const TERMINAL_EXECUTE_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_FLAG_NAME: &str = "terminal_remote_bound_terminal";
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL";
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_FLAG_NAME: &str = "terminal_interactive_tools";
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS";
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_REMOTE_INTERACTIVE_TOOLS_FLAG_NAME: &str =
    "terminal_remote_interactive_tools";
pub(crate) const TERMINAL_REMOTE_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_REMOTE_INTERACTIVE_TOOLS";
pub(crate) const TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED: bool = false;
const DEFAULT_REPLAY_MAX_FRAMES: usize = 512;
const DEFAULT_REPLAY_MAX_BYTES: usize = 1_048_576;
const DEFAULT_CAPTURE_MAX_BYTES: usize = 262_144;
const DEFAULT_CLOSED_SESSION_CAPACITY: usize = 256;
const MAX_FRAME_BYTES: usize = 262_144;
const TRANSPORT_LATENCY_SAMPLE_INTERVAL_FRAMES: u64 = 64;
const TERMINAL_MAX_DIMENSION: u32 = 1_000;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const USER_OWNER_ID: &str = "interactive-user";
const SYSTEM_OWNER_ID: &str = "shellspan-runtime";
#[path = "terminal_command/coordinator.rs"]
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "NIP adapter is exercised by real P1 tests; production transport wiring is P2"
    )
)]
mod native_input_coordinator;
pub(crate) use native_input_coordinator::NativeInputCoordinator;

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
    fn new(
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
    record: SessionRecord,
    predecessor: Option<String>,
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
    command_id: String,
    operation_id: String,
    bytes: Vec<u8>,
    capture_open: bool,
    truncated: bool,
    native_fence_registered: bool,
    native_fence_complete: bool,
    start_sequence: u64,
    end_sequence: Option<u64>,
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
struct TerminalRolloutCounters {
    integration_ready: AtomicU64,
    lifecycle_matched: AtomicU64,
    uncertainty: AtomicU64,
    timeout: AtomicU64,
    takeover: AtomicU64,
    truncation: AtomicU64,
    backpressure: AtomicU64,
    transport_latency_samples: AtomicU64,
    transport_latency_total_micros: AtomicU64,
    transport_latency_max_micros: AtomicU64,
}

impl TerminalRolloutCounters {
    fn snapshot(&self) -> TerminalRolloutCountersSnapshot {
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

    fn increment(counter: &AtomicU64) {
        let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            Some(value.saturating_add(1).min(JAVASCRIPT_MAX_SAFE_INTEGER))
        });
    }

    fn add(counter: &AtomicU64, amount: u64) {
        let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            Some(
                value
                    .saturating_add(amount)
                    .min(JAVASCRIPT_MAX_SAFE_INTEGER),
            )
        });
    }

    fn observe_transport_latency(&self, elapsed: Duration) {
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

#[derive(Debug)]
struct TerminalCommandData {
    lifecycle: CommandLifecycle,
    intent: CommandIntent,
    plan: ExecutionPlan,
    has_submission_envelope: bool,
    submission_intent_recorded: bool,
    requires_complete_proof: bool,
    input_proof: Option<FullInputProof>,
    native_protocol: bool,
    native_capabilities_confirmed: bool,
    native_commit_armed: bool,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Read by the P1 native adapter, not wired to production until P2"
        )
    )]
    native_coordinator_claimed: bool,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Read by the P1 native adapter, not wired to production until P2"
        )
    )]
    native_editor_ready_confirmed: bool,
    native_prepare_rejected: bool,
    native_empty_confirmed: bool,
    native_checkpoint: Option<(String, bool)>,
    native_private_checkpoint: Option<(String, String, bool)>,
    native_private_ready: Option<bool>,
    native_read_only_probe: bool,
    native_probe_refresh: bool,
    native_probe_waiting_prompt: bool,
    native_probe_outstanding: bool,
    source_may_be_enqueued: bool,
    integration_id: Option<String>,
    revision: u64,
    takeover_pending: bool,
    handed_off: bool,
    handoff_screen: Option<TerminalScreenModel>,
    interrupt_sent: bool,
    input_rejection: Option<String>,
    interrupt_uncertain: bool,
    exit_code: Option<i32>,
    cwd: Option<String>,
    capture: Vec<u8>,
    capture_truncated: bool,
    capture_limit: usize,
    capture_start_sequence: u64,
    capture_end_sequence: Option<u64>,
    capture_open: bool,
    native_capture: Option<crate::terminal_command::capture::CaptureFence>,
}

impl TerminalCommandData {
    fn state(&self) -> TerminalCommandState {
        self.lifecycle.legacy_state()
    }
    fn confirm_editor(&mut self, actual_buffer: &str) -> Result<(), String> {
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
    broker_state: std::sync::Weak<Mutex<BrokerState>>,
    pub(crate) submission_gate: Arc<Mutex<()>>,
    data: Mutex<TerminalCommandData>,
    changed: Condvar,
    counters: Arc<TerminalRolloutCounters>,
}

impl TerminalCommandOperation {
    #[cfg(test)]
    fn new(
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

    fn from_intent(
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
        Self {
            broker_state,
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
    fn acceptance_capture(&self) -> Result<TerminalAcceptanceCommandCapture, String> {
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

    fn observation(&self) -> Result<TerminalCommandObservation, String> {
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
        let broker = self.broker_state.upgrade();
        let mut broker = broker
            .as_ref()
            .map(|state| {
                state
                    .lock()
                    .map_err(|_| "TERMINAL_BROKER_UNAVAILABLE".to_string())
            })
            .transpose()?;
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
            if let Some(state) = broker.as_mut() {
                let Some(record) = state
                    .sessions
                    .get_mut(&data.intent.identity.terminal_session_id)
                else {
                    return Ok(false);
                };
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
        let changed =
            settle_command_uncertain(self, self.snapshot()?.capture_end_sequence.unwrap_or(0));
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

    fn capture(&self, frame: &TerminalRawOutputFrame) -> Result<(), String> {
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

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, TerminalCommandData>, String> {
        self.data
            .lock()
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())
    }

    fn notify(&self) {
        self.changed.notify_all();
    }
}

fn next_command_revision(current: u64) -> Result<u64, String> {
    let next = current.checked_add(1).ok_or_else(counter_exhausted)?;
    if next > JAVASCRIPT_MAX_SAFE_INTEGER {
        return Err(counter_exhausted());
    }
    Ok(next)
}

fn command_observation(data: &TerminalCommandData) -> TerminalCommandObservation {
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

fn command_snapshot(data: &TerminalCommandData) -> TerminalCommandSnapshot {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalInputKind {
    Text,
    Executable,
    NativePrepare,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "NIP private control admission is wired to production in P2"
        )
    )]
    NativeControl,
    NativeDraftClear,
    Binary,
    Key,
    Paste,
    Interrupt,
    SystemControl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalBrokerInputSource {
    User,
    Agent {
        agent_session_id: String,
        task_id: String,
        operation_id: String,
    },
    System {
        operation_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalInputRequest {
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) lease_id: String,
    pub(crate) input_sequence: u64,
    pub(crate) source: TerminalBrokerInputSource,
    pub(crate) input_kind: TerminalInputKind,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalInputReceipt {
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) lease_id: String,
    pub(crate) input_sequence: u64,
    pub(crate) source_owner_id: String,
    pub(crate) accepted_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalReplayBatch {
    pub(crate) frames: Vec<TerminalRawOutputFrame>,
    pub(crate) through_sequence: u64,
    pub(crate) has_more: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalWaitReason {
    ScreenChanged,
    OutputObserved,
    LifecycleObserved,
    TextFound,
    Idle,
    Closed,
    TimedOut,
}

#[derive(Debug, Clone)]
pub(crate) struct TerminalWaitRequest {
    pub(crate) after_screen_version: Option<u64>,
    pub(crate) after_output_sequence: Option<u64>,
    pub(crate) after_lifecycle_sequence: Option<u64>,
    pub(crate) text: Option<String>,
    pub(crate) case_sensitive: bool,
    pub(crate) idle: Option<Duration>,
    pub(crate) timeout: Duration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalWaitResult {
    pub(crate) reason: TerminalWaitReason,
    pub(crate) lifecycle_sequence: u64,
    pub(crate) open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot: Option<TerminalScreenSnapshot>,
}

#[derive(Debug, Clone, Copy)]
struct TerminalBrokerConfig {
    replay_max_frames: usize,
    replay_max_bytes: usize,
    capture_max_bytes: usize,
    closed_session_capacity: usize,
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
struct TransportAttachment {
    terminal_session_id: String,
    terminal_generation: u64,
    active: bool,
}

#[derive(Debug, Clone)]
struct SubscriberState {
    status: TerminalSubscriberStatus,
    next_sequence: u64,
    observed_frames: u64,
    observed_bytes: u64,
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
    fn observe(&mut self, frame: &TerminalRawOutputFrame) -> Result<(), String> {
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

    fn snapshot(&self) -> TerminalSubscriberSnapshot {
        TerminalSubscriberSnapshot {
            status: self.status,
            through_output_sequence: self.next_sequence.saturating_sub(1),
            observed_frames: self.observed_frames,
            observed_bytes: self.observed_bytes,
        }
    }

    fn close(&mut self) {
        self.status = TerminalSubscriberStatus::Closed;
    }
}

#[derive(Debug, Clone, Default)]
struct SubscriberSet {
    display: SubscriberState,
    capture: SubscriberState,
    integration: SubscriberState,
    screen: SubscriberState,
}

impl SubscriberSet {
    fn snapshot(&self) -> TerminalSubscriberSetSnapshot {
        TerminalSubscriberSetSnapshot {
            display: self.display.snapshot(),
            capture: self.capture.snapshot(),
            integration: self.integration.snapshot(),
            screen: self.screen.snapshot(),
        }
    }

    fn close(&mut self) {
        self.display.close();
        self.capture.close();
        self.integration.close();
        self.screen.close();
    }
}

#[derive(Debug)]
struct SessionRecord {
    snapshot_sequence: Mutex<(Option<String>, u64)>,
    input_mode: InputMode,
    native_display_negotiated: bool,
    native_peer_profile: Option<nip::PeerProfile>,
    last_native_prepared: Option<CommandIdentity>,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Read by the P1 native adapter, not wired to production until P2"
        )
    )]
    native_profile: Option<crate::terminal_command::registration::VerifiedNativeProfile>,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Read by the P1 native adapter, not wired to production until P2"
        )
    )]
    native_probe_request_id: Option<String>,
    predecessor_transport_session_ids: Vec<String>,
    terminal_session_id: String,
    terminal_generation: u64,
    transport_session_id: String,
    transport_kind: TerminalTransportKind,
    geometry: TerminalGeometry,
    next_output_sequence: u64,
    next_byte_offset: u64,
    integration_state: TerminalIntegrationState,
    integration_id: Option<String>,
    integration_shell: Option<TerminalShellKind>,
    integration_reason: Option<String>,
    integration_event_sequence: u64,
    integration_state_revision: u64,
    prompt_started: bool,
    prompt_ready: bool,
    prompt_ready_revision: u64,
    prompt_start_input_sequence: u64,
    prompt_next_input_sequence: u64,
    interactive_input: Option<InteractiveInput>,
    native_input: bool,
    native_checkpoints: bool,
    native_typing: bool,
    native_private_control: bool,
    native_recovery_required: bool,
    native_clear_pending: Option<(String, Option<String>, u64, bool)>,
    native_clear_sequence: u64,
    native_clear_confirmed: Option<String>,
    native_clear_scope: Option<(String, Option<String>)>,
    native_jobs: bool,
    native_comments: bool,
    current_directory: Option<String>,
    active_command: Option<Arc<TerminalCommandOperation>>,
    // Kept across lease release/retirement until a trusted shell event proves
    // the edit buffer was submitted or cleared. Never cleared by raw output.
    command_input_pending: bool,
    screen_model: Option<TerminalScreenModel>,
    display_screen: Option<TerminalScreenModel>,
    display_sequence: u64,
    last_output_at: Instant,
    lease: Option<TerminalLeaseSnapshot>,
    next_input_sequence: u64,
    output_listener_ready: bool,
    output_paused: bool,
    open: bool,
    close_reason: Option<TerminalGenerationCloseReason>,
    replay: VecDeque<TerminalRawOutputFrame>,
    replay_bytes: usize,
    capture: Vec<u8>,
    capture_truncated: bool,
    subscribers: SubscriberSet,
}

/// Only an exact shell command start followed by its end can acknowledge
/// a submitted interactive line. A prompt alone cannot acknowledge PTY input.
#[derive(Debug)]
enum InteractiveInput {
    Draft(String),
    Submitted { line: String, through: u64 },
    Running { through: u64 },
    Unconfirmed,
}

impl SessionRecord {
    fn foreground_handoff_active(&self) -> bool {
        self.active_command.as_ref().is_some_and(|command| {
            command.lock().is_ok_and(|data| {
                data.handed_off && !(data.lifecycle.ended() && data.native_editor_ready_confirmed)
            })
        })
    }

    fn open(
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
            interactive_input: None,
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
        }
    }

    fn close(&mut self, reason: TerminalGenerationCloseReason) -> Result<(), String> {
        self.open = false;
        self.close_reason = Some(reason);
        self.integration_state = TerminalIntegrationState::Invalidated;
        self.integration_id = None;
        self.integration_reason = Some("generationClosed".into());
        self.prompt_ready = false;
        self.prompt_started = false;
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
        self.replay.clear();
        self.replay_bytes = 0;
        self.capture.fill(0);
        self.capture.clear();
        self.screen_model = None;
        self.display_screen = None;
        advance_integration_state_revision(self)?;
        Ok(())
    }

    fn native_display_binding(&self) -> Option<nip::DisplayBinding> {
        (self.input_mode == InputMode::NativeInline && self.native_display_negotiated).then(|| {
            self.native_profile
                .as_ref()
                .map_or_else(nip::DisplayBinding::native, |profile| {
                    profile.display_binding()
                })
        })
    }

    fn snapshot(&self) -> Result<TerminalBrokerSessionSnapshot, String> {
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
            integration_capabilities: if self.integration_state == TerminalIntegrationState::Ready {
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
            },
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
                foreground_handoff_active: self.foreground_handoff_active(),
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

#[derive(Debug)]
struct BrokerState {
    jobs: HashMap<String, crate::terminal_jobs::NativeShellJob>,
    prepared_job_commands: HashMap<String, crate::terminal_jobs::PreparedShellJob>,
    rollout: TerminalBrokerRolloutDecision,
    shell_integration_rollout: TerminalFeatureRolloutDecision,
    terminal_execute_rollout: TerminalFeatureRolloutDecision,
    remote_bound_terminal_rollout: TerminalFeatureRolloutDecision,
    interactive_tools_rollout: TerminalFeatureRolloutDecision,
    remote_interactive_tools_rollout: TerminalFeatureRolloutDecision,
    sessions: HashMap<String, SessionRecord>,
    transports: HashMap<String, TransportAttachment>,
    closed_session_order: VecDeque<String>,
}

impl Default for BrokerState {
    fn default() -> Self {
        let rollout = TerminalBrokerRolloutDecision::default();
        Self {
            jobs: HashMap::new(),
            prepared_job_commands: HashMap::new(),
            shell_integration_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_SHELL_INTEGRATION_FLAG_NAME,
                TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
                TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
                rollout.enabled,
                TerminalBrokerRolloutSource::Default,
                "invalidateIntegrationAndMarkIncompleteCommandsUncertain",
            ),
            terminal_execute_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_EXECUTE_FLAG_NAME,
                TERMINAL_EXECUTE_DEFAULT_ENABLED,
                TERMINAL_EXECUTE_DEFAULT_ENABLED,
                rollout.enabled && TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
                TerminalBrokerRolloutSource::Default,
                "stopNewRoutingNeverReplayInflightCommands",
            ),
            remote_bound_terminal_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_REMOTE_BOUND_TERMINAL_FLAG_NAME,
                TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED,
                TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED,
                rollout.enabled
                    && TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED
                    && TERMINAL_EXECUTE_DEFAULT_ENABLED,
                TerminalBrokerRolloutSource::Default,
                "releaseAgentLeasesAndMarkIncompleteCommandsUncertain",
            ),
            interactive_tools_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_INTERACTIVE_TOOLS_FLAG_NAME,
                TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                rollout.enabled && TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
                TerminalBrokerRolloutSource::Default,
                "removeToolsRevokeAgentLeasesAndRejectLaterInput",
            ),
            remote_interactive_tools_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_REMOTE_INTERACTIVE_TOOLS_FLAG_NAME,
                TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                rollout.enabled
                    && TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED
                    && TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED
                    && TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                TerminalBrokerRolloutSource::Default,
                "removeRemoteToolsRevokeAgentLeasesAndRejectLaterInput",
            ),
            rollout,
            sessions: HashMap::new(),
            transports: HashMap::new(),
            closed_session_order: VecDeque::new(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct TerminalSessionBroker {
    state: Arc<Mutex<BrokerState>>,
    changed: Arc<Condvar>,
    counters: Arc<TerminalRolloutCounters>,
    submission_journal: SubmissionJournal,
    config: TerminalBrokerConfig,
}

impl Default for TerminalSessionBroker {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::default(),
            config: TerminalBrokerConfig::default(),
        }
    }
}

impl TerminalSessionBroker {
    pub(crate) fn configure_submission_journal(
        &self,
        root: &std::path::Path,
    ) -> Result<(), String> {
        self.submission_journal.configure(root)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn unresolved_submissions(
        &self,
    ) -> Result<Vec<crate::terminal_command::journal::SubmissionIntent>, String> {
        self.submission_journal.unresolved()
    }
    pub(crate) fn check_submission_replay(
        &self,
        agent: &str,
        task: &str,
        operation: &str,
    ) -> Result<(), String> {
        self.submission_journal
            .ensure_new_operation(agent, task, operation)
    }
    pub(crate) fn submission_recovery_for_agent(
        &self,
        agent: &str,
    ) -> Result<Vec<crate::terminal_command::journal::SubmissionIntent>, String> {
        self.submission_journal.unresolved_for_agent(Some(agent))
    }
    pub(crate) fn recovered_submissions_for_agent(
        &self,
        agent: &str,
    ) -> Result<Vec<crate::terminal_command::journal::SubmissionIntent>, String> {
        self.submission_journal.recovered_for_agent(agent)
    }

    #[cfg(test)]
    pub(crate) fn prepare_executable(
        &self,
        transport: &str,
        agent: &str,
        task: &str,
        operation: &str,
    ) -> Result<(), String> {
        let command = {
            let mut state = self.lock()?;
            let attachment = current_attachment(&state, transport)?.clone();
            let record = current_record_mut(&mut state, transport, &attachment)?;
            let command = record
                .active_command
                .clone()
                .ok_or("TERMINAL_COMMAND_NOT_FOUND")?;
            let data = command.lock()?;
            let id = &data.intent.identity;
            if id.agent_session_id != agent || id.task_id != task || id.operation_id != operation {
                return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
            }
            drop(data);
            command
        };
        command.record_submission_intent(&self.submission_journal)
    }

    pub(crate) fn settle_submission(
        &self,
        operation: &TerminalCommandOperation,
    ) -> Result<(), String> {
        let identity = {
            let data = operation.lock()?;
            let cancelled_draft = data.native_protocol
                && data.lifecycle.phase() == CommandPhase::Cancelled
                && data.lifecycle.draft_cleared()
                && !data.lifecycle.may_have_submitted();
            if !data.submission_intent_recorded
                || (!data.lifecycle.ended()
                    && !data.lifecycle.source_rejected()
                    && !cancelled_draft)
            {
                return Ok(());
            }
            data.intent.identity.clone()
        };
        self.submission_journal.settle(&identity)
    }

    #[cfg(test)]
    pub(crate) fn disabled_for_test() -> Self {
        let broker = Self::default();
        broker
            .apply_trusted_rollout(
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .expect("the disabled test rollout must be valid");
        broker
    }

    #[cfg(test)]
    pub(crate) fn set_remote_visible_rollout_for_test(&self, enabled: bool) -> Result<(), String> {
        self.apply_trusted_rollout(
            true,
            TerminalBrokerRolloutSource::Test,
            true,
            TerminalBrokerRolloutSource::Test,
            true,
            TerminalBrokerRolloutSource::Test,
            enabled,
            TerminalBrokerRolloutSource::Test,
            false,
            TerminalBrokerRolloutSource::Test,
            false,
            TerminalBrokerRolloutSource::Test,
        )
    }

    pub(crate) fn configure_from_trusted_environment(&self) -> Result<(), String> {
        let (broker, broker_source) = trusted_rollout_value(
            TERMINAL_BROKER_ENVIRONMENT_VARIABLE,
            TERMINAL_BROKER_DEFAULT_ENABLED,
        )?;
        let (integration, integration_source) = trusted_rollout_value(
            TERMINAL_SHELL_INTEGRATION_ENVIRONMENT_VARIABLE,
            TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
        )?;
        let (execute, execute_source) = trusted_rollout_value(
            TERMINAL_EXECUTE_ENVIRONMENT_VARIABLE,
            TERMINAL_EXECUTE_DEFAULT_ENABLED,
        )?;
        let (remote_bound_terminal, remote_bound_terminal_source) = trusted_rollout_value(
            TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE,
            TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED,
        )?;
        let (interactive_tools, interactive_tools_source) = trusted_rollout_value(
            TERMINAL_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE,
            TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
        )?;
        let (remote_interactive_tools, remote_interactive_tools_source) = trusted_rollout_value(
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE,
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
        )?;
        self.apply_trusted_rollout(
            broker,
            broker_source,
            integration,
            integration_source,
            execute,
            execute_source,
            remote_bound_terminal,
            remote_bound_terminal_source,
            interactive_tools,
            interactive_tools_source,
            remote_interactive_tools,
            remote_interactive_tools_source,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_trusted_rollout(
        &self,
        broker: bool,
        broker_source: TerminalBrokerRolloutSource,
        integration: bool,
        integration_source: TerminalBrokerRolloutSource,
        execute: bool,
        execute_source: TerminalBrokerRolloutSource,
        remote_bound_terminal: bool,
        remote_bound_terminal_source: TerminalBrokerRolloutSource,
        interactive_tools: bool,
        interactive_tools_source: TerminalBrokerRolloutSource,
        remote_interactive_tools: bool,
        remote_interactive_tools_source: TerminalBrokerRolloutSource,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.rollout.enabled && !broker {
            close_all_open_generations(
                &mut state,
                TerminalGenerationCloseReason::BrokerShutdown,
                self.config.closed_session_capacity,
            )?;
        } else if state.shell_integration_rollout.enabled && !(broker && integration) {
            for record in state.sessions.values_mut().filter(|record| record.open) {
                degrade_record(record, "shellIntegrationRollback")?;
            }
        } else if state.terminal_execute_rollout.enabled && !(broker && integration && execute) {
            for record in state.sessions.values_mut().filter(|record| record.open) {
                if let Some(command) = &record.active_command {
                    settle_command_uncertain(
                        command,
                        record.next_output_sequence.saturating_sub(1),
                    );
                }
            }
        } else if state.remote_bound_terminal_rollout.enabled
            && !(broker && integration && execute && remote_bound_terminal)
        {
            for record in state.sessions.values_mut().filter(|record| {
                record.open && record.transport_kind == TerminalTransportKind::SshPty
            }) {
                if let Some(command) = &record.active_command {
                    settle_command_uncertain(
                        command,
                        record.next_output_sequence.saturating_sub(1),
                    );
                }
                let agent_lease_revision = record.lease.as_ref().and_then(|lease| {
                    matches!(lease.owner, TerminalLeaseOwner::Agent { .. })
                        .then_some(lease.revision)
                });
                if let Some(revision) = agent_lease_revision {
                    let revision = revision.checked_add(1).ok_or_else(counter_exhausted)?;
                    if revision > JAVASCRIPT_MAX_SAFE_INTEGER {
                        return Err(counter_exhausted());
                    }
                    record.lease = Some(user_lease(revision));
                }
            }
        }
        state.rollout = TerminalBrokerRolloutDecision {
            enabled: broker,
            source: broker_source,
            ..TerminalBrokerRolloutDecision::default()
        };
        state.shell_integration_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_SHELL_INTEGRATION_FLAG_NAME,
            integration,
            TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
            broker,
            integration_source,
            "invalidateIntegrationAndMarkIncompleteCommandsUncertain",
        );
        state.terminal_execute_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_EXECUTE_FLAG_NAME,
            execute,
            TERMINAL_EXECUTE_DEFAULT_ENABLED,
            broker && integration,
            execute_source,
            "stopNewRoutingNeverReplayInflightCommands",
        );
        state.remote_bound_terminal_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_REMOTE_BOUND_TERMINAL_FLAG_NAME,
            remote_bound_terminal,
            TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED,
            broker && integration && execute,
            remote_bound_terminal_source,
            "releaseAgentLeasesAndMarkIncompleteCommandsUncertain",
        );
        state.interactive_tools_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_INTERACTIVE_TOOLS_FLAG_NAME,
            interactive_tools,
            TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
            broker && integration,
            interactive_tools_source,
            "removeToolsRevokeAgentLeasesAndRejectLaterInput",
        );
        state.remote_interactive_tools_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_FLAG_NAME,
            remote_interactive_tools,
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
            broker && integration && execute && remote_bound_terminal && interactive_tools,
            remote_interactive_tools_source,
            "removeRemoteToolsRevokeAgentLeasesAndRejectLaterInput",
        );
        Ok(())
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn apply_trusted_phase3_rollout(
        &self,
        broker: bool,
        broker_source: TerminalBrokerRolloutSource,
        integration: bool,
        integration_source: TerminalBrokerRolloutSource,
        execute: bool,
        execute_source: TerminalBrokerRolloutSource,
    ) -> Result<(), String> {
        self.apply_trusted_rollout(
            broker,
            broker_source,
            integration,
            integration_source,
            execute,
            execute_source,
            false,
            TerminalBrokerRolloutSource::Test,
            false,
            TerminalBrokerRolloutSource::Test,
            false,
            TerminalBrokerRolloutSource::Test,
        )
    }

    pub(crate) fn attach_transport(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        self.attach_transport_with_mode(
            transport_session_id,
            predecessor_transport_session_id,
            transport_kind,
            geometry,
            InputMode::Raw,
        )
    }

    /// Explicit future adapter entry; no Tauri/production creation path selects
    /// native mode in P1. The choice is immutable for this transport generation.
    pub(crate) fn attach_transport_with_mode(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
        input_mode: InputMode,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        validate_identifier(transport_session_id, "transport session id")?;
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        let record = new_transport_record(
            &state,
            transport_session_id,
            predecessor_transport_session_id,
            transport_kind,
            geometry,
            input_mode,
        )?;
        install_transport_record(&mut state, record, predecessor_transport_session_id).map(Some)
    }

    pub(crate) fn prepare_ssh_native_terminal(
        &self,
        transport: &str,
        predecessor: Option<&str>,
        geometry: TerminalGeometry,
    ) -> Result<PendingSshTerminal, String> {
        validate_identifier(transport, "transport session id")?;
        let state = self.lock()?;
        if !state.remote_bound_terminal_rollout.enabled {
            return Err("TERMINAL_NATIVE_INITIALIZATION_REJECTED".into());
        }
        let record = new_transport_record(
            &state,
            transport,
            predecessor,
            TerminalTransportKind::SshPty,
            geometry,
            InputMode::NativeInline,
        )?;
        Ok(PendingSshTerminal {
            record,
            predecessor: predecessor.map(str::to_owned),
        })
    }

    pub(crate) fn commit_started_ssh_terminal(
        &self,
        sessions: &SessionManager,
        transport: &str,
        predecessor: Option<&str>,
        geometry: TerminalGeometry,
        pending: Option<PendingSshTerminal>,
    ) -> Result<StatusEvent, String> {
        validate_identifier(transport, "transport session id")?;
        // Input admission enqueues through SessionManager under the Broker lock.
        // Take the same locks in the same order when committing a replacement.
        let mut state = self.lock()?;
        let record = if let Some(mut pending) = pending {
            if !state.remote_bound_terminal_rollout.enabled
                || pending.record.transport_session_id != transport
                || pending.predecessor.as_deref() != predecessor
                || pending.record.geometry != geometry
            {
                return Err("TERMINAL_NATIVE_INITIALIZATION_REJECTED".into());
            }
            let interactive_tools =
                effective_interactive_tools_for_transport(&state, TerminalTransportKind::SshPty);
            pending.record.screen_model =
                interactive_tools.then(|| TerminalScreenModel::new(geometry));
            Some(pending.record)
        } else if state.rollout.enabled {
            Some(new_transport_record(
                &state,
                transport,
                predecessor,
                TerminalTransportKind::SshPty,
                geometry,
                InputMode::Raw,
            )?)
        } else {
            None
        };
        let event = sessions.commit_connection_ready(transport, || {
            crate::connection::terminal_deadline::complete()?;
            if let Some(record) = record {
                install_transport_record(&mut state, record, predecessor)?;
            }
            Ok(())
        })?;
        self.changed.notify_all();
        Ok(event)
    }

    pub(crate) fn is_replacement_transport(
        &self,
        previous: &str,
        current: &str,
    ) -> Result<bool, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, current)?;
        let record = &state.sessions[&attachment.terminal_session_id];
        Ok(record.open
            && record
                .predecessor_transport_session_ids
                .iter()
                .any(|id| id == previous))
    }

    pub(crate) fn attachment_for_transport(
        &self,
        transport_session_id: &str,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        let state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        Ok(state
            .transports
            .get(transport_session_id)
            .filter(|attachment| attachment.active)
            .map(|attachment| TerminalBrokerAttachment {
                terminal_session_id: attachment.terminal_session_id.clone(),
                terminal_generation: attachment.terminal_generation,
            }))
    }

    pub(crate) fn close_transport(
        &self,
        transport_session_id: &str,
        reason: TerminalGenerationCloseReason,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(false);
        }
        let Some(attachment) = state.transports.get(transport_session_id).cloned() else {
            return Ok(false);
        };
        {
            let Some(record) = state.sessions.get_mut(&attachment.terminal_session_id) else {
                return Ok(false);
            };
            if !attachment.active
                || !record.open
                || record.terminal_generation != attachment.terminal_generation
                || record.transport_session_id != transport_session_id
            {
                return Ok(false);
            }
            record.close(reason)?;
        }
        if let Some(attachment) = state.transports.get_mut(transport_session_id) {
            attachment.active = false;
        }
        remember_closed_session(
            &mut state,
            &attachment.terminal_session_id,
            self.config.closed_session_capacity,
        );
        self.changed.notify_all();
        Ok(true)
    }

    pub(crate) fn observe_raw_output(
        &self,
        transport_session_id: &str,
        bytes: &[u8],
    ) -> Result<Option<TerminalRawOutputFrame>, String> {
        if bytes.is_empty() {
            return Ok(None);
        }
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        let latency_sample_started =
            (record.next_output_sequence % TRANSPORT_LATENCY_SAMPLE_INTERVAL_FRAMES == 1)
                .then(Instant::now);
        let frame = TerminalRawOutputFrame {
            protocol_version: 1,
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            frame_type: "rawOutput",
            sequence: record.next_output_sequence,
            byte_offset: record.next_byte_offset,
            bytes: bytes.to_vec(),
        };
        let accepted = match accept_raw_frame(record, frame.clone(), self.config, &self.counters)? {
            RawFrameAcceptance::Accepted => Some(frame),
            RawFrameAcceptance::Duplicate => None,
        };
        if let (Some(_), Some(started)) = (&accepted, latency_sample_started) {
            self.counters.observe_transport_latency(started.elapsed());
        }
        self.changed.notify_all();
        Ok(accepted)
    }

    pub(crate) fn resize(
        &self,
        transport_session_id: &str,
        geometry: TerminalGeometry,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        record.geometry = geometry;
        if let Some(screen) = &mut record.screen_model {
            screen.resize(geometry)?;
        }
        if let Some(screen) = &mut record.display_screen {
            screen.resize(geometry)?;
        }
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn arm_display_recovery(&self, transport: &str, token: &str) -> Result<(), String> {
        if token.is_empty() {
            return Ok(());
        }
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        record
            .display_screen
            .get_or_insert_with(|| TerminalScreenModel::new(record.geometry))
            .arm_display_recovery(token);
        if let Some(screen) = record.screen_model.as_mut() {
            screen.arm_display_recovery(token);
        }
        Ok(())
    }

    pub(crate) fn observe_display_output(
        &self,
        transport_session_id: &str,
        text: &str,
    ) -> Result<Option<TerminalDisplayFrame>, String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled || !state.transports.contains_key(transport_session_id) {
            return Ok(None);
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        let sequence = record
            .display_sequence
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        let text = record
            .display_screen
            .get_or_insert_with(|| TerminalScreenModel::new(record.geometry))
            .observe_display(sequence, text);
        record.display_sequence = sequence;
        Ok(Some(TerminalDisplayFrame {
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            sequence,
            text,
        }))
    }

    pub(crate) fn terminal_display_snapshot(
        &self,
        transport_session_id: &str,
        terminal_session_id: &str,
        terminal_generation: u64,
    ) -> Result<TerminalDisplaySnapshot, String> {
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.terminal_session_id != terminal_session_id
            || record.terminal_generation != terminal_generation
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        let (through_sequence, contents) = record
            .display_screen
            .as_ref()
            .map(TerminalScreenModel::format_display)
            .transpose()?
            .unwrap_or_default();
        Ok(TerminalDisplaySnapshot {
            through_sequence,
            rows: record.geometry.rows,
            columns: record.geometry.columns,
            contents,
        })
    }

    pub(crate) fn mark_output_ready(&self, transport_session_id: &str) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.output_listener_ready = true;
            Ok(())
        })
    }

    pub(crate) fn set_output_paused(
        &self,
        transport_session_id: &str,
        paused: bool,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        let entered_backpressure = paused && !record.output_paused;
        record.output_paused = paused;
        if entered_backpressure {
            TerminalRolloutCounters::increment(&self.counters.backpressure);
        }
        Ok(())
    }

    pub(crate) fn shell_integration_enabled(&self) -> Result<bool, String> {
        Ok(self.lock()?.shell_integration_rollout.enabled)
    }

    pub(crate) fn interactive_tools_enabled(&self) -> Result<bool, String> {
        Ok(self.lock()?.interactive_tools_rollout.enabled)
    }

    pub(crate) fn screen_snapshot(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalScreenSnapshot, String> {
        let state = self.lock()?;
        if !state.interactive_tools_rollout.enabled {
            return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?;
        let record = state
            .sessions
            .get(&attachment.terminal_session_id)
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        record
            .screen_model
            .as_ref()
            .map(|screen| screen.snapshot(&record.terminal_session_id, record.terminal_generation))
            .ok_or_else(|| "TERMINAL_SCREEN_UNAVAILABLE".to_string())
    }

    pub(crate) fn bracketed_paste_enabled(
        &self,
        transport_session_id: &str,
    ) -> Result<bool, String> {
        let state = self.lock()?;
        if !state.interactive_tools_rollout.enabled {
            return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?;
        let record = state
            .sessions
            .get(&attachment.terminal_session_id)
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        record
            .screen_model
            .as_ref()
            .map(TerminalScreenModel::bracketed_paste)
            .ok_or_else(|| "TERMINAL_SCREEN_UNAVAILABLE".to_string())
    }

    pub(crate) fn execution_capabilities(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalExecutionCapabilities, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?;
        let record = state
            .sessions
            .get(&attachment.terminal_session_id)
            .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?;
        let snapshot = record.snapshot()?;
        Ok(TerminalExecutionCapabilities {
            terminal_generation: snapshot.terminal_generation,
            open: snapshot.open,
            shell: snapshot.integration_shell,
            prompt_ready: snapshot.prompt_ready,
            integration_capabilities: snapshot.integration_capabilities,
            input_recovery_required: record.native_recovery_required
                || record.native_clear_pending.is_some(),
        })
    }

    #[cfg(test)]
    pub(crate) fn native_input_enabled(&self, transport_session_id: &str) -> Result<bool, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?;
        let record = state
            .sessions
            .get(&attachment.terminal_session_id)
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        Ok(record.integration_state == TerminalIntegrationState::Ready
            && record.native_input
            && record.native_checkpoints
            && (!matches!(
                record.integration_shell,
                Some(TerminalShellKind::Bash | TerminalShellKind::Zsh)
            ) || record.native_private_control)
            && !record.native_recovery_required)
    }

    pub(crate) fn command_shell(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalShellKind, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?;
        state
            .sessions
            .get(&attachment.terminal_session_id)
            .and_then(|record| record.integration_shell)
            .ok_or_else(|| "TERMINAL_INTEGRATION_NOT_READY".to_string())
    }

    pub(crate) fn native_comments_enabled(
        &self,
        transport_session_id: &str,
    ) -> Result<bool, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?;
        Ok(state
            .sessions
            .get(&attachment.terminal_session_id)
            .is_some_and(|record| record.native_comments))
    }

    pub(crate) fn wait_terminal(
        &self,
        transport_session_id: &str,
        request: TerminalWaitRequest,
    ) -> Result<TerminalWaitResult, String> {
        self.wait_terminal_observed(transport_session_id, request, || {})
    }

    fn wait_terminal_observed(
        &self,
        transport_session_id: &str,
        request: TerminalWaitRequest,
        on_attached: impl FnOnce(),
    ) -> Result<TerminalWaitResult, String> {
        let deadline = Instant::now() + request.timeout;
        let mut state = self.lock()?;
        if !state.interactive_tools_rollout.enabled {
            return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let terminal_session_id = attachment.terminal_session_id;
        let terminal_generation = attachment.terminal_generation;
        on_attached();
        loop {
            let record = state
                .sessions
                .get(&terminal_session_id)
                .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
            if record.terminal_generation != terminal_generation || !record.open {
                return Ok(TerminalWaitResult {
                    reason: TerminalWaitReason::Closed,
                    lifecycle_sequence: record.integration_event_sequence,
                    open: false,
                    snapshot: None,
                });
            }
            let snapshot = record
                .screen_model
                .as_ref()
                .map(|screen| screen.snapshot(&terminal_session_id, terminal_generation))
                .ok_or_else(|| "TERMINAL_SCREEN_UNAVAILABLE".to_string())?;
            if let Some(reason) = terminal_wait_reason(record, &snapshot, &request) {
                return Ok(TerminalWaitResult {
                    reason,
                    lifecycle_sequence: record.integration_event_sequence,
                    open: true,
                    snapshot: Some(snapshot),
                });
            }
            let now = Instant::now();
            if now >= deadline {
                TerminalRolloutCounters::increment(&self.counters.timeout);
                return Ok(TerminalWaitResult {
                    reason: TerminalWaitReason::TimedOut,
                    lifecycle_sequence: record.integration_event_sequence,
                    open: true,
                    snapshot: Some(snapshot),
                });
            }
            let mut remaining = deadline.saturating_duration_since(now);
            if let Some(idle) = request.idle {
                remaining = remaining.min(idle.saturating_sub(record.last_output_at.elapsed()));
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| "TERMINAL_BROKER_UNAVAILABLE".to_string())?;
            state = next;
        }
    }

    pub(crate) fn visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.scoped_visible_command_route(transport_session_id)
    }

    pub(crate) fn remote_visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.scoped_visible_command_route(transport_session_id)
    }

    fn scoped_visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        let state = self.lock()?;
        if state.terminal_execute_rollout.enabled {
            if let Ok(attachment) = current_attachment(&state, transport_session_id) {
                if let Some(record) = state.sessions.get(&attachment.terminal_session_id) {
                    let transport_eligible = record.transport_kind != TerminalTransportKind::SshPty
                        || state.remote_bound_terminal_rollout.enabled;
                    if transport_eligible
                        && record.integration_state == TerminalIntegrationState::Ready
                        && record.prompt_ready
                        && record.active_command.is_none()
                        && record.lease.as_ref().is_some_and(|lease| {
                            matches!(lease.owner, TerminalLeaseOwner::User { .. })
                        })
                    {
                        return Ok(TerminalVisibleCommandRoute::TerminalExecute);
                    }
                }
            }
        }
        Ok(TerminalVisibleCommandRoute::Unavailable)
    }

    pub(crate) fn register_integration_channel(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        shell: TerminalShellKind,
    ) -> Result<(), String> {
        validate_identifier(integration_id, "integration id")?;
        let mut state = self.lock()?;
        if !state.shell_integration_rollout.enabled {
            return Err("TERMINAL_SHELL_INTEGRATION_DISABLED".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.input_mode == InputMode::NativeInline {
            return Err("TERMINAL_NATIVE_MODE_NOT_LEGACY".into());
        }
        if !shell.supported() {
            record.integration_shell = Some(shell);
            degrade_record(record, "unsupportedShell")?;
            return Ok(());
        }
        record.integration_state = TerminalIntegrationState::Initializing;
        if record.native_clear_pending.is_none() {
            record.native_clear_sequence = 0;
            record.native_clear_confirmed = None;
            record.native_clear_scope = None;
        }
        record.integration_id = Some(integration_id.to_string());
        record.integration_shell = Some(shell);
        record.integration_reason = None;
        record.integration_event_sequence = 0;
        record.prompt_started = false;
        record.prompt_ready = false;
        record.native_input = false;
        record.native_checkpoints = false;
        record.native_typing = false;
        record.native_private_control = false;
        record.native_jobs = false;
        record.native_comments = false;
        advance_integration_state_revision(record)?;
        Ok(())
    }

    pub(crate) fn mark_integration_degraded(
        &self,
        transport_session_id: &str,
        shell: TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.integration_shell = Some(shell);
            degrade_record(record, reason)
        })
    }

    pub(crate) fn mark_integration_unavailable(
        &self,
        transport_session_id: &str,
        shell: TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.integration_shell = Some(shell);
            record.integration_state = TerminalIntegrationState::Unavailable;
            record.integration_reason = Some(reason.to_string());
            record.integration_id = None;
            record.prompt_ready = false;
            record.prompt_started = false;
            if let Some(command) = &record.active_command {
                settle_command_uncertain(command, record.next_output_sequence.saturating_sub(1));
            }
            advance_integration_state_revision(record)
        })
    }

    pub(crate) fn accept_integration_event(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        event: TerminalIntegrationControlEvent,
    ) -> Result<(), String> {
        let integration_became_ready =
            matches!(&event, TerminalIntegrationControlEvent::Ready { .. });
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        if let TerminalIntegrationControlEvent::Job {
            handle,
            state: observed,
            exit_code,
        } = &event
        {
            let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
            if record.integration_id.as_deref() != Some(integration_id) {
                return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
            }
            require_ready_integration(record)?;
            let sequence = record.next_output_sequence.saturating_sub(1);
            let active_command = record
                .active_command
                .as_ref()
                .map(|operation| {
                    let data = operation.lock()?;
                    Ok::<_, String>((
                        data.intent.identity.operation_id.clone(),
                        data.lifecycle.started(),
                        data.state(),
                    ))
                })
                .transpose()?;
            let active_operation = active_command
                .as_ref()
                .map(|(operation, _, _)| operation.as_str());
            let command_accepted = active_command.as_ref().is_some_and(|(_, started, state)| {
                *started
                    && matches!(
                        state,
                        TerminalCommandState::Running | TerminalCommandState::CancelRequested
                    )
            });
            let fresh_control = command_accepted
                && active_operation
                    .and_then(|operation| {
                        state
                            .prepared_job_commands
                            .get(operation)
                            .map(|prepared| (operation, prepared))
                    })
                    .is_some_and(|(operation, prepared)| {
                        prepared.job.process_handle == *handle
                            && prepared.job.operation_id != operation
                            && prepared.source == prepared.line
                    });
            let job = state.jobs.get_mut(handle).ok_or("TERMINAL_JOB_UNKNOWN")?;
            if job.transport_session_id != transport_session_id
                || job.terminal_generation != attachment.terminal_generation
                || job.terminal_session_id != attachment.terminal_session_id
                || job.integration_id.as_deref() != Some(integration_id)
            {
                return Err("TERMINAL_JOB_IDENTITY_MISMATCH".into());
            }
            if matches!(job.state.as_str(), "exited" | "rejected")
                || job.native_active == Some(false)
                || job.control_lost
                || !command_accepted
                || (active_operation != Some(job.operation_id.as_str()) && !fresh_control)
                || (job.state == "uncertain" && !fresh_control)
            {
                return Ok(());
            }
            job.observed_output_sequence = sequence;
            job.observed_at_unix_ms = crate::terminal_jobs::observation_time();
            job.observation_revision = job
                .observation_revision
                .checked_add(1)
                .filter(|revision| *revision <= JAVASCRIPT_MAX_SAFE_INTEGER)
                .ok_or_else(counter_exhausted)?;
            match observed.as_str() {
                "running" | "queued" => {
                    if !job.launch_confirmed
                        && active_operation != Some(job.operation_id.as_str())
                        && !fresh_control
                    {
                        return Err("TERMINAL_JOB_START_UNCONFIRMED".into());
                    }
                    job.launch_confirmed = true;
                    job.native_active = Some(true);
                    job.state = observed.clone();
                }
                "finished" => {
                    job.exit_code = *exit_code;
                    job.launch_confirmed = true;
                }
                "stopRequested" => {
                    job.launch_confirmed = true;
                    job.native_active = Some(true);
                    job.stop_requested = true;
                    job.state = observed.clone();
                }
                "settled" => {
                    job.native_active = Some(false);
                    if job.exit_code.is_none() {
                        job.exit_code = *exit_code;
                    }
                    job.state = if job.exit_code.is_some() {
                        "exited"
                    } else {
                        "uncertain"
                    }
                    .into();
                    if job.exit_code.is_none() {
                        job.cleanup_reason = Some(
                            "native job no longer active; original exit status unavailable".into(),
                        );
                    }
                }
                "terminated" => {
                    job.native_active = Some(false);
                    job.state = "exited".into();
                }
                other => {
                    job.native_active = match other {
                        "stopped" => Some(true),
                        "rejected" => Some(false),
                        _ => None,
                    };
                    if !matches!(job.state.as_str(), "exited" | "rejected") {
                        job.state = other.into();
                    }
                    if other == "uncertain"
                        && job.stop_requested
                        && matches!(
                            job.shell,
                            TerminalShellKind::WindowsPowerShell | TerminalShellKind::PowerShell7
                        )
                    {
                        job.cleanup_reason = Some("PowerShell stop remains uncertain; native descendant termination has not been established".into());
                    }
                }
            }
            self.changed.notify_all();
            return Ok(());
        }
        let job_submission_event =
            if let TerminalIntegrationControlEvent::CommandStart { command_line, .. }
            | TerminalIntegrationControlEvent::InputRejected { command_line, .. } = &event
            {
                let operation = current_record_mut(&mut state, transport_session_id, &attachment)?
                    .active_command
                    .as_ref()
                    .map(|operation| operation.snapshot())
                    .transpose()?
                    .map(|snapshot| snapshot.operation_id);
                operation.as_ref().and_then(|operation| {
                    state
                        .prepared_job_commands
                        .get(operation)
                        .filter(|prepared| prepared.job.operation_id == *operation)
                        .map(|prepared| {
                            (
                                prepared.job.process_handle.clone(),
                                command_line.clone(),
                                matches!(
                                    &event,
                                    TerminalIntegrationControlEvent::InputRejected { .. }
                                ),
                            )
                        })
                })
            } else {
                None
            };
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.integration_id.as_deref() != Some(integration_id) {
            return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
        }
        let event_sequence = record
            .integration_event_sequence
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if event_sequence > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        let through_output_sequence = record.next_output_sequence.saturating_sub(1);
        let confirms_prompt = matches!(&event, TerminalIntegrationControlEvent::PromptEnd);
        match event {
            TerminalIntegrationControlEvent::NativeTyping { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started
                    || record.prompt_ready
                    || (enabled && (!record.native_input || !record.native_checkpoints))
                {
                    return Err("TERMINAL_NATIVE_TYPING_OUT_OF_ORDER".into());
                }
                record.native_typing = enabled;
            }
            TerminalIntegrationControlEvent::NativePrivateControl { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started
                    || record.prompt_ready
                    || (enabled && !record.native_input)
                {
                    return Err("TERMINAL_PRIVATE_CONTROL_OUT_OF_ORDER".into());
                }
                record.native_private_control = enabled;
            }
            TerminalIntegrationControlEvent::NativePrivateReady => {
                require_ready_integration(record)?;
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if data.integration_id == record.integration_id
                        && data.state() == TerminalCommandState::Submitted
                        && data.native_empty_confirmed
                        && record.native_private_control
                        && data.native_private_ready == Some(false)
                    {
                        data.native_private_ready = Some(true);
                        drop(data);
                        command.notify();
                    }
                }
            }
            TerminalIntegrationControlEvent::NativePrivateCheckpoint { descriptor, buffer } => {
                require_ready_integration(record)?;
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if data.integration_id != record.integration_id {
                        return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
                    }
                    if data.state() == TerminalCommandState::Submitted {
                        if let Some((expected, expected_buffer, acknowledged)) =
                            data.native_private_checkpoint.take()
                        {
                            // A descriptor from a cancelled/retired operation
                            // must not acknowledge or quarantine its successor.
                            if descriptor.len() != 65 || descriptor.get(33..) != expected.get(33..)
                            {
                                data.native_private_checkpoint =
                                    Some((expected, expected_buffer, acknowledged));
                                return Ok(());
                            }
                            let matched = descriptor == expected
                                && buffer == expected_buffer
                                && data.native_empty_confirmed
                                && record.native_private_control;
                            data.native_private_checkpoint =
                                Some((expected, expected_buffer, matched));
                            if matched {
                                data.confirm_editor(&buffer)?;
                            }
                            if matched && matches!(data.plan.method,crate::terminal_command::state::ExecutionMethod::NativeJobControl) {
                                data.input_proof=Some(FullInputProof::verify_legacy_control(&data.intent,&data.plan,&descriptor,&buffer)?);
                                data.lifecycle.apply(CommandEvent::ConfirmInput)?;
                                data.revision=next_command_revision(data.revision)?;
                            }
                            if !matched {
                                data.lifecycle.apply(CommandEvent::InputLost)?;
                                data.revision = next_command_revision(data.revision)?;
                                data.input_rejection =
                                    Some("TERMINAL_PRIVATE_CONTROL_MISMATCH".into());
                                record.native_recovery_required = true;
                                record.command_input_pending = true;
                                record.native_input = false;
                            }
                            drop(data);
                            command.notify();
                        }
                    }
                }
            }
            TerminalIntegrationControlEvent::NativeCleared { sequence, buffer } => {
                require_ready_integration(record)?;
                if let Some((operation, integration, expected, queued)) =
                    record.native_clear_pending.clone()
                {
                    if integration != record.integration_id {
                        return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
                    }
                    if queued && sequence == expected && sequence > record.native_clear_sequence {
                        record.native_clear_sequence = sequence;
                        record.native_clear_pending = None;
                        record.native_clear_scope = None;
                        if buffer.is_empty() {
                            record.native_clear_confirmed = Some(operation.clone());
                            record.prompt_started = false;
                            record.prompt_ready = true;
                            record.command_input_pending = record.native_recovery_required;
                            if let Some(command) = &record.active_command {
                                let mut data = command.lock()?;
                                if data.intent.identity.operation_id == operation
                                    && data.lifecycle.phase() == CommandPhase::CancelRequested
                                    && !data.lifecycle.may_have_submitted()
                                {
                                    data.lifecycle.apply(CommandEvent::DraftCleared)?;
                                    data.revision = next_command_revision(data.revision)?;
                                    drop(data);
                                    command.notify();
                                }
                            }
                        } else {
                            record.native_recovery_required = true;
                            record.command_input_pending = true;
                            record.native_input = false;
                        }
                    }
                } else if sequence > record.native_clear_sequence {
                    record.native_clear_sequence = sequence;
                }
            }
            TerminalIntegrationControlEvent::NativeCheckpointMode { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started
                    || record.prompt_ready
                    || (enabled && !record.native_input)
                {
                    return Err("TERMINAL_NATIVE_CHECKPOINT_OUT_OF_ORDER".into());
                }
                record.native_checkpoints = enabled;
            }
            TerminalIntegrationControlEvent::NativeCheckpoint { buffer } => {
                require_ready_integration(record)?;
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if data.integration_id != record.integration_id {
                        return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
                    }
                    if data.state() == TerminalCommandState::Submitted {
                        if data.native_read_only_probe && data.native_probe_refresh {
                            // Drain the old read-only request before issuing a
                            // new one after Q. Its late A cannot authorize data.
                            data.native_probe_outstanding = false;
                            drop(data);
                            command.notify();
                        } else if let Some((expected, _)) = data.native_checkpoint.take() {
                            if data.native_read_only_probe {
                                data.native_probe_outstanding = false;
                            }
                            let initial = expected.is_empty() && !data.native_empty_confirmed;
                            let matched = expected == buffer;
                            data.native_checkpoint = Some((expected, matched));
                            if matched {
                                data.confirm_editor(&buffer)?;
                                if initial {
                                    data.native_empty_confirmed = true;
                                    record.native_clear_scope = Some((
                                        data.intent.identity.operation_id.clone(),
                                        record.integration_id.clone(),
                                    ));
                                }
                            } else if initial {
                                data.lifecycle.apply(CommandEvent::PreparationFailed)?;
                                data.revision = next_command_revision(data.revision)?;
                                record.prompt_ready = true;
                                record.command_input_pending = false;
                            } else {
                                data.lifecycle.apply(CommandEvent::InputLost)?;
                                data.revision = next_command_revision(data.revision)?;
                                record.native_input = false;
                                record.native_recovery_required = true;
                                record.command_input_pending = true;
                            }
                            drop(data);
                            command.notify();
                        }
                    }
                }
            }
            TerminalIntegrationControlEvent::NativeJobs { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started {
                    return Err("TERMINAL_JOB_CAPABILITY_OUTSIDE_PROMPT".into());
                }
                record.native_jobs = enabled && record.native_private_control;
            }
            TerminalIntegrationControlEvent::Job { .. } => unreachable!("job event handled above"),
            TerminalIntegrationControlEvent::Ready { shell } => {
                if record.integration_state != TerminalIntegrationState::Initializing
                    || record.integration_shell != Some(shell)
                {
                    degrade_record(record, "shellIdentityMismatch")?;
                    return Err("TERMINAL_INTEGRATION_SHELL_IDENTITY_MISMATCH".into());
                }
                record.integration_state = TerminalIntegrationState::Ready;
                record.integration_reason = None;
            }
            TerminalIntegrationControlEvent::PromptStart { cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                let (read_only_probe, source_may_be_enqueued) =
                    if let Some(command) = &record.active_command {
                        let mut data = command.lock()?;
                        let safe = data.state() == TerminalCommandState::Submitted
                            && data.native_read_only_probe
                            && !data.source_may_be_enqueued;
                        if safe {
                            data.native_probe_refresh = true;
                            data.native_probe_waiting_prompt = true;
                            data.native_empty_confirmed = false;
                            data.native_checkpoint = Some((String::new(), false));
                            record.native_clear_scope = None;
                        }
                        (safe, data.source_may_be_enqueued)
                    } else {
                        (false, false)
                    };
                if (record.command_input_pending || source_may_be_enqueued)
                    && !read_only_probe
                    && record.active_command.as_ref().is_some_and(|command| {
                        command
                            .snapshot()
                            .is_ok_and(|snapshot| snapshot.state == TerminalCommandState::Submitted)
                    })
                {
                    record.native_recovery_required = true;
                    record.command_input_pending = true;
                    record.native_input = false;
                    degrade_record(
                        record,
                        if source_may_be_enqueued {
                            "promptDuringUnsubmittedInput:sourceMayBeEnqueued"
                        } else {
                            "promptDuringUnsubmittedInput:sourceNotEnqueued"
                        },
                    )?;
                    return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: shell prompt changed while command input was pending; reconnect before retrying".into());
                }
                if record.prompt_started {
                    return Err("TERMINAL_PROMPT_START_OUT_OF_ORDER".into());
                }
                record.current_directory = Some(cwd);
                record.prompt_started = true;
                record.prompt_ready = false;
                record.prompt_start_input_sequence = if record.interactive_input.is_none() {
                    record.next_input_sequence
                } else {
                    record.prompt_next_input_sequence
                };
                record.native_input = false;
                record.native_checkpoints = false;
                record.native_typing = false;
                record.native_private_control = false;
                record.native_jobs = false;
                record.native_comments = false;
            }
            TerminalIntegrationControlEvent::NativeInput { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started || record.prompt_ready {
                    return Err("TERMINAL_NATIVE_INPUT_OUT_OF_ORDER".into());
                }
                record.native_input = enabled;
            }
            TerminalIntegrationControlEvent::NativeComments { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started
                    || record.prompt_ready
                    || record.integration_shell != Some(TerminalShellKind::Zsh)
                {
                    return Err("TERMINAL_NATIVE_INPUT_OUT_OF_ORDER".into());
                }
                record.native_comments = enabled;
            }
            TerminalIntegrationControlEvent::InputRejected {
                command_line,
                reason,
            } => {
                require_ready_integration(record)?;
                if !matches!(
                    reason.as_str(),
                    "TERMINAL_INPUT_UNSUPPORTED" | "TERMINAL_BACKGROUND_UNSUPPORTED"
                ) {
                    return Err("TERMINAL_INTEGRATION_INVALID_INPUT_REJECTION".into());
                }
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    let matches_prepared_submission = job_submission_event.is_some()
                        && data
                            .has_submission_envelope
                            .then(|| data.plan.submitted_line())
                            == Some(command_line.as_str());
                    if (data.intent.source() != command_line && !matches_prepared_submission)
                        || !matches!(
                            data.state(),
                            TerminalCommandState::Submitted
                                | TerminalCommandState::Running
                                | TerminalCommandState::CancelRequested
                        )
                    {
                        drop(data);
                        degrade_record(record, "invalidInputRejection")?;
                        return Err("TERMINAL_COMMAND_LINE_MISMATCH".into());
                    }
                    if data.lifecycle.requested_settlement().is_none() {
                        data.input_rejection = Some(reason);
                    }
                    data.lifecycle.apply(CommandEvent::ParserRejected)?;
                    data.revision = next_command_revision(data.revision)?;
                    data.capture_end_sequence = Some(through_output_sequence);
                    drop(data);
                    command.notify();
                }
                record.command_input_pending = true;
            }
            TerminalIntegrationControlEvent::InterruptUncertain => {
                require_ready_integration(record)?;
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    data.interrupt_uncertain = true;
                    data.revision = next_command_revision(data.revision)?;
                    drop(data);
                    command.notify();
                }
            }
            TerminalIntegrationControlEvent::PromptEnd => {
                require_ready_integration(record)?;
                if !record.prompt_started {
                    return Err("TERMINAL_PROMPT_END_OUT_OF_ORDER".into());
                }
                record.prompt_started = false;
                record.prompt_ready = true;
                record.prompt_next_input_sequence = record.prompt_start_input_sequence;
                record.command_input_pending =
                    record.native_recovery_required || record.native_clear_pending.is_some();
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if !data.native_protocol
                        && data.lifecycle.phase() == CommandPhase::CancelRequested
                        && data
                            .lifecycle
                            .apply(CommandEvent::LegacyEditReturned)
                            .is_ok()
                    {
                        data.revision = next_command_revision(data.revision)?;
                        command.notify();
                    }
                    if data.native_read_only_probe && data.native_probe_refresh {
                        data.native_probe_waiting_prompt = false;
                        drop(data);
                        command.notify();
                    }
                }
            }
            TerminalIntegrationControlEvent::CommandStart { command_line, cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                record.prompt_ready = false;
                record.prompt_started = false;
                record.current_directory = Some(cwd.clone());
                if let Some(input) = record.interactive_input.take() {
                    record.interactive_input = Some(match input {
                        InteractiveInput::Submitted { line, through } if line == command_line => {
                            InteractiveInput::Running { through }
                        }
                        _ => InteractiveInput::Unconfirmed,
                    });
                }
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if data.native_protocol
                        || data.lifecycle.submission_revoked()
                            && !data.lifecycle.may_have_submitted()
                    {
                        return Ok(());
                    }
                    if !matches!(
                        data.state(),
                        TerminalCommandState::Submitted | TerminalCommandState::CancelRequested
                    ) {
                        drop(data);
                        degrade_record(record, "unexpectedCommandStart")?;
                        return Err("TERMINAL_COMMAND_START_OUT_OF_ORDER".into());
                    }
                    if command_line != data.plan.submitted_line() {
                        data.lifecycle.apply(CommandEvent::ControlLost)?;
                        data.revision = next_command_revision(data.revision)?;
                        data.capture_end_sequence = Some(through_output_sequence);
                        TerminalRolloutCounters::increment(&self.counters.uncertainty);
                        drop(data);
                        command.notify();
                        degrade_record(record, "exactCommandLineMismatch")?;
                        return Err("TERMINAL_COMMAND_LINE_MISMATCH".into());
                    }
                    data.lifecycle.apply(CommandEvent::LegacyStarted)?;
                    record.native_clear_scope = None;
                    record.command_input_pending = false;
                    data.revision = next_command_revision(data.revision)?;
                    data.cwd = Some(cwd);
                    data.capture_start_sequence = data
                        .capture_start_sequence
                        .min(through_output_sequence.saturating_add(1));
                    drop(data);
                    command.notify();
                }
            }
            TerminalIntegrationControlEvent::CommandEnd { exit_code, cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                record.prompt_ready = false;
                record.prompt_started = false;
                record.current_directory = Some(cwd.clone());
                if matches!(record.interactive_input, Some(InteractiveInput::Running { through }) if through == record.next_input_sequence)
                {
                    record.interactive_input = None;
                }
                if let Some(command) = &record.active_command {
                    settle_command_from_integration(
                        command,
                        exit_code,
                        cwd,
                        through_output_sequence,
                    )?;
                }
            }
            TerminalIntegrationControlEvent::DirectoryChanged { cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                record.current_directory = Some(cwd);
            }
        }
        record.integration_event_sequence = event_sequence;
        advance_integration_state_revision(record)?;
        if confirms_prompt {
            record.prompt_ready_revision = record.integration_state_revision;
        }
        if let Some((handle, line, rejected)) = job_submission_event {
            if let Some(job) = state.jobs.get_mut(&handle) {
                if rejected {
                    job.state = "rejected".into();
                    job.native_active = Some(false);
                    job.cleanup_reason =
                        Some("native parser refused source before starting a job".into());
                } else {
                    job.accepted_command_line = Some(line);
                }
            }
        }
        TerminalRolloutCounters::increment(&self.counters.lifecycle_matched);
        if integration_became_ready {
            TerminalRolloutCounters::increment(&self.counters.integration_ready);
        }
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn integration_channel_closed(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(());
        }
        let attachment = match current_attachment(&state, transport_session_id) {
            Ok(attachment) => attachment.clone(),
            Err(_) => return Ok(()),
        };
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.integration_id.as_deref() != Some(integration_id) {
            return Ok(());
        }
        degrade_record(record, reason)?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn begin_command(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.begin_command_with_submission(transport_session_id, operation_id, command_line, None)
    }

    #[cfg(test)]
    pub(crate) fn begin_command_with_submission(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
        submitted_command_line: Option<&str>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.begin_command_with_context(
            transport_session_id,
            operation_id,
            command_line,
            submitted_command_line,
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn begin_command_with_context(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
        submitted_command_line: Option<&str>,
        authorization: Option<crate::terminal_command::state::IntentAuthorization>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.begin_command_record(
            transport_session_id,
            operation_id,
            command_line,
            submitted_command_line,
            authorization,
            false,
            false,
            None,
        )
    }

    pub(crate) fn begin_waiting_command_with_context(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
        submitted_command_line: Option<&str>,
        authorization: Option<crate::terminal_command::state::IntentAuthorization>,
        handoff_to_user: bool,
        expected_agent: &str,
        expected_task: &str,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.begin_command_record(
            transport_session_id,
            operation_id,
            command_line,
            submitted_command_line,
            authorization,
            true,
            handoff_to_user,
            Some((expected_agent, expected_task)),
        )
    }

    fn begin_command_record(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
        submitted_command_line: Option<&str>,
        authorization: Option<crate::terminal_command::state::IntentAuthorization>,
        awaiting_ready: bool,
        handoff_to_user: bool,
        expected_owner: Option<(&str, &str)>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        validate_identifier(operation_id, "operation id")?;
        let prior_owner = {
            let mut state = self.lock()?;
            if state.terminal_execute_rollout.enabled {
                let attachment = current_attachment(&state, transport_session_id)?.clone();
                let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
                record.lease.as_ref().and_then(|lease| match &lease.owner {
                    TerminalLeaseOwner::Agent {
                        agent_session_id,
                        task_id,
                        operation_id: expected,
                        ..
                    } if expected == operation_id => {
                        Some((agent_session_id.clone(), task_id.clone()))
                    }
                    _ => None,
                })
            } else {
                None
            }
        };
        if let Some((agent, task)) = prior_owner {
            self.check_submission_replay(&agent, &task, operation_id)?;
        }
        let mut state = self.lock()?;
        if !state.terminal_execute_rollout.enabled {
            return Err("TERMINAL_EXECUTE_DISABLED".into());
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let prepared_job = state.prepared_job_commands.get(operation_id).cloned();
        if prepared_job.is_some() && submitted_command_line.is_none() {
            return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.transport_kind == TerminalTransportKind::SshPty && !remote_visible_command_enabled
        {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        if record.integration_state != TerminalIntegrationState::Ready || !record.prompt_ready {
            return Err("TERMINAL_INTEGRATION_NOT_READY".into());
        }
        if record.native_recovery_required || record.native_clear_pending.is_some() {
            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native edit was not confirmed; reconnect before any further input".into());
        }
        if handoff_to_user
            && (record.input_mode != InputMode::NativeInline
                || !record
                    .native_profile
                    .as_ref()
                    .is_some_and(|profile| profile.capture_fence()))
        {
            return Err(
                "TERMINAL_HANDOFF_UNAVAILABLE: this terminal cannot observe the foreground screen"
                    .into(),
            );
        }
        if record.input_mode == InputMode::NativeInline && submitted_command_line.is_none() {
            return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
        }
        if let Some(submitted) = submitted_command_line {
            let job_matches = prepared_job.as_ref().is_some_and(|prepared| {
                prepared.source == command_line
                    && if record.input_mode == InputMode::NativeInline {
                        prepared_native_job(prepared)
                            .and_then(|job| {
                                nip::native_shell_job_plan(
                                    command_line,
                                    crate::terminal_command::registration::shell_family(
                                        prepared.job.shell,
                                    )?,
                                    &job,
                                )
                                .map_err(|_| "TERMINAL_NATIVE_PLAN_INVALID".into())
                            })
                            .is_ok_and(|expected| expected == submitted)
                    } else {
                        prepared.line == submitted
                    }
            });
            if let Some(prepared) = &prepared_job {
                validate_prepared_shell_job(record, prepared, operation_id)?;
            }
            let expected_bash = if record.input_mode == InputMode::NativeInline {
                nip::native_foreground_plan(
                    command_line,
                    crate::terminal_command::registration::shell_family(
                        record
                            .integration_shell
                            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?,
                    )?,
                )
                .map_err(|_| "TERMINAL_NATIVE_SUBMISSION_MISMATCH")?
            } else {
                crate::terminal_integration::bash_native_submission(command_line)?
            };
            let bash_source_matches = (record.input_mode == InputMode::NativeInline
                || record.integration_shell == Some(TerminalShellKind::Bash))
                && submitted == expected_bash
                && (record.native_input
                    || (command_line.len() <= 512 && !command_line.contains(['\n', '\r', '\t'])));
            // A short Bash eval submission uses ordinary Readline typing and
            // does not require the complete-script receiver (notably Bash 3).
            // Prepared background jobs still require their native capability.
            if (job_matches && !record.native_input) || (!job_matches && !bash_source_matches) {
                return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
            }
        }
        if record.active_command.is_some() {
            return Err("TERMINAL_COMMAND_BUSY".into());
        }
        let lease = record
            .lease
            .as_ref()
            .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
        if !matches!(
            &lease.owner,
            TerminalLeaseOwner::Agent {
                operation_id: expected,
                ..
            } if expected == operation_id
        ) {
            return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
        }
        let (agent_session_id, task_id) = match &lease.owner {
            TerminalLeaseOwner::Agent {
                agent_session_id,
                task_id,
                ..
            } => (agent_session_id.clone(), task_id.clone()),
            _ => return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into()),
        };
        if expected_owner.is_some_and(|(agent, task)| agent != agent_session_id || task != task_id)
        {
            return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
        }
        let identity = CommandIdentity {
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            lease_id: lease.lease_id.clone(),
            lease_generation: lease.revision,
            agent_session_id,
            task_id,
            operation_id: operation_id.into(),
            command_id: opaque_id("command"),
            source_revision: 1,
        };
        let intent =
            CommandIntent::new(identity, command_line.into())?.with_authorization(authorization);
        intent.validate_authorization_binding(transport_session_id, prepared_job.as_ref())?;
        use crate::terminal_command::state::ExecutionMethod;
        let method = if record.input_mode == InputMode::NativeInline {
            ExecutionMethod::NativeInline
        } else if prepared_job.is_some() {
            if submitted_command_line == Some(command_line) {
                ExecutionMethod::NativeJobControl
            } else {
                ExecutionMethod::NativeJobLaunch
            }
        } else {
            ExecutionMethod::LegacyEditor
        };
        let mut plan = ExecutionPlan::new(
            &intent,
            submitted_command_line.unwrap_or(command_line).into(),
            record.integration_shell,
            method,
        );
        if record.input_mode == InputMode::NativeInline {
            plan.native_job = prepared_job.as_ref().map(prepared_native_job).transpose()?;
        }
        let operation = Arc::new(TerminalCommandOperation::from_intent(
            intent,
            plan,
            submitted_command_line.is_some(),
            record.integration_id.clone(),
            record.next_output_sequence,
            self.config.capture_max_bytes,
            Arc::clone(&self.counters),
            awaiting_ready,
            Arc::downgrade(&self.state),
        ));
        if record.input_mode == InputMode::NativeInline {
            let mut data = operation.lock()?;
            data.native_protocol = true;
            data.requires_complete_proof = true;
            data.native_capabilities_confirmed = record.native_display_negotiated;
            if handoff_to_user {
                data.handoff_screen = Some(TerminalScreenModel::new(record.geometry));
            }
        }
        record.active_command = Some(Arc::clone(&operation));
        record.native_clear_scope = None;
        if !awaiting_ready {
            record.prompt_ready = false;
        }
        advance_integration_state_revision(record)?;
        Ok(operation)
    }

    pub(crate) fn activate_waiting_command(
        &self,
        transport: &str,
        operation: &Arc<TerminalCommandOperation>,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let operation_id = operation.lock()?.intent.identity.operation_id.clone();
        let prepared = state.prepared_job_commands.get(&operation_id).cloned();
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        if !record
            .active_command
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
        }
        require_ready_integration(record)?;
        let mut data = operation.lock()?;
        if data.integration_id != record.integration_id {
            return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
        }
        if let Some(prepared) = &prepared {
            validate_prepared_shell_job(record, prepared, &operation_id)?;
        }
        if !record.lease.as_ref().is_some_and(|lease| {
            lease.lease_id == data.intent.identity.lease_id
                && lease.revision == data.intent.identity.lease_generation
        }) {
            return Err("TERMINAL_BROKER_STALE_LEASE".into());
        }
        if record.native_recovery_required || record.native_clear_pending.is_some() {
            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED".into());
        }
        data.lifecycle.apply(CommandEvent::Ready)?;
        data.revision = next_command_revision(data.revision)?;
        record.prompt_ready = false;
        advance_integration_state_revision(record)?;
        Ok(())
    }

    pub(crate) fn prepare_shell_job(
        &self,
        transport: &str,
        target: &crate::agent_runtime::AgentToolTargetNative,
        agent: &str,
        task: &str,
        operation: &str,
        source: &str,
    ) -> Result<crate::terminal_jobs::NativeShellJob, String> {
        let mut state = self.lock()?;
        if state.jobs.len() >= 4096 {
            return Err("TERMINAL_JOB_CAPACITY_REACHED".into());
        }
        if state.jobs.values().any(|job| {
            job.owner_target_id == target.target_id()
                && job.agent_session_id == agent
                && job.task_id == task
                && job.operation_id == operation
        }) {
            return Err("TERMINAL_JOB_LAUNCH_ALREADY_REGISTERED: do not replay; retain the original opaque handle".into());
        }
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        require_ready_integration(record)?;
        if !record.native_input
            || !record.native_checkpoints
            || record.native_recovery_required
            || !record.native_jobs
            || !matches!(
                record.integration_shell,
                Some(
                    TerminalShellKind::Bash
                        | TerminalShellKind::Zsh
                        | TerminalShellKind::WindowsPowerShell
                        | TerminalShellKind::PowerShell7
                )
            )
        {
            return Err("TERMINAL_BACKGROUND_UNSUPPORTED: the current shell has not advertised nativeJobControl; no input was sent".into());
        }
        let handle = format!("job-{}", Uuid::new_v4().simple());
        let shell = record
            .integration_shell
            .ok_or("TERMINAL_INTEGRATION_SHELL_UNKNOWN")?;
        let submitted = crate::terminal_jobs::shell_submission(source, &handle, shell)?;
        let job = crate::terminal_jobs::NativeShellJob {
            process_handle: handle.clone(),
            owner_target_id: target.target_id().into(),
            agent_session_id: agent.into(),
            task_id: task.into(),
            integration_id: record.integration_id.clone(),
            frozen_target: target.clone(),
            transport_session_id: transport.into(),
            terminal_session_id: attachment.terminal_session_id,
            terminal_generation: attachment.terminal_generation,
            shell,
            operation_id: operation.into(),
            command_line: source.into(),
            submitted_command_line: submitted.clone(),
            accepted_command_line: None,
            control_lost: false,
            native_active: None,
            state: "starting".into(),
            exit_code: None,
            observed_output_sequence: record.next_output_sequence.saturating_sub(1),
            observed_at_unix_ms: crate::terminal_jobs::observation_time(),
            observation_revision: 0,
            capture_start_sequence: record.next_output_sequence,
            cleanup_reason: None,
            stop_requested: false,
            launch_confirmed: false,
        };
        state.prepared_job_commands.insert(
            operation.into(),
            crate::terminal_jobs::PreparedShellJob {
                native_control_nonce: None,
                job: job.clone(),
                source: source.into(),
                line: submitted,
            },
        );
        state.jobs.insert(handle, job.clone());
        Ok(job)
    }

    pub(crate) fn native_job_plan(
        &self,
        transport: &str,
        operation: &str,
        source: &str,
        line: &str,
    ) -> Result<String, String> {
        let mut state = self.lock()?;
        let prepared = state
            .prepared_job_commands
            .get(operation)
            .ok_or("TERMINAL_JOB_SUBMISSION_UNREGISTERED")?
            .clone();
        if source != prepared.source || line != prepared.line {
            return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
        }
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        validate_prepared_shell_job_binding(record, &prepared, operation, false)?;
        nip::native_shell_job_plan(
            source,
            crate::terminal_command::registration::shell_family(prepared.job.shell)?,
            &prepared_native_job(&prepared)?,
        )
        .map_err(|_| "TERMINAL_NATIVE_PLAN_INVALID".into())
    }

    pub(crate) fn native_job_started(
        &self,
        transport: &str,
        operation: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let prepared = state
            .prepared_job_commands
            .get(operation)
            .filter(|prepared| prepared.job.operation_id == operation)
            .cloned();
        if let Some(prepared) = prepared {
            let attachment = current_attachment(&state, transport)?;
            if attachment.terminal_generation != prepared.job.terminal_generation {
                return Err("TERMINAL_JOB_STALE_BINDING".into());
            }
            let job = state
                .jobs
                .get_mut(&prepared.job.process_handle)
                .ok_or("TERMINAL_JOB_UNKNOWN")?;
            job.accepted_command_line = Some(prepared.line);
        }
        Ok(())
    }

    pub(crate) fn shell_job(
        &self,
        handle: &str,
        owner: &str,
        agent: &str,
        task: &str,
    ) -> Result<crate::terminal_jobs::NativeShellJob, String> {
        let mut state = self.lock()?;
        let job = state
            .jobs
            .get(handle)
            .ok_or("TERMINAL_JOB_UNKNOWN")?
            .clone();
        if job.owner_target_id != owner || job.agent_session_id != agent || job.task_id != task {
            return Err("TERMINAL_JOB_OWNER_MISMATCH".into());
        }
        let live = state
            .sessions
            .get(&job.terminal_session_id)
            .is_some_and(|record| {
                record.open
                    && record.terminal_generation == job.terminal_generation
                    && record.integration_state == TerminalIntegrationState::Ready
                    && record.integration_id == job.integration_id
            });
        if !live {
            let job = state.jobs.get_mut(handle).expect("job exists");
            job.control_lost = true;
            if job.native_active != Some(false) {
                job.native_active = None;
            }
            if !matches!(job.state.as_str(), "exited" | "rejected") {
                job.state = "uncertain".into();
            }
        }
        Ok(state.jobs.get(handle).expect("job exists").clone())
    }

    pub(crate) fn prepare_shell_job_control(
        &self,
        job: &crate::terminal_jobs::NativeShellJob,
        operation: &str,
        stop: bool,
    ) -> Result<String, String> {
        let mut state = self.lock()?;
        let current = state
            .jobs
            .get(&job.process_handle)
            .ok_or("TERMINAL_JOB_UNKNOWN")?;
        if current.owner_target_id != job.owner_target_id
            || current.agent_session_id != job.agent_session_id
            || current.task_id != job.task_id
            || current.frozen_target != job.frozen_target
            || current.terminal_generation != job.terminal_generation
            || current.integration_id != job.integration_id
        {
            return Err("TERMINAL_JOB_OWNER_MISMATCH".into());
        }
        let job = current.clone();
        if job.control_lost
            || job.native_active == Some(false)
            || matches!(job.state.as_str(), "rejected" | "exited")
            || (job.state == "starting" && job.accepted_command_line.is_none())
        {
            return Err("TERMINAL_JOB_NOT_CONTROLLABLE".into());
        }
        let line = crate::terminal_jobs::control_submission(&job.process_handle, job.shell, stop)?;
        state.prepared_job_commands.insert(
            operation.into(),
            crate::terminal_jobs::PreparedShellJob {
                native_control_nonce: Some(Uuid::new_v4().simple().to_string()),
                job: job.clone(),
                source: line.clone(),
                line: line.clone(),
            },
        );
        Ok(line)
    }

    pub(crate) fn validate_shell_job_input(
        &self,
        transport: &str,
        operation: &str,
        source: &str,
        line: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let prepared = state
            .prepared_job_commands
            .get(operation)
            .ok_or("TERMINAL_JOB_SUBMISSION_UNREGISTERED")?
            .clone();
        if source != prepared.source || line != prepared.line {
            return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
        }
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        validate_prepared_shell_job(record, &prepared, operation)
    }

    pub(crate) fn discard_shell_job_submission(&self, operation: &str) -> Result<(), String> {
        self.lock()?.prepared_job_commands.remove(operation);
        Ok(())
    }

    pub(crate) fn require_native_input_recovery(
        &self,
        transport: &str,
        operation: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        if !record.lease.as_ref().is_some_and(|lease|matches!(&lease.owner,TerminalLeaseOwner::Agent{operation_id,..}|TerminalLeaseOwner::Revoking{operation_id,..} if operation_id==operation)) {return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());}
        if let Some(command) = &record.active_command {
            let mut data = command.lock()?;
            if data.intent.identity.operation_id != operation {
                return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
            }
            if data.native_protocol && data.lifecycle.phase() == CommandPhase::CancelRequested {
                // A requested stop is not a private completion receipt. Retain
                // possible submission and allow a genuine late result while
                // making the unknown outcome visible in the authoritative DTO.
                data.lifecycle.apply(CommandEvent::StopUnconfirmed)?;
                data.revision = next_command_revision(data.revision)?;
                drop(data);
                command.notify();
            }
        }
        record.native_recovery_required = true;
        record.command_input_pending = true;
        self.changed.notify_all();
        Ok(())
    }

    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Used by the P1 native adapter; production transport wiring is P2"
        )
    )]
    pub(crate) fn close_native_protocol(
        &self,
        transport: &str,
        operation: &Arc<TerminalCommandOperation>,
        input_safe: bool,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        if !record
            .active_command
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
        }
        record.integration_state = TerminalIntegrationState::Degraded;
        record.integration_reason = Some("nativeControlClosed".into());
        record.integration_id = None;
        record.native_input = false;
        record.prompt_ready = false;
        if !input_safe {
            record.native_recovery_required = true;
            record.command_input_pending = true;
        } else {
            record.command_input_pending =
                record.native_recovery_required || record.native_clear_pending.is_some();
        }
        advance_integration_state_revision(record)?;
        self.changed.notify_all();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn expect_native_clear(
        &self,
        transport: &str,
        operation: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        require_ready_integration(record)?;
        if !record.native_checkpoints||!matches!(record.integration_shell,Some(TerminalShellKind::Bash|TerminalShellKind::Zsh))||!record.native_clear_scope.as_ref().is_some_and(|(expected,integration)|expected==operation&&integration==&record.integration_id)||!record.lease.as_ref().is_some_and(|lease|matches!(&lease.owner,TerminalLeaseOwner::Agent{operation_id,..}|TerminalLeaseOwner::Revoking{operation_id,..}if operation_id==operation)) {return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native clear is not bound to an unsubmitted, confirmed-empty editor/lease".into());}
        if record.native_clear_pending.is_some() {
            return Err(
                "TERMINAL_INPUT_RECOVERY_REQUIRED: an earlier clear is still pending".into(),
            );
        }
        let sequence = record
            .native_clear_sequence
            .checked_add(1)
            .filter(|sequence| *sequence <= JAVASCRIPT_MAX_SAFE_INTEGER)
            .ok_or_else(counter_exhausted)?;
        record.native_clear_pending = Some((
            operation.into(),
            record.integration_id.clone(),
            sequence,
            false,
        ));
        record.native_clear_confirmed = None;
        record.command_input_pending = true;
        record.prompt_ready = false;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn wait_native_clear(
        &self,
        transport: &str,
        operation: &str,
        timeout: Duration,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let integration = current_record_mut(&mut state, transport, &attachment)?
            .integration_id
            .clone();
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state
                    .sessions
                    .get(&attachment.terminal_session_id)
                    .is_some_and(|record| {
                        record.terminal_generation == attachment.terminal_generation
                            && record.integration_id == integration
                            && record
                                .native_clear_pending
                                .as_ref()
                                .is_some_and(|(expected, _, _, _)| expected == operation)
                    })
            })
            .map_err(|_| "TERMINAL_INPUT_RECOVERY_REQUIRED")?;
        Ok(state
            .sessions
            .get(&attachment.terminal_session_id)
            .is_some_and(|record| {
                record.open
                    && record.terminal_generation == attachment.terminal_generation
                    && record.integration_id == integration
                    && record.native_clear_confirmed.as_deref() == Some(operation)
            }))
    }

    /// Called only with execution-layer proof that accept-line was never
    /// attempted. Preparation and a stale transport are not launch evidence.
    pub(crate) fn reject_shell_job_before_submission(
        &self,
        prepared: &crate::terminal_jobs::NativeShellJob,
        reason: &str,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        let job = state
            .jobs
            .get_mut(&prepared.process_handle)
            .ok_or("TERMINAL_JOB_UNKNOWN")?;
        if job.owner_target_id != prepared.owner_target_id
            || job.agent_session_id != prepared.agent_session_id
            || job.task_id != prepared.task_id
            || job.operation_id != prepared.operation_id
            || job.frozen_target != prepared.frozen_target
            || job.terminal_session_id != prepared.terminal_session_id
            || job.terminal_generation != prepared.terminal_generation
            || job.integration_id != prepared.integration_id
        {
            return Err("TERMINAL_JOB_IDENTITY_MISMATCH".into());
        }
        if job.launch_confirmed || job.accepted_command_line.is_some() || job.state == "exited" {
            return Ok(false);
        }
        job.state = "rejected".into();
        job.native_active = Some(false);
        job.cleanup_reason = Some(crate::redaction::redact_sensitive_text(reason));
        state.prepared_job_commands.remove(&prepared.operation_id);
        self.changed.notify_all();
        Ok(true)
    }

    pub(crate) fn mark_shell_job_uncertain(&self, handle: &str) -> Result<(), String> {
        let mut state = self.lock()?;
        let job = state.jobs.get_mut(handle).ok_or("TERMINAL_JOB_UNKNOWN")?;
        if !matches!(job.state.as_str(), "exited" | "rejected") {
            job.state = "uncertain".into();
        }
        Ok(())
    }

    pub(crate) fn shell_jobs_for_cleanup(
        &self,
        task: Option<&str>,
    ) -> Result<Vec<crate::terminal_jobs::NativeShellJob>, String> {
        Ok(self
            .lock()?
            .jobs
            .values()
            .filter(|job| {
                task.is_none_or(|task| task == job.task_id)
                    && !matches!(job.state.as_str(), "exited" | "rejected")
                    && !job.control_lost
                    && job.native_active != Some(false)
            })
            .cloned()
            .collect())
    }

    #[cfg(all(test, unix))]
    pub(crate) fn has_active_shell_jobs(&self, transport: &str) -> Result<bool, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport)?;
        let record = state
            .sessions
            .get(&attachment.terminal_session_id)
            .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?;
        Ok(state.jobs.values().any(|job| {
            job.terminal_session_id == attachment.terminal_session_id
                && job.terminal_generation == attachment.terminal_generation
                && job.integration_id == record.integration_id
                && !job.control_lost
                && job.native_active != Some(false)
                && !matches!(job.state.as_str(), "exited" | "rejected")
        }))
    }

    pub(crate) fn record_shell_job_cleanup(
        &self,
        handle: &str,
        reason: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let job = state.jobs.get_mut(handle).ok_or("TERMINAL_JOB_UNKNOWN")?;
        if matches!(job.state.as_str(), "exited" | "rejected") || job.native_active == Some(false) {
            return Ok(());
        }
        job.cleanup_reason = Some(reason.into());
        if job.state != "exited" {
            job.state = "uncertain".into();
        }
        Ok(())
    }

    pub(crate) fn wait_shell_job_prompt(
        &self,
        job: &crate::terminal_jobs::NativeShellJob,
        timeout: Duration,
    ) -> Result<bool, String> {
        let state = self.lock()?;
        let matches = |record: &SessionRecord| {
            record.open
                && record.terminal_generation == job.terminal_generation
                && record.integration_id == job.integration_id
        };
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state
                    .sessions
                    .get(&job.terminal_session_id)
                    .is_some_and(|record| {
                        matches(record) && (!record.prompt_ready || record.active_command.is_some())
                    })
            })
            .map_err(|_| "TERMINAL_JOB_PROMPT_WAIT_UNAVAILABLE")?;
        Ok(state
            .sessions
            .get(&job.terminal_session_id)
            .is_some_and(|record| {
                matches(record) && record.prompt_ready && record.active_command.is_none()
            }))
    }

    pub(crate) fn wait_shell_job_change(
        &self,
        job: &crate::terminal_jobs::NativeShellJob,
        timeout: Duration,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let _ = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state.jobs.get(&job.process_handle).is_some_and(|current| {
                    current.state == job.state
                        && current.observation_revision == job.observation_revision
                        && current.accepted_command_line == job.accepted_command_line
                        && current.control_lost == job.control_lost
                })
            })
            .map_err(|_| "TERMINAL_JOB_OBSERVATION_UNAVAILABLE")?;
        Ok(())
    }

    pub(crate) fn wait_command_prompt(
        &self,
        operation: &TerminalCommandOperation,
        timeout: Duration,
    ) -> Result<bool, String> {
        let data = operation.lock()?;
        let terminal_id = data.intent.identity.terminal_session_id.clone();
        let generation = data.intent.identity.terminal_generation;
        let integration = data.integration_id.clone();
        drop(data);
        let matches = |record: &SessionRecord| {
            record.open
                && record.terminal_generation == generation
                && record.integration_id == integration
        };
        let state = self.lock()?;
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state.sessions.get(&terminal_id).is_some_and(|record| {
                    matches(record) && (!record.prompt_ready || record.active_command.is_some())
                })
            })
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        Ok(state.sessions.get(&terminal_id).is_some_and(|record| {
            matches(record) && record.prompt_ready && record.active_command.is_none()
        }))
    }

    pub(crate) fn mark_command_uncertain(
        &self,
        transport_session_id: &str,
        command_id: &str,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        let Some(command) = &record.active_command else {
            return Ok(false);
        };
        if command.command_id()?.as_str() != command_id {
            return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
        }
        Ok(settle_command_uncertain(
            command,
            record.next_output_sequence.saturating_sub(1),
        ))
    }

    pub(crate) fn retire_command(
        &self,
        transport_session_id: &str,
        command_id: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        let Some(command) = record.active_command.as_ref() else {
            return Ok(());
        };
        if command.command_id()?.as_str() != command_id {
            return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
        }
        {
            let data = command.lock()?;
            if data.lifecycle.phase() == CommandPhase::CancelRequested
                && (!data.lifecycle.may_have_submitted() || data.lifecycle.source_rejected())
                && data.source_may_be_enqueued
            {
                return Ok(());
            }
        }
        command.finalize_capture(record.next_output_sequence.saturating_sub(1))?;
        {
            let data = command.lock()?;
            if data.lifecycle.may_have_submitted()
                && !data.lifecycle.ended()
                && !data.lifecycle.source_rejected()
                && (data.native_protocol
                    || !data.lifecycle.started()
                    || record.integration_state != TerminalIntegrationState::Ready)
            {
                record.native_recovery_required = true;
                record.command_input_pending = true;
            }
            if !data.lifecycle.started() && !record.command_input_pending {
                record.prompt_ready = record.integration_state == TerminalIntegrationState::Ready;
            }
        }
        record.active_command = None;
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn acquire_agent_lease(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
    ) -> Result<Option<TerminalLeaseSnapshot>, String> {
        self.acquire_agent_lease_for_input(
            transport_session_id,
            agent_session_id,
            task_id,
            operation_id,
            false,
        )
    }

    pub(crate) fn acquire_agent_interactive_lease(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
    ) -> Result<Option<TerminalLeaseSnapshot>, String> {
        self.acquire_agent_lease_for_input(
            transport_session_id,
            agent_session_id,
            task_id,
            operation_id,
            true,
        )
    }

    fn acquire_agent_lease_for_input(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        interactive: bool,
    ) -> Result<Option<TerminalLeaseSnapshot>, String> {
        validate_identifier(agent_session_id, "Agent Session id")?;
        validate_identifier(task_id, "task id")?;
        validate_identifier(operation_id, "operation id")?;
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let interactive_enabled = state.interactive_tools_rollout.enabled;
        let remote_interactive_enabled = state.remote_interactive_tools_rollout.enabled;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.foreground_handoff_active() {
            return Err("TERMINAL_BROKER_LEASE_BUSY".into());
        }
        if interactive {
            if !interactive_enabled
                || (record.transport_kind == TerminalTransportKind::SshPty
                    && !remote_interactive_enabled)
            {
                return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
            }
            if !record.open
                || record.integration_state != TerminalIntegrationState::Ready
                || record.active_command.is_some()
            {
                return Err("TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY".into());
            }
        }
        if record.native_clear_pending.is_some() || record.native_recovery_required {
            return Err(
                "TERMINAL_INPUT_RECOVERY_REQUIRED: edit restoration is not confirmed".into(),
            );
        }
        if record.transport_kind == TerminalTransportKind::SshPty {
            if !remote_visible_command_enabled
                || record.integration_state != TerminalIntegrationState::Ready
            {
                return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
            }
            if !interactive && (!record.prompt_ready || record.active_command.is_some()) {
                return Err("TERMINAL_VISIBLE_COMMAND_BUSY".into());
            }
        }
        let current = record
            .lease
            .as_ref()
            .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
        if !matches!(current.owner, TerminalLeaseOwner::User { .. }) {
            return Err("TERMINAL_BROKER_LEASE_BUSY".into());
        }
        let revision = current
            .revision
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if revision > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        let lease = TerminalLeaseSnapshot {
            lease_id: opaque_id("lease"),
            revision,
            owner: TerminalLeaseOwner::Agent {
                owner_id: agent_session_id.to_string(),
                agent_session_id: agent_session_id.to_string(),
                task_id: task_id.to_string(),
                operation_id: operation_id.to_string(),
            },
        };
        record.lease = Some(lease.clone());
        Ok(Some(lease))
    }

    pub(crate) fn release_agent_lease(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        self.release_agent_lease_checked(
            transport_session_id,
            agent_session_id,
            task_id,
            operation_id,
            false,
        )
    }

    pub(crate) fn handoff_running_command(
        &self,
        transport: &str,
        operation: &Arc<TerminalCommandOperation>,
    ) -> Result<Option<TerminalCommandSnapshot>, String> {
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let record = current_record_mut(&mut state, transport, &attachment)?;
        let mut data = operation.lock()?;
        if data.lifecycle.phase() != CommandPhase::Running
            || data.lifecycle.requested_settlement().is_some()
            || data.takeover_pending
            || !data
                .handoff_screen
                .as_ref()
                .is_some_and(TerminalScreenModel::is_alternate_screen)
        {
            return Ok(None);
        }
        let identity = &data.intent.identity;
        let lease = record
            .lease
            .as_ref()
            .ok_or("TERMINAL_BROKER_LEASE_UNAVAILABLE")?;
        if !record
            .active_command
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, operation))
            || record.integration_id != data.integration_id
            || record.integration_state != TerminalIntegrationState::Ready
            || record.native_recovery_required
            || record.native_clear_pending.is_some()
            || !data.native_protocol
            || !data.submission_intent_recorded
            || lease.lease_id != identity.lease_id
            || lease.revision != identity.lease_generation
            || !matches!(&lease.owner, TerminalLeaseOwner::Agent { agent_session_id, task_id, operation_id, .. }
                if agent_session_id == &identity.agent_session_id && task_id == &identity.task_id && operation_id == &identity.operation_id)
        {
            return Err(
                "TERMINAL_HANDOFF_UNAVAILABLE: foreground command ownership changed".into(),
            );
        }
        let revision = next_command_revision(lease.revision)?;
        advance_integration_state_revision(record)?;
        data.handed_off = true;
        data.handoff_screen = None;
        record.lease = Some(user_lease(revision));
        record.command_input_pending = false;
        let mut snapshot = command_snapshot(&data);
        snapshot.command_observation = Some(command_observation(&data));
        self.changed.notify_all();
        Ok(Some(snapshot))
    }

    pub(crate) fn release_agent_lease_checked(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        require_confirmed_prompt: bool,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(false);
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        // Use the same critical section as input admission. A check on a
        // detached snapshot would permit another admission before release.
        if require_confirmed_prompt
            && (record.integration_state != TerminalIntegrationState::Ready
                || !record.prompt_ready
                || record.active_command.is_some()
                || record.prompt_next_input_sequence != record.next_input_sequence
                || record.command_input_pending)
        {
            return Err("TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY".into());
        }
        let lease = record
            .lease
            .as_ref()
            .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
        match &lease.owner {
            TerminalLeaseOwner::Agent {
                agent_session_id: expected_agent,
                task_id: expected_task,
                operation_id: expected_operation,
                ..
            }
            | TerminalLeaseOwner::Revoking {
                agent_session_id: expected_agent,
                task_id: expected_task,
                operation_id: expected_operation,
                ..
            } if expected_agent == agent_session_id
                && expected_task == task_id
                && expected_operation == operation_id => {}
            TerminalLeaseOwner::User { .. } => return Ok(false),
            _ => return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into()),
        }
        let revision = lease
            .revision
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if revision > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        if let Some(command) = &record.active_command {
            let data = command.lock()?;
            if data.lifecycle.requested_settlement().is_some()
                && data.lifecycle.may_have_submitted()
                && !record.prompt_ready
            {
                record.command_input_pending = true;
            }
        }
        record.lease = Some(user_lease(revision));
        Ok(true)
    }

    pub(crate) fn admit_terminal_input<F>(
        &self,
        transport_session_id: &str,
        source: TerminalBrokerInputSource,
        input_kind: TerminalInputKind,
        bytes: &[u8],
        write: F,
    ) -> Result<Option<TerminalInputReceipt>, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        self.admit_terminal_input_with_turn_guard(
            transport_session_id,
            source,
            input_kind,
            bytes,
            false,
            write,
        )
    }

    pub(crate) fn admit_terminal_input_with_turn_guard<F>(
        &self,
        transport_session_id: &str,
        source: TerminalBrokerInputSource,
        input_kind: TerminalInputKind,
        bytes: &[u8],
        require_foreground_handoff: bool,
        write: F,
    ) -> Result<Option<TerminalInputReceipt>, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut state = self.lock()?;
        if require_foreground_handoff {
            let handoff_active = state
                .transports
                .get(transport_session_id)
                .and_then(|attachment| {
                    state
                        .sessions
                        .get(&attachment.terminal_session_id)
                        .filter(|record| {
                            record.open
                                && record.transport_session_id == transport_session_id
                                && record.terminal_generation == attachment.terminal_generation
                        })
                })
                .is_some_and(SessionRecord::foreground_handoff_active);
            if !handoff_active {
                return Err("TERMINAL_INPUT_BLOCKED_BY_AGENT: user input is blocked while an Agent owns the terminal".into());
            }
        }
        // Even a lease release or trusted feature rollback must not expose a
        // partially typed command to a later user Enter. A scoped interrupt is
        // still allowed; only a trusted prompt or a new generation clears it.
        if let Some(record) = state
            .transports
            .get(transport_session_id)
            .and_then(|attachment| state.sessions.get(&attachment.terminal_session_id))
        {
            let owned_clear = bytes == [0x18, 0x04]
                && matches!(&source,TerminalBrokerInputSource::System{operation_id}if record.native_clear_pending.as_ref().is_some_and(|(expected,_,_,_)|expected==operation_id));
            let owned_native_clear = input_kind == TerminalInputKind::NativeDraftClear
                && record.active_command.as_ref().is_some_and(|command|command.lock().is_ok_and(|data|
                    data.native_protocol && data.lifecycle.phase()==CommandPhase::CancelRequested && !data.lifecycle.may_have_submitted()
                    && matches!(&source,TerminalBrokerInputSource::Agent {operation_id,..} if operation_id==&data.intent.identity.operation_id)));
            if bytes == [0x18, 0x04]
                && matches!(&source, TerminalBrokerInputSource::System { .. })
                && !owned_clear
            {
                return Err("TERMINAL_BROKER_SYSTEM_CONTROL_NOT_SCOPED".into());
            }
            if record.native_recovery_required
                && bytes != [3]
                && !owned_clear
                && !owned_native_clear
            {
                return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native editor acknowledgement was lost or mismatched; reconnect before further input".into());
            }
            if record.command_input_pending && bytes != [3] && !owned_clear && !owned_native_clear {
                let continuing_command = matches!(&source, TerminalBrokerInputSource::Agent { .. })
                    && record
                        .active_command
                        .as_ref()
                        .map(|command| {
                            command
                                .lock()
                                .map(|data| data.state() == TerminalCommandState::Submitted)
                        })
                        .transpose()?
                        .unwrap_or(false);
                if !continuing_command {
                    return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: command input was interrupted; wait for the shell prompt or reconnect the terminal".into());
                }
            }
        }
        if !state.rollout.enabled {
            write()?;
            return Ok(None);
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let terminal_execute_enabled = state.terminal_execute_rollout.enabled;
        let prepared_job = match &source {
            TerminalBrokerInputSource::Agent { operation_id, .. }
            | TerminalBrokerInputSource::System { operation_id } => state
                .prepared_job_commands
                .get(operation_id)
                .map(|prepared| (operation_id.clone(), prepared.clone())),
            TerminalBrokerInputSource::User => None,
        };
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        let scoped_native_interrupt = matches!(&source,TerminalBrokerInputSource::System{operation_id} if input_kind==TerminalInputKind::Interrupt && bytes==[3] && record.active_command.as_ref().is_some_and(|command|command.lock().is_ok_and(|data|data.native_protocol && data.intent.identity.operation_id==*operation_id && data.lifecycle.may_have_submitted() && !data.lifecycle.ended())));
        if let Some((operation, prepared)) =
            prepared_job.as_ref().filter(|_| !scoped_native_interrupt)
        {
            validate_prepared_shell_job(record, prepared, operation)?;
        }
        if !matches!(&source, TerminalBrokerInputSource::User)
            && record.transport_kind == TerminalTransportKind::SshPty
            && !remote_visible_command_enabled
            && !scoped_native_interrupt
        {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        if record.active_command.is_some() && !terminal_execute_enabled && !scoped_native_interrupt
        {
            return Err("TERMINAL_EXECUTE_DISABLED".into());
        }
        if !matches!(&source, TerminalBrokerInputSource::User)
            && record.transport_kind == TerminalTransportKind::SshPty
            && record.integration_state != TerminalIntegrationState::Ready
            && !scoped_native_interrupt
        {
            return Err("TERMINAL_INTEGRATION_NOT_READY".into());
        }
        let lease = record
            .lease
            .as_ref()
            .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
        let request = TerminalInputRequest {
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            lease_id: lease.lease_id.clone(),
            input_sequence: record.next_input_sequence,
            source,
            input_kind,
            bytes: bytes.to_vec(),
        };
        if bytes != [3]
            && matches!(request.source, TerminalBrokerInputSource::User)
            && record.active_command.as_ref().is_some_and(|command| {
                command.lock().is_ok_and(|data| {
                    data.lifecycle.requested_settlement().is_some()
                        && data.lifecycle.may_have_submitted()
                        && !data.lifecycle.ended()
                })
            })
        {
            return Err(
                "TERMINAL_INPUT_RECOVERY_REQUIRED: stop settlement is not confirmed".into(),
            );
        }
        let receipt = validate_input(record, &request)?;
        let next_input_sequence = record
            .next_input_sequence
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if next_input_sequence > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        let read_only_probe = bytes == [0x18, 0x01]
            && record.active_command.as_ref().is_some_and(|command| {
                command.lock().is_ok_and(|data| {
                    data.native_read_only_probe
                        && !data.source_may_be_enqueued
                        && data
                            .native_checkpoint
                            .as_ref()
                            .is_some_and(|(prefix, _)| prefix.is_empty())
                })
            });
        let user_submission = matches!(&request.source, TerminalBrokerInputSource::User)
            && record.prompt_ready
            && (bytes == b"\n" || bytes == b"\r");
        let submitted_agent_line =
            matches!(&request.source, TerminalBrokerInputSource::Agent { .. })
                && (bytes == [0x18, 0x05] || bytes == b"\n" || bytes == b"\r");
        let command_input_pending =
            matches!(&request.source, TerminalBrokerInputSource::Agent { .. })
                && record
                    .active_command
                    .as_ref()
                    .map(|command| {
                        command
                            .lock()
                            .map(|data| data.state() == TerminalCommandState::Submitted)
                    })
                    .transpose()?
                    .unwrap_or(false);
        // Authorization, transport admission, and input-sequence commit share
        // the broker lock. A rejected transport enqueue therefore consumes no
        // sequence and writes no partial input.
        if matches!(&request.source, TerminalBrokerInputSource::Agent { .. })
            && bytes != [0x18, 0x01]
            && bytes != [0x18, 0x02]
        {
            if let Some(command) = &record.active_command {
                // Called while the execution registration's submit/cancel/
                // takeover gate is held. Mark before a queue callback can
                // possibly deliver data, including an ambiguous enqueue error.
                let mut data = command.lock()?;
                if input_kind == TerminalInputKind::NativePrepare {
                    record.last_native_prepared = Some(data.intent.identity.clone());
                }
                if input_kind == TerminalInputKind::Executable {
                    if data.takeover_pending {
                        return Err("TERMINAL_LEASE_TAKEN_OVER".into());
                    }
                    if data.native_prepare_rejected {
                        return Err("TERMINAL_NATIVE_SOURCE_REJECTED".into());
                    }
                    if !data.submission_intent_recorded {
                        return Err("TERMINAL_SUBMISSION_INTENT_REQUIRED".into());
                    }
                    if data.native_protocol
                        && (!data.native_capabilities_confirmed || !data.native_commit_armed)
                    {
                        return Err("TERMINAL_NATIVE_COMMIT_NOT_ARMED".into());
                    }
                    if data.requires_complete_proof
                        && !data
                            .input_proof
                            .as_ref()
                            .is_some_and(|proof| proof.matches(&data.intent, &data.plan))
                    {
                        return Err("TERMINAL_INPUT_PROOF_REQUIRED".into());
                    }
                    if data.intent.identity.lease_id != request.lease_id {
                        return Err("TERMINAL_BROKER_STALE_LEASE".into());
                    }
                    let event = if data.requires_complete_proof {
                        CommandEvent::AttemptSubmission
                    } else {
                        CommandEvent::LegacyAttemptSubmission
                    };
                    data.lifecycle.apply(event)?;
                } else if !matches!(
                    input_kind,
                    TerminalInputKind::NativeControl
                        | TerminalInputKind::NativeDraftClear
                        | TerminalInputKind::NativePrepare
                ) && data.lifecycle.can_edit()
                {
                    data.input_proof = None;
                    data.lifecycle.apply(CommandEvent::BeginInput)?;
                }
                data.source_may_be_enqueued = true;
                data.revision = next_command_revision(data.revision)?;
            }
        }
        write()?;
        if record.active_command.is_none()
            && matches!(request.source, TerminalBrokerInputSource::Agent { .. })
        {
            let previous = record.interactive_input.take();
            let text = std::str::from_utf8(bytes).ok().filter(|text| {
                input_kind == TerminalInputKind::Text && !text.chars().any(char::is_control)
            });
            record.interactive_input = Some(match (previous, text) {
                (None, Some(text))
                    if record.prompt_ready
                        && record.prompt_next_input_sequence == record.next_input_sequence =>
                {
                    InteractiveInput::Draft(text.into())
                }
                (Some(InteractiveInput::Draft(mut draft)), Some(text))
                    if draft.len().saturating_add(text.len()) <= MAX_FRAME_BYTES =>
                {
                    draft.push_str(text);
                    InteractiveInput::Draft(draft)
                }
                (Some(InteractiveInput::Draft(line)), None)
                    if input_kind == TerminalInputKind::Key && bytes == b"\r" =>
                {
                    InteractiveInput::Submitted {
                        line,
                        through: next_input_sequence,
                    }
                }
                _ => InteractiveInput::Unconfirmed,
            });
        }
        if input_kind == TerminalInputKind::Interrupt
            && bytes == [3]
            && matches!(request.source, TerminalBrokerInputSource::System { .. })
        {
            if let Some(command) = &record.active_command {
                let mut data = command.lock()?;
                if !data.native_protocol
                    && data.lifecycle.phase() == CommandPhase::CancelRequested
                    && data.lifecycle.submission_revoked()
                    && !data.lifecycle.may_have_submitted()
                {
                    data.lifecycle
                        .apply(CommandEvent::LegacyInterruptEnqueued)?;
                    data.revision = next_command_revision(data.revision)?;
                }
            }
        }
        if bytes == [0x18, 0x04]
            && matches!(&request.source, TerminalBrokerInputSource::System { .. })
        {
            if let Some((_, _, _, queued)) = &mut record.native_clear_pending {
                *queued = true;
            }
        }
        if command_input_pending && !read_only_probe {
            record.command_input_pending = true;
        }
        if submitted_agent_line {
            record.native_clear_scope = None;
        }
        if user_submission {
            record.prompt_ready = false;
            advance_integration_state_revision(record)?;
            self.changed.notify_all();
        }
        record.next_input_sequence = next_input_sequence;
        Ok(Some(receipt))
    }

    pub(crate) fn snapshot(
        &self,
        transport_session_id: Option<&str>,
    ) -> Result<TerminalBrokerSnapshot, String> {
        if let Some(transport_session_id) = transport_session_id {
            validate_identifier(transport_session_id, "transport session id")?;
        }
        let state = self.lock()?;
        let session = transport_session_id
            .and_then(|transport_session_id| state.transports.get(transport_session_id))
            .and_then(|attachment| state.sessions.get(&attachment.terminal_session_id))
            .map(SessionRecord::snapshot)
            .transpose()?;
        Ok(TerminalBrokerSnapshot {
            rollout: state.rollout.clone(),
            shell_integration_rollout: state.shell_integration_rollout.clone(),
            terminal_execute_rollout: state.terminal_execute_rollout.clone(),
            remote_bound_terminal_rollout: state.remote_bound_terminal_rollout.clone(),
            interactive_tools_rollout: state.interactive_tools_rollout.clone(),
            remote_interactive_tools_rollout: state.remote_interactive_tools_rollout.clone(),
            counters: self.counters.snapshot(),
            session,
        })
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
    pub(crate) fn acceptance_raw_output(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalAcceptanceRawOutput, String> {
        validate_identifier(transport_session_id, "transport session id")?;
        let state = self.lock()?;
        let attachment = state.transports.get(transport_session_id).ok_or_else(|| {
            if state.sessions.values().any(|record| {
                record
                    .predecessor_transport_session_ids
                    .iter()
                    .any(|previous| previous == transport_session_id)
            }) {
                "TERMINAL_BROKER_STALE_GENERATION".to_string()
            } else {
                "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string()
            }
        })?;
        let record = state
            .sessions
            .get(&attachment.terminal_session_id)
            .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?;
        if record.terminal_generation != attachment.terminal_generation
            || record.transport_session_id != transport_session_id
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        let complete_from_start = match (record.replay.front(), record.replay.back()) {
            (Some(first), Some(last)) => {
                first.sequence == 1
                    && first.byte_offset == 0
                    && record.replay_bytes as u64 == record.next_byte_offset
                    && last.sequence.checked_add(1) == Some(record.next_output_sequence)
            }
            (None, None) => record.next_output_sequence == 1 && record.next_byte_offset == 0,
            _ => false,
        };
        Ok(TerminalAcceptanceRawOutput {
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            transport_session_id: record.transport_session_id.clone(),
            open: record.open,
            next_output_sequence: record.next_output_sequence,
            next_byte_offset: record.next_byte_offset,
            complete_from_start,
            captured_bytes: record.capture.clone(),
            capture_truncated: record.capture_truncated,
            capture_complete_from_start: !record.capture_truncated
                && record.capture.len() as u64 == record.next_byte_offset
                && record.subscribers.capture.next_sequence == record.next_output_sequence
                && record.subscribers.capture.observed_frames + 1 == record.next_output_sequence
                && record.subscribers.capture.observed_bytes == record.next_byte_offset,
            captured_frame_count: record.subscribers.capture.observed_frames,
            captured_byte_count: record.subscribers.capture.observed_bytes,
            frames: record.replay.iter().cloned().collect(),
        })
    }

    #[cfg(test)]
    pub(crate) fn replay_output(
        &self,
        terminal_session_id: &str,
        terminal_generation: u64,
        from_sequence: u64,
        max_frames: usize,
        max_bytes: usize,
    ) -> Result<TerminalReplayBatch, String> {
        let state = self.lock()?;
        let record = state
            .sessions
            .get(terminal_session_id)
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        if record.terminal_generation != terminal_generation {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        replay_from_record(record, from_sequence, max_frames, max_bytes, self.config)
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let mut state = self.lock()?;
        close_all_open_generations(
            &mut state,
            TerminalGenerationCloseReason::BrokerShutdown,
            self.config.closed_session_capacity,
        )?;
        self.changed.notify_all();
        Ok(())
    }

    fn with_current_record_mut(
        &self,
        transport_session_id: &str,
        update: impl FnOnce(&mut SessionRecord) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        update(record)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, BrokerState>, String> {
        self.state
            .lock()
            .map_err(|_| "TERMINAL_BROKER_UNAVAILABLE".to_string())
    }

    #[cfg(test)]
    pub(crate) fn enabled_for_test(
        replay_max_frames: usize,
        replay_max_bytes: usize,
        capture: usize,
    ) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                replay_max_frames,
                replay_max_bytes,
                capture_max_bytes: capture,
                closed_session_capacity: DEFAULT_CLOSED_SESSION_CAPACITY,
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase3_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                capture_max_bytes: capture,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(all(test, unix))]
    pub(crate) fn phase3_with_journal_for_test(capture: usize, root: &std::path::Path) -> Self {
        let mut broker = Self::phase3_enabled_for_test(capture);
        let journal = SubmissionJournal::unconfigured();
        journal.configure(root).unwrap();
        broker.submission_journal = journal;
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase4_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                capture_max_bytes: capture,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase5_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                capture_max_bytes: capture,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase5_with_journal_for_test(capture: usize, root: &std::path::Path) -> Self {
        let mut broker = Self::phase5_enabled_for_test(capture);
        let journal = SubmissionJournal::unconfigured();
        journal.configure(root).unwrap();
        broker.submission_journal = journal;
        broker
    }

    #[cfg(test)]
    fn enabled_with_closed_capacity_for_test(closed_session_capacity: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                closed_session_capacity,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    fn ingest_test_frame(
        &self,
        frame: TerminalRawOutputFrame,
    ) -> Result<RawFrameAcceptance, String> {
        let mut state = self.lock()?;
        let record = state
            .sessions
            .get_mut(&frame.terminal_session_id)
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        if record.terminal_generation != frame.terminal_generation {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        accept_raw_frame(record, frame, self.config, &self.counters)
    }

    #[cfg(test)]
    fn validate_test_input(
        &self,
        request: &TerminalInputRequest,
    ) -> Result<TerminalInputReceipt, String> {
        let state = self.lock()?;
        let record = state
            .sessions
            .get(&request.terminal_session_id)
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        validate_input(record, request)
    }

    #[cfg(test)]
    fn captured_bytes(&self, terminal_session_id: &str) -> Vec<u8> {
        self.state
            .lock()
            .unwrap()
            .sessions
            .get(terminal_session_id)
            .unwrap()
            .capture
            .clone()
    }

    #[cfg(test)]
    fn metadata_counts(&self) -> (usize, usize, usize) {
        let state = self.state.lock().unwrap();
        (
            state.sessions.len(),
            state.transports.len(),
            state.closed_session_order.len(),
        )
    }
}

/// Narrow benchmark facade. It exercises the same bounded broker fan-out as
/// production without exposing broker mutation or rollout controls to the UI.
pub struct TerminalBrokerBenchmarkObserver {
    broker: TerminalSessionBroker,
    transport_session_id: &'static str,
}

impl TerminalBrokerBenchmarkObserver {
    pub fn local() -> Result<Self, String> {
        Self::attach("benchmark-local", TerminalTransportKind::LocalPty)
    }

    pub fn ssh() -> Result<Self, String> {
        Self::attach("benchmark-ssh", TerminalTransportKind::SshPty)
    }

    fn attach(
        transport_session_id: &'static str,
        transport_kind: TerminalTransportKind,
    ) -> Result<Self, String> {
        let broker = TerminalSessionBroker::default();
        broker.apply_trusted_rollout(
            true,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
        )?;
        broker.attach_transport(
            transport_session_id,
            None,
            transport_kind,
            TerminalGeometry::new(120, 30),
        )?;
        Ok(Self {
            broker,
            transport_session_id,
        })
    }

    pub fn observe(&self, bytes: &[u8]) -> Result<(), String> {
        self.broker
            .observe_raw_output(self.transport_session_id, bytes)
            .map(|_| ())
    }
}

fn close_all_open_generations(
    state: &mut BrokerState,
    reason: TerminalGenerationCloseReason,
    closed_session_capacity: usize,
) -> Result<(), String> {
    let closing = state
        .sessions
        .iter()
        .filter(|(_, record)| record.open)
        .map(|(terminal_session_id, _)| terminal_session_id.clone())
        .collect::<Vec<_>>();
    for terminal_session_id in &closing {
        if let Some(record) = state.sessions.get_mut(terminal_session_id) {
            record.close(reason)?;
        }
    }
    for attachment in state.transports.values_mut() {
        attachment.active = false;
    }
    for terminal_session_id in closing {
        remember_closed_session(state, &terminal_session_id, closed_session_capacity);
    }
    Ok(())
}

fn remember_closed_session(
    state: &mut BrokerState,
    terminal_session_id: &str,
    closed_session_capacity: usize,
) {
    state
        .closed_session_order
        .retain(|closed_id| closed_id != terminal_session_id);
    state
        .closed_session_order
        .push_back(terminal_session_id.to_string());
    while state.closed_session_order.len() > closed_session_capacity {
        let Some(evicted_session_id) = state.closed_session_order.pop_front() else {
            break;
        };
        if state
            .sessions
            .get(&evicted_session_id)
            .is_some_and(|record| !record.open)
        {
            state.sessions.remove(&evicted_session_id);
            state
                .transports
                .retain(|_, attachment| attachment.terminal_session_id != evicted_session_id);
        }
    }
}

fn effective_interactive_tools_for_transport(
    state: &BrokerState,
    transport_kind: TerminalTransportKind,
) -> bool {
    state.interactive_tools_rollout.enabled
        && (transport_kind != TerminalTransportKind::SshPty
            || (state.remote_bound_terminal_rollout.enabled
                && state.remote_interactive_tools_rollout.enabled))
}

fn transport_predecessor<'a>(
    state: &'a BrokerState,
    transport: &str,
) -> Result<&'a SessionRecord, String> {
    let attachment = state
        .transports
        .get(transport)
        .ok_or("TERMINAL_BROKER_PREDECESSOR_NOT_FOUND")?;
    let record = state
        .sessions
        .get(&attachment.terminal_session_id)
        .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?;
    if record.terminal_generation != attachment.terminal_generation
        || record.transport_session_id != transport
    {
        return Err("TERMINAL_BROKER_STALE_PREDECESSOR".into());
    }
    Ok(record)
}

fn new_transport_record(
    state: &BrokerState,
    transport: &str,
    predecessor: Option<&str>,
    kind: TerminalTransportKind,
    geometry: TerminalGeometry,
    mode: InputMode,
) -> Result<SessionRecord, String> {
    let (session_id, generation) = if let Some(predecessor) = predecessor {
        let old = transport_predecessor(state, predecessor)?;
        let generation = old
            .terminal_generation
            .checked_add(1)
            .filter(|generation| *generation <= JAVASCRIPT_MAX_SAFE_INTEGER)
            .ok_or_else(counter_exhausted)?;
        (old.terminal_session_id.clone(), generation)
    } else {
        (format!("terminal-{}", Uuid::new_v4()), 1)
    };
    let mut record = SessionRecord::open(
        session_id,
        generation,
        transport.to_owned(),
        kind,
        geometry,
        effective_interactive_tools_for_transport(state, kind),
    );
    record.input_mode = mode;
    Ok(record)
}

fn install_transport_record(
    state: &mut BrokerState,
    mut record: SessionRecord,
    predecessor: Option<&str>,
) -> Result<TerminalBrokerAttachment, String> {
    let transport = &record.transport_session_id;
    if state
        .transports
        .get(transport)
        .is_some_and(|attachment| attachment.active)
    {
        return Err("TERMINAL_BROKER_TRANSPORT_ALREADY_ATTACHED".into());
    }
    let terminal_session_id = record.terminal_session_id.clone();
    let terminal_generation = record.terminal_generation;
    if let Some(predecessor) = predecessor {
        let old = transport_predecessor(state, predecessor)?;
        if old.terminal_session_id != terminal_session_id
            || old.terminal_generation + 1 != terminal_generation
        {
            return Err("TERMINAL_BROKER_STALE_PREDECESSOR".into());
        }
        let old = state
            .sessions
            .get_mut(&terminal_session_id)
            .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?;
        if old.open {
            old.close(TerminalGenerationCloseReason::Replaced)?;
        }
        record.predecessor_transport_session_ids = old.predecessor_transport_session_ids.clone();
        record
            .predecessor_transport_session_ids
            .push(predecessor.to_owned());
        if record.predecessor_transport_session_ids.len() > 32 {
            record.predecessor_transport_session_ids.remove(0);
        }
    }
    // Keep only the current or most recently closed transport for each session.
    state
        .transports
        .retain(|_, attachment| attachment.terminal_session_id != terminal_session_id);
    state
        .closed_session_order
        .retain(|closed_id| closed_id != &terminal_session_id);
    state.transports.insert(
        transport.clone(),
        TransportAttachment {
            terminal_session_id: terminal_session_id.clone(),
            terminal_generation,
            active: true,
        },
    );
    state.sessions.insert(terminal_session_id.clone(), record);
    Ok(TerminalBrokerAttachment {
        terminal_session_id,
        terminal_generation,
    })
}

fn current_attachment<'a>(
    state: &'a BrokerState,
    transport_session_id: &str,
) -> Result<&'a TransportAttachment, String> {
    let attachment = state
        .transports
        .get(transport_session_id)
        .ok_or_else(|| "TERMINAL_BROKER_TRANSPORT_NOT_FOUND".to_string())?;
    if !attachment.active {
        return Err("TERMINAL_BROKER_STALE_TRANSPORT".into());
    }
    Ok(attachment)
}

fn current_record_mut<'a>(
    state: &'a mut BrokerState,
    transport_session_id: &str,
    attachment: &TransportAttachment,
) -> Result<&'a mut SessionRecord, String> {
    let record = state
        .sessions
        .get_mut(&attachment.terminal_session_id)
        .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
    if !record.open
        || record.terminal_generation != attachment.terminal_generation
        || record.transport_session_id != transport_session_id
    {
        return Err("TERMINAL_BROKER_STALE_GENERATION".into());
    }
    Ok(record)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawFrameAcceptance {
    Accepted,
    Duplicate,
}

fn accept_raw_frame(
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
    let display_bytes = frame.bytes.clone();

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
    debug_assert_eq!(display_bytes, frame.bytes);

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

fn terminal_wait_reason(
    record: &SessionRecord,
    snapshot: &TerminalScreenSnapshot,
    request: &TerminalWaitRequest,
) -> Option<TerminalWaitReason> {
    if let Some(text) = request.text.as_deref() {
        let found = if request.case_sensitive {
            snapshot.content.iter().any(|row| row.contains(text))
        } else {
            let needle = text.to_lowercase();
            snapshot
                .content
                .iter()
                .any(|row| row.to_lowercase().contains(&needle))
        };
        if found {
            return Some(TerminalWaitReason::TextFound);
        }
    }
    if request
        .after_lifecycle_sequence
        .is_some_and(|sequence| record.integration_event_sequence > sequence)
    {
        return Some(TerminalWaitReason::LifecycleObserved);
    }
    if request
        .after_output_sequence
        .is_some_and(|sequence| snapshot.through_output_sequence > sequence)
    {
        return Some(TerminalWaitReason::OutputObserved);
    }
    if request
        .after_screen_version
        .is_some_and(|version| snapshot.screen_version > version)
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

fn replay_from_record(
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

fn validate_input(
    record: &SessionRecord,
    request: &TerminalInputRequest,
) -> Result<TerminalInputReceipt, String> {
    if !record.open {
        return Err("TERMINAL_BROKER_GENERATION_CLOSED".into());
    }
    if request.terminal_session_id != record.terminal_session_id
        || request.terminal_generation != record.terminal_generation
    {
        return Err("TERMINAL_BROKER_STALE_GENERATION".into());
    }
    let lease = record
        .lease
        .as_ref()
        .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
    if request.lease_id != lease.lease_id {
        return Err("TERMINAL_BROKER_STALE_LEASE".into());
    }
    if request.input_sequence != record.next_input_sequence {
        return Err(format!(
            "TERMINAL_BROKER_STALE_INPUT: expected sequence {}, received {}",
            record.next_input_sequence, request.input_sequence
        ));
    }
    if request.bytes.is_empty() || request.bytes.len() > MAX_FRAME_BYTES {
        return Err("TERMINAL_BROKER_INPUT_SIZE_INVALID".into());
    }

    let source_owner_id = match (&request.source, &lease.owner) {
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
                request.input_kind,
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
        ) if request.input_kind == TerminalInputKind::NativeDraftClear
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
        input_sequence: request.input_sequence,
        source_owner_id,
        accepted_bytes: request.bytes.len(),
    })
}

fn user_lease(revision: u64) -> TerminalLeaseSnapshot {
    TerminalLeaseSnapshot {
        lease_id: opaque_id("lease"),
        revision,
        owner: TerminalLeaseOwner::User {
            owner_id: USER_OWNER_ID.to_string(),
        },
    }
}

fn validate_prepared_shell_job(
    record: &SessionRecord,
    prepared: &crate::terminal_jobs::PreparedShellJob,
    operation: &str,
) -> Result<(), String> {
    validate_prepared_shell_job_binding(record, prepared, operation, true)
}
fn validate_prepared_shell_job_binding(
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

fn prepared_native_job(
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

fn require_ready_integration(record: &SessionRecord) -> Result<(), String> {
    if record.integration_state == TerminalIntegrationState::Ready {
        Ok(())
    } else {
        Err("TERMINAL_INTEGRATION_NOT_READY".into())
    }
}

fn validate_cwd(cwd: &str) -> Result<(), String> {
    if cwd.is_empty() || cwd.len() > 16_384 {
        Err("TERMINAL_INTEGRATION_INVALID_CWD".into())
    } else {
        Ok(())
    }
}

fn degrade_record(record: &mut SessionRecord, reason: &str) -> Result<(), String> {
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

fn advance_integration_state_revision(record: &mut SessionRecord) -> Result<(), String> {
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

fn settle_command_from_integration(
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

fn settle_command_uncertain(
    command: &TerminalCommandOperation,
    through_output_sequence: u64,
) -> bool {
    settle_command_after_loss(command, through_output_sequence, CommandEvent::ControlLost)
}

fn settle_command_after_loss(
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

fn opaque_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

fn parse_rollout_value(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" => Some(true),
        "0" | "false" | "off" => Some(false),
        _ => None,
    }
}

fn trusted_rollout_value(
    environment_variable: &str,
    default_enabled: bool,
) -> Result<(bool, TerminalBrokerRolloutSource), String> {
    rollout_value_from_environment_result(
        environment_variable,
        std::env::var(environment_variable),
        default_enabled,
    )
}

fn rollout_value_from_environment_result(
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

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if !crate::terminal_command::protocol::valid_identifier(value) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn counter_exhausted() -> String {
    "TERMINAL_BROKER_COUNTER_EXHAUSTED: reconnect before the IPC safe-integer limit".into()
}

#[cfg(test)]
mod tests {
    include!("tests/terminal_broker.rs");
}
