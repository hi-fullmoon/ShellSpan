use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use base64::Engine;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::models::SessionManager;
use crate::models::SessionStatus;

use super::{
    TerminalInputSource, TerminalLeaseError, TerminalLeaseManager, TerminalLeaseReleaseReason,
};

const RECORD_SEPARATOR: char = '\u{001e}';
const UNIT_SEPARATOR: char = '\u{001f}';
const REPLACE_CURRENT_TERMINAL_LINE: &str = "\r\u{001b}[2K";
const PTY_CAPTURE_LIMIT_BYTES: usize = 1024 * 1024;
const PTY_PROTOCOL_BUFFER_LIMIT_BYTES: usize = 2 * 1024 * 1024;
#[cfg(not(test))]
const FRONTEND_READY_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(test)]
const FRONTEND_READY_TIMEOUT: Duration = Duration::from_millis(50);
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PtyShellKindNative {
    Posix,
    PowerShell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PtyLifecycleNative {
    Running,
    Exited,
    Cancelled,
    TimedOut,
    TakenOver,
    Failed,
}

impl PtyLifecycleNative {
    fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PtySnapshotNative {
    pub(crate) state: PtyLifecycleNative,
    pub(crate) exit_code: Option<i32>,
    pub(crate) combined_output: String,
    pub(crate) bytes_read: u64,
    pub(crate) truncated: bool,
    pub(crate) error: Option<String>,
}

#[derive(Debug)]
struct PtyStateNative {
    lifecycle: PtyLifecycleNative,
    exit_code: Option<i32>,
    protocol_buffer: String,
    capture: String,
    bytes_read: u64,
    truncated: bool,
    shell_kind: Option<PtyShellKindNative>,
    shell_probe_pending: bool,
    began: bool,
    display_announced: bool,
    completion_commitment: Option<String>,
    error: Option<String>,
}

pub(crate) struct PtyOperationNative {
    begin_prefix: String,
    end_prefix: String,
    record_terminator: String,
    shell_probe_prefix: String,
    command_display: String,
    state: Mutex<PtyStateNative>,
    changed: Condvar,
}

impl PtyOperationNative {
    fn new(
        marker: String,
        shell_kind: Option<PtyShellKindNative>,
        command_display: String,
    ) -> Arc<Self> {
        let powershell_protocol = shell_kind == Some(PtyShellKindNative::PowerShell);
        Arc::new(Self {
            begin_prefix: if powershell_protocol {
                format!("{marker}:BEGIN:")
            } else {
                format!("{RECORD_SEPARATOR}{marker}:BEGIN:")
            },
            end_prefix: if powershell_protocol {
                format!("{marker}:END:")
            } else {
                format!("{RECORD_SEPARATOR}{marker}:END:")
            },
            record_terminator: if powershell_protocol {
                "\r\n".into()
            } else {
                UNIT_SEPARATOR.to_string()
            },
            shell_probe_prefix: format!("{marker}:SHELL:"),
            command_display,
            state: Mutex::new(PtyStateNative {
                lifecycle: PtyLifecycleNative::Running,
                exit_code: None,
                protocol_buffer: String::new(),
                capture: String::new(),
                bytes_read: 0,
                truncated: false,
                shell_kind,
                shell_probe_pending: shell_kind.is_none(),
                began: false,
                display_announced: false,
                completion_commitment: None,
                error: None,
            }),
            changed: Condvar::new(),
        })
    }

    fn observe(&self, chunk: &str) -> String {
        let Ok(mut state) = self.state.lock() else {
            return String::new();
        };
        if state.lifecycle.is_terminal() {
            return if state.lifecycle == PtyLifecycleNative::Exited {
                chunk.to_string()
            } else {
                String::new()
            };
        }
        state.protocol_buffer.push_str(chunk);

        if state.shell_probe_pending {
            self.consume_shell_probe(&mut state);
            if state.shell_probe_pending {
                self.enforce_protocol_boundary(&mut state);
                self.changed.notify_all();
                return String::new();
            }
        }
        if !state.began && !self.consume_begin(&mut state) {
            self.enforce_protocol_boundary(&mut state);
            self.changed.notify_all();
            return String::new();
        }

        let mut display = String::new();
        if state.began && !state.display_announced {
            display.push_str(&self.command_display);
            state.display_announced = true;
        }
        self.consume_output_and_end(&mut state, &mut display);
        self.enforce_protocol_boundary(&mut state);
        self.changed.notify_all();
        display
    }

    fn enforce_protocol_boundary(&self, state: &mut PtyStateNative) {
        if state.protocol_buffer.len() > PTY_PROTOCOL_BUFFER_LIMIT_BYTES {
            state.lifecycle = PtyLifecycleNative::Failed;
            state.error = Some("PTY protocol output exceeded its hard boundary".into());
        }
    }

    fn consume_shell_probe(&self, state: &mut PtyStateNative) {
        let mut through = 0;
        for line in state.protocol_buffer.split_inclusive('\n') {
            through += line.len();
            let normalized = strip_ansi(line).trim_matches(['\r', '\n']).to_string();
            let Some(value) = normalized.strip_prefix(&self.shell_probe_prefix) else {
                continue;
            };
            state.shell_kind = classify_shell_probe(value.trim());
            state.shell_probe_pending = false;
            state.protocol_buffer.drain(..through);
            return;
        }
        if through > 0 {
            state.protocol_buffer.drain(..through);
        }
    }

    fn consume_begin(&self, state: &mut PtyStateNative) -> bool {
        loop {
            let view = protocol_view(
                &state.protocol_buffer,
                state.shell_kind == Some(PtyShellKindNative::PowerShell),
            );
            let Some(index) = view.text.find(&self.begin_prefix) else {
                let keep = suffix_prefix_len(&view.text, &self.begin_prefix);
                let normalized_start = view.text.len().saturating_sub(keep);
                let start = view.raw_start(normalized_start);
                state.protocol_buffer.drain(..start);
                return false;
            };
            let commitment_start = index + self.begin_prefix.len();
            let Some(relative_end) = view.text[commitment_start..].find(&self.record_terminator)
            else {
                if index > 0 {
                    state.protocol_buffer.drain(..view.raw_start(index));
                }
                return false;
            };
            let commitment_end = commitment_start + relative_end;
            let commitment = if state.shell_kind == Some(PtyShellKindNative::PowerShell) {
                view.text[commitment_start..commitment_end]
                    .trim_end_matches(' ')
                    .to_string()
            } else {
                view.text[commitment_start..commitment_end].to_string()
            };
            let through = view.raw_end(commitment_end + self.record_terminator.len());
            state.protocol_buffer.drain(..through);
            if commitment.len() != 64 || !commitment.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                continue;
            }
            state.began = true;
            state.completion_commitment = Some(commitment.to_ascii_lowercase());
            return true;
        }
    }

    fn consume_output_and_end(&self, state: &mut PtyStateNative, display: &mut String) {
        loop {
            let view = protocol_view(
                &state.protocol_buffer,
                state.shell_kind == Some(PtyShellKindNative::PowerShell),
            );
            let Some(index) = view.text.find(&self.end_prefix) else {
                let keep = suffix_prefix_len(&view.text, &self.end_prefix);
                let normalized_split = view.text.len().saturating_sub(keep);
                let split = view.raw_start(normalized_split);
                if split > 0 {
                    let output = state.protocol_buffer[..split].to_string();
                    state.protocol_buffer.drain(..split);
                    append_capture(state, &output);
                    display.push_str(&output);
                }
                return;
            };
            let record_start = index + self.end_prefix.len();
            let Some(relative_end) = view.text[record_start..].find(&self.record_terminator) else {
                if index > 0 {
                    let raw_index = view.raw_start(index);
                    let output = state.protocol_buffer[..raw_index].to_string();
                    state.protocol_buffer.drain(..raw_index);
                    append_capture(state, &output);
                    display.push_str(&output);
                }
                return;
            };
            let record_end = record_start + relative_end;
            let record = if state.shell_kind == Some(PtyShellKindNative::PowerShell) {
                view.text[record_start..record_end]
                    .trim_end_matches(' ')
                    .to_string()
            } else {
                view.text[record_start..record_end].to_string()
            };
            let authenticated = record.split_once(':').and_then(|(capability, exit)| {
                if capability.len() != 64
                    || !capability.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return None;
                }
                let digest = Sha256::digest(capability.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                (Some(digest) == state.completion_commitment)
                    .then(|| exit.parse::<i32>().ok())
                    .flatten()
            });
            if index > 0 {
                let raw_index = view.raw_start(index);
                let output = state.protocol_buffer[..raw_index].to_string();
                state.protocol_buffer.drain(..raw_index);
                append_capture(state, &output);
                display.push_str(&output);
            }
            let through =
                view.raw_end(record_end + self.record_terminator.len()) - view.raw_start(index);
            if let Some(code) = authenticated {
                state.protocol_buffer.drain(..through);
                display.push_str(&state.protocol_buffer);
                state.protocol_buffer.clear();
                state.exit_code = Some(code);
                state.lifecycle = PtyLifecycleNative::Exited;
                return;
            }
            // A record using our unpredictable marker but failing commitment
            // authentication is protocol-shaped forgery. Drop it from both
            // display and model capture, and keep waiting for the real END.
            state.protocol_buffer.drain(..through);
        }
    }

    fn shell_probe_command(&self) -> String {
        format!("echo {}$0\r", self.shell_probe_prefix)
    }

    fn wait_shell_probe(&self, timeout: Duration) -> Result<PtyShellKindNative, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "PTY operation state is unavailable".to_string())?;
        let (state, timed) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state.shell_probe_pending && !state.lifecycle.is_terminal()
            })
            .map_err(|_| "PTY operation state is unavailable".to_string())?;
        if timed.timed_out() && state.shell_probe_pending {
            return Err(
                "PTY_SHELL_PROBE_TIMEOUT: terminal shell capability probe timed out".into(),
            );
        }
        state
            .shell_kind
            .ok_or_else(|| "PTY_SHELL_UNSUPPORTED: terminal shell is unknown or unsupported".into())
    }

    pub(crate) fn wait(&self, timeout: Duration) -> Result<PtySnapshotNative, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "PTY operation state is unavailable".to_string())?;
        let (state, timed) = self
            .changed
            .wait_timeout_while(state, timeout, |state| !state.lifecycle.is_terminal())
            .map_err(|_| "PTY operation state is unavailable".to_string())?;
        let timed_out = timed.timed_out() && !state.lifecycle.is_terminal();
        // `snapshot` acquires the same mutex. Always release the guard returned
        // by the condvar before calling it, including the normal completion
        // path; otherwise the worker self-deadlocks as soon as END is observed.
        drop(state);
        if timed_out {
            self.finish(PtyLifecycleNative::TimedOut, "PTY command timed out");
        }
        self.snapshot()
    }

    pub(crate) fn finish(&self, lifecycle: PtyLifecycleNative, error: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.lifecycle.is_terminal() {
            return false;
        }
        state.lifecycle = lifecycle;
        if !error.is_empty() {
            state.error = Some(error.to_string());
        }
        self.changed.notify_all();
        true
    }

    pub(crate) fn snapshot(&self) -> Result<PtySnapshotNative, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "PTY operation state is unavailable".to_string())?;
        let mut combined_output = state.capture.clone();
        if state.began {
            combined_output.push_str(&state.protocol_buffer);
        }
        Ok(PtySnapshotNative {
            state: state.lifecycle,
            exit_code: state.exit_code,
            combined_output,
            bytes_read: state.bytes_read,
            truncated: state.truncated,
            error: state.error.clone(),
        })
    }
}

