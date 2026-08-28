//! Bounded, redacted PTY capture for the dedicated Agent terminal.
//!
//! Capture is deliberately owner-aware. Bytes emitted while the user owns the
//! PTY are discarded before transcript processing, and returning control
//! rotates/clears the capture epoch so echoed user input cannot enter a later
//! model observation. Terminal text is always untrusted and never becomes
//! verification evidence.

use super::redaction::AgentGenericRedactorV1;
use super::terminal_policy::{
    detect_sensitive_prompt_v1, TerminalPromptClassV1, TerminalPromptSurfaceV1,
};
use crate::terminal_lease::TerminalLeaseOwner;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub(crate) const MAX_AGENT_TRANSCRIPT_BYTES_V1: usize = 32 * 1024;
pub(crate) const MAX_AGENT_TRANSCRIPT_LINES_V1: usize = 200;
pub(crate) const MAX_AGENT_CAPTURE_AGE_MS_V1: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscapeStateV1 {
    Plain,
    Escape,
    Csi,
    Osc,
    OscEscape,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCapturedObservationV1 {
    pub(crate) capture_epoch: u64,
    pub(crate) observed_at_ms: u64,
    pub(crate) redacted_transcript: String,
    pub(crate) transcript_digest: String,
    pub(crate) truncated: bool,
    pub(crate) line_count: u32,
    pub(crate) surface: TerminalPromptSurfaceV1,
    pub(crate) prompt_class: TerminalPromptClassV1,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalModelObservationV1 {
    pub(crate) observation_id: String,
    pub(crate) capture_epoch: u64,
    pub(crate) observed_at_ms: u64,
    pub(crate) redacted_transcript: String,
    pub(crate) transcript_digest: String,
    pub(crate) truncated: bool,
    pub(crate) surface: TerminalPromptSurfaceV1,
    pub(crate) prompt_class: TerminalPromptClassV1,
    pub(crate) untrusted: bool,
}

#[derive(Clone)]
pub(crate) struct BoundedTerminalCaptureV1 {
    owner: TerminalLeaseOwner,
    capture_epoch: u64,
    started_at_ms: u64,
    text: String,
    line_count: usize,
    truncated: bool,
    escape_state: EscapeStateV1,
    surface_probe_tail: String,
    alternate_screen_seen: bool,
    editor_seen: bool,
    installer_seen: bool,
    redactor: AgentGenericRedactorV1,
}

impl BoundedTerminalCaptureV1 {
    pub(crate) fn new(started_at_ms: u64, additional_secrets: Vec<String>) -> Self {
        Self {
            owner: TerminalLeaseOwner::Agent,
            capture_epoch: 1,
            started_at_ms,
            text: String::new(),
            line_count: 0,
            truncated: false,
            escape_state: EscapeStateV1::Plain,
            surface_probe_tail: String::new(),
            alternate_screen_seen: false,
            editor_seen: false,
            installer_seen: false,
            redactor: AgentGenericRedactorV1::new(additional_secrets),
        }
    }

    pub(crate) fn capture_epoch(&self) -> u64 {
        self.capture_epoch
    }

    pub(crate) fn owner(&self) -> TerminalLeaseOwner {
        self.owner
    }

    pub(crate) fn set_unowned(&mut self) {
        self.owner = TerminalLeaseOwner::Unowned;
        self.clear_transient();
    }

    pub(crate) fn take_over_by_user(&mut self) {
        self.owner = TerminalLeaseOwner::User;
        self.clear_transient();
    }

    pub(crate) fn return_to_agent(&mut self, now_ms: u64) -> Result<u64, &'static str> {
        if self.owner != TerminalLeaseOwner::User {
            return Err("terminal capture can return only from user ownership");
        }
        self.capture_epoch = self
            .capture_epoch
            .checked_add(1)
            .ok_or("terminal capture epoch exhausted")?;
        self.owner = TerminalLeaseOwner::Agent;
        self.started_at_ms = now_ms;
        self.clear_transient();
        Ok(self.capture_epoch)
    }

    /// Consumes a Rust-side decoded PTY chunk. User/unowned output is dropped
    /// immediately and is never retained, redacted, journaled, or returned.
    pub(crate) fn ingest(&mut self, chunk: &str, now_ms: u64) -> bool {
        if self.owner != TerminalLeaseOwner::Agent {
            return false;
        }
        if now_ms.saturating_sub(self.started_at_ms) > MAX_AGENT_CAPTURE_AGE_MS_V1 {
            self.truncated = true;
            if self.text.is_empty() {
                self.text
                    .push_str("[terminal capture time budget exceeded]");
            }
            return true;
        }
        self.detect_surface(chunk);
        for character in chunk.chars() {
            self.process_character(character);
            if self.truncated {
                break;
            }
        }
        true
    }

    pub(crate) fn should_handoff_immediately(&self) -> bool {
        if self.owner != TerminalLeaseOwner::Agent {
            return false;
        }
        self.alternate_screen_seen
            || self.editor_seen
            || self.installer_seen
            || self.truncated
            || detect_sensitive_transcript_v1(&self.text).is_some()
    }

    pub(crate) fn finish(&mut self, observed_at_ms: u64) -> Option<TerminalCapturedObservationV1> {
        if self.owner != TerminalLeaseOwner::Agent || self.text.trim().is_empty() {
            return None;
        }
        if observed_at_ms.saturating_sub(self.started_at_ms) > MAX_AGENT_CAPTURE_AGE_MS_V1 {
            self.truncated = true;
        }
        let surface = if self.truncated {
            TerminalPromptSurfaceV1::Unknown
        } else {
            self.classify_surface()
        };
        let prompt_tail = prompt_tail_v1(&self.text);
        let prompt_class = if self.truncated {
            TerminalPromptClassV1::UnknownSensitive
        } else {
            detect_sensitive_transcript_v1(&self.text)
                .unwrap_or_else(|| classify_non_sensitive_prompt_v1(prompt_tail, surface))
        };
        let redacted_transcript = self.redactor.redact(&self.text);
        let transcript_digest = digest_text_v1(&redacted_transcript);
        let observation = TerminalCapturedObservationV1 {
            capture_epoch: self.capture_epoch,
            observed_at_ms,
            redacted_transcript,
            transcript_digest,
            truncated: self.truncated,
            line_count: self.line_count.min(u32::MAX as usize) as u32,
            surface,
            prompt_class,
        };
        self.started_at_ms = observed_at_ms;
        self.clear_transient();
        Some(observation)
    }

    fn clear_transient(&mut self) {
        self.text.clear();
        self.line_count = 0;
        self.truncated = false;
        self.escape_state = EscapeStateV1::Plain;
        self.surface_probe_tail.clear();
        self.alternate_screen_seen = false;
        self.editor_seen = false;
        self.installer_seen = false;
    }

    fn detect_surface(&mut self, chunk: &str) {
        let mut probe = std::mem::take(&mut self.surface_probe_tail);
        probe.push_str(chunk);
        self.alternate_screen_seen |= ["\u{1b}[?1049h", "\u{1b}[?1047h", "\u{1b}[?47h"]
            .iter()
            .any(|marker| probe.contains(marker));
        let lower = probe.to_ascii_lowercase();
        self.editor_seen |= ["-- insert --", "gnu nano", "emacs", "vim:"]
            .iter()
            .any(|marker| lower.contains(marker));
        self.installer_seen |= [
            "installation wizard",
            "installer",
            "package configuration",
            "license agreement",
        ]
        .iter()
        .any(|marker| lower.contains(marker));
        self.surface_probe_tail = probe
            .chars()
            .rev()
            .take(64)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
    }

    fn classify_surface(&self) -> TerminalPromptSurfaceV1 {
        if self.installer_seen {
            TerminalPromptSurfaceV1::Installer
        } else if self.editor_seen {
            TerminalPromptSurfaceV1::Editor
        } else if self.alternate_screen_seen {
            TerminalPromptSurfaceV1::FullScreen
        } else {
            TerminalPromptSurfaceV1::LinePrompt
        }
    }

    fn process_character(&mut self, character: char) {
        match self.escape_state {
            EscapeStateV1::Plain => match character {
                '\u{1b}' => self.escape_state = EscapeStateV1::Escape,
                '\0' => self.truncated = true,
                '\r' => {}
                '\n' => self.push_visible('\n'),
                '\t' => self.push_visible('\t'),
                '\u{8}' => {
                    self.text.pop();
                }
                value if value.is_control() => {}
                value => self.push_visible(value),
            },
            EscapeStateV1::Escape => match character {
                '[' => self.escape_state = EscapeStateV1::Csi,
                ']' => self.escape_state = EscapeStateV1::Osc,
                _ => self.escape_state = EscapeStateV1::Plain,
            },
            EscapeStateV1::Csi => {
                if ('@'..='~').contains(&character) {
                    self.escape_state = EscapeStateV1::Plain;
                }
            }
            EscapeStateV1::Osc => match character {
                '\u{7}' => self.escape_state = EscapeStateV1::Plain,
                '\u{1b}' => self.escape_state = EscapeStateV1::OscEscape,
                _ => {}
            },
            EscapeStateV1::OscEscape => {
                self.escape_state = if character == '\\' {
                    EscapeStateV1::Plain
                } else {
                    EscapeStateV1::Osc
                };
            }
        }
    }

    fn push_visible(&mut self, character: char) {
        if character == '\n' {
            if self.line_count >= MAX_AGENT_TRANSCRIPT_LINES_V1 {
                self.truncated = true;
                return;
            }
            self.line_count += 1;
        }
        if self.text.len() + character.len_utf8() > MAX_AGENT_TRANSCRIPT_BYTES_V1 {
            self.truncated = true;
            return;
        }
        self.text.push(character);
    }
}

fn classify_non_sensitive_prompt_v1(
    text: &str,
    surface: TerminalPromptSurfaceV1,
) -> TerminalPromptClassV1 {
    if surface != TerminalPromptSurfaceV1::LinePrompt {
        return TerminalPromptClassV1::Unknown;
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("[y/n]")
        || lower.contains("continue?")
        || lower.contains("proceed?")
        || lower.contains("are you sure")
    {
        TerminalPromptClassV1::Confirm
    } else if lower.contains("choose")
        || lower.contains("select an option")
        || lower.contains("retry or cancel")
    {
        TerminalPromptClassV1::Choice
    } else {
        TerminalPromptClassV1::Unknown
    }
}

fn prompt_tail_v1(text: &str) -> &str {
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(text)
}

fn detect_sensitive_transcript_v1(text: &str) -> Option<TerminalPromptClassV1> {
    text.lines()
        .find_map(|line| detect_sensitive_prompt_v1(line.trim()))
}

pub(crate) fn digest_text_v1(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"agent-terminal-text-v1\0");
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let digest_hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256-v1:{digest_hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_bounds_and_redacts_before_observation() {
        let mut capture = BoundedTerminalCaptureV1::new(10, Vec::new());
        assert!(capture.ingest("\u{1b}[32mContinue? [y/N]\u{1b}[0m token=secret-value", 11));
        let observation = capture.finish(12).unwrap();
        assert_eq!(observation.surface, TerminalPromptSurfaceV1::LinePrompt);
        assert_eq!(observation.prompt_class, TerminalPromptClassV1::Token);
        assert!(!observation.redacted_transcript.contains("\u{1b}"));
        assert!(!observation.redacted_transcript.contains("secret-value"));
        assert!(observation.redacted_transcript.contains("[REDACTED]"));
    }

    #[test]
    fn user_output_is_dropped_and_return_rotates_capture_epoch() {
        let mut capture = BoundedTerminalCaptureV1::new(10, Vec::new());
        capture.ingest("initial prompt", 11);
        capture.take_over_by_user();
        assert!(!capture.ingest("echoed-user-secret", 12));
        assert!(capture.finish(13).is_none());
        assert_eq!(capture.return_to_agent(14).unwrap(), 2);
        capture.ingest("Continue? [y/N]", 15);
        let observation = capture.finish(16).unwrap();
        assert_eq!(observation.capture_epoch, 2);
        assert!(!observation
            .redacted_transcript
            .contains("echoed-user-secret"));
    }

    #[test]
    fn alternate_screen_editor_and_installer_require_non_line_surfaces() {
        for (input, surface) in [
            ("\u{1b}[?1049hmenu", TerminalPromptSurfaceV1::FullScreen),
            ("GNU nano 9", TerminalPromptSurfaceV1::Editor),
            ("Installation wizard", TerminalPromptSurfaceV1::Installer),
        ] {
            let mut capture = BoundedTerminalCaptureV1::new(1, Vec::new());
            capture.ingest(input, 2);
            assert!(capture.should_handoff_immediately());
            assert_eq!(capture.finish(3).unwrap().surface, surface);
        }
    }

    #[test]
    fn alternate_screen_detection_survives_transport_chunk_boundaries() {
        let mut capture = BoundedTerminalCaptureV1::new(1, Vec::new());
        capture.ingest("\u{1b}[?10", 2);
        capture.ingest("49hmenu", 3);
        assert!(capture.should_handoff_immediately());
        assert_eq!(
            capture.finish(4).unwrap().surface,
            TerminalPromptSurfaceV1::FullScreen
        );
    }

    #[test]
    fn fixed_seed_capture_property_is_bounded_redacted_and_time_limited() {
        let mut capture = BoundedTerminalCaptureV1::new(10, vec!["fixture-extra-secret".into()]);
        let mut seed = 0x5eed_1234_u32;
        for index in 0..400 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let color = 30 + (seed % 8);
            let chunk = format!(
                "\u{1b}[{color}mline-{index} token=token-{seed} fixture-extra-secret\u{1b}[0m\n"
            );
            capture.ingest(&chunk, 11 + index);
        }
        let observation = capture.finish(500).unwrap();
        assert!(observation.truncated);
        assert!(observation.redacted_transcript.len() <= MAX_AGENT_TRANSCRIPT_BYTES_V1);
        assert!(observation.line_count <= MAX_AGENT_TRANSCRIPT_LINES_V1 as u32);
        assert!(!observation
            .redacted_transcript
            .contains("fixture-extra-secret"));
        assert!(!observation.redacted_transcript.contains("token=token-"));
        assert!(!observation
            .redacted_transcript
            .chars()
            .any(|character| character == '\u{1b}' || character == '\0'));

        let mut aged = BoundedTerminalCaptureV1::new(1_000, Vec::new());
        assert!(aged.ingest("late output", 1_000 + MAX_AGENT_CAPTURE_AGE_MS_V1 + 1));
        let aged_observation = aged
            .finish(1_000 + MAX_AGENT_CAPTURE_AGE_MS_V1 + 2)
            .unwrap();
        assert!(aged_observation.truncated);
        assert_eq!(aged_observation.surface, TerminalPromptSurfaceV1::Unknown);
        assert_eq!(
            aged_observation.prompt_class,
            TerminalPromptClassV1::UnknownSensitive
        );
    }
}
