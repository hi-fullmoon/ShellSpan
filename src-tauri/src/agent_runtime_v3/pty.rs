use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use base64::Engine;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::models::SessionManager;

const RECORD_SEPARATOR: char = '\u{001e}';
const UNIT_SEPARATOR: char = '\u{001f}';
const PTY_CAPTURE_LIMIT_BYTES: usize = 1024 * 1024;
const PTY_PROTOCOL_BUFFER_LIMIT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PtyLifecycleV3 {
    Running,
    Exited,
    Cancelled,
    TimedOut,
    Failed,
}

impl PtyLifecycleV3 {
    fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PtySnapshotV3 {
    pub(crate) state: PtyLifecycleV3,
    pub(crate) exit_code: Option<i32>,
    pub(crate) combined_output: String,
    pub(crate) bytes_read: u64,
    pub(crate) truncated: bool,
    pub(crate) error: Option<String>,
}

#[derive(Debug)]
struct PtyStateV3 {
    lifecycle: PtyLifecycleV3,
    exit_code: Option<i32>,
    protocol_buffer: String,
    capture: String,
    bytes_read: u64,
    truncated: bool,
    began: bool,
    completion_commitment: Option<String>,
    error: Option<String>,
}

pub(crate) struct PtyOperationV3 {
    begin_prefix: String,
    end_prefix: String,
    state: Mutex<PtyStateV3>,
    changed: Condvar,
}

impl PtyOperationV3 {
    fn new(marker: String) -> Arc<Self> {
        Arc::new(Self {
            begin_prefix: format!("{RECORD_SEPARATOR}{marker}:BEGIN:"),
            end_prefix: format!("{RECORD_SEPARATOR}{marker}:END:"),
            state: Mutex::new(PtyStateV3 {
                lifecycle: PtyLifecycleV3::Running,
                exit_code: None,
                protocol_buffer: String::new(),
                capture: String::new(),
                bytes_read: 0,
                truncated: false,
                began: false,
                completion_commitment: None,
                error: None,
            }),
            changed: Condvar::new(),
        })
    }

    fn observe(&self, chunk: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.lifecycle.is_terminal() {
            return;
        }
        state.protocol_buffer.push_str(chunk);
        if state.protocol_buffer.len() > PTY_PROTOCOL_BUFFER_LIMIT_BYTES {
            state.lifecycle = PtyLifecycleV3::Failed;
            state.error = Some("PTY protocol output exceeded its hard boundary".into());
            self.changed.notify_all();
            return;
        }
        if !state.began && !self.consume_begin(&mut state) {
            return;
        }
        if self.consume_authenticated_end(&mut state) {
            self.changed.notify_all();
            return;
        }

        let keep = self.end_prefix.len() + 160;
        if state.protocol_buffer.len() > keep {
            let split =
                floor_char_boundary(&state.protocol_buffer, state.protocol_buffer.len() - keep);
            let output = state.protocol_buffer[..split].to_string();
            state.protocol_buffer.drain(..split);
            append_capture(&mut state, &output);
        }
        self.changed.notify_all();
    }

    fn consume_begin(&self, state: &mut PtyStateV3) -> bool {
        let Some(index) = state.protocol_buffer.find(&self.begin_prefix) else {
            let keep = self.begin_prefix.len().saturating_sub(1);
            if state.protocol_buffer.len() > keep {
                let start = floor_char_boundary(
                    &state.protocol_buffer,
                    state.protocol_buffer.len().saturating_sub(keep),
                );
                state.protocol_buffer.drain(..start);
            }
            return false;
        };
        let commitment_start = index + self.begin_prefix.len();
        let Some(relative_end) = state.protocol_buffer[commitment_start..].find(UNIT_SEPARATOR)
        else {
            return false;
        };
        let commitment_end = commitment_start + relative_end;
        let commitment = state.protocol_buffer[commitment_start..commitment_end].to_string();
        let through = commitment_end + UNIT_SEPARATOR.len_utf8();
        state.protocol_buffer.drain(..through);
        if commitment.len() != 64 || !commitment.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return false;
        }
        state.began = true;
        state.completion_commitment = Some(commitment.to_ascii_lowercase());
        true
    }

