use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::strip_ansi;

pub(crate) const AGENT_TOOL_PROGRESS_EVENT: &str = "agent-tool-progress";
pub(crate) const TOOL_PROGRESS_THROTTLE_INTERVAL: Duration = Duration::from_millis(200);
pub(crate) const TOOL_PROGRESS_MAX_LINES: usize = 40;
pub(crate) const TOOL_PROGRESS_MAX_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentToolProgressEvent {
    pub(crate) session_id: String,
    pub(crate) call_id: String,
    pub(crate) revision: u64,
    pub(crate) tail: String,
    pub(crate) total_bytes: u64,
    pub(crate) truncated: bool,
    pub(crate) alternate_screen: bool,
}

pub(crate) type ToolProgressPublisher = Arc<dyn Fn(AgentToolProgressEvent) + Send + Sync>;

#[derive(Clone, Default)]
pub(crate) struct ToolProgressHub {
    publisher: Arc<Mutex<Option<ToolProgressPublisher>>>,
}

impl ToolProgressHub {
    pub(crate) fn set_publisher(&self, publisher: ToolProgressPublisher) -> Result<(), String> {
        let mut slot = self
            .publisher
            .lock()
            .map_err(|_| "Tool progress publisher is unavailable".to_string())?;
        *slot = Some(publisher);
        Ok(())
    }

    pub(crate) fn begin(&self, session_id: String, call_id: String) -> ToolProgressSession {
        let publisher = self
            .publisher
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(Arc::clone));
        ToolProgressSession::new(
            session_id,
            call_id,
            publisher,
            TOOL_PROGRESS_THROTTLE_INTERVAL,
        )
    }
}

#[derive(PartialEq, Eq)]
struct LastProgressSnapshot {
    tail: String,
    total_bytes: u64,
    truncated: bool,
    alternate_screen: bool,
}

pub(crate) struct ToolProgressSession {
    session_id: String,
    call_id: String,
    publisher: Option<ToolProgressPublisher>,
    throttle_interval: Duration,
    last_emitted_at: Option<Instant>,
    last_snapshot: Option<LastProgressSnapshot>,
    revision: u64,
    closed: bool,
}

impl ToolProgressSession {
    pub(crate) fn new(
        session_id: String,
        call_id: String,
        publisher: Option<ToolProgressPublisher>,
        throttle_interval: Duration,
    ) -> Self {
        Self {
            session_id,
            call_id,
            publisher,
            throttle_interval,
            last_emitted_at: None,
            last_snapshot: None,
            revision: 0,
            closed: false,
        }
    }

    pub(crate) fn has_publisher(&self) -> bool {
        !self.closed && self.publisher.is_some()
    }

    pub(crate) fn finish(&mut self) {
        self.closed = true;
    }

    pub(crate) fn publish_direct(
        &mut self,
        stdout: &str,
        stderr: &str,
        total_bytes: u64,
        upstream_truncated: bool,
    ) {
        self.publish_direct_at(
            stdout,
            stderr,
            total_bytes,
            upstream_truncated,
            Instant::now(),
        );
    }

    fn publish_direct_at(
        &mut self,
        stdout: &str,
        stderr: &str,
        total_bytes: u64,
        upstream_truncated: bool,
        now: Instant,
    ) {
        if !self.should_attempt_emit(now) {
            return;
        }
        let combined = combine_stdout_stderr(stdout, stderr);
        let alternate_screen = detect_alternate_screen(&combined);
        let (tail, window_truncated) = if alternate_screen {
            (String::new(), false)
        } else {
            let redacted = redact_direct_progress(&combined);
            tail_window(&redacted, TOOL_PROGRESS_MAX_LINES, TOOL_PROGRESS_MAX_BYTES)
        };
        self.emit_if_changed(
            tail,
            total_bytes,
            upstream_truncated || window_truncated,
            alternate_screen,
            now,
        );
    }

