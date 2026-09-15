use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;

use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};

pub(crate) const TERMINAL_BROKER_FLAG_NAME: &str = "terminal_broker_v1";
pub(crate) const TERMINAL_BROKER_ENVIRONMENT_VARIABLE: &str = "SHELLSPAN_TERMINAL_BROKER_V1";
pub(crate) const TERMINAL_BROKER_DEFAULT_ENABLED: bool = false;
pub(crate) const TERMINAL_SHELL_INTEGRATION_FLAG_NAME: &str = "terminal_shell_integration_v1";
pub(crate) const TERMINAL_SHELL_INTEGRATION_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_SHELL_INTEGRATION_V1";
pub(crate) const TERMINAL_EXECUTE_FLAG_NAME: &str = "terminal_execute_v1";
pub(crate) const TERMINAL_EXECUTE_ENVIRONMENT_VARIABLE: &str = "SHELLSPAN_TERMINAL_EXECUTE_V1";
pub(crate) const TERMINAL_REMOTE_AGENT_PTY_FLAG_NAME: &str = "terminal_remote_agent_pty_v1";
pub(crate) const TERMINAL_REMOTE_AGENT_PTY_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_REMOTE_AGENT_PTY_V1";
pub(crate) const TERMINAL_LEGACY_FALLBACK_FLAG_NAME: &str = "terminal_legacy_wrapper_fallback_v1";
pub(crate) const TERMINAL_LEGACY_FALLBACK_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_LEGACY_WRAPPER_FALLBACK_V1";

const DEFAULT_REPLAY_MAX_FRAMES: usize = 512;
const DEFAULT_REPLAY_MAX_BYTES: usize = 1_048_576;
const DEFAULT_CAPTURE_MAX_BYTES: usize = 262_144;
const DEFAULT_CLOSED_SESSION_CAPACITY: usize = 256;
const MAX_FRAME_BYTES: usize = 262_144;
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
    pub(crate) legacy_display_authoritative: bool,
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
            mode: "shadowCompatibility",
            legacy_display_authoritative: true,
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
            rows: rows.max(1),
            columns: columns.max(1),
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
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalAgentPtyOwner {
    pub(crate) agent_session_id: String,
    pub(crate) target_id: String,
    pub(crate) source_transport_session_id: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_pty_owner: Option<TerminalAgentPtyOwner>,
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
    pub(crate) remote_agent_pty_rollout: TerminalFeatureRolloutDecision,
    pub(crate) legacy_fallback_rollout: TerminalFeatureRolloutDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session: Option<TerminalBrokerSessionSnapshot>,
}

pub(crate) const TERMINAL_INTEGRATION_STATE_EVENT: &str = "terminal-integration-state";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalIntegrationStateEvent {
    pub(crate) session_id: String,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) state: TerminalIntegrationState,
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
    LegacyFallback,
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
}

impl TerminalCommandOperation {
    fn new(
        terminal_session_id: String,
        terminal_generation: u64,
        operation_id: String,
        command_line: String,
        capture_start_sequence: u64,
        capture_limit: usize,
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

#[derive(Debug, Clone)]
struct SessionRecord {
    terminal_session_id: String,
    terminal_generation: u64,
    transport_session_id: String,
    transport_kind: TerminalTransportKind,
    agent_pty_owner: Option<TerminalAgentPtyOwner>,
    geometry: TerminalGeometry,
    next_output_sequence: u64,
    next_byte_offset: u64,
    integration_state: TerminalIntegrationState,
    integration_id: Option<String>,
    integration_shell: Option<TerminalShellKind>,
    integration_reason: Option<String>,
    integration_event_sequence: u64,
    prompt_started: bool,
    prompt_ready: bool,
    current_directory: Option<String>,
    active_command: Option<Arc<TerminalCommandOperation>>,
    screen_version: u64,
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
        agent_pty_owner: Option<TerminalAgentPtyOwner>,
        geometry: TerminalGeometry,
    ) -> Self {
        Self {
            terminal_session_id,
            terminal_generation,
            transport_session_id,
            transport_kind,
            agent_pty_owner,
            geometry,
            next_output_sequence: 1,
            next_byte_offset: 0,
            integration_state: TerminalIntegrationState::Initializing,
            integration_id: None,
            integration_shell: None,
            integration_reason: None,
            integration_event_sequence: 0,
            prompt_started: false,
            prompt_ready: false,
            current_directory: None,
            active_command: None,
            screen_version: 0,
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

    fn close(&mut self, reason: TerminalGenerationCloseReason) {
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
    }

    fn snapshot(&self) -> TerminalBrokerSessionSnapshot {
        TerminalBrokerSessionSnapshot {
            terminal_session_id: self.terminal_session_id.clone(),
            terminal_generation: self.terminal_generation,
            transport_session_id: self.transport_session_id.clone(),
            transport_kind: self.transport_kind,
            agent_pty_owner: self.agent_pty_owner.clone(),
            geometry: self.geometry,
            next_output_sequence: self.next_output_sequence,
            next_byte_offset: self.next_byte_offset,
            integration_state: self.integration_state,
            integration_id: self.integration_id.clone(),
            integration_shell: self.integration_shell,
            integration_reason: self.integration_reason.clone(),
            integration_event_sequence: self.integration_event_sequence,
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
            screen_version: self.screen_version,
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
    remote_agent_pty_rollout: TerminalFeatureRolloutDecision,
    legacy_fallback_rollout: TerminalFeatureRolloutDecision,
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
                false,
                false,
                rollout.enabled,
                TerminalBrokerRolloutSource::Default,
                "invalidateIntegrationAndMarkIncompleteCommandsUncertain",
            ),
            terminal_execute_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_EXECUTE_FLAG_NAME,
                false,
                false,
                false,
                TerminalBrokerRolloutSource::Default,
                "stopNewRoutingNeverReplayInflightCommands",
            ),
            remote_agent_pty_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_REMOTE_AGENT_PTY_FLAG_NAME,
                false,
                false,
                false,
                TerminalBrokerRolloutSource::Default,
                "closeIdleAgentPtysAndMarkIncompleteCommandsUncertain",
            ),
            legacy_fallback_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_LEGACY_FALLBACK_FLAG_NAME,
                true,
                true,
                true,
                TerminalBrokerRolloutSource::Default,
                "newOperationsOnly",
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
    config: TerminalBrokerConfig,
}

impl Default for TerminalSessionBroker {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            config: TerminalBrokerConfig::default(),
        }
    }
}

impl TerminalSessionBroker {
    pub(crate) fn configure_from_trusted_environment(&self) -> Result<(), String> {
        let (broker, broker_source) = trusted_rollout_value(
            TERMINAL_BROKER_ENVIRONMENT_VARIABLE,
            TERMINAL_BROKER_DEFAULT_ENABLED,
        )?;
        let (integration, integration_source) =
            trusted_rollout_value(TERMINAL_SHELL_INTEGRATION_ENVIRONMENT_VARIABLE, false)?;
        let (execute, execute_source) =
            trusted_rollout_value(TERMINAL_EXECUTE_ENVIRONMENT_VARIABLE, false)?;
        let (remote_agent_pty, remote_agent_pty_source) =
            trusted_rollout_value(TERMINAL_REMOTE_AGENT_PTY_ENVIRONMENT_VARIABLE, false)?;
        let (legacy, legacy_source) =
            trusted_rollout_value(TERMINAL_LEGACY_FALLBACK_ENVIRONMENT_VARIABLE, true)?;
        self.apply_trusted_rollout(
            broker,
            broker_source,
            integration,
            integration_source,
            execute,
            execute_source,
            remote_agent_pty,
            remote_agent_pty_source,
            legacy,
            legacy_source,
        )
    }