    fn consume_authenticated_end(&self, state: &mut PtyStateV3) -> bool {
        loop {
            let Some(index) = state.protocol_buffer.find(&self.end_prefix) else {
                return false;
            };
            let record_start = index + self.end_prefix.len();
            let Some(relative_end) = state.protocol_buffer[record_start..].find(UNIT_SEPARATOR)
            else {
                return false;
            };
            let record_end = record_start + relative_end;
            let record = state.protocol_buffer[record_start..record_end].to_string();
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
            if let Some(code) = authenticated {
                let output = state.protocol_buffer[..index].to_string();
                append_capture(state, &output);
                state.protocol_buffer.clear();
                state.exit_code = Some(code);
                state.lifecycle = PtyLifecycleV3::Exited;
                return true;
            }
            let through = record_end + UNIT_SEPARATOR.len_utf8();
            let unauthenticated = state.protocol_buffer[..through].to_string();
            state.protocol_buffer.drain(..through);
            append_capture(state, &unauthenticated);
        }
    }

    pub(crate) fn wait(&self, timeout: Duration) -> Result<PtySnapshotV3, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "PTY operation state is unavailable".to_string())?;
        let (state, timed) = self
            .changed
            .wait_timeout_while(state, timeout, |state| !state.lifecycle.is_terminal())
            .map_err(|_| "PTY operation state is unavailable".to_string())?;
        if timed.timed_out() && !state.lifecycle.is_terminal() {
            drop(state);
            self.finish(PtyLifecycleV3::TimedOut, "PTY command timed out");
        }
        self.snapshot()
    }

    pub(crate) fn finish(&self, lifecycle: PtyLifecycleV3, error: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.lifecycle.is_terminal() {
            return;
        }
        state.lifecycle = lifecycle;
        if !error.is_empty() {
            state.error = Some(error.to_string());
        }
        self.changed.notify_all();
    }

    pub(crate) fn snapshot(&self) -> Result<PtySnapshotV3, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "PTY operation state is unavailable".to_string())?;
        let mut combined_output = state.capture.clone();
        if state.began {
            combined_output.push_str(&state.protocol_buffer);
        }
        Ok(PtySnapshotV3 {
            state: state.lifecycle,
            exit_code: state.exit_code,
            combined_output,
            bytes_read: state.bytes_read,
            truncated: state.truncated,
            error: state.error.clone(),
        })
    }
}