    pub(crate) fn publish_terminal(
        &mut self,
        combined_output: &str,
        is_native_protocol: bool,
        upstream_truncated: bool,
    ) {
        self.publish_terminal_at(
            combined_output,
            is_native_protocol,
            upstream_truncated,
            Instant::now(),
        );
    }

    fn publish_terminal_at(
        &mut self,
        combined_output: &str,
        is_native_protocol: bool,
        upstream_truncated: bool,
        now: Instant,
    ) {
        if !self.should_attempt_emit(now) {
            return;
        }
        let alternate_screen = detect_alternate_screen(combined_output);
        let total_bytes = combined_output.len() as u64;
        let (tail, window_truncated) = if alternate_screen {
            (String::new(), false)
        } else {
            let redacted = redact_terminal_progress(combined_output, is_native_protocol);
            tail_window(&redacted, TOOL_PROGRESS_MAX_LINES, TOOL_PROGRESS_MAX_BYTES)
        };
        self.emit_if_changed(
            tail,
            total_bytes,
            upstream_truncated || window_truncated,
            alternate_screen,
            now,
        );
    }

    fn should_attempt_emit(&self, now: Instant) -> bool {
        if self.closed || self.publisher.is_none() {
            return false;
        }
        if let Some(last) = self.last_emitted_at {
            if now.saturating_duration_since(last) < self.throttle_interval {
                return false;
            }
        }
        true
    }

    fn emit_if_changed(
        &mut self,
        tail: String,
        total_bytes: u64,
        truncated: bool,
        alternate_screen: bool,
        now: Instant,
    ) {
        let Some(publisher) = self.publisher.as_ref() else {
            return;
        };
        if tail.is_empty() && !alternate_screen {
            return;
        }
        let next_snapshot = LastProgressSnapshot {
            tail: tail.clone(),
            total_bytes,
            truncated,
            alternate_screen,
        };
        if self.last_snapshot.as_ref() == Some(&next_snapshot) {
            return;
        }
        self.revision = self.revision.saturating_add(1);
        self.last_emitted_at = Some(now);
        self.last_snapshot = Some(next_snapshot);
        publisher(AgentToolProgressEvent {
            session_id: self.session_id.clone(),
            call_id: self.call_id.clone(),
            revision: self.revision,
            tail,
            total_bytes,
            truncated,
            alternate_screen,
        });
    }
}

impl Drop for ToolProgressSession {
    fn drop(&mut self) {
        self.closed = true;
    }
}

fn combine_stdout_stderr(stdout: &str, stderr: &str) -> String {
    if stdout.is_empty() {
        return stderr.to_string();
    }
    if stderr.is_empty() {
        return stdout.to_string();
    }
    let separator = if !stdout.ends_with('\n') && !stderr.starts_with('\n') {
        "\n"
    } else {
        ""
    };
    format!("{stdout}{separator}{stderr}")
}

fn redact_direct_progress(raw: &str) -> String {
    let plain = strip_ansi(raw);
    let redacted_plain = crate::redaction::redact_sensitive_text(&plain);
    if redacted_plain == plain {
        crate::redaction::redact_sensitive_text(raw)
    } else {
        redacted_plain
    }
}

pub(crate) fn redact_terminal_progress(raw: &str, is_native_protocol: bool) -> String {
    let plain = strip_ansi(raw);
    let redacted_plain = crate::redaction::redact_sensitive_text(&plain);
    // Keep the exact same sensitive-output boundary as terminal_tools.rs,
    // including secrets split across ANSI escape sequences.
    if is_native_protocol && redacted_plain == plain {
        crate::redaction::redact_sensitive_text(raw)
    } else {
        redacted_plain
    }
}