fn append_capture(state: &mut PtyStateNative, value: &str) {
    state.bytes_read = state.bytes_read.saturating_add(value.len() as u64);
    if state.capture.len() < PTY_CAPTURE_LIMIT_BYTES {
        let available = PTY_CAPTURE_LIMIT_BYTES - state.capture.len();
        let end = floor_char_boundary(value, available.min(value.len()));
        state.capture.push_str(&value[..end]);
    }
    if state.bytes_read > PTY_CAPTURE_LIMIT_BYTES as u64 {
        state.truncated = true;
    }
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn suffix_prefix_len(value: &str, prefix: &str) -> usize {
    let max = value.len().min(prefix.len().saturating_sub(1));
    (1..=max)
        .rev()
        .find(|length| {
            let start = value.len() - length;
            value.is_char_boundary(start) && prefix.starts_with(&value[start..])
        })
        .unwrap_or(0)
}

/// Windows ConPTY represents a physical line wrap in its VT output as a CRLF
/// followed by an absolute cursor-position sequence. PowerShell protocol
/// records are deliberately long and can therefore contain those display-only
/// bytes at ordinary terminal widths. Keep a normalized search view together
/// with offsets into the untouched stream so protocol bytes can be recognized
/// without changing real command output or ANSI styling.
struct ProtocolView {
    text: String,
    raw_starts: Vec<usize>,
    raw_ends: Vec<usize>,
    raw_boundary: usize,
}

impl ProtocolView {
    fn raw_start(&self, normalized_index: usize) -> usize {
        self.raw_starts
            .get(normalized_index)
            .copied()
            .unwrap_or(self.raw_boundary)
    }

    fn raw_end(&self, normalized_end: usize) -> usize {
        normalized_end
            .checked_sub(1)
            .and_then(|index| self.raw_ends.get(index).copied())
            .unwrap_or(0)
    }
}

fn protocol_view(value: &str, normalize_conpty_wraps: bool) -> ProtocolView {
    if !normalize_conpty_wraps {
        return ProtocolView {
            text: value.to_string(),
            raw_starts: (0..value.len()).collect(),
            raw_ends: (1..=value.len()).collect(),
            raw_boundary: value.len(),
        };
    }

    let bytes = value.as_bytes();
    let mut text = Vec::with_capacity(bytes.len());
    let mut raw_starts = Vec::with_capacity(bytes.len());
    let mut raw_ends = Vec::with_capacity(bytes.len());
    let mut raw_index = 0;
    let mut raw_boundary = bytes.len();
    while raw_index < bytes.len() {
        if let Some(length) = conpty_wrap_sequence_len(&bytes[raw_index..]) {
            // ConPTY positions the cursor on the last cell of the previous
            // physical row and redraws that cell before continuing. Wait for
            // the redraw byte when chunks split at the CSI boundary, then
            // remove it only when it is the duplicated boundary character.
            if raw_index + length == bytes.len() {
                raw_boundary = raw_index;
                break;
            }
            raw_index += length;
            if text.last() == bytes.get(raw_index) {
                raw_index += 1;
            }
            continue;
        }
        if is_partial_conpty_wrap_sequence(&bytes[raw_index..]) {
            raw_boundary = raw_index;
            break;
        }
        text.push(bytes[raw_index]);
        raw_starts.push(raw_index);
        raw_ends.push(raw_index + 1);
        raw_index += 1;
    }
    ProtocolView {
        // Removing ASCII control sequences from valid UTF-8 cannot invalidate
        // the remaining byte stream.
        text: String::from_utf8(text).expect("ConPTY protocol view remains UTF-8"),
        raw_starts,
        raw_ends,
        raw_boundary,
    }
}

fn conpty_wrap_sequence_len(value: &[u8]) -> Option<usize> {
    if !value.starts_with(b"\r\n\x1b[") {
        return None;
    }
    let mut index = 4;
    let row_start = index;
    while value.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if index == row_start || value.get(index) != Some(&b';') {
        return None;
    }
    index += 1;
    let column_start = index;
    while value.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if index == column_start || value.get(index) != Some(&b'H') {
        return None;
    }
    Some(index + 1)
}

fn is_partial_conpty_wrap_sequence(value: &[u8]) -> bool {
    const PREFIX: &[u8] = b"\r\n\x1b[";
    if value.len() < PREFIX.len() {
        return PREFIX.starts_with(value);
    }
    if !value.starts_with(PREFIX) {
        return false;
    }
    let mut index = PREFIX.len();
    while value.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if index == value.len() {
        return true;
    }
    if index == PREFIX.len() || value[index] != b';' {
        return false;
    }
    index += 1;
    while value.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if index == value.len() {
        return true;
    }
    value.get(index) == Some(&b'H') && index + 1 == value.len()
}

fn classify_shell_probe(value: &str) -> Option<PtyShellKindNative> {
    if value.is_empty() {
        return Some(PtyShellKindNative::PowerShell);
    }
    let shell = value
        .trim_start_matches('-')
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    matches!(shell.as_str(), "sh" | "bash" | "zsh" | "dash" | "ksh")
        .then_some(PtyShellKindNative::Posix)
}

pub(crate) fn strip_ansi(value: &str) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Ground,
        Escape,
        Csi,
        Osc,
        OscEscape,
    }
    let mut state = State::Ground;
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        state = match state {
            State::Ground if character == '\u{1b}' => State::Escape,
            State::Ground => {
                output.push(character);
                State::Ground
            }
            State::Escape if character == '[' => State::Csi,
            State::Escape if character == ']' => State::Osc,
            State::Escape => State::Ground,
            State::Csi if ('@'..='~').contains(&character) => State::Ground,
            State::Csi => State::Csi,
            State::Osc if character == '\u{7}' => State::Ground,
            State::Osc if character == '\u{1b}' => State::OscEscape,
            State::Osc => State::Osc,
            State::OscEscape if character == '\\' => State::Ground,
            State::OscEscape if character == '\u{1b}' => State::OscEscape,
            State::OscEscape => State::Osc,
        };
    }
    output
}