fn append_capture(state: &mut PtyStateV3, value: &str) {
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

#[derive(Clone, Default)]
pub(crate) struct PtyRegistryV3 {
    operations: Arc<Mutex<HashMap<String, Arc<PtyOperationV3>>>>,
}

impl PtyRegistryV3 {
    pub(crate) fn start(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        command: &str,
        powershell: bool,
    ) -> Result<Arc<PtyOperationV3>, String> {
        let marker = format!(
            "shellspan_v3_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let operation = PtyOperationV3::new(marker.clone());
        {
            let mut operations = self
                .operations
                .lock()
                .map_err(|_| "PTY registry is unavailable".to_string())?;
            if operations.contains_key(session_id) {
                return Err("another native Agent command is active in this PTY".into());
            }
            operations.insert(session_id.to_string(), Arc::clone(&operation));
        }
        let wrapper = if powershell {
            build_powershell_wrapper(command, &marker)
        } else {
            build_posix_wrapper(command, &marker)
        };
        let terminator = if powershell { "\r" } else { "\n" };
        if let Err(error) =
            sessions.write_user_session(session_id, format!("{wrapper}{terminator}"))
        {
            let _ = self.remove(session_id);
            return Err(error);
        }
        Ok(operation)
    }

    pub(crate) fn observe(&self, session_id: &str, chunk: &str) {
        let operation = self
            .operations
            .lock()
            .ok()
            .and_then(|operations| operations.get(session_id).cloned());
        if let Some(operation) = operation {
            operation.observe(chunk);
        }
    }

    pub(crate) fn interrupt(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        lifecycle: PtyLifecycleV3,
    ) {
        let operation = self
            .operations
            .lock()
            .ok()
            .and_then(|operations| operations.get(session_id).cloned());
        if let Some(operation) = operation {
            let _ = sessions.write_user_session(session_id, "\u{3}".to_string());
            operation.finish(lifecycle, "PTY command was interrupted");
        }
    }

    pub(crate) fn remove(&self, session_id: &str) -> Result<(), String> {
        self.operations
            .lock()
            .map_err(|_| "PTY registry is unavailable".to_string())?
            .remove(session_id);
        Ok(())
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
        "__ss_m={}{}; __ss_k=$(/usr/bin/od -An -N32 -tx1 /dev/urandom 2>/dev/null | /usr/bin/tr -d '[:space:]'); if /bin/test -x /usr/bin/sha256sum; then __ss_h=$(/usr/bin/printf '%s' \"$__ss_k\" | /usr/bin/sha256sum); elif /bin/test -x /usr/bin/shasum; then __ss_h=$(/usr/bin/printf '%s' \"$__ss_k\" | /usr/bin/shasum -a 256); else __ss_h=; fi; __ss_h=${{__ss_h%% *}}; /usr/bin/printf '\\036%s:BEGIN:%s\\037' \"$__ss_m\" \"$__ss_h\"; /bin/sh -c {}; __ss_e=$?; /usr/bin/printf '\\036%s:END:%s:%d\\037' \"$__ss_m\" \"$__ss_k\" \"$__ss_e\"; unset __ss_m __ss_k __ss_h __ss_e",
        quote_posix(marker_a),
        quote_posix(marker_b),
        quote_posix(command)
    )
}

fn build_powershell_wrapper(command: &str, marker: &str) -> String {
    let (marker_a, marker_b) = split_secret(marker);
    let encoded = encode_powershell_command(command);
    format!(
        "$__ss_m={}+{}; $__ss_b=[byte[]]::new(32); $__ss_r=[System.Security.Cryptography.RandomNumberGenerator]::Create(); $__ss_r.GetBytes($__ss_b); $__ss_r.Dispose(); $__ss_k=[System.BitConverter]::ToString($__ss_b).Replace('-','').ToLowerInvariant(); $__ss_s=[System.Security.Cryptography.SHA256]::Create(); $__ss_h=[System.BitConverter]::ToString($__ss_s.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($__ss_k))).Replace('-','').ToLowerInvariant(); $__ss_s.Dispose(); [Console]::Write((-join ([char]30,$__ss_m,':BEGIN:',$__ss_h,[char]31))); & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}; $__ss_e=$LASTEXITCODE; [Console]::Write((-join ([char]30,$__ss_m,':END:',$__ss_k,':',$__ss_e,[char]31))); Remove-Variable __ss_m,__ss_b,__ss_r,__ss_k,__ss_s,__ss_h,__ss_e -ErrorAction SilentlyContinue",
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

    #[test]
    fn parser_ignores_forged_end_and_accepts_split_committed_completion() {
        let operation = PtyOperationV3::new("marker-1".into());
        let capability = "a".repeat(64);
        let commitment = Sha256::digest(capability.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        operation.observe("echo wrapper marker-1:BEGIN marker-1:END:forged:9");
        assert_eq!(operation.snapshot().unwrap().state, PtyLifecycleV3::Running);
        operation.observe(&format!("\u{1e}marker-1:BEGIN:{commitment}\u{1f}hello"));
        operation.observe(&format!(
            " world\u{1e}marker-1:END:{}:0\u{1f}",
            "b".repeat(64)
        ));
        assert_eq!(operation.snapshot().unwrap().state, PtyLifecycleV3::Running);
        operation.observe(&format!("\u{1e}marker-1:END:{capability}:7"));
        operation.observe("\u{1f}prompt");
        let snapshot = operation.snapshot().unwrap();
        assert_eq!(snapshot.state, PtyLifecycleV3::Exited);
        assert_eq!(snapshot.exit_code, Some(7));
        assert!(snapshot.combined_output.starts_with("hello world"));
    }
}