    fn apply_trusted_rollout_decision(
        &self,
        enabled: bool,
        source: TerminalBrokerRolloutSource,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.rollout.enabled && !enabled {
            close_all_open_generations(
                &mut state,
                TerminalGenerationCloseReason::BrokerShutdown,
                self.config.closed_session_capacity,
            );
        }
        state.rollout = TerminalBrokerRolloutDecision {
            enabled,
            source,
            ..TerminalBrokerRolloutDecision::default()
        };
        let integration_requested = state.shell_integration_rollout.requested;
        let execute_requested = state.terminal_execute_rollout.requested;
        state.shell_integration_rollout.prerequisite_satisfied = enabled;
        state.shell_integration_rollout.enabled = enabled && integration_requested;
        state.terminal_execute_rollout.prerequisite_satisfied =
            enabled && state.shell_integration_rollout.enabled;
        state.terminal_execute_rollout.enabled =
            state.terminal_execute_rollout.prerequisite_satisfied && execute_requested;
        let remote_requested = state.remote_agent_pty_rollout.requested;
        state.remote_agent_pty_rollout.prerequisite_satisfied =
            state.terminal_execute_rollout.enabled;
        state.remote_agent_pty_rollout.enabled =
            state.remote_agent_pty_rollout.prerequisite_satisfied && remote_requested;
        Ok(())
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
        remote_agent_pty: bool,
        remote_agent_pty_source: TerminalBrokerRolloutSource,
        legacy: bool,
        legacy_source: TerminalBrokerRolloutSource,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.rollout.enabled && !broker {
            close_all_open_generations(
                &mut state,
                TerminalGenerationCloseReason::BrokerShutdown,
                self.config.closed_session_capacity,
            );
        } else if state.shell_integration_rollout.enabled && !(broker && integration) {
            for record in state.sessions.values_mut().filter(|record| record.open) {
                degrade_record(record, "shellIntegrationRollback");
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
        } else if state.remote_agent_pty_rollout.enabled
            && !(broker && integration && execute && remote_agent_pty)
        {
            for record in state
                .sessions
                .values_mut()
                .filter(|record| record.open && record.agent_pty_owner.is_some())
            {
                if let Some(command) = &record.active_command {
                    settle_command_uncertain(
                        command,
                        record.next_output_sequence.saturating_sub(1),
                    );
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
            false,
            broker,
            integration_source,
            "invalidateIntegrationAndMarkIncompleteCommandsUncertain",
        );
        state.terminal_execute_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_EXECUTE_FLAG_NAME,
            execute,
            false,
            broker && integration,
            execute_source,
            "stopNewRoutingNeverReplayInflightCommands",
        );
        state.remote_agent_pty_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_REMOTE_AGENT_PTY_FLAG_NAME,
            remote_agent_pty,
            false,
            broker && integration && execute,
            remote_agent_pty_source,
            "closeIdleAgentPtysAndMarkIncompleteCommandsUncertain",
        );
        state.legacy_fallback_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_LEGACY_FALLBACK_FLAG_NAME,
            legacy,
            true,
            true,
            legacy_source,
            "newOperationsOnly",
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
        legacy: bool,
        legacy_source: TerminalBrokerRolloutSource,
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
            legacy,
            legacy_source,
        )
    }

    pub(crate) fn attach_transport(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        self.attach_transport_with_owner(
            transport_session_id,
            predecessor_transport_session_id,
            transport_kind,
            geometry,
            None,
        )
    }

    pub(crate) fn attach_agent_ssh_transport(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        geometry: TerminalGeometry,
        owner: TerminalAgentPtyOwner,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        validate_identifier(&owner.agent_session_id, "Agent Session id")?;
        validate_identifier(&owner.target_id, "target id")?;
        validate_identifier(
            &owner.source_transport_session_id,
            "source transport session id",
        )?;
        let enabled = self.lock()?.remote_agent_pty_rollout.enabled;
        if !enabled {
            return Err("TERMINAL_REMOTE_AGENT_PTY_DISABLED".into());
        }
        self.attach_transport_with_owner(
            transport_session_id,
            predecessor_transport_session_id,
            TerminalTransportKind::SshPty,
            geometry,
            Some(owner),
        )
    }