#[derive(Clone)]
struct PtyRegistrationNative {
    agent_session_id: String,
    task_id: String,
    operation_id: String,
    operation: Arc<PtyOperationNative>,
}

type PtyOperationsNative = Arc<Mutex<HashMap<String, PtyRegistrationNative>>>;

#[derive(Clone)]
pub(crate) struct PtyRegistryNative {
    operations: PtyOperationsNative,
    leases: TerminalLeaseManager,
}

impl Default for PtyRegistryNative {
    fn default() -> Self {
        Self::new(TerminalLeaseManager::default())
    }
}

impl PtyRegistryNative {
    pub(crate) fn new(leases: TerminalLeaseManager) -> Self {
        Self {
            operations: Arc::new(Mutex::new(HashMap::new())),
            leases,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        command: &str,
        shell_kind: Option<PtyShellKindNative>,
    ) -> Result<Arc<PtyOperationNative>, String> {
        let safe_command_display = format!(
            "[Agent] $ {}",
            crate::redaction::redact_sensitive_text(command)
        );
        // The interactive shell prompt is still visible on the current line
        // while the authenticated wrapper runs behind the display filter.
        // Replace that prompt instead of moving down and leaving an empty line.
        let command_display = format!("{REPLACE_CURRENT_TERMINAL_LINE}{safe_command_display}\r\n");
        self.leases.acquire(
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            Some(safe_command_display),
        )?;
        let marker = format!(
            "shellspan_native_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let operation = PtyOperationNative::new(marker.clone(), shell_kind, command_display);
        {
            let mut operations = match self.operations.lock() {
                Ok(operations) => operations,
                Err(_) => {
                    let _ = self.leases.release(
                        session_id,
                        agent_session_id,
                        task_id,
                        operation_id,
                        TerminalLeaseReleaseReason::Failed,
                    );
                    return Err("PTY_REGISTRY_UNAVAILABLE: PTY registry is unavailable".into());
                }
            };
            if operations.contains_key(session_id) {
                let _ = self.leases.release(
                    session_id,
                    agent_session_id,
                    task_id,
                    operation_id,
                    TerminalLeaseReleaseReason::Failed,
                );
                return Err(TerminalLeaseError::Busy.to_string());
            }
            operations.insert(
                session_id.to_string(),
                PtyRegistrationNative {
                    agent_session_id: agent_session_id.to_string(),
                    task_id: task_id.to_string(),
                    operation_id: operation_id.to_string(),
                    operation: Arc::clone(&operation),
                },
            );
        }
        if let Err(error) = self.leases.wait_frontend_ready(
            session_id,
            agent_session_id,
            task_id,
            operation_id,
            FRONTEND_READY_TIMEOUT,
        ) {
            if operation
                .snapshot()
                .is_ok_and(|snapshot| snapshot.state.is_terminal())
            {
                return Ok(operation);
            }
            operation.finish(PtyLifecycleNative::Failed, &error);
            let _ = self.settle(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err(error);
        }
        let terminal_connected = sessions
            .target_state(session_id)
            .map(|state| state.status == SessionStatus::Connected)
            .unwrap_or(false);
        if !terminal_connected {
            let error = "PTY_TERMINAL_NOT_CONNECTED: terminal disconnected before PTY write";
            operation.finish(PtyLifecycleNative::Failed, error);
            let _ = self.settle(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err(error.into());
        }

        let shell_kind = match shell_kind {
            Some(shell_kind) => shell_kind,
            None => {
                if let Err(error) = self.leases.write(
                    sessions,
                    session_id,
                    operation.shell_probe_command(),
                    TerminalInputSource::Agent {
                        agent_session_id,
                        task_id,
                        operation_id,
                    },
                ) {
                    if operation
                        .snapshot()
                        .is_ok_and(|snapshot| snapshot.state.is_terminal())
                    {
                        return Ok(operation);
                    }
                    operation.finish(PtyLifecycleNative::Failed, &error);
                    let _ = self.settle(
                        session_id,
                        agent_session_id,
                        task_id,
                        operation_id,
                        TerminalLeaseReleaseReason::Failed,
                    );
                    return Err(error);
                }
                match operation.wait_shell_probe(SHELL_PROBE_TIMEOUT) {
                    Ok(shell_kind) => shell_kind,
                    Err(error) => {
                        if operation
                            .snapshot()
                            .is_ok_and(|snapshot| snapshot.state.is_terminal())
                        {
                            return Ok(operation);
                        }
                        operation.finish(PtyLifecycleNative::Failed, &error);
                        let _ = self.settle(
                            session_id,
                            agent_session_id,
                            task_id,
                            operation_id,
                            TerminalLeaseReleaseReason::Failed,
                        );
                        return Err(error);
                    }
                }
            }
        };
        let (wrapper, terminator) = match shell_kind {
            PtyShellKindNative::PowerShell => (build_powershell_wrapper(command, &marker), "\r"),
            PtyShellKindNative::Posix => (build_posix_wrapper(command, &marker), "\n"),
        };
        if let Err(error) = self.leases.write(
            sessions,
            session_id,
            format!("{wrapper}{terminator}"),
            TerminalInputSource::Agent {
                agent_session_id,
                task_id,
                operation_id,
            },
        ) {
            if operation
                .snapshot()
                .is_ok_and(|snapshot| snapshot.state.is_terminal())
            {
                return Ok(operation);
            }
            operation.finish(PtyLifecycleNative::Failed, &error);
            let _ = self.settle(
                session_id,
                agent_session_id,
                task_id,
                operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err(error);
        }
        Ok(operation)
    }

    pub(crate) fn observe(&self, session_id: &str, chunk: &str) -> String {
        let operation = self.operations.lock().ok().and_then(|operations| {
            operations
                .get(session_id)
                .map(|record| Arc::clone(&record.operation))
        });
        if let Some(operation) = operation {
            operation.observe(chunk)
        } else {
            chunk.to_string()
        }
    }

    pub(crate) fn interrupt_timed_out(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        operation_id: &str,
    ) -> Result<(), String> {
        let registration = self.registration(session_id, operation_id)?;
        let _ = self.leases.write(
            sessions,
            session_id,
            "\u{3}".to_string(),
            TerminalInputSource::System {
                operation_id: Some(operation_id),
            },
        );
        self.settle_registration(
            session_id,
            &registration,
            TerminalLeaseReleaseReason::TimedOut,
        )?;
        Ok(())
    }

    pub(crate) fn takeover(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        self.leases
            .validate_control_owner(session_id, agent_session_id, operation_id)?;
        let registration = self.registration(session_id, operation_id)?;
        if !registration.operation.finish(
            PtyLifecycleNative::TakenOver,
            "PTY command was interrupted by user takeover",
        ) {
            return Err(TerminalLeaseError::AlreadyTerminal.to_string());
        }
        let _ = self.leases.write(
            sessions,
            session_id,
            "\u{3}".to_string(),
            TerminalInputSource::System {
                operation_id: Some(operation_id),
            },
        );
        self.settle_registration(
            session_id,
            &registration,
            TerminalLeaseReleaseReason::TakenOver,
        )?;
        Ok(true)
    }

    pub(crate) fn complete(
        &self,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        reason: TerminalLeaseReleaseReason,
    ) -> Result<bool, String> {
        self.settle(session_id, agent_session_id, task_id, operation_id, reason)
    }

    fn settle(
        &self,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        reason: TerminalLeaseReleaseReason,
    ) -> Result<bool, String> {
        let removed = {
            let mut operations = self
                .operations
                .lock()
                .map_err(|_| "PTY_REGISTRY_UNAVAILABLE: PTY registry is unavailable".to_string())?;
            if operations
                .get(session_id)
                .is_some_and(|record| record.operation_id == operation_id)
            {
                operations.remove(session_id);
                true
            } else {
                false
            }
        };
        let released =
            self.leases
                .release(session_id, agent_session_id, task_id, operation_id, reason)?;
        Ok(removed || released)
    }

    fn settle_registration(
        &self,
        session_id: &str,
        registration: &PtyRegistrationNative,
        reason: TerminalLeaseReleaseReason,
    ) -> Result<bool, String> {
        self.settle(
            session_id,
            &registration.agent_session_id,
            &registration.task_id,
            &registration.operation_id,
            reason,
        )
    }

    fn registration(
        &self,
        session_id: &str,
        operation_id: &str,
    ) -> Result<PtyRegistrationNative, String> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| "PTY_REGISTRY_UNAVAILABLE: PTY registry is unavailable".to_string())?;
        let registration = operations
            .get(session_id)
            .ok_or_else(|| TerminalLeaseError::AlreadyTerminal.to_string())?;
        if registration.operation_id != operation_id {
            return Err(TerminalLeaseError::OperationMismatch.to_string());
        }
        Ok(registration.clone())
    }

    pub(crate) fn cancel_task(
        &self,
        sessions: &SessionManager,
        task_id: &str,
    ) -> Result<usize, String> {
        self.interrupt_where(sessions, TerminalLeaseReleaseReason::Cancelled, |record| {
            record.task_id == task_id
        })
    }

    pub(crate) fn terminal_closed(&self, session_id: &str) -> Result<bool, String> {
        let registration = self
            .operations
            .lock()
            .ok()
            .and_then(|operations| operations.get(session_id).cloned());
        let Some(registration) = registration else {
            return self
                .leases
                .release_terminal(session_id, TerminalLeaseReleaseReason::TerminalClosed);
        };
        let reason = if registration
            .operation
            .finish(PtyLifecycleNative::Failed, "PTY terminal session closed")
        {
            TerminalLeaseReleaseReason::TerminalClosed
        } else {
            release_reason_for_lifecycle(registration.operation.snapshot()?.state)?
        };
        self.settle_registration(session_id, &registration, reason)
    }

    pub(crate) fn shutdown_all(&self, sessions: &SessionManager) -> Result<usize, String> {
        let interrupted =
            self.interrupt_where(sessions, TerminalLeaseReleaseReason::Shutdown, |_| true)?;
        let orphaned = self
            .leases
            .release_all(TerminalLeaseReleaseReason::Shutdown)?;
        Ok(interrupted.saturating_add(orphaned))
    }

    fn interrupt_where(
        &self,
        sessions: &SessionManager,
        reason: TerminalLeaseReleaseReason,
        predicate: impl Fn(&PtyRegistrationNative) -> bool,
    ) -> Result<usize, String> {
        let registrations = self
            .operations
            .lock()
            .map_err(|_| "PTY_REGISTRY_UNAVAILABLE: PTY registry is unavailable".to_string())?
            .iter()
            .filter(|(_, record)| predicate(record))
            .map(|(session_id, record)| (session_id.clone(), record.clone()))
            .collect::<Vec<_>>();
        let lifecycle = match reason {
            TerminalLeaseReleaseReason::TakenOver => PtyLifecycleNative::TakenOver,
            TerminalLeaseReleaseReason::TimedOut => PtyLifecycleNative::TimedOut,
            TerminalLeaseReleaseReason::Failed | TerminalLeaseReleaseReason::TerminalClosed => {
                PtyLifecycleNative::Failed
            }
            TerminalLeaseReleaseReason::Completed => PtyLifecycleNative::Exited,
            TerminalLeaseReleaseReason::Cancelled | TerminalLeaseReleaseReason::Shutdown => {
                PtyLifecycleNative::Cancelled
            }
        };
        let mut interrupted = 0;
        for (session_id, registration) in registrations {
            let won_terminal_state = registration
                .operation
                .finish(lifecycle, "PTY command was interrupted");
            let release_reason = if won_terminal_state {
                let _ = self.leases.write(
                    sessions,
                    &session_id,
                    "\u{3}".to_string(),
                    TerminalInputSource::System {
                        operation_id: Some(&registration.operation_id),
                    },
                );
                interrupted += 1;
                reason
            } else {
                release_reason_for_lifecycle(registration.operation.snapshot()?.state)?
            };
            self.settle_registration(&session_id, &registration, release_reason)?;
        }
        Ok(interrupted)
    }
}

fn release_reason_for_lifecycle(
    lifecycle: PtyLifecycleNative,
) -> Result<TerminalLeaseReleaseReason, String> {
    match lifecycle {
        PtyLifecycleNative::Exited => Ok(TerminalLeaseReleaseReason::Completed),
        PtyLifecycleNative::Cancelled => Ok(TerminalLeaseReleaseReason::Cancelled),
        PtyLifecycleNative::TimedOut => Ok(TerminalLeaseReleaseReason::TimedOut),
        PtyLifecycleNative::TakenOver => Ok(TerminalLeaseReleaseReason::TakenOver),
        PtyLifecycleNative::Failed => Ok(TerminalLeaseReleaseReason::Failed),
        PtyLifecycleNative::Running => {
            Err("PTY_TERMINAL_STATE_UNAVAILABLE: PTY operation did not settle".into())
        }
    }
}

fn split_secret(value: &str) -> (&str, &str) {
    value.split_at(value.len() / 2)
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn build_posix_wrapper(command: &str, marker: &str) -> String {
    let (marker_a, marker_b) = split_secret(marker);
    format!(
        "__ss_m={}{}; __ss_k=$(/usr/bin/od -An -N32 -tx1 /dev/urandom 2>/dev/null | /usr/bin/tr -d '[:space:]'); if [ -x /usr/bin/sha256sum ]; then __ss_h=$(/usr/bin/printf '%s' \"$__ss_k\" | /usr/bin/sha256sum); elif [ -x /usr/bin/shasum ]; then __ss_h=$(/usr/bin/printf '%s' \"$__ss_k\" | /usr/bin/shasum -a 256); else __ss_h=; fi; __ss_h=${{__ss_h%% *}}; if [ -n \"$__ss_k\" ] && [ -n \"$__ss_h\" ]; then /usr/bin/printf '\\036%s:BEGIN:%s\\037' \"$__ss_m\" \"$__ss_h\"; /bin/sh -c {}; __ss_e=$?; /usr/bin/printf '\\036%s:END:%s:%d\\037' \"$__ss_m\" \"$__ss_k\" \"$__ss_e\"; fi; unset __ss_m __ss_k __ss_h __ss_e",
        quote_posix(marker_a),
        quote_posix(marker_b),
        quote_posix(command)
    )
}

fn build_powershell_wrapper(command: &str, marker: &str) -> String {
    let (marker_a, marker_b) = split_secret(marker);
    let encoded = encode_powershell_command(command);
    format!(
        "$__ss_m={}+{}; $__ss_b=[byte[]]::new(32); $__ss_r=[System.Security.Cryptography.RandomNumberGenerator]::Create(); $__ss_r.GetBytes($__ss_b); $__ss_r.Dispose(); $__ss_k=[System.BitConverter]::ToString($__ss_b).Replace('-','').ToLowerInvariant(); $__ss_s=[System.Security.Cryptography.SHA256]::Create(); $__ss_h=[System.BitConverter]::ToString($__ss_s.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($__ss_k))).Replace('-','').ToLowerInvariant(); $__ss_s.Dispose(); [Console]::WriteLine((-join ($__ss_m,':BEGIN:',$__ss_h))); & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}; $__ss_e=$LASTEXITCODE; [Console]::WriteLine((-join ($__ss_m,':END:',$__ss_k,':',$__ss_e))); Remove-Variable __ss_m,__ss_b,__ss_r,__ss_k,__ss_s,__ss_h,__ss_e -ErrorAction SilentlyContinue",
        quote_powershell(marker_a),
        quote_powershell(marker_b),
        encoded
    )
}

fn encode_powershell_command(command: &str) -> String {
    let bytes = command
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crossbeam_channel::{unbounded, Receiver};
    #[cfg(any(unix, target_os = "windows"))]
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    #[cfg(any(unix, target_os = "windows"))]
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicBool;
    #[cfg(any(unix, target_os = "windows"))]
    use std::sync::mpsc;
    #[cfg(any(unix, target_os = "windows"))]
    use std::thread;
    #[cfg(any(unix, target_os = "windows"))]
    use std::time::Instant;

    fn ready_leases() -> TerminalLeaseManager {
        let leases = TerminalLeaseManager::default();
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        leases
    }

    fn sessions(session_id: &str) -> (SessionManager, Receiver<SessionCommand>) {
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                session_id.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: session_id.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "Local".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        (sessions, receiver)
    }

    fn commitment(capability: &str) -> String {
        Sha256::digest(capability.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn protocol(marker: &str, capability: &str, output: &str, code: i32, prompt: &str) -> String {
        format!(
            "wrapper echo\r\n\u{1e}{marker}:BEGIN:{}\u{1f}{output}\u{1e}{marker}:END:{capability}:{code}\u{1f}{prompt}",
            commitment(capability)
        )
    }

    #[cfg(any(unix, target_os = "windows"))]
    fn run_local_shell_protocol(wrapper: &str, cols: u16) -> String {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open a real local terminal");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("clone the real terminal reader");
        let mut writer = pair
            .master
            .take_writer()
            .expect("take the real terminal writer");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = CommandBuilder::new("powershell.exe");
            command.args(["-NoLogo", "-NoProfile"]);
            command
        };
        #[cfg(unix)]
        let mut command = CommandBuilder::new("/bin/sh");
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn the production local shell");
        drop(pair.slave);

        let (output_tx, output_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut output = String::new();
            let result = reader
                .read_to_string(&mut output)
                .map(|_| output)
                .map_err(|error| error.to_string());
            let _ = output_tx.send(result);
        });
        #[cfg(target_os = "windows")]
        let input = format!("{wrapper}\rexit\r");
        #[cfg(unix)]
        let input = format!("{wrapper}\nexit\n");
        writer
            .write_all(input.as_bytes())
            .expect("write the authenticated command wrapper");
        writer.flush().expect("flush the authenticated wrapper");

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match child.try_wait().expect("poll the local shell") {
                Some(_) => break,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                None => {
                    child.kill().expect("terminate the timed-out local shell");
                    panic!("the local shell did not exit before the PTY deadline");
                }
            }
        }
        drop(writer);
        drop(pair.master);
        output_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("receive local terminal output before the deadline")
            .expect("read local terminal output")
    }

    #[cfg(any(unix, target_os = "windows"))]
    fn assert_real_protocol_stream(
        raw: &str,
        marker: &str,
        shell_kind: PtyShellKindNative,
        expected_output: &str,
    ) {
        let single_chunk = PtyOperationNative::new(marker.into(), Some(shell_kind), String::new());
        single_chunk.observe(raw);
        assert_eq!(
            single_chunk.snapshot().unwrap().state,
            PtyLifecycleNative::Exited,
            "single chunk raw={raw:?}"
        );
        let operation = PtyOperationNative::new(
            marker.into(),
            Some(shell_kind),
            "\r\u{1b}[2K[Agent] $ safe fixture command\r\n".into(),
        );
        let mut display = String::new();
        let characters = raw.chars().collect::<Vec<_>>();
        for chunk in characters.chunks(17) {
            display.push_str(&operation.observe(&chunk.iter().collect::<String>()));
        }
        let snapshot = operation.snapshot().unwrap();
        assert_eq!(
            snapshot.state,
            PtyLifecycleNative::Exited,
            "snapshot={snapshot:?} raw={raw:?}"
        );
        assert_eq!(snapshot.exit_code, Some(7), "raw={raw:?}");
        assert!(snapshot.combined_output.contains(expected_output));
        assert!(display.contains(expected_output));
        assert!(display.contains("[Agent] $ safe fixture command"));
        assert!(!display.contains(marker));
        assert!(!display.contains("__ss_"));
        assert!(!snapshot.combined_output.contains(marker));
        assert!(!snapshot.combined_output.contains("__ss_"));
    }

    #[test]
    fn parser_ignores_forged_end_and_accepts_split_committed_completion() {
        let operation = PtyOperationNative::new(
            "marker-1".into(),
            Some(PtyShellKindNative::Posix),
            "\r\u{1b}[2K[Agent] $ test\r\n".into(),
        );
        let capability = "a".repeat(64);
        let commitment = commitment(&capability);
        operation.observe("echo wrapper marker-1:BEGIN marker-1:END:forged:9");
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Running
        );
        operation.observe(&format!("\u{1e}marker-1:BEGIN:{commitment}\u{1f}hello"));
        operation.observe(&format!(
            " world\u{1e}marker-1:END:{}:0\u{1f}",
            "b".repeat(64)
        ));
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Running
        );
        operation.observe(&format!("\u{1e}marker-1:END:{capability}:7"));
        operation.observe("\u{1f}prompt");
        let snapshot = operation.snapshot().unwrap();
        assert_eq!(snapshot.state, PtyLifecycleNative::Exited);
        assert_eq!(snapshot.exit_code, Some(7));
        assert!(snapshot.combined_output.starts_with("hello world"));
    }

    #[cfg(any(unix, target_os = "windows"))]
    #[test]
    fn wait_returns_after_observed_completion_without_self_deadlocking() {
        let marker = "marker-wait";
        let capability = "d".repeat(64);
        let operation = PtyOperationNative::new(
            marker.into(),
            Some(PtyShellKindNative::Posix),
            "\r\u{1b}[2K[Agent] $ test\r\n".into(),
        );
        let waiter_operation = Arc::clone(&operation);
        let (result_tx, result_rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            let _ = result_tx.send(waiter_operation.wait(Duration::from_secs(5)));
        });

        operation.observe(&protocol(marker, &capability, "done\r\n", 0, "$ "));
        let snapshot = result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("completed PTY wait must release its condvar mutex")
            .expect("completed PTY wait must return a snapshot");
        assert_eq!(snapshot.state, PtyLifecycleNative::Exited);
        assert_eq!(snapshot.exit_code, Some(0));
        waiter.join().expect("join PTY waiter");
    }

