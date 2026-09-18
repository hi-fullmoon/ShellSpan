use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;

use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};
use crate::terminal_screen::{TerminalScreenModel, TerminalScreenSnapshot};

pub(crate) const TERMINAL_BROKER_FLAG_NAME: &str = "terminal_broker_v1";
pub(crate) const TERMINAL_BROKER_ENVIRONMENT_VARIABLE: &str = "SHELLSPAN_TERMINAL_BROKER_V1";
pub(crate) const TERMINAL_BROKER_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_SHELL_INTEGRATION_FLAG_NAME: &str = "terminal_shell_integration_v1";
pub(crate) const TERMINAL_SHELL_INTEGRATION_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_SHELL_INTEGRATION_V1";
pub(crate) const TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_EXECUTE_FLAG_NAME: &str = "terminal_execute_v1";
pub(crate) const TERMINAL_EXECUTE_ENVIRONMENT_VARIABLE: &str = "SHELLSPAN_TERMINAL_EXECUTE_V1";
pub(crate) const TERMINAL_EXECUTE_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_FLAG_NAME: &str =
    "terminal_remote_bound_terminal_v1";
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL_V1";
const TERMINAL_REMOTE_BOUND_TERMINAL_LEGACY_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_REMOTE_AGENT_PTY_V1";
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_FLAG_NAME: &str = "terminal_interactive_tools_v1";
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS_V1";
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_REMOTE_INTERACTIVE_TOOLS_FLAG_NAME: &str =
    "terminal_remote_interactive_tools_v1";
pub(crate) const TERMINAL_REMOTE_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_REMOTE_INTERACTIVE_TOOLS_V1";
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
pub(crate) struct TerminalBrokerSessionSnapshot {
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_command_id: Option<String>,
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
    pub(crate) session_id: String,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) integration_state_revision: u64,
    pub(crate) state: TerminalIntegrationState,
    pub(crate) prompt_ready: bool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalVisibleCommandRoute {
    TerminalExecute,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCommandSnapshot {
    pub(crate) protocol_version: u8,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) operation_id: String,
    pub(crate) command_id: String,
    pub(crate) command_line: String,
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
    terminal_session_id: String,
    terminal_generation: u64,
    operation_id: String,
    command_id: String,
    command_line: String,
    state: TerminalCommandState,
    revision: u64,
    requested_settlement: Option<TerminalCommandRequestedSettlement>,
    interrupt_sent: bool,
    exit_code: Option<i32>,
    cwd: Option<String>,
    capture: Vec<u8>,
    capture_truncated: bool,
    capture_limit: usize,
    capture_start_sequence: u64,
    capture_end_sequence: Option<u64>,
    capture_open: bool,
}

#[derive(Debug)]
pub(crate) struct TerminalCommandOperation {
    data: Mutex<TerminalCommandData>,
    changed: Condvar,
    counters: Arc<TerminalRolloutCounters>,
}

impl TerminalCommandOperation {
    fn new(
        terminal_session_id: String,
        terminal_generation: u64,
        operation_id: String,
        command_line: String,
        capture_start_sequence: u64,
        capture_limit: usize,
        counters: Arc<TerminalRolloutCounters>,
    ) -> Self {
        Self {
            data: Mutex::new(TerminalCommandData {
                terminal_session_id,
                terminal_generation,
                operation_id,
                command_id: opaque_id("command"),
                command_line,
                state: TerminalCommandState::Submitted,
                revision: 1,
                requested_settlement: None,
                interrupt_sent: false,
                exit_code: None,
                cwd: None,
                capture: Vec::new(),
                capture_truncated: false,
                capture_limit,
                capture_start_sequence,
                capture_end_sequence: None,
                capture_open: true,
            }),
            changed: Condvar::new(),
            counters,
        }
    }

    pub(crate) fn command_id(&self) -> Result<String, String> {
        Ok(self.lock()?.command_id.clone())
    }

    pub(crate) fn snapshot(&self) -> Result<TerminalCommandSnapshot, String> {
        let data = self.lock()?;
        Ok(command_snapshot(&data))
    }

    pub(crate) fn wait_until_terminal(
        &self,
        timeout: Duration,
    ) -> Result<TerminalCommandSnapshot, String> {
        let deadline = Instant::now() + timeout;
        let mut data = self.lock()?;
        while !data.state.is_terminal() {
            let now = Instant::now();
            if now >= deadline {
                return Ok(command_snapshot(&data));
            }
            let (next, wait) = self
                .changed
                .wait_timeout(data, deadline.saturating_duration_since(now))
                .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE".to_string())?;
            data = next;
            if wait.timed_out() && !data.state.is_terminal() {
                return Ok(command_snapshot(&data));
            }
        }
        Ok(command_snapshot(&data))
    }