    fn attach_transport_with_owner(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
        agent_pty_owner: Option<TerminalAgentPtyOwner>,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        validate_identifier(transport_session_id, "transport session id")?;
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        if agent_pty_owner.is_some() && !state.remote_agent_pty_rollout.enabled {
            return Err("TERMINAL_REMOTE_AGENT_PTY_DISABLED".into());
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
                if record.agent_pty_owner != agent_pty_owner {
                    return Err("TERMINAL_BROKER_PREDECESSOR_OWNERSHIP_MISMATCH".into());
                }
                if record.terminal_generation != predecessor.terminal_generation {
                    return Err("TERMINAL_BROKER_STALE_PREDECESSOR".into());
                }
                if record.open {
                    if record.transport_session_id != predecessor_transport_session_id {
                        return Err("TERMINAL_BROKER_STALE_PREDECESSOR".into());
                    }
                    record.close(TerminalGenerationCloseReason::Replaced);
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
        let record = SessionRecord::open(
            terminal_session_id.clone(),
            terminal_generation,
            transport_session_id.to_string(),
            transport_kind,
            agent_pty_owner,
            geometry,
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
            record.close(reason);
        }
        if let Some(attachment) = state.transports.get_mut(transport_session_id) {
            attachment.active = false;
        }
        remember_closed_session(
            &mut state,
            &attachment.terminal_session_id,
            self.config.closed_session_capacity,
        );
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
        let frame = TerminalRawOutputFrame {
            protocol_version: 1,
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            frame_type: "rawOutput",
            sequence: record.next_output_sequence,
            byte_offset: record.next_byte_offset,
            bytes: bytes.to_vec(),
        };
        match accept_raw_frame(record, frame.clone(), self.config)? {
            RawFrameAcceptance::Accepted => Ok(Some(frame)),
            RawFrameAcceptance::Duplicate => Ok(None),
        }
    }

    pub(crate) fn resize(
        &self,
        transport_session_id: &str,
        geometry: TerminalGeometry,
    ) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.geometry = geometry;
        })
    }

    pub(crate) fn mark_output_ready(&self, transport_session_id: &str) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.output_listener_ready = true;
        })
    }

    pub(crate) fn set_output_paused(
        &self,
        transport_session_id: &str,
        paused: bool,
    ) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.output_paused = paused;
        })
    }

    pub(crate) fn shell_integration_enabled(&self) -> Result<bool, String> {
        Ok(self.lock()?.shell_integration_rollout.enabled)
    }

    pub(crate) fn visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        let state = self.lock()?;
        if state.terminal_execute_rollout.enabled {
            if let Ok(attachment) = current_attachment(&state, transport_session_id) {
                if let Some(record) = state.sessions.get(&attachment.terminal_session_id) {
                    let transport_eligible = record.transport_kind != TerminalTransportKind::SshPty
                        || (state.remote_agent_pty_rollout.enabled
                            && record.agent_pty_owner.is_some());
                    if transport_eligible
                        && record.integration_state == TerminalIntegrationState::Ready
                        && record.prompt_ready
                    {
                        return Ok(TerminalVisibleCommandRoute::TerminalExecute);
                    }
                }
            }
        }
        if state.legacy_fallback_rollout.enabled {
            Ok(TerminalVisibleCommandRoute::LegacyFallback)
        } else {
            Ok(TerminalVisibleCommandRoute::Unavailable)
        }
    }

    pub(crate) fn remote_agent_pty_new_operation_route(
        &self,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        let state = self.lock()?;
        if state.remote_agent_pty_rollout.enabled {
            Ok(TerminalVisibleCommandRoute::TerminalExecute)
        } else if state.legacy_fallback_rollout.enabled {
            Ok(TerminalVisibleCommandRoute::LegacyFallback)
        } else {
            Ok(TerminalVisibleCommandRoute::Unavailable)
        }
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
            degrade_record(record, "unsupportedShell");
            record.integration_shell = Some(shell);
            return Ok(());
        }
        record.integration_state = TerminalIntegrationState::Initializing;
        record.integration_id = Some(integration_id.to_string());
        record.integration_shell = Some(shell);
        record.integration_reason = None;
        record.integration_event_sequence = 0;
        record.prompt_started = false;
        record.prompt_ready = false;
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
            degrade_record(record, reason);
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
        })
    }

    pub(crate) fn accept_integration_event(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        event: TerminalIntegrationControlEvent,
    ) -> Result<(), String> {
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
                    degrade_record(record, "shellIdentityMismatch");
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
                        degrade_record(record, "unexpectedCommandStart");
                        return Err("TERMINAL_COMMAND_START_OUT_OF_ORDER".into());
                    }
                    if command_line != data.command_line {
                        data.state = TerminalCommandState::Uncertain;
                        data.revision = next_command_revision(data.revision)?;
                        data.capture_end_sequence = Some(through_output_sequence);
                        drop(data);
                        command.notify();
                        degrade_record(record, "exactCommandLineMismatch");
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
        degrade_record(record, reason);
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
        let remote_agent_pty_enabled = state.remote_agent_pty_rollout.enabled;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        if record.transport_kind == TerminalTransportKind::SshPty {
            if !remote_agent_pty_enabled || record.agent_pty_owner.is_none() {
                return Err("TERMINAL_EXECUTE_REQUIRES_DEDICATED_AGENT_SSH_PTY".into());
            }
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
        if let Some(owner) = &record.agent_pty_owner {
            if !matches!(
                &lease.owner,
                TerminalLeaseOwner::Agent {
                    agent_session_id,
                    ..
                } if agent_session_id == &owner.agent_session_id
            ) {
                return Err("TERMINAL_AGENT_PTY_OWNER_MISMATCH".into());
            }
        }
        let operation = Arc::new(TerminalCommandOperation::new(
            record.terminal_session_id.clone(),
            record.terminal_generation,
            operation_id.to_string(),
            command_line.to_string(),
            record.next_output_sequence,
            self.config.capture_max_bytes,
        ));
        record.active_command = Some(Arc::clone(&operation));
        record.prompt_ready = false;
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
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
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

    pub(crate) fn admit_compatibility_input<F>(
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
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
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
            remote_agent_pty_rollout: state.remote_agent_pty_rollout.clone(),
            legacy_fallback_rollout: state.legacy_fallback_rollout.clone(),
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
        );
        Ok(())
    }

    fn with_current_record_mut(
        &self,
        transport_session_id: &str,
        update: impl FnOnce(&mut SessionRecord),
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = current_record_mut(&mut state, transport_session_id, &attachment)?;
        update(record);
        Ok(())
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
            config: TerminalBrokerConfig {
                replay_max_frames,
                replay_max_bytes,
                capture_max_bytes: capture,
                closed_session_capacity: DEFAULT_CLOSED_SESSION_CAPACITY,
            },
        };
        broker
            .apply_trusted_rollout_decision(true, TerminalBrokerRolloutSource::Test)
            .unwrap();
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase3_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
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
                true,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase4_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
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
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    fn enabled_with_closed_capacity_for_test(closed_session_capacity: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            config: TerminalBrokerConfig {
                closed_session_capacity,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout_decision(true, TerminalBrokerRolloutSource::Test)
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
        accept_raw_frame(record, frame, self.config)
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
        broker.apply_trusted_rollout_decision(true, TerminalBrokerRolloutSource::Environment)?;
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
) {
    let closing = state
        .sessions
        .iter()
        .filter(|(_, record)| record.open)
        .map(|(terminal_session_id, _)| terminal_session_id.clone())
        .collect::<Vec<_>>();
    for terminal_session_id in &closing {
        if let Some(record) = state.sessions.get_mut(terminal_session_id) {
            record.close(reason);
        }
    }
    for attachment in state.transports.values_mut() {
        attachment.active = false;
    }
    for terminal_session_id in closing {
        remember_closed_session(state, &terminal_session_id, closed_session_capacity);
    }
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
        }
    }
    record.subscribers.integration.observe(&frame)?;
    record.subscribers.screen.observe(&frame)?;
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

fn degrade_record(record: &mut SessionRecord, reason: &str) {
    record.integration_state = TerminalIntegrationState::Degraded;
    record.integration_reason = Some(reason.to_string());
    record.integration_id = None;
    record.prompt_ready = false;
    record.prompt_started = false;
    if let Some(command) = &record.active_command {
        settle_command_uncertain(command, record.next_output_sequence.saturating_sub(1));
    }
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
    match std::env::var(environment_variable) {
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
    use super::*;

    #[cfg(unix)]
    fn run_native_shell_broker_acceptance(shell: &str, args: &[&str], label: &str) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::thread;
        use std::time::{Duration, Instant};

        let broker = TerminalSessionBroker::enabled_for_test(512, 1_048_576, 1_048_576);
        let attachment = broker
            .attach_transport(
                "shell-transport",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        pair.master
            .resize(PtySize {
                rows: 33,
                cols: 111,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        broker
            .resize("shell-transport", TerminalGeometry::new(111, 33))
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new(shell);
        command.args(args);
        command.env("TERM", "xterm-256color");
        command.env("LC_ALL", "C");
        command.env("PS1", "");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let reader_broker = broker.clone();
        let reader_shell = shell.to_string();
        let reader_thread = thread::spawn(move || -> Result<_, String> {
            let mut raw = Vec::new();
            let mut frames = Vec::new();
            let mut buffer = [0_u8; 257];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let bytes = &buffer[..count];
                        let frame = reader_broker
                            .observe_raw_output("shell-transport", bytes)?
                            .ok_or_else(|| "enabled broker omitted a raw frame".to_string())?;
                        if frame.bytes != bytes {
                            return Err("broker display frame changed PTY bytes".into());
                        }
                        raw.extend_from_slice(bytes);
                        frames.push(frame);
                    }
                    // Unix PTY masters commonly report EIO after the slave
                    // closes. It is EOF only after some output was observed.
                    Err(error) if error.raw_os_error() == Some(libc::EIO) && !raw.is_empty() => {
                        break;
                    }
                    Err(error) => return Err(format!("read {reader_shell} PTY: {error}")),
                }
            }
            Ok((raw, frames))
        });

        let input = format!(
            "printf 'SHELLSPAN_{label}_RAW_BEGIN:'; printf '\\377'; printf ':\\033[31mred\\033[0m:'; printf '\\346\\261\\211'; printf ':END'; exit\n"
        );
        broker
            .admit_compatibility_input(
                "shell-transport",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                input.as_bytes(),
                || {
                    writer
                        .write_all(input.as_bytes())
                        .map_err(|error| format!("write {shell} PTY: {error}"))?;
                    writer
                        .flush()
                        .map_err(|error| format!("flush {shell} PTY: {error}"))
                },
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            match child.try_wait().unwrap() {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    child.kill().unwrap();
                    panic!("{shell} PTY did not exit before acceptance deadline");
                }
            }
        };
        drop(writer);
        drop(pair.master);
        let (raw, frames) = reader_thread.join().unwrap().unwrap();

        assert!(status.success(), "{shell} exited unsuccessfully");
        assert!(raw.windows(2).any(|window| window == [0x1b, b'[']));
        assert!(
            raw.contains(&0xff),
            "{shell} did not emit the non-UTF-8 byte"
        );
        assert!(raw
            .windows(format!("SHELLSPAN_{label}_RAW_BEGIN:").len())
            .any(|window| window == format!("SHELLSPAN_{label}_RAW_BEGIN:").as_bytes()));
        assert_eq!(
            frames
                .iter()
                .flat_map(|frame| frame.bytes.iter().copied())
                .collect::<Vec<_>>(),
            raw
        );
        let mut next_offset = 0_u64;
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.sequence, index as u64 + 1);
            assert_eq!(frame.byte_offset, next_offset);
            next_offset += frame.bytes.len() as u64;
        }
        let replay = broker
            .replay_output(
                &attachment.terminal_session_id,
                attachment.terminal_generation,
                1,
                512,
                1_048_576,
            )
            .unwrap();
        assert_eq!(
            replay
                .frames
                .iter()
                .flat_map(|frame| frame.bytes.iter().copied())
                .collect::<Vec<_>>(),
            raw
        );
        let snapshot = broker
            .snapshot(Some("shell-transport"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(snapshot.geometry, TerminalGeometry::new(111, 33));
        assert_eq!(snapshot.next_byte_offset, raw.len() as u64);
        assert_eq!(snapshot.next_input_sequence, 2);
        assert_eq!(
            snapshot.subscribers.display.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(
            snapshot.subscribers.capture.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(
            snapshot.subscribers.integration.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(snapshot.subscribers.screen.observed_bytes, raw.len() as u64);
    }

    #[cfg(target_os = "windows")]
    fn run_windows_powershell_broker_acceptance(shell: &str, label: &str) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{ErrorKind, Read, Write};
        use std::thread;
        use std::time::{Duration, Instant};

        let broker = TerminalSessionBroker::enabled_for_test(512, 1_048_576, 1_048_576);
        let attachment = broker
            .attach_transport(
                "windows-shell-transport",
                None,
                TerminalTransportKind::WindowsConPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        pair.master
            .resize(PtySize {
                rows: 33,
                cols: 111,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        broker
            .resize("windows-shell-transport", TerminalGeometry::new(111, 33))
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new(shell);
        command.args(["-NoLogo", "-NoProfile"]);
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let reader_broker = broker.clone();
        let reader_shell = shell.to_string();
        let reader_thread = thread::spawn(move || -> Result<_, String> {
            let mut raw = Vec::new();
            let mut frames = Vec::new();
            let mut buffer = [0_u8; 31];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let bytes = &buffer[..count];
                        let frame = reader_broker
                            .observe_raw_output("windows-shell-transport", bytes)?
                            .ok_or_else(|| "enabled broker omitted a ConPTY frame".to_string())?;
                        if frame.bytes != bytes {
                            return Err("broker display frame changed ConPTY bytes".into());
                        }
                        raw.extend_from_slice(bytes);
                        frames.push(frame);
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            ErrorKind::BrokenPipe | ErrorKind::UnexpectedEof
                        ) && !raw.is_empty() =>
                    {
                        break;
                    }
                    Err(error) => return Err(format!("read {reader_shell} ConPTY: {error}")),
                }
            }
            Ok((raw, frames))
        });

        // Keep the actual output marker, ESC byte, Unicode scalar, geometry,
        // and long payload out of the echoed input. The second admission also
        // depends on variables created by the first, so reversing or dropping
        // either independently admitted write cannot satisfy the assertion.
        let output_marker = format!("SHELLSPAN_{label}_OUTPUT_BEGIN:");
        let first_input = format!("$m=('SHELL'+'SPAN_{label}_OUTPUT_BEGIN:'); $e=[char]27\r");
        assert!(!first_input
            .as_bytes()
            .windows(output_marker.len())
            .any(|window| window == output_marker.as_bytes()));
        let first_receipt = broker
            .admit_compatibility_input(
                "windows-shell-transport",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                first_input.as_bytes(),
                || {
                    writer
                        .write_all(first_input.as_bytes())
                        .map_err(|error| format!("write {shell} ConPTY: {error}"))?;
                    writer
                        .flush()
                        .map_err(|error| format!("flush {shell} ConPTY: {error}"))
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(first_receipt.input_sequence, 1);
        assert_eq!(first_receipt.accepted_bytes, first_input.len());
        assert_eq!(first_receipt.source_owner_id, USER_OWNER_ID);

        let second_input = "if (($Host.UI.RawUI.WindowSize.Width -ne 111) -or ($Host.UI.RawUI.WindowSize.Height -ne 33)) { exit 91 }; [Console]::Write(($m+$e+'[31mred'+$e+'[0m:'+([char]0x6c49)+':111x33:'+('Q'*8)+':OUTPUT_END')); exit 0\r";
        assert!(!second_input
            .as_bytes()
            .windows(output_marker.len())
            .any(|window| window == output_marker.as_bytes()));
        assert!(!second_input.as_bytes().contains(&0x1b));
        assert!(!second_input
            .as_bytes()
            .windows("汉".len())
            .any(|window| window == "汉".as_bytes()));
        let second_receipt = broker
            .admit_compatibility_input(
                "windows-shell-transport",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                second_input.as_bytes(),
                || {
                    writer
                        .write_all(second_input.as_bytes())
                        .map_err(|error| format!("write {shell} ConPTY: {error}"))?;
                    writer
                        .flush()
                        .map_err(|error| format!("flush {shell} ConPTY: {error}"))
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(second_receipt.input_sequence, 2);
        assert_eq!(second_receipt.accepted_bytes, second_input.len());
        assert_eq!(second_receipt.source_owner_id, USER_OWNER_ID);

        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            match child.try_wait().unwrap() {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    child.kill().unwrap();
                    panic!("{shell} ConPTY did not exit before acceptance deadline");
                }
            }
        };
        drop(writer);
        drop(pair.master);
        let (raw, frames) = reader_thread.join().unwrap().unwrap();

        assert!(status.success(), "{shell} exited unsuccessfully");
        let mut expected_shell_output = output_marker.into_bytes();
        expected_shell_output.extend_from_slice(b"\x1b[31mred\x1b[0m:");
        expected_shell_output.extend_from_slice("汉".as_bytes());
        expected_shell_output.extend_from_slice(b":111x33:");
        expected_shell_output.extend(std::iter::repeat_n(b'Q', 8));
        expected_shell_output.extend_from_slice(b":OUTPUT_END");
        assert!(
            raw.windows(expected_shell_output.len())
                .any(|window| window == expected_shell_output.as_slice()),
            "{shell} output did not contain the echo-independent payload"
        );
        assert!(
            frames.len() > 1,
            "ConPTY output must span multiple raw frames"
        );
        assert_eq!(
            frames
                .iter()
                .flat_map(|frame| frame.bytes.iter().copied())
                .collect::<Vec<_>>(),
            raw
        );
        let mut next_offset = 0_u64;
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.sequence, index as u64 + 1);
            assert_eq!(frame.byte_offset, next_offset);
            next_offset += frame.bytes.len() as u64;
        }
        let bounded_replay = broker
            .replay_output(
                &attachment.terminal_session_id,
                attachment.terminal_generation,
                1,
                1,
                1_048_576,
            )
            .unwrap();
        assert_eq!(bounded_replay.frames, vec![frames[0].clone()]);
        assert_eq!(bounded_replay.through_sequence, 1);
        assert!(bounded_replay.has_more);
        let replay = broker
            .replay_output(
                &attachment.terminal_session_id,
                attachment.terminal_generation,
                1,
                512,
                1_048_576,
            )
            .unwrap();
        assert_eq!(
            replay
                .frames
                .iter()
                .flat_map(|frame| frame.bytes.iter().copied())
                .collect::<Vec<_>>(),
            raw
        );
        let snapshot = broker
            .snapshot(Some("windows-shell-transport"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(snapshot.geometry, TerminalGeometry::new(111, 33));
        assert_eq!(snapshot.next_byte_offset, raw.len() as u64);
        assert_eq!(snapshot.next_input_sequence, 3);
        assert_eq!(
            snapshot.subscribers.display.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(
            snapshot.subscribers.capture.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(
            snapshot.subscribers.integration.observed_bytes,
            raw.len() as u64
        );
        assert_eq!(snapshot.subscribers.screen.observed_bytes, raw.len() as u64);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bash_pty_broker_preserves_raw_bytes_input_order_and_resize() {
        run_native_shell_broker_acceptance("/bin/bash", &["--noprofile", "--norc"], "MACOS_BASH");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_bash_pty_broker_preserves_raw_bytes_input_order_and_resize() {
        run_native_shell_broker_acceptance("/bin/bash", &["--noprofile", "--norc"], "LINUX_BASH");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_zsh_pty_broker_preserves_raw_bytes_input_order_and_resize() {
        run_native_shell_broker_acceptance("/bin/zsh", &["-f"], "LINUX_ZSH");
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "run explicitly in the native Windows PowerShell 5.1 acceptance lane"]
    fn windows_powershell_5_1_conpty_broker_preserves_raw_bytes_order_and_resize() {
        run_windows_powershell_broker_acceptance("powershell.exe", "WINDOWS_POWERSHELL_5_1");
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "run explicitly in the native PowerShell 7 acceptance lane"]
    fn windows_powershell_7_conpty_broker_preserves_raw_bytes_order_and_resize() {
        run_windows_powershell_broker_acceptance("pwsh.exe", "POWERSHELL_7");
    }

    fn attached(broker: &TerminalSessionBroker, transport: &str) -> TerminalBrokerAttachment {
        broker
            .attach_transport(
                transport,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap()
    }

    fn frame(
        attachment: &TerminalBrokerAttachment,
        sequence: u64,
        byte_offset: u64,
        bytes: &[u8],
    ) -> TerminalRawOutputFrame {
        TerminalRawOutputFrame {
            protocol_version: 1,
            terminal_session_id: attachment.terminal_session_id.clone(),
            terminal_generation: attachment.terminal_generation,
            frame_type: "rawOutput",
            sequence,
            byte_offset,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn rollout_default_is_off_non_persisted_and_rollback_closes_generations() {
        let broker = TerminalSessionBroker::default();
        let snapshot = broker.snapshot(None).unwrap();
        assert_eq!(snapshot.rollout.name, TERMINAL_BROKER_FLAG_NAME);
        assert!(!snapshot.rollout.enabled);
        assert!(!snapshot.rollout.default_enabled);
        assert!(!snapshot.rollout.persisted);
        assert_eq!(snapshot.rollout.mode, "shadowCompatibility");
        assert!(snapshot.rollout.legacy_display_authoritative);
        assert!(!snapshot.shell_integration_rollout.enabled);
        assert!(!snapshot.terminal_execute_rollout.enabled);
        assert_eq!(
            snapshot.remote_agent_pty_rollout.name,
            TERMINAL_REMOTE_AGENT_PTY_FLAG_NAME
        );
        assert!(!snapshot.remote_agent_pty_rollout.enabled);
        assert!(!snapshot.remote_agent_pty_rollout.default_enabled);
        assert!(snapshot.legacy_fallback_rollout.enabled);
        assert!(!snapshot.shell_integration_rollout.persisted);
        assert!(!snapshot.terminal_execute_rollout.persisted);
        assert!(!snapshot.remote_agent_pty_rollout.persisted);
        assert!(!snapshot.legacy_fallback_rollout.persisted);
        assert!(broker
            .attach_transport(
                "transport-1",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .is_none());

        broker
            .apply_trusted_rollout_decision(true, TerminalBrokerRolloutSource::Test)
            .unwrap();
        attached(&broker, "transport-1");
        broker
            .apply_trusted_rollout_decision(false, TerminalBrokerRolloutSource::Test)
            .unwrap();
        let snapshot = broker.snapshot(Some("transport-1")).unwrap();
        assert!(!snapshot.rollout.enabled);
        assert_eq!(
            snapshot.session.unwrap().close_reason,
            Some(TerminalGenerationCloseReason::BrokerShutdown)
        );
        assert!(broker
            .observe_raw_output("transport-1", b"legacy remains authoritative")
            .unwrap()
            .is_none());
    }

    #[test]
    fn failed_attachment_is_atomic_and_leaves_the_existing_generation_usable() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        let original = attached(&broker, "transport-1");
        let before = broker.snapshot(Some("transport-1")).unwrap().session;

        assert_eq!(
            broker
                .attach_transport(
                    "transport-candidate",
                    Some("unknown-predecessor"),
                    TerminalTransportKind::LocalPty,
                    TerminalGeometry::new(100, 30),
                )
                .unwrap_err(),
            "TERMINAL_BROKER_PREDECESSOR_NOT_FOUND"
        );

        assert_eq!(
            broker.snapshot(Some("transport-1")).unwrap().session,
            before
        );
        assert!(broker
            .snapshot(Some("transport-candidate"))
            .unwrap()
            .session
            .is_none());
        let output = broker
            .observe_raw_output("transport-1", b"still-usable")
            .unwrap()
            .unwrap();
        assert_eq!(output.terminal_session_id, original.terminal_session_id);
        assert_eq!(output.terminal_generation, 1);
    }

    #[test]
    fn closed_metadata_and_reconnect_transport_history_are_bounded() {
        let broker = TerminalSessionBroker::enabled_with_closed_capacity_for_test(2);
        for index in 1..=3 {
            let transport = format!("transport-{index}");
            attached(&broker, &transport);
            broker
                .close_transport(&transport, TerminalGenerationCloseReason::UserClosed)
                .unwrap();
        }

        assert_eq!(broker.metadata_counts(), (2, 2, 2));
        assert!(broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .is_none());
        let predecessor = broker
            .snapshot(Some("transport-2"))
            .unwrap()
            .session
            .unwrap();
        let replacement = broker
            .attach_transport(
                "transport-4",
                Some("transport-2"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            replacement.terminal_session_id,
            predecessor.terminal_session_id
        );
        assert_eq!(replacement.terminal_generation, 2);
        assert!(broker
            .snapshot(Some("transport-2"))
            .unwrap()
            .session
            .is_none());
        assert_eq!(broker.metadata_counts(), (2, 2, 1));

        // Repeated rollover for one logical session keeps only its current
        // transport mapping rather than one tombstone per generation.
        broker
            .attach_transport(
                "transport-5",
                Some("transport-4"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        assert_eq!(broker.metadata_counts(), (2, 2, 1));
    }

    #[test]
    fn raw_bytes_have_exact_sequence_offsets_and_independent_subscribers() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 3);
        let attachment = attached(&broker, "transport-1");
        let first = broker
            .observe_raw_output("transport-1", &[0xff, 0x00])
            .unwrap()
            .unwrap();
        let second = broker
            .observe_raw_output("transport-1", &[b'a', b'\r', b'\n'])
            .unwrap()
            .unwrap();
        assert_eq!((first.sequence, first.byte_offset), (1, 0));
        assert_eq!((second.sequence, second.byte_offset), (2, 2));
        assert_eq!(
            [first.bytes, second.bytes].concat(),
            [0xff, 0x00, b'a', b'\r', b'\n']
        );
        assert_eq!(
            broker.captured_bytes(&attachment.terminal_session_id),
            [0xff, 0x00, b'a']
        );

        let snapshot = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap();
        assert!(snapshot.capture_truncated);
        assert_eq!(
            snapshot.subscribers.capture.status,
            TerminalSubscriberStatus::Truncated
        );
        assert_eq!(snapshot.subscribers.display.through_output_sequence, 2);
        assert_eq!(snapshot.subscribers.integration.through_output_sequence, 2);
        assert_eq!(snapshot.subscribers.screen.through_output_sequence, 2);
        assert_eq!(snapshot.subscribers.display.observed_bytes, 5);
        assert_eq!(snapshot.next_byte_offset, 5);
    }

    #[test]
    fn replay_is_bounded_and_duplicate_and_gap_rules_are_exact() {
        let broker = TerminalSessionBroker::enabled_for_test(2, 4, 32);
        let attachment = attached(&broker, "transport-1");
        broker.observe_raw_output("transport-1", b"aa").unwrap();
        broker.observe_raw_output("transport-1", b"bb").unwrap();
        broker.observe_raw_output("transport-1", b"cc").unwrap();

        assert!(broker
            .replay_output(&attachment.terminal_session_id, 1, 1, 8, 64)
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_REPLAY_UNAVAILABLE:"));
        let replay = broker
            .replay_output(&attachment.terminal_session_id, 1, 2, 8, 64)
            .unwrap();
        assert_eq!(
            replay
                .frames
                .iter()
                .map(|frame| frame.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(!replay.has_more);

        assert_eq!(
            broker
                .ingest_test_frame(frame(&attachment, 3, 4, b"cc"))
                .unwrap(),
            RawFrameAcceptance::Duplicate
        );
        assert!(broker
            .ingest_test_frame(frame(&attachment, 3, 4, b"XX"))
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_CONFLICTING_DUPLICATE"));
        assert!(broker
            .ingest_test_frame(frame(&attachment, 5, 6, b"gap"))
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_OUTPUT_GAP:"));
        let gap_snapshot = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            gap_snapshot.subscribers.display.status,
            TerminalSubscriberStatus::Gap
        );
        assert_eq!(gap_snapshot.subscribers.display.through_output_sequence, 3);
        assert_eq!(
            broker
                .ingest_test_frame(frame(&attachment, 4, 6, b"ok"))
                .unwrap(),
            RawFrameAcceptance::Accepted
        );
        let repaired = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            repaired.subscribers.display.status,
            TerminalSubscriberStatus::Active
        );
    }

    #[test]
    fn reconnect_preserves_session_identity_resets_counters_and_rejects_stale_data() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        let first = attached(&broker, "transport-1");
        broker.observe_raw_output("transport-1", b"old").unwrap();
        let old_lease = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .lease
            .unwrap();

        let second = broker
            .attach_transport(
                "transport-2",
                Some("transport-1"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(100, 30),
            )
            .unwrap()
            .unwrap();
        assert_eq!(second.terminal_session_id, first.terminal_session_id);
        assert_eq!(second.terminal_generation, first.terminal_generation + 1);
        assert!(broker.observe_raw_output("transport-1", b"stale").is_err());
        let new_frame = broker
            .observe_raw_output("transport-2", b"new")
            .unwrap()
            .unwrap();
        assert_eq!((new_frame.sequence, new_frame.byte_offset), (1, 0));
        broker.mark_output_ready("transport-2").unwrap();
        broker.set_output_paused("transport-2", true).unwrap();
        broker
            .resize("transport-2", TerminalGeometry::new(132, 43))
            .unwrap();
        let current = broker
            .snapshot(Some("transport-2"))
            .unwrap()
            .session
            .unwrap();
        assert!(current.output_listener_ready);
        assert!(current.output_paused);
        assert_eq!(current.geometry, TerminalGeometry::new(132, 43));

        let stale_input = TerminalInputRequest {
            terminal_session_id: first.terminal_session_id,
            terminal_generation: first.terminal_generation,
            lease_id: old_lease.lease_id,
            input_sequence: 1,
            source: TerminalBrokerInputSource::User,
            input_kind: TerminalInputKind::Text,
            bytes: b"stale".to_vec(),
        };
        assert!(broker
            .validate_test_input(&stale_input)
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_STALE_GENERATION"));
    }

    #[test]
    fn lease_identity_and_one_input_path_cover_user_agent_and_scoped_system_control() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        let attachment = attached(&broker, "transport-1");
        let written = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink = Arc::clone(&written);
        broker
            .admit_compatibility_input(
                "transport-1",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                b"user",
                move || {
                    sink.lock().unwrap().push(b"user".to_vec());
                    Ok(())
                },
            )
            .unwrap();
        let user_lease = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .lease
            .unwrap();
        let stale_sequence = TerminalInputRequest {
            terminal_session_id: attachment.terminal_session_id.clone(),
            terminal_generation: attachment.terminal_generation,
            lease_id: user_lease.lease_id.clone(),
            input_sequence: 1,
            source: TerminalBrokerInputSource::User,
            input_kind: TerminalInputKind::Text,
            bytes: b"duplicate".to_vec(),
        };
        assert!(broker
            .validate_test_input(&stale_sequence)
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_STALE_INPUT:"));
        let agent_lease = broker
            .acquire_agent_lease("transport-1", "agent-1", "task-1", "operation-1")
            .unwrap()
            .unwrap();
        assert!(broker
            .admit_compatibility_input(
                "transport-1",
                TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                b"blocked",
                || panic!("rejected input must not reach the transport"),
            )
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH"));
        broker
            .admit_compatibility_input(
                "transport-1",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-1".into(),
                    task_id: "task-1".into(),
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Text,
                b"agent",
                || Ok(()),
            )
            .unwrap();
        broker
            .admit_compatibility_input(
                "transport-1",
                TerminalBrokerInputSource::System {
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Interrupt,
                &[3],
                || Ok(()),
            )
            .unwrap();
        assert!(broker
            .admit_compatibility_input(
                "transport-1",
                TerminalBrokerInputSource::System {
                    operation_id: "operation-wrong".into(),
                },
                TerminalInputKind::Interrupt,
                &[3],
                || panic!("unscoped control must not reach the transport"),
            )
            .unwrap_err()
            .starts_with("TERMINAL_BROKER_SYSTEM_CONTROL_NOT_SCOPED"));
        assert_eq!(written.lock().unwrap().as_slice(), [b"user"]);
        assert_eq!(
            broker
                .snapshot(Some("transport-1"))
                .unwrap()
                .session
                .unwrap()
                .lease
                .unwrap()
                .lease_id,
            agent_lease.lease_id
        );
        assert!(broker
            .release_agent_lease("transport-1", "agent-1", "task-1", "operation-1")
            .unwrap());
        let user_lease = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .lease
            .unwrap();
        assert_ne!(user_lease.lease_id, agent_lease.lease_id);
        assert!(matches!(user_lease.owner, TerminalLeaseOwner::User { .. }));
        assert_eq!(attachment.terminal_generation, 1);
    }

    #[test]
    fn diagnostic_snapshot_contains_counts_but_not_raw_or_captured_content() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        attached(&broker, "transport-1");
        broker
            .observe_raw_output("transport-1", b"credential-like-secret")
            .unwrap();

        let json = serde_json::to_string(&broker.snapshot(Some("transport-1")).unwrap()).unwrap();
        assert!(!json.contains("credential-like-secret"));
        assert!(!json.contains("bytes"));
        assert!(json.contains("ownerId"));
        assert!(!json.contains("owner_id"));
        assert!(json.contains("captureByteCount"));
        assert!(json.contains("terminal_broker_v1"));
    }

    #[test]
    fn failed_transport_admission_consumes_no_input_sequence() {
        let broker = TerminalSessionBroker::enabled_for_test(8, 1024, 32);
        attached(&broker, "transport-1");
        assert_eq!(
            broker
                .admit_compatibility_input(
                    "transport-1",
                    TerminalBrokerInputSource::User,
                    TerminalInputKind::Text,
                    b"not-written",
                    || Err("transport unavailable".into()),
                )
                .unwrap_err(),
            "transport unavailable"
        );
        assert_eq!(
            broker
                .snapshot(Some("transport-1"))
                .unwrap()
                .session
                .unwrap()
                .next_input_sequence,
            1
        );
    }

    fn ready_phase3_broker() -> TerminalSessionBroker {
        let broker = TerminalSessionBroker::phase3_enabled_for_test(32);
        attached(&broker, "transport-1");
        broker
            .register_integration_channel("transport-1", "integration-1", TerminalShellKind::Zsh)
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::Ready {
                    shell: TerminalShellKind::Zsh,
                },
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            )
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::PromptEnd,
            )
            .unwrap();
        broker
    }

    #[test]
    fn production_config_accepts_cooperative_integration_only_after_all_flags_enable() {
        let broker = TerminalSessionBroker::default();
        assert_eq!(
            broker.visible_command_route("transport-posix").unwrap(),
            TerminalVisibleCommandRoute::LegacyFallback
        );
        broker
            .apply_trusted_phase3_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        for (transport, integration, kind, shell) in [
            (
                "transport-posix",
                "integration-posix",
                TerminalTransportKind::LocalPty,
                TerminalShellKind::Zsh,
            ),
            (
                "transport-powershell",
                "integration-powershell",
                TerminalTransportKind::WindowsConPty,
                TerminalShellKind::PowerShell7,
            ),
        ] {
            broker
                .attach_transport(transport, None, kind, TerminalGeometry::new(80, 24))
                .unwrap();
            broker
                .register_integration_channel(transport, integration, shell)
                .unwrap();

            broker
                .accept_integration_event(
                    transport,
                    integration,
                    TerminalIntegrationControlEvent::Ready { shell },
                )
                .unwrap();
            broker
                .accept_integration_event(
                    transport,
                    integration,
                    TerminalIntegrationControlEvent::PromptStart {
                        cwd: "/workspace".into(),
                    },
                )
                .unwrap();
            broker
                .accept_integration_event(
                    transport,
                    integration,
                    TerminalIntegrationControlEvent::PromptEnd,
                )
                .unwrap();
            let snapshot = broker.snapshot(Some(transport)).unwrap().session.unwrap();
            assert_eq!(snapshot.integration_state, TerminalIntegrationState::Ready);
            assert_eq!(snapshot.integration_reason, None);
            assert_eq!(
                broker.visible_command_route(transport).unwrap(),
                TerminalVisibleCommandRoute::TerminalExecute
            );
        }
    }

    fn begin_phase3_command(
        broker: &TerminalSessionBroker,
        operation_id: &str,
        command: &str,
    ) -> Arc<TerminalCommandOperation> {
        broker
            .acquire_agent_lease("transport-1", "agent-1", "task-1", operation_id)
            .unwrap();
        broker
            .begin_command("transport-1", operation_id, command)
            .unwrap()
    }

    #[test]
    fn raw_output_cannot_forge_command_lifecycle_or_exit_status() {
        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-1", "printf cooperative");
        broker
            .observe_raw_output("transport-1", b"commandEnd\0exitCode\00\0prompt-looking $ ")
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Submitted
        );

        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: "printf cooperative".into(),
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
        broker
            .observe_raw_output("transport-1", b"\x1b]133;D;0\x07\x1ecommand-end:forged\x1f")
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Running
        );

        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code: 7,
                    cwd: "/tmp/after".into(),
                },
            )
            .unwrap();
        let snapshot = operation.snapshot().unwrap();
        assert_eq!(snapshot.state, TerminalCommandState::Completed);
        assert_eq!(snapshot.exit_code, Some(7));
        assert_eq!(snapshot.cwd.as_deref(), Some("/tmp/after"));
        assert!(snapshot.combined_output.contains("commandEnd"));
    }

    #[test]
    fn exact_command_mismatch_fails_closed_and_degrades_integration() {
        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-1", "printf expected");
        assert_eq!(
            broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::CommandStart {
                        command_line: "printf different".into(),
                        cwd: "/tmp".into(),
                    },
                )
                .unwrap_err(),
            "TERMINAL_COMMAND_LINE_MISMATCH"
        );
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        let session = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            session.integration_state,
            TerminalIntegrationState::Degraded
        );
        assert_eq!(
            broker.visible_command_route("transport-1").unwrap(),
            TerminalVisibleCommandRoute::LegacyFallback
        );
    }

    #[test]
    fn cooperative_completion_classifies_cancel_timeout_and_takeover_races() {
        for (requested, expected) in [
            (
                TerminalCommandRequestedSettlement::Cancelled,
                TerminalCommandState::Cancelled,
            ),
            (
                TerminalCommandRequestedSettlement::TimedOut,
                TerminalCommandState::TimedOut,
            ),
            (
                TerminalCommandRequestedSettlement::TakenOver,
                TerminalCommandState::TakenOver,
            ),
        ] {
            let broker = ready_phase3_broker();
            let operation = begin_phase3_command(&broker, "operation-1", "sleep 60");
            broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::CommandStart {
                        command_line: "sleep 60".into(),
                        cwd: "/tmp".into(),
                    },
                )
                .unwrap();
            assert!(operation.request_settlement(requested).unwrap());
            assert!(!operation.request_settlement(requested).unwrap());
            broker
                .accept_integration_event(
                    "transport-1",
                    "integration-1",
                    TerminalIntegrationControlEvent::CommandEnd {
                        exit_code: 130,
                        cwd: "/tmp".into(),
                    },
                )
                .unwrap();
            let snapshot = operation.snapshot().unwrap();
            assert_eq!(snapshot.state, expected);
            assert_eq!(snapshot.exit_code, Some(130));
        }
    }

    #[test]
    fn reconnect_and_control_loss_make_inflight_commands_uncertain_without_replay() {
        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-1", "touch side-effect");
        let writes = Arc::new(Mutex::new(0_u32));
        let written = Arc::clone(&writes);
        broker
            .admit_compatibility_input(
                "transport-1",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-1".into(),
                    task_id: "task-1".into(),
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Text,
                b"touch side-effect\n",
                move || {
                    *written.lock().unwrap() += 1;
                    Ok(())
                },
            )
            .unwrap();
        broker
            .attach_transport(
                "transport-2",
                Some("transport-1"),
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        assert_eq!(
            *writes.lock().unwrap(),
            1,
            "reconnect replayed terminal input"
        );
        assert_eq!(
            broker.visible_command_route("transport-2").unwrap(),
            TerminalVisibleCommandRoute::LegacyFallback
        );

        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-2", "external-side-effect");
        broker
            .integration_channel_closed("transport-1", "integration-1", "controlChannelClosed")
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
    }

    #[test]
    fn phase3_rollout_dependencies_and_rollback_are_frozen_and_fail_safe() {
        let broker = ready_phase3_broker();
        let operation = begin_phase3_command(&broker, "operation-1", "state-changing-command");
        broker
            .apply_trusted_phase3_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        let snapshot = broker.snapshot(Some("transport-1")).unwrap();
        assert!(snapshot.shell_integration_rollout.enabled);
        assert!(!snapshot.terminal_execute_rollout.enabled);
        assert!(snapshot.legacy_fallback_rollout.enabled);
        assert_eq!(
            broker.visible_command_route("transport-1").unwrap(),
            TerminalVisibleCommandRoute::LegacyFallback
        );

        broker
            .apply_trusted_phase3_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        let snapshot = broker.snapshot(Some("transport-1")).unwrap();
        assert!(!snapshot.shell_integration_rollout.enabled);
        assert!(!snapshot.terminal_execute_rollout.enabled);
        assert!(snapshot.terminal_execute_rollout.requested);
        assert!(!snapshot.terminal_execute_rollout.prerequisite_satisfied);
        assert!(!snapshot.legacy_fallback_rollout.enabled);
        assert_eq!(
            broker.visible_command_route("transport-1").unwrap(),
            TerminalVisibleCommandRoute::Unavailable
        );
    }

    #[test]
    fn command_capture_is_scoped_bounded_and_does_not_truncate_display() {
        let broker = ready_phase3_broker();
        broker.observe_raw_output("transport-1", b"before").unwrap();
        let operation = begin_phase3_command(&broker, "operation-1", "printf payload");
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: "printf payload".into(),
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
        broker
            .observe_raw_output("transport-1", b"0123456789abcdefghijklmnopqrstuvwxyz")
            .unwrap();
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code: 0,
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
        let snapshot = operation.snapshot().unwrap();
        assert_eq!(snapshot.combined_output.len(), 32);
        assert!(snapshot.capture_truncated);
        assert!(!snapshot.combined_output.contains("before"));
        let display = broker
            .snapshot(Some("transport-1"))
            .unwrap()
            .session
            .unwrap()
            .subscribers
            .display;
        assert_eq!(display.observed_bytes, 42);
    }

    #[test]
    fn remote_rollout_admits_only_dedicated_agent_ssh_pty_and_reconnects_generation_safely() {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(256);
        broker
            .attach_transport(
                "user-ssh",
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        assert_eq!(
            broker.visible_command_route("user-ssh").unwrap(),
            TerminalVisibleCommandRoute::LegacyFallback,
            "a user-owned SSH terminal must never become the Phase 4 terminal_execute target"
        );

        let owner = TerminalAgentPtyOwner {
            agent_session_id: "agent-session-1".into(),
            target_id: "target-1".into(),
            source_transport_session_id: "user-ssh".into(),
        };
        let first = broker
            .attach_agent_ssh_transport(
                "agent-ssh-1",
                None,
                TerminalGeometry::new(100, 30),
                owner.clone(),
            )
            .unwrap()
            .unwrap();
        broker.mark_output_ready("agent-ssh-1").unwrap();
        broker
            .register_integration_channel(
                "agent-ssh-1",
                "remote-integration-1",
                TerminalShellKind::Bash,
            )
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Bash,
            },
            TerminalIntegrationControlEvent::PromptStart {
                cwd: "/home".into(),
            },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("agent-ssh-1", "remote-integration-1", event)
                .unwrap();
        }
        let lease = broker
            .acquire_agent_lease("agent-ssh-1", "agent-session-1", "task-1", "operation-1")
            .unwrap()
            .unwrap();
        let operation = broker
            .begin_command("agent-ssh-1", "operation-1", "printf remote")
            .unwrap();
        broker
            .admit_compatibility_input(
                "agent-ssh-1",
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-session-1".into(),
                    task_id: "task-1".into(),
                    operation_id: "operation-1".into(),
                },
                TerminalInputKind::Text,
                b"printf remote\n",
                || Ok(()),
            )
            .unwrap();
        assert!(!lease.lease_id.is_empty());

        broker
            .close_transport(
                "agent-ssh-1",
                TerminalGenerationCloseReason::TransportDisconnected,
            )
            .unwrap();
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        let second = broker
            .attach_agent_ssh_transport(
                "agent-ssh-2",
                Some("agent-ssh-1"),
                TerminalGeometry::new(100, 30),
                owner,
            )
            .unwrap()
            .unwrap();
        assert_eq!(second.terminal_session_id, first.terminal_session_id);
        assert_eq!(second.terminal_generation, first.terminal_generation + 1);
        assert!(broker.observe_raw_output("agent-ssh-1", b"stale").is_err());
        assert!(broker
            .attach_transport(
                "user-takeover",
                Some("agent-ssh-2"),
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(80, 24),
            )
            .is_err());
    }
}