    #[test]
    fn parser_chunk_matrix_hides_wrapper_and_markers_and_preserves_prompt() {
        let marker = "marker-matrix";
        let capability = "c".repeat(64);
        let raw = protocol(
            marker,
            &capability,
            "first\r\nsecond\r\n",
            23,
            "\u{1b}[32m$ \u{1b}[0m",
        );
        for chunk_size in 1..=raw.len() {
            let operation = PtyOperationNative::new(
                marker.into(),
                Some(PtyShellKindNative::Posix),
                "\r\u{1b}[2K[Agent] $ printf safe\r\n".into(),
            );
            let mut display = String::new();
            let mut offset = 0;
            while offset < raw.len() {
                let end = (offset + chunk_size).min(raw.len());
                display.push_str(&operation.observe(&raw[offset..end]));
                offset = end;
            }
            let snapshot = operation.snapshot().unwrap();
            assert_eq!(
                snapshot.state,
                PtyLifecycleNative::Exited,
                "chunk={chunk_size}"
            );
            assert_eq!(snapshot.exit_code, Some(23), "chunk={chunk_size}");
            assert_eq!(
                snapshot.combined_output, "first\r\nsecond\r\n",
                "chunk={chunk_size}"
            );
            assert_eq!(
                display,
                "\r\u{1b}[2K[Agent] $ printf safe\r\nfirst\r\nsecond\r\n\u{1b}[32m$ \u{1b}[0m",
                "chunk={chunk_size}"
            );
            assert!(!display.contains(marker), "chunk={chunk_size}");
            assert!(!display.contains("wrapper echo"), "chunk={chunk_size}");
        }
    }