pub(crate) fn detect_alternate_screen(raw: &str) -> bool {
    const ENTER_SEQUENCES: [&str; 3] = ["\x1b[?1049h", "\x1b[?1047h", "\x1b[?47h"];
    const EXIT_SEQUENCES: [&str; 3] = ["\x1b[?1049l", "\x1b[?1047l", "\x1b[?47l"];
    let last_enter = ENTER_SEQUENCES
        .iter()
        .filter_map(|seq| raw.rfind(seq))
        .max();
    let Some(enter_pos) = last_enter else {
        return false;
    };
    let last_exit = EXIT_SEQUENCES.iter().filter_map(|seq| raw.rfind(seq)).max();
    last_exit.is_none_or(|exit_pos| enter_pos > exit_pos)
}

pub(crate) fn tail_window(text: &str, max_lines: usize, max_bytes: usize) -> (String, bool) {
    if text.is_empty() || max_lines == 0 || max_bytes == 0 {
        return (String::new(), !text.is_empty());
    }
    let mut start = 0usize;
    let mut truncated = false;

    // Limit by trailing line count first. A trailing newline ends the last line
    // rather than introducing an extra empty line.
    let scan_end = text.strip_suffix('\n').map_or(text.len(), str::len);
    let mut newlines = 0usize;
    for (idx, byte) in text.as_bytes()[..scan_end].iter().enumerate().rev() {
        if *byte == b'\n' {
            newlines += 1;
            if newlines == max_lines {
                start = idx + 1;
                truncated = true;
                break;
            }
        }
    }

    // Then enforce the byte budget at a valid UTF-8 char boundary.
    let mut slice = &text[start..];
    if slice.len() > max_bytes {
        let mut byte_start = slice.len() - max_bytes;
        while byte_start < slice.len() && !slice.is_char_boundary(byte_start) {
            byte_start += 1;
        }
        slice = &slice[byte_start..];
        truncated = true;
    }

    (slice.to_string(), truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collector() -> (
        Arc<Mutex<Vec<AgentToolProgressEvent>>>,
        ToolProgressPublisher,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let publisher: ToolProgressPublisher = Arc::new(move |event| {
            sink.lock().expect("events lock").push(event);
        });
        (events, publisher)
    }

    #[test]
    fn tail_window_keeps_last_lines_and_respects_utf8_byte_boundary() {
        let lines = (1..=60)
            .map(|i| format!("line-{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (tail, truncated) = tail_window(&lines, 40, 8 * 1024);
        assert!(truncated);
        assert_eq!(tail.lines().count(), 40);
        assert!(tail.starts_with("line-21\n"));
        assert!(tail.ends_with("line-60"));

        // Multi-byte Chinese characters must never split mid-codepoint.
        let wide = "测试输出日志内容".repeat(500);
        let (tail, truncated) = tail_window(&wide, 40, 100);
        assert!(truncated);
        assert!(tail.len() <= 100);
        assert!(std::str::from_utf8(tail.as_bytes()).is_ok());
    }

    #[test]
    fn redacts_secrets_consistently_including_ansi_split_tokens() {
        let (events, publisher) = collector();
        let mut session = ToolProgressSession::new(
            "sess-1".into(),
            "call-1".into(),
            Some(publisher),
            Duration::from_millis(200),
        );
        let base = Instant::now();
        let ansi_split_token =
            "Authorization: Bearer \x1b[31msk-live-1234567890abcdef1234567890\x1b[0m\n";
        session.publish_terminal_at(ansi_split_token, true, false, base);

        {
            let recorded = events.lock().expect("events lock");
            assert_eq!(recorded.len(), 1);
            assert!(!recorded[0]
                .tail
                .contains("sk-live-1234567890abcdef1234567890"));
            assert!(recorded[0].tail.contains("[REDACTED]"));
        }

        // Direct path redacts identically.
        session.publish_direct_at(
            "token=ghp_1234567890abcdef1234567890abcdef1234\n",
            "",
            48,
            false,
            base + Duration::from_millis(250),
        );
        let recorded = events.lock().expect("events lock");
        assert_eq!(recorded.len(), 2);
        assert!(!recorded[1]
            .tail
            .contains("ghp_1234567890abcdef1234567890abcdef1234"));
    }

    #[test]
    fn throttles_deduplicates_and_stops_after_finish() {
        let (events, publisher) = collector();
        let mut session = ToolProgressSession::new(
            "sess-1".into(),
            "call-1".into(),
            Some(publisher),
            Duration::from_millis(200),
        );
        let t0 = Instant::now();

        session.publish_direct_at("step 1\n", "", 7, false, t0);
        // Within 200ms window -> throttled
        session.publish_direct_at(
            "step 1\nstep 2\n",
            "",
            14,
            false,
            t0 + Duration::from_millis(100),
        );
        // Past 200ms with same content -> deduplicated
        session.publish_direct_at("step 1\n", "", 7, false, t0 + Duration::from_millis(250));
        // Past 200ms with new content -> emitted with revision 2
        session.publish_direct_at(
            "step 1\nstep 2\n",
            "",
            14,
            false,
            t0 + Duration::from_millis(260),
        );
        // After finish -> never emits again
        session.finish();
        session.publish_direct_at(
            "step 1\nstep 2\nstep 3\n",
            "",
            21,
            false,
            t0 + Duration::from_millis(600),
        );

        let recorded = events.lock().expect("events lock");
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0].revision, 1);
        assert_eq!(recorded[0].tail, "step 1\n");
        assert_eq!(recorded[1].revision, 2);
        assert_eq!(recorded[1].tail, "step 1\nstep 2\n");
    }

    #[test]
    fn detects_alternate_screen_enter_and_exit() {
        assert!(!detect_alternate_screen("normal output\n"));
        assert!(detect_alternate_screen("starting\n\x1b[?1049hvim buffer"));
        assert!(!detect_alternate_screen(
            "starting\n\x1b[?1049hvim buffer\x1b[?1049lback to main"
        ));

        let (events, publisher) = collector();
        let mut session = ToolProgressSession::new(
            "sess-1".into(),
            "call-1".into(),
            Some(publisher),
            Duration::from_millis(200),
        );
        let t0 = Instant::now();
        session.publish_terminal_at("\x1b[?1049htop screen content", true, false, t0);

        let recorded = events.lock().expect("events lock");
        assert_eq!(recorded.len(), 1);
        assert!(recorded[0].alternate_screen);
        assert_eq!(recorded[0].tail, "");
    }

    #[cfg(unix)]
    #[test]
    fn direct_process_wait_with_progress_streams_tail_and_stops_on_exit() {
        let (events, publisher) = collector();
        let hub = ToolProgressHub::default();
        hub.set_publisher(publisher).expect("set publisher");
        let process = super::super::spawn_local_process_native(
            "task-1".into(),
            "req-1".into(),
            "local-1".into(),
            "printf 'alpha\\n'; sleep 0.28; printf 'beta\\n'; sleep 0.12",
            None,
            Duration::from_secs(5),
        )
        .expect("spawn local process");

        let mut session = hub.begin("sess-live".into(), "call-live".into());
        let snapshot = process
            .wait_with_progress(
                Duration::from_secs(5),
                Duration::from_millis(80),
                |stdout, stderr, total_bytes, truncated| {
                    session.publish_direct(stdout, stderr, total_bytes, truncated);
                },
            )
            .expect("wait with progress");
        session.finish();
        let count_after_exit = events.lock().expect("events lock").len();
        assert_eq!(snapshot.exit_code, Some(0));
        assert!(snapshot.stdout.contains("alpha"));
        assert!(snapshot.stdout.contains("beta"));
        assert!(
            count_after_exit >= 1,
            "expected at least one live progress snapshot during command execution"
        );
        // Any late publish after finish must be ignored.
        session.publish_direct("late\n", "", 5, false);
        assert_eq!(events.lock().expect("events lock").len(), count_after_exit);
    }
}