    pub(crate) fn request_settlement(
        &self,
        requested: TerminalCommandRequestedSettlement,
    ) -> Result<bool, String> {
        let mut data = self.lock()?;
        if data.state.is_terminal() {
            return Ok(false);
        }
        if data.requested_settlement.is_none() {
            data.requested_settlement = Some(requested);
            data.state = TerminalCommandState::CancelRequested;
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

    pub(crate) fn finalize_capture(&self, through_sequence: u64) -> Result<(), String> {
        let mut data = self.lock()?;
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
        if !data.capture_truncated {
            let remaining = data.capture_limit.saturating_sub(data.capture.len());
            let accepted = remaining.min(frame.bytes.len());
            data.capture.extend_from_slice(&frame.bytes[..accepted]);
            if accepted < frame.bytes.len() {
                data.capture_truncated = true;
                TerminalRolloutCounters::increment(&self.counters.truncation);
            }
        }
        data.capture_end_sequence = Some(frame.sequence);
        Ok(())
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

fn command_snapshot(data: &TerminalCommandData) -> TerminalCommandSnapshot {
    TerminalCommandSnapshot {
        protocol_version: 1,
        terminal_session_id: data.terminal_session_id.clone(),
        terminal_generation: data.terminal_generation,
        operation_id: data.operation_id.clone(),
        command_id: data.command_id.clone(),
        command_line: data.command_line.clone(),
        state: data.state,
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
    current_directory: Option<String>,
    active_command: Option<Arc<TerminalCommandOperation>>,
    screen_model: Option<TerminalScreenModel>,
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

impl SessionRecord {
    fn open(
        terminal_session_id: String,
        terminal_generation: u64,
        transport_session_id: String,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
        interactive_tools_enabled: bool,
    ) -> Self {
        Self {
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
            current_directory: None,
            active_command: None,
            screen_model: interactive_tools_enabled.then(|| TerminalScreenModel::new(geometry)),
            last_output_at: Instant::now(),
            lease: Some(user_lease(1)),
            next_input_sequence: 1,
            output_listener_ready: false,
            output_paused: false,
            open: true,
            close_reason: None,
            replay: VecDeque::new(),
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
            settle_command_uncertain(&command, self.next_output_sequence.saturating_sub(1));
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
        advance_integration_state_revision(self)?;
        Ok(())
    }

    fn snapshot(&self) -> TerminalBrokerSessionSnapshot {
        TerminalBrokerSessionSnapshot {
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
                vec![
                    "promptLifecycle",
                    "commandLifecycle",
                    "exactCommandLine",
                    "exitStatus",
                    "currentDirectory",
                ]
            } else {
                Vec::new()
            },
            prompt_ready: self.prompt_ready,
            current_directory: self.current_directory.clone(),
            active_command_id: self
                .active_command
                .as_ref()
                .and_then(|command| command.command_id().ok()),
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
        }
    }
}

#[derive(Debug)]
struct BrokerState {
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
    config: TerminalBrokerConfig,
}

impl Default for TerminalSessionBroker {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            config: TerminalBrokerConfig::default(),
        }
    }
}

impl TerminalSessionBroker {
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
        let (remote_bound_terminal, remote_bound_terminal_source) =
            trusted_rollout_value_with_legacy_alias(
                TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE,
                TERMINAL_REMOTE_BOUND_TERMINAL_LEGACY_ENVIRONMENT_VARIABLE,
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
        validate_identifier(transport_session_id, "transport session id")?;
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        if state
            .transports
            .get(transport_session_id)
            .is_some_and(|attachment| attachment.active)
        {
            return Err("TERMINAL_BROKER_TRANSPORT_ALREADY_ATTACHED".into());
        }

        let (terminal_session_id, terminal_generation) =
            if let Some(predecessor_transport_session_id) = predecessor_transport_session_id {
                let predecessor = state
                    .transports
                    .get(predecessor_transport_session_id)
                    .cloned()
                    .ok_or_else(|| "TERMINAL_BROKER_PREDECESSOR_NOT_FOUND".to_string())?;
                let next_generation = predecessor
                    .terminal_generation
                    .checked_add(1)
                    .ok_or_else(counter_exhausted)?;
                if next_generation > JAVASCRIPT_MAX_SAFE_INTEGER {
                    return Err(counter_exhausted());
                }
                let record = state
                    .sessions
                    .get_mut(&predecessor.terminal_session_id)
                    .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
                if record.terminal_generation != predecessor.terminal_generation {
                    return Err("TERMINAL_BROKER_STALE_PREDECESSOR".into());
                }
                if record.open {
                    if record.transport_session_id != predecessor_transport_session_id {
                        return Err("TERMINAL_BROKER_STALE_PREDECESSOR".into());
                    }
                    record.close(TerminalGenerationCloseReason::Replaced)?;
                }
                if let Some(attachment) = state.transports.get_mut(predecessor_transport_session_id)
                {
                    attachment.active = false;
                }
                (predecessor.terminal_session_id, next_generation)
            } else {
                (format!("terminal-{}", Uuid::new_v4()), 1)
            };

        if terminal_generation > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        // Only the currently attached transport or the most recent closed
        // predecessor is needed. Superseded transport identities must not
        // accumulate across repeated reconnects.
        state
            .transports
            .retain(|_, attachment| attachment.terminal_session_id != terminal_session_id);
        state
            .closed_session_order
            .retain(|closed_id| closed_id != &terminal_session_id);
        let interactive_tools_enabled =
            effective_interactive_tools_for_transport(&state, transport_kind);
        let record = SessionRecord::open(
            terminal_session_id.clone(),
            terminal_generation,
            transport_session_id.to_string(),
            transport_kind,
            geometry,
            interactive_tools_enabled,
        );
        state.sessions.insert(terminal_session_id.clone(), record);
        state.transports.insert(
            transport_session_id.to_string(),
            TransportAttachment {
                terminal_session_id: terminal_session_id.clone(),
                terminal_generation,
                active: true,
            },
        );
        Ok(Some(TerminalBrokerAttachment {
            terminal_session_id,
            terminal_generation,
        }))
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
        self.changed.notify_all();
        Ok(())
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

    pub(crate) fn wait_terminal(
        &self,
        transport_session_id: &str,
        request: TerminalWaitRequest,
    ) -> Result<TerminalWaitResult, String> {
        let deadline = Instant::now() + request.timeout;
        let mut state = self.lock()?;
        if !state.interactive_tools_rollout.enabled {
            return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let terminal_session_id = attachment.terminal_session_id;
        let terminal_generation = attachment.terminal_generation;
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
        if !shell.supported() {
            record.integration_shell = Some(shell);
            degrade_record(record, "unsupportedShell")?;
            return Ok(());
        }
        record.integration_state = TerminalIntegrationState::Initializing;
        record.integration_id = Some(integration_id.to_string());
        record.integration_shell = Some(shell);
        record.integration_reason = None;
        record.integration_event_sequence = 0;
        record.prompt_started = false;
        record.prompt_ready = false;
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
        match event {
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
                if record.prompt_started {
                    return Err("TERMINAL_PROMPT_START_OUT_OF_ORDER".into());
                }
                record.current_directory = Some(cwd);
                record.prompt_started = true;
                record.prompt_ready = false;
            }
            TerminalIntegrationControlEvent::PromptEnd => {
                require_ready_integration(record)?;
                if !record.prompt_started {
                    return Err("TERMINAL_PROMPT_END_OUT_OF_ORDER".into());
                }
                record.prompt_started = false;
                record.prompt_ready = true;
            }
            TerminalIntegrationControlEvent::CommandStart { command_line, cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                record.prompt_ready = false;
                record.prompt_started = false;
                record.current_directory = Some(cwd.clone());
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if !matches!(
                        data.state,
                        TerminalCommandState::Submitted | TerminalCommandState::CancelRequested
                    ) {
                        drop(data);
                        degrade_record(record, "unexpectedCommandStart")?;
                        return Err("TERMINAL_COMMAND_START_OUT_OF_ORDER".into());
                    }
                    if command_line != data.command_line {
                        data.state = TerminalCommandState::Uncertain;
                        data.revision = next_command_revision(data.revision)?;
                        data.capture_end_sequence = Some(through_output_sequence);
                        TerminalRolloutCounters::increment(&self.counters.uncertainty);
                        drop(data);
                        command.notify();
                        degrade_record(record, "exactCommandLineMismatch")?;
                        return Err("TERMINAL_COMMAND_LINE_MISMATCH".into());
                    }
                    if data.state == TerminalCommandState::Submitted {
                        data.state = TerminalCommandState::Running;
                    }
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

    pub(crate) fn begin_command(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        validate_identifier(operation_id, "operation id")?;
        let mut state = self.lock()?;
        if !state.terminal_execute_rollout.enabled {
            return Err("TERMINAL_EXECUTE_DISABLED".into());
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.transport_kind == TerminalTransportKind::SshPty && !remote_visible_command_enabled
        {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        if record.integration_state != TerminalIntegrationState::Ready || !record.prompt_ready {
            return Err("TERMINAL_INTEGRATION_NOT_READY".into());
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
        let operation = Arc::new(TerminalCommandOperation::new(
            record.terminal_session_id.clone(),
            record.terminal_generation,
            operation_id.to_string(),
            command_line.to_string(),
            record.next_output_sequence,
            self.config.capture_max_bytes,
            Arc::clone(&self.counters),
        ));
        record.active_command = Some(Arc::clone(&operation));
        record.prompt_ready = false;
        advance_integration_state_revision(record)?;
        Ok(operation)
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
        command.finalize_capture(record.next_output_sequence.saturating_sub(1))?;
        record.active_command = None;
        Ok(())
    }

    pub(crate) fn acquire_agent_lease(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
    ) -> Result<Option<TerminalLeaseSnapshot>, String> {
        validate_identifier(agent_session_id, "Agent Session id")?;
        validate_identifier(task_id, "task id")?;
        validate_identifier(operation_id, "operation id")?;
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.transport_kind == TerminalTransportKind::SshPty {
            if !remote_visible_command_enabled
                || record.integration_state != TerminalIntegrationState::Ready
            {
                return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
            }
            if !record.prompt_ready || record.active_command.is_some() {
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
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(false);
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
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
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            write()?;
            return Ok(None);
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let terminal_execute_enabled = state.terminal_execute_rollout.enabled;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if !matches!(&source, TerminalBrokerInputSource::User)
            && record.transport_kind == TerminalTransportKind::SshPty
            && !remote_visible_command_enabled
        {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        if record.active_command.is_some() && !terminal_execute_enabled {
            return Err("TERMINAL_EXECUTE_DISABLED".into());
        }
        if !matches!(&source, TerminalBrokerInputSource::User)
            && record.transport_kind == TerminalTransportKind::SshPty
            && record.integration_state != TerminalIntegrationState::Ready
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
        let receipt = validate_input(record, &request)?;
        let next_input_sequence = record
            .next_input_sequence
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if next_input_sequence > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        // Authorization, transport admission, and input-sequence commit share
        // the broker lock. A rejected transport enqueue therefore consumes no
        // sequence and writes no partial input.
        write()?;
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
            .map(SessionRecord::snapshot);
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

    #[cfg(test)]
    fn replay_output(
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

    #[cfg(test)]
    pub(crate) fn phase4_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
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
    fn enabled_with_closed_capacity_for_test(closed_session_capacity: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(Condvar::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
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
            },
        ) if operation_id == expected_operation
            && matches!(
                request.input_kind,
                TerminalInputKind::Interrupt | TerminalInputKind::SystemControl
            ) =>
        {
            SYSTEM_OWNER_ID.to_string()
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
    if data.state.is_terminal() {
        return Ok(false);
    }
    if !matches!(
        data.state,
        TerminalCommandState::Running | TerminalCommandState::CancelRequested
    ) {
        return Err("TERMINAL_COMMAND_END_OUT_OF_ORDER".into());
    }
    data.state = match data.requested_settlement {
        Some(TerminalCommandRequestedSettlement::Cancelled) => TerminalCommandState::Cancelled,
        Some(TerminalCommandRequestedSettlement::TimedOut) => TerminalCommandState::TimedOut,
        Some(TerminalCommandRequestedSettlement::TakenOver) => TerminalCommandState::TakenOver,
        None => TerminalCommandState::Completed,
    };
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
    let Ok(mut data) = command.data.lock() else {
        return false;
    };
    if data.state.is_terminal() {
        return false;
    }
    data.state = TerminalCommandState::Uncertain;
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

fn trusted_rollout_value_with_legacy_alias(
    environment_variable: &str,
    legacy_environment_variable: &str,
    default_enabled: bool,
) -> Result<(bool, TerminalBrokerRolloutSource), String> {
    trusted_rollout_value_with_legacy_alias_reader(
        environment_variable,
        legacy_environment_variable,
        default_enabled,
        |name| std::env::var(name),
    )
}

fn trusted_rollout_value_with_legacy_alias_reader<F>(
    environment_variable: &str,
    legacy_environment_variable: &str,
    default_enabled: bool,
    mut read: F,
) -> Result<(bool, TerminalBrokerRolloutSource), String>
where
    F: FnMut(&str) -> Result<String, std::env::VarError>,
{
    match read(environment_variable) {
        Err(std::env::VarError::NotPresent) => rollout_value_from_environment_result(
            legacy_environment_variable,
            read(legacy_environment_variable),
            default_enabled,
        ),
        result => {
            rollout_value_from_environment_result(environment_variable, result, default_enabled)
        }
    }
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
    if value.is_empty()
        || value.len() > 128
        || !value.chars().enumerate().all(|(index, character)| {
            (index == 0 && character.is_ascii_alphanumeric())
                || (index > 0
                    && (character.is_ascii_alphanumeric()
                        || matches!(character, '.' | '_' | ':' | '-')))
        })
    {
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