    #[test]
    fn powershell_parser_hides_conpty_wrapped_protocol_for_every_chunk_boundary() {
        fn wrapped_record(record: &str) -> String {
            let mut wrapped = String::new();
            let mut previous = None;
            for segment in record.as_bytes().chunks(31) {
                if let Some(boundary) = previous {
                    wrapped.push_str("\r\n\u{1b}[23;40H");
                    wrapped.push(boundary as char);
                }
                wrapped.push_str(std::str::from_utf8(segment).unwrap());
                previous = segment.last().copied();
            }
            wrapped.push_str("        \r\n");
            wrapped
        }

        let marker =
            "shellspan_native_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let capability = "a".repeat(64);
        let raw = format!(
            "wrapper echo\r\n{}visible\r\n{}PS C:\\> ",
            wrapped_record(&format!("{marker}:BEGIN:{}", commitment(&capability))),
            wrapped_record(&format!("{marker}:END:{capability}:7")),
        );
        for chunk_size in 1..=raw.len() {
            let operation = PtyOperationNative::new(
                marker.into(),
                Some(PtyShellKindNative::PowerShell),
                "\r\u{1b}[2K[Agent] $ fixture\r\n".into(),
            );
            let mut display = String::new();
            let mut offset = 0;
            while offset < raw.len() {
                let end = floor_char_boundary(&raw, (offset + chunk_size).min(raw.len()));
                display.push_str(&operation.observe(&raw[offset..end]));
                offset = end;
            }
            let snapshot = operation.snapshot().unwrap();
            assert_eq!(
                snapshot.state,
                PtyLifecycleNative::Exited,
                "chunk={chunk_size}"
            );
            assert_eq!(snapshot.exit_code, Some(7), "chunk={chunk_size}");
            assert_eq!(
                snapshot.combined_output, "visible\r\n",
                "chunk={chunk_size}"
            );
            assert_eq!(
                display, "\r\u{1b}[2K[Agent] $ fixture\r\nvisible\r\nPS C:\\> ",
                "chunk={chunk_size}"
            );
            assert!(!display.contains(marker), "chunk={chunk_size}");
            assert!(!display.contains("wrapper echo"), "chunk={chunk_size}");
        }
    }

    #[test]
    fn forged_protocol_record_is_dropped_without_completing() {
        let marker = "marker-forged";
        let capability = "d".repeat(64);
        let operation = PtyOperationNative::new(
            marker.into(),
            Some(PtyShellKindNative::Posix),
            "\r\u{1b}[2K[Agent] $ test\r\n".into(),
        );
        let begin = format!("\u{1e}{marker}:BEGIN:{}\u{1f}", commitment(&capability));
        let forged = format!("before\u{1e}{marker}:END:{}:0\u{1f}after", "e".repeat(64));
        let mut display = operation.observe(&begin);
        display.push_str(&operation.observe(&forged));
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Running
        );
        assert_eq!(display, "\r\u{1b}[2K[Agent] $ test\r\nbeforeafter");
        assert!(!display.contains(marker));
        display.push_str(
            &operation.observe(&format!("\u{1e}{marker}:END:{capability}:4\u{1f}prompt")),
        );
        assert!(display.ends_with("prompt"));
        assert_eq!(operation.snapshot().unwrap().exit_code, Some(4));
    }

    #[test]
    fn capture_truncation_does_not_stop_display_and_protocol_limit_fails_closed() {
        let marker = "marker-large";
        let capability = "f".repeat(64);
        let operation = PtyOperationNative::new(
            marker.into(),
            Some(PtyShellKindNative::Posix),
            "\r\u{1b}[2K[Agent] $ large\r\n".into(),
        );
        operation.observe(&format!(
            "\u{1e}{marker}:BEGIN:{}\u{1f}",
            commitment(&capability)
        ));
        let block = "x".repeat(64 * 1024);
        let mut displayed = 0;
        for _ in 0..20 {
            displayed += operation.observe(&block).len();
        }
        operation.observe(&format!("\u{1e}{marker}:END:{capability}:0\u{1f}"));
        let snapshot = operation.snapshot().unwrap();
        assert!(snapshot.truncated);
        assert_eq!(snapshot.combined_output.len(), PTY_CAPTURE_LIMIT_BYTES);
        assert!(displayed > PTY_CAPTURE_LIMIT_BYTES);

        let broken = PtyOperationNative::new(
            "marker-broken".into(),
            Some(PtyShellKindNative::Posix),
            String::new(),
        );
        broken.observe(&format!(
            "\u{1e}marker-broken:BEGIN:{}",
            "a".repeat(PTY_PROTOCOL_BUFFER_LIMIT_BYTES)
        ));
        assert_eq!(broken.snapshot().unwrap().state, PtyLifecycleNative::Failed);
    }

    #[test]
    fn shell_probe_recognizes_remote_posix_and_powershell_but_rejects_unknown() {
        assert_eq!(
            classify_shell_probe("-bash"),
            Some(PtyShellKindNative::Posix)
        );
        assert_eq!(
            classify_shell_probe("/bin/zsh"),
            Some(PtyShellKindNative::Posix)
        );
        assert_eq!(
            classify_shell_probe(""),
            Some(PtyShellKindNative::PowerShell)
        );
        assert_eq!(classify_shell_probe("$0"), None);
        assert_eq!(classify_shell_probe("fish"), None);
    }

    #[test]
    fn remote_probe_selects_posix_wrapper_and_unknown_shell_never_gets_one() {
        for (reported_shell, expect_wrapper) in [("-bash", true), ("$0", false)] {
            let leases = ready_leases();
            let registry = PtyRegistryNative::new(leases.clone());
            let (sessions, receiver) = sessions("terminal-1");
            let worker_registry = registry.clone();
            let worker_sessions = sessions.clone();
            let worker = std::thread::spawn(move || {
                worker_registry.start(
                    &worker_sessions,
                    "terminal-1",
                    "agent-1",
                    "task-1",
                    "operation-1",
                    "printf done",
                    None,
                )
            });
            let probe = match receiver.recv_timeout(Duration::from_secs(1)).unwrap() {
                SessionCommand::Write(value) => value,
                _ => panic!("expected shell probe"),
            };
            let prefix = probe
                .strip_prefix("echo ")
                .and_then(|value| value.strip_suffix("$0\r"))
                .unwrap();
            registry.observe("terminal-1", &format!("{prefix}{reported_shell}\r\n"));
            let started = worker.join().unwrap();
            if expect_wrapper {
                assert!(started.is_ok());
                let wrapper = match receiver.recv_timeout(Duration::from_secs(1)).unwrap() {
                    SessionCommand::Write(value) => value,
                    _ => panic!("expected POSIX wrapper"),
                };
                assert!(wrapper.contains("/bin/sh -c"));
                registry
                    .terminal_closed("terminal-1")
                    .expect("cleanup probed operation");
            } else {
                assert!(started.err().unwrap().starts_with("PTY_SHELL_UNSUPPORTED:"));
                assert!(receiver.try_recv().is_err());
                assert!(leases.lease("terminal-1").is_none());
            }
        }
    }

    #[test]
    fn command_display_is_redacted_before_the_acquired_event() {
        let leases = TerminalLeaseManager::default();
        let command_display = Arc::new(Mutex::new(None));
        let captured = command_display.clone();
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    *captured.lock().unwrap() = event.command_display.clone();
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let registry = PtyRegistryNative::new(leases);
        let (sessions, _receiver) = sessions("terminal-1");
        let operation = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "curl --token extremely-sensitive-value",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();
        assert_eq!(
            operation.command_display,
            "\r\u{1b}[2K[Agent] $ [REDACTED]\r\n"
        );
        let display = command_display.lock().unwrap().clone().unwrap();
        assert_eq!(display, "[Agent] $ [REDACTED]");
        assert!(!display.contains("extremely-sensitive-value"));
        registry.terminal_closed("terminal-1").unwrap();
    }

    #[test]
    fn ansi_is_removed_from_model_text_before_rust_redaction() {
        let raw = "\u{1b}[31mpassword=very-secret\u{1b}[0m";
        assert_eq!(
            crate::redaction::redact_sensitive_text(&strip_ansi(raw)),
            crate::redaction::REDACTED_VALUE
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_powershell_wrapper_emits_authenticated_boundary_and_exit_code() {
        let marker = "marker-powershell-baseline";
        let wrapper = build_powershell_wrapper("Write-Output 'visible-output'; exit 7", marker);
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-Command", &wrapper])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("visible-output"));
        assert!(stdout.contains(&format!("{marker}:BEGIN:")));
        assert!(stdout.contains(&format!(":END:")));
        assert!(stdout.contains(":7"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_conpty_visible_command_protocol_is_end_to_end() {
        let marker =
            "shellspan_native_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let wrapper =
            build_powershell_wrapper("Write-Output 'visible-conpty-output'; exit 7", marker);
        for cols in [40, 80, 120, 240] {
            let raw = run_local_shell_protocol(&wrapper, cols);
            assert_real_protocol_stream(
                &raw,
                marker,
                PtyShellKindNative::PowerShell,
                "visible-conpty-output",
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn posix_wrapper_emits_authenticated_boundary_and_exit_code() {
        let marker = "marker-posix-baseline";
        let wrapper = build_posix_wrapper("printf visible-output; exit 7", marker);
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &wrapper])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("visible-output"));
        assert!(stdout.contains(&format!("\u{1e}{marker}:BEGIN:")));
        assert!(stdout.contains(":END:"));
        assert!(stdout.contains(":7\u{1f}"));
    }

    #[cfg(unix)]
    #[test]
    fn local_posix_pty_visible_command_protocol_is_end_to_end() {
        let marker = "marker-local-posix-e2e";
        let wrapper = build_posix_wrapper("printf visible-posix-output; exit 7", marker);
        let raw = run_local_shell_protocol(&wrapper, 240);
        assert_real_protocol_stream(
            &raw,
            marker,
            PtyShellKindNative::Posix,
            "visible-posix-output",
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_ssh_posix_visible_command_protocol_is_end_to_end() {
        use ssh2::{ExtendedData, Session};
        use std::net::TcpStream;

        let host = std::env::var("SHELLSPAN_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("SHELLSPAN_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username =
            std::env::var("SHELLSPAN_E2E_SSH_USERNAME").unwrap_or_else(|_| "shellspan".into());
        let password =
            std::env::var("SHELLSPAN_E2E_SSH_PASSWORD").unwrap_or_else(|_| "shellspan-e2e".into());
        let tcp = TcpStream::connect((host.as_str(), port)).expect("connect to SSH fixture");
        tcp.set_read_timeout(Some(Duration::from_secs(15)))
            .expect("bound fixture read timeout");
        tcp.set_write_timeout(Some(Duration::from_secs(15)))
            .expect("bound fixture write timeout");
        let mut session = Session::new().expect("create SSH fixture session");
        session.set_tcp_stream(tcp);
        session.handshake().expect("handshake with SSH fixture");
        session
            .userauth_password(&username, &password)
            .expect("authenticate to SSH fixture");
        assert!(session.authenticated());
        let mut channel = session
            .channel_session()
            .expect("open SSH terminal channel");
        channel
            .request_pty("xterm-256color", None, Some((240, 24, 0, 0)))
            .expect("request SSH PTY");
        channel
            .handle_extended_data(ExtendedData::Merge)
            .expect("merge SSH terminal output");
        channel.shell().expect("start SSH POSIX shell");

        let marker = "marker-remote-ssh-posix-e2e";
        let wrapper = build_posix_wrapper("printf visible-ssh-output; exit 7", marker);
        channel
            .write_all(format!("{wrapper}\nexit\n").as_bytes())
            .expect("write SSH wrapper");
        channel.flush().expect("flush SSH wrapper");
        let mut raw = String::new();
        channel
            .read_to_string(&mut raw)
            .expect("read SSH protocol stream");
        channel.wait_close().expect("close SSH fixture channel");

        assert_real_protocol_stream(
            &raw,
            marker,
            PtyShellKindNative::Posix,
            "visible-ssh-output",
        );
    }

    #[test]
    fn registration_failure_rolls_back_the_new_lease() {
        let leases = ready_leases();
        let registry = PtyRegistryNative::new(leases.clone());
        let (sessions, _receiver) = sessions("terminal-1");
        registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "echo first",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();
        leases
            .release_terminal("terminal-1", TerminalLeaseReleaseReason::Failed)
            .unwrap();

        let error = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-2",
                "task-2",
                "operation-2",
                "echo second",
                Some(PtyShellKindNative::Posix),
            )
            .err()
            .expect("second registration must fail");
        assert!(error.starts_with("TERMINAL_LEASE_BUSY:"));
        assert!(leases.lease("terminal-1").is_none());
    }

    #[test]
    fn a_second_visible_agent_is_busy_without_writing_or_replacing_the_owner() {
        let leases = ready_leases();
        let registry = PtyRegistryNative::new(leases.clone());
        let (sessions, receiver) = sessions("terminal-1");
        registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "sleep 10",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();
        let first_write_count = receiver.try_iter().count();
        let error = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-2",
                "task-2",
                "operation-2",
                "echo must-not-run",
                Some(PtyShellKindNative::Posix),
            )
            .err()
            .expect("a second Agent must be rejected immediately");
        assert!(error.starts_with("TERMINAL_LEASE_BUSY:"));
        assert_eq!(receiver.try_iter().count(), 0);
        assert_eq!(first_write_count, 1);
        assert_eq!(
            leases.lease("terminal-1").unwrap().operation_id,
            "operation-1"
        );
        registry.terminal_closed("terminal-1").unwrap();
    }

    #[test]
    fn frontend_rejection_or_timeout_never_writes_a_wrapper_and_cleans_the_lease() {
        for rejection in ["pendingInput", "credentialPrompt", "timeout"] {
            let leases = TerminalLeaseManager::default();
            if rejection != "timeout" {
                let acknowledger = leases.clone();
                let rejection = rejection.to_string();
                leases
                    .set_publisher(Arc::new(move |event| {
                        if event.state == super::super::TerminalLeaseEventState::Acquired {
                            acknowledger
                                .acknowledge_frontend_ready(
                                    &event.session_id,
                                    &event.agent_session_id,
                                    &event.operation_id,
                                    true,
                                    true,
                                    rejection == "pendingInput",
                                    false,
                                    rejection == "credentialPrompt",
                                )
                                .unwrap();
                        }
                    }))
                    .unwrap();
            }
            let registry = PtyRegistryNative::new(leases.clone());
            let (sessions, receiver) = sessions("terminal-1");
            assert!(registry
                .start(
                    &sessions,
                    "terminal-1",
                    "agent-1",
                    "task-1",
                    "operation-1",
                    "echo must-not-run",
                    Some(PtyShellKindNative::Posix),
                )
                .is_err());
            assert!(leases.lease("terminal-1").is_none(), "{rejection}");
            assert!(
                receiver
                    .try_iter()
                    .all(|command| !matches!(command, SessionCommand::Write(_))),
                "{rejection}"
            );
        }
    }

    #[test]
    fn takeover_wins_once_sends_control_c_and_releases() {
        let leases = ready_leases();
        let registry = PtyRegistryNative::new(leases.clone());
        let (sessions, receiver) = sessions("terminal-1");
        let operation = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "sleep 10",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();

        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-2", "operation-1")
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_OWNER_MISMATCH:"));
        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-1", "operation-2")
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_OPERATION_MISMATCH:"));

        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-1", "operation-1")
            .unwrap());
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::TakenOver
        );
        assert!(leases.lease("terminal-1").is_none());
        assert!(receiver
            .try_iter()
            .any(|command| matches!(command, SessionCommand::Write(data) if data == "\u{3}")));
        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-1", "operation-1")
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_NOT_FOUND:"));
    }

    #[test]
    fn completed_terminal_state_beats_late_takeover() {
        let leases = ready_leases();
        let registry = PtyRegistryNative::new(leases.clone());
        let (sessions, _receiver) = sessions("terminal-1");
        let operation = registry
            .start(
                &sessions,
                "terminal-1",
                "agent-1",
                "task-1",
                "operation-1",
                "true",
                Some(PtyShellKindNative::Posix),
            )
            .unwrap();
        assert!(operation.finish(PtyLifecycleNative::Exited, ""));
        assert!(registry
            .takeover(&sessions, "terminal-1", "agent-1", "operation-1")
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_ALREADY_TERMINAL:"));
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Exited
        );
        assert!(registry.terminal_closed("terminal-1").unwrap());
        assert_eq!(
            operation.snapshot().unwrap().state,
            PtyLifecycleNative::Exited
        );
        assert!(leases.lease("terminal-1").is_none());
    }

    #[test]
    fn cancel_disconnect_timeout_and_shutdown_are_idempotent_cleanup_paths() {
        let cases = ["cancel", "closed", "timeout", "shutdown"];
        for case in cases {
            let leases = ready_leases();
            let registry = PtyRegistryNative::new(leases.clone());
            let (sessions, _receiver) = sessions("terminal-1");
            let operation = registry
                .start(
                    &sessions,
                    "terminal-1",
                    "agent-1",
                    "task-1",
                    "operation-1",
                    "sleep 10",
                    Some(PtyShellKindNative::Posix),
                )
                .unwrap();
            match case {
                "cancel" => assert_eq!(registry.cancel_task(&sessions, "task-1").unwrap(), 1),
                "closed" => assert!(registry.terminal_closed("terminal-1").unwrap()),
                "timeout" => {
                    let snapshot = operation.wait(Duration::ZERO).unwrap();
                    assert_eq!(snapshot.state, PtyLifecycleNative::TimedOut);
                    registry
                        .interrupt_timed_out(&sessions, "terminal-1", "operation-1")
                        .unwrap();
                }
                "shutdown" => assert_eq!(registry.shutdown_all(&sessions).unwrap(), 1),
                _ => unreachable!(),
            }
            assert!(leases.lease("terminal-1").is_none(), "case={case}");
            assert!(!registry.terminal_closed("terminal-1").unwrap());
        }
    }
}
