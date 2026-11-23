//! Recover modes left by a foreground application at an ordered shell prompt.
use std::{borrow::Cow, fmt::Write, path::Path};

// The main screen retains its own saved cursor for mode 1049.
const ALTERNATE_MODES: [u16; 3] = [47, 1047, 1049];
const INPUT_MODES: [u16; 4] = [1, 25, 1004, 2004];
const MOUSE_TRACKING: [u16; 4] = [9, 1000, 1002, 1003];
const MOUSE_ENCODING: [u16; 2] = [1006, 1016];
const MAX_TTY_REPLIES_PER_EPOCH: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Modes {
    private: [bool; INPUT_MODES.len()],
    keypad: bool,
    mouse_tracking: Option<u16>,
    mouse_encoding: Option<u16>,
    modify_other_keys: u16,
}

impl Default for Modes {
    fn default() -> Self {
        Self {
            private: [false, true, false, false],
            keypad: false,
            mouse_tracking: None,
            mouse_encoding: None,
            modify_other_keys: 0,
        }
    }
}

struct ForegroundApplication {
    before_display: Option<Modes>,
    prior_jobs: Vec<u32>,
}

struct PromptBoundary {
    token: String,
    modes: Modes,
    alternate: Option<u16>,
    live_jobs: Vec<u32>,
    command_epoch: u64,
    epoch_tickets: Vec<u32>,
    application: Option<ForegroundApplication>,
    cleanup: String,
    tty_replies: Vec<TtyRecoveryReply>,
}

fn parse_job_ids(jobs: &[u8]) -> Option<Vec<u32>> {
    std::str::from_utf8(jobs)
        .ok()?
        .split_ascii_whitespace()
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()
}

fn parse_prompt_jobs(stopped: &[u8], jobs: &[u8]) -> Option<(bool, Vec<u32>)> {
    let stopped = match stopped {
        b"0" => false,
        b"1" => true,
        _ => return None,
    };
    Some((stopped, parse_job_ids(jobs)?))
}

impl PromptBoundary {
    fn application_job_is_live(
        &mut self,
        stopped: bool,
        jobs: &[u32],
        suspended: Option<&[u32]>,
    ) -> bool {
        let Some(ForegroundApplication { prior_jobs, .. }) = self.application.as_mut() else {
            return false;
        };
        if let Some(suspended) = suspended {
            // fg can promote an existing job and mask its stop status. Keep
            // tracking suspended candidates even if they later resume via bg.
            prior_jobs.retain(|pid| !suspended.contains(pid));
        } else if stopped {
            // A foreground job can have been resumed from the prior job table.
            // After a stop, keep its modes until the observed jobs are gone.
            prior_jobs.clear();
        }
        jobs.iter().any(|job| !prior_jobs.contains(job))
    }
}

impl vte::Perform for PromptBoundary {
    fn csi_dispatch(&mut self, params: &vte::Params, prefix: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        if prefix == b">" && action == 'm' {
            let mut params = params.iter();
            if let (Some([4]), Some([level])) = (params.next(), params.next()) {
                self.modes.modify_other_keys = *level;
            }
            return;
        }
        if prefix != b"?" || !matches!(action, 'h' | 'l') {
            return;
        }
        let enabled = action == 'h';
        for param in params.iter() {
            let [mode] = *param else { continue };
            if ALTERNATE_MODES.contains(&mode) {
                if enabled && self.alternate.is_none() {
                    self.application
                        .get_or_insert_with(|| ForegroundApplication {
                            before_display: None,
                            prior_jobs: self.live_jobs.clone(),
                        })
                        .before_display
                        .get_or_insert(self.modes);
                    self.alternate = Some(mode);
                } else if !enabled {
                    self.alternate = None;
                }
            } else if let Some(index) = INPUT_MODES.iter().position(|&candidate| candidate == mode)
            {
                self.modes.private[index] = enabled;
            } else if mode == 66 {
                self.modes.keypad = enabled;
            } else if MOUSE_TRACKING.contains(&mode) {
                self.modes.mouse_tracking = enabled.then_some(mode);
            } else if MOUSE_ENCODING.contains(&mode) {
                self.modes.mouse_encoding = enabled.then_some(mode);
            }
        }
    }

    fn esc_dispatch(&mut self, prefix: &[u8], ignore: bool, byte: u8) {
        if ignore || !prefix.is_empty() {
            return;
        }
        match byte {
            b'=' => self.modes.keypad = true,
            b'>' => self.modes.keypad = false,
            b'c' => {
                self.modes = Modes::default();
                self.alternate = None;
                if let Some(application) = self.application.as_mut() {
                    application.before_display = None;
                }
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], bell_terminated: bool) {
        let [kind, token, fields @ ..] = params else {
            return;
        };
        if self.token.is_empty() || !bell_terminated || *token != self.token.as_bytes() {
            return;
        }
        if let (b"6975", [epoch, jobs]) = (*kind, fields) {
            let epoch = std::str::from_utf8(epoch).ok().and_then(|s| s.parse().ok());
            if let (Some(epoch), Some(jobs)) = (epoch, parse_job_ids(jobs)) {
                if epoch > self.command_epoch {
                    self.command_epoch = epoch;
                    self.epoch_tickets.clear();
                    self.live_jobs = jobs;
                }
            }
            return;
        }
        if let (b"6974", [ticket, stopped, jobs, suspended, epoch]) = (*kind, fields) {
            if self.command_epoch == 0 {
                return;
            }
            let Some((stopped, jobs)) = parse_prompt_jobs(stopped, jobs) else {
                return;
            };
            let Some(suspended) = parse_job_ids(suspended) else {
                return;
            };
            if std::str::from_utf8(epoch).ok().and_then(|s| s.parse().ok())
                != Some(self.command_epoch)
            {
                return;
            }
            let Some(ticket) = std::str::from_utf8(ticket)
                .ok()
                .and_then(|ticket| ticket.parse::<u32>().ok())
                .filter(|ticket| (1..=i32::MAX as u32).contains(ticket))
            else {
                return;
            };
            if self.epoch_tickets.len() >= MAX_TTY_REPLIES_PER_EPOCH
                || self.epoch_tickets.contains(&ticket)
            {
                return;
            }
            self.epoch_tickets.push(ticket);
            let decision = if self.application_job_is_live(stopped, &jobs, Some(&suspended)) {
                TtyDecision::Defer
            } else if self.application.is_some() {
                // A program can leave the alternate screen before restoring
                // termios. Keep its recovery context through the primary prompt.
                TtyDecision::Restore
            } else {
                TtyDecision::Keep
            };
            self.tty_replies.push(TtyRecoveryReply { ticket, decision });
            return;
        }
        let (stopped, jobs, suspended) = match (*kind, fields) {
            (b"6973", [stopped, jobs]) => (*stopped, *jobs, None),
            (b"6973", [stopped, jobs, suspended]) => {
                let Some(suspended) = parse_job_ids(suspended) else {
                    return;
                };
                (*stopped, *jobs, Some(suspended))
            }
            _ => return,
        };
        let Some((stopped, jobs)) = parse_prompt_jobs(stopped, jobs) else {
            return;
        };
        let application_live = self.application_job_is_live(stopped, &jobs, suspended.as_deref());
        self.live_jobs = jobs;
        if application_live {
            return;
        }
        let Some(before) = self.application.take().and_then(|app| app.before_display) else {
            return;
        };
        if let Some(mode) = self.alternate.take() {
            let _ = write!(self.cleanup, "\x1b[?{mode}l");
        }
        for (index, mode) in INPUT_MODES.iter().enumerate() {
            if before.private[index] != self.modes.private[index] {
                let action = if before.private[index] { 'h' } else { 'l' };
                let _ = write!(self.cleanup, "\x1b[?{mode}{action}");
            }
        }
        if self.modes.keypad != before.keypad {
            self.cleanup
                .push_str(if before.keypad { "\x1b=" } else { "\x1b>" });
        }
        for (current, previous) in [
            (self.modes.mouse_tracking, before.mouse_tracking),
            (self.modes.mouse_encoding, before.mouse_encoding),
        ] {
            if current != previous {
                if let Some(mode) = current {
                    let _ = write!(self.cleanup, "\x1b[?{mode}l");
                }
                if let Some(mode) = previous {
                    let _ = write!(self.cleanup, "\x1b[?{mode}h");
                }
            }
        }
        if self.modes.modify_other_keys != before.modify_other_keys {
            let _ = write!(self.cleanup, "\x1b[>4;{}m", before.modify_other_keys);
        }
        self.modes = before;
    }

    fn terminated(&self) -> bool {
        !self.cleanup.is_empty()
    }
}

pub(crate) struct DisplayRecovery {
    parser: vte::Parser,
    boundary: PromptBoundary,
}

impl DisplayRecovery {
    pub(crate) fn new(token: &str) -> Self {
        Self {
            parser: vte::Parser::new(),
            boundary: PromptBoundary {
                token: token.into(),
                modes: Modes::default(),
                alternate: None,
                live_jobs: Vec::new(),
                command_epoch: 0,
                epoch_tickets: Vec::new(),
                application: None,
                cleanup: String::new(),
                tty_replies: Vec::new(),
            },
        }
    }

    pub(crate) fn apply<'a>(&mut self, bytes: &'a [u8]) -> Cow<'a, [u8]> {
        let mut offset = 0;
        let mut copied = 0;
        let mut output = Vec::new();
        while offset < bytes.len() {
            offset += self
                .parser
                .advance_until_terminated(&mut self.boundary, &bytes[offset..]);
            if !self.boundary.cleanup.is_empty() {
                output.extend_from_slice(&bytes[copied..offset]);
                output.extend_from_slice(self.boundary.cleanup.as_bytes());
                self.boundary.cleanup.clear();
                copied = offset;
            }
        }
        // Display-only callers never consume tty_replies; clear so OSC 6974
        // sequences cannot accumulate unboundedly in screen models.
        self.boundary.tty_replies.clear();
        if copied == 0 {
            Cow::Borrowed(bytes)
        } else {
            output.extend_from_slice(&bytes[copied..]);
            Cow::Owned(output)
        }
    }

    // Inspect the raw PTY stream in the transport worker before output delivery
    // can be deferred by frontend backpressure. The shell reads the reply only
    // at the primary prompt while the OS tty still has the candidate settings.
    pub(crate) fn tty_replies(&mut self, bytes: &[u8]) -> Vec<TtyRecoveryReply> {
        self.parser.advance(&mut self.boundary, bytes);
        self.boundary.cleanup.clear();
        std::mem::take(&mut self.boundary.tty_replies)
    }

    #[cfg(test)]
    pub(crate) fn tty_reply(&mut self, bytes: &[u8]) -> Option<TtyRecoveryReply> {
        self.tty_replies(bytes).pop()
    }
}

pub(crate) struct TtyRecoveryReply {
    ticket: u32,
    decision: TtyDecision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TtyDecision {
    Keep = 0,
    Restore = 1,
    Defer = 2,
}

pub(crate) struct TtyRecoveryWatcher {
    root: std::path::PathBuf,
    recovery: DisplayRecovery,
}

impl TtyRecoveryWatcher {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            recovery: DisplayRecovery::new(crate::terminal_integration::recovery_token(root)),
        }
    }

    #[cfg(unix)]
    pub(crate) fn observe_local(&mut self, bytes: &[u8]) {
        for reply in self.recovery.tty_replies(bytes) {
            if let Err(error) = reply.answer_local(&self.root) {
                log::warn!("Failed to deliver local terminal mode recovery reply: {error}");
            }
        }
    }

    pub(crate) fn observe_ssh(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        let replies = self.recovery.tty_replies(bytes);
        if replies.is_empty() {
            return None;
        }
        let mut encoded = Vec::new();
        for reply in replies {
            encoded.extend_from_slice(&reply.encode());
        }
        Some(encoded)
    }
}

impl TtyRecoveryReply {
    fn encode(&self) -> Vec<u8> {
        format!("TTY-RECOVERY {} {}\n", self.ticket, self.decision as u8).into_bytes()
    }

    pub(crate) fn path(&self, root: &Path) -> std::path::PathBuf {
        root.join(format!(
            "control.tty-reply-{}-{}",
            self.ticket, self.decision as u8
        ))
    }

    #[cfg(unix)]
    pub(crate) fn answer_local(&self, root: &Path) -> std::io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.path(root))?;
        Ok(())
    }

    pub(crate) fn is_reply_file(name: &str) -> bool {
        name.strip_prefix("control.tty-reply-")
            .and_then(|suffix| suffix.split_once('-'))
            .is_some_and(|(ticket, choice)| {
                ticket.parse::<u32>().is_ok_and(|ticket| ticket != 0)
                    && matches!(choice, "0" | "1" | "2")
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_only_application_changes_at_the_matching_prompt_after_the_job_exits() {
        let mut recovery = DisplayRecovery::new("pty-fixture");
        // A focus mode belongs to the shell and a background process already
        // exists when the editor enters the alternate screen.
        let output = b"\x1b[?1004h\x1b]6973;pty-fixture;0; 13\x07\x1b[?1049h\x1b[?1h\x1b=";
        assert_eq!(recovery.apply(output).as_ref(), output);
        for output in [
            b"\x1b]6973;another-pty;0; \x07".as_slice(),
            b"\x1b]6973;pty-fixture;0; 13 17\x07",
            b"\x1b]6973;pty-fixture;0; 13 17\x07background output",
            b"\x1b]6973;pty-fixture;0; 13",
        ] {
            assert_eq!(recovery.apply(output).as_ref(), output);
        }
        assert_eq!(
            recovery.apply(b"\x07prompt").as_ref(),
            b"\x07\x1b[?1049l\x1b[?1l\x1b>prompt"
        );
    }

    #[test]
    fn tty_replies_distinguish_live_apps_completed_apps_and_manual_modes() {
        let mut recovery = DisplayRecovery::new("pty-fixture");
        let _ = recovery.apply(b"\x1b]6975;pty-fixture;1; 13 17\x07\x1b[?1049h");
        let deferred = recovery
            .tty_reply(b"\x1b]6974;pty-fixture;1;0; 13 17; 17;1\x07")
            .unwrap();
        assert_eq!(deferred.encode(), b"TTY-RECOVERY 1 2\n");

        // The previously suspended job can run again without leaving its
        // alternate screen or acquiring a different process ID.
        let continued = b"\x1b]6973;pty-fixture;0; 13 17; \x07";
        assert_eq!(recovery.apply(continued).as_ref(), continued);

        let _ = recovery.apply(b"\x1b]6975;pty-fixture;2; 13 17\x07\x1b[?1049l");
        assert!(recovery
            .tty_reply(b"\x1b]6974;pty-fixture;2;0; 13; ;1\x07")
            .is_none());
        let restore = recovery
            .tty_reply(b"\x1b]6974;pty-fixture;3;0; 13; ;2\x07")
            .unwrap();
        assert_eq!(restore.encode(), b"TTY-RECOVERY 3 1\n");

        let prompt = b"\x1b]6973;pty-fixture;0; 13; \x07";
        assert_eq!(recovery.apply(prompt).as_ref(), prompt);
        let keep = recovery
            .tty_reply(b"\x1b]6974;pty-fixture;4;0; 13; ;2\x07")
            .unwrap();
        assert_eq!(keep.encode(), b"TTY-RECOVERY 4 0\n");
    }

    #[test]
    fn terminal_reset_preserves_tty_recovery_context_until_the_prompt() {
        let mut recovery = DisplayRecovery::new("pty-fixture");
        let full_screen = b"\x1b[?1004h\x1b]6975;pty-fixture;1; \x07\x1b[?1049h\x1bc";
        assert_eq!(recovery.apply(full_screen).as_ref(), full_screen);
        let reply = recovery
            .tty_reply(b"\x1b]6974;pty-fixture;1;0; ; ;1\x07")
            .unwrap();
        assert_eq!(reply.encode(), b"TTY-RECOVERY 1 1\n");
        let prompt = b"\x1b]6973;pty-fixture;0; ; \x07";
        assert_eq!(recovery.apply(prompt).as_ref(), prompt);
    }

    #[test]
    fn coalesced_tty_recovery_requests_return_all_replies_in_order() {
        let mut recovery = DisplayRecovery::new("pty-fixture");
        let _ = recovery.apply(b"\x1b]6975;pty-fixture;1; \x07");
        let chunk = b"\x1b]6974;pty-fixture;1;0; ; ;1\x07\x1b]6974;pty-fixture;2;0; ; ;1\x07";
        let replies = recovery.tty_replies(chunk);
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0].encode(), b"TTY-RECOVERY 1 0\n");
        assert_eq!(replies[1].encode(), b"TTY-RECOVERY 2 0\n");
    }

    #[test]
    fn apply_drops_tty_replies_and_bounds_or_deduplicates_osc_6974() {
        let mut empty = DisplayRecovery::new("");
        assert!(empty
            .tty_replies(b"\x1b]6975;;1; \x07\x1b]6974;;1;0; ; ;1\x07")
            .is_empty());

        let mut recovery = DisplayRecovery::new("pty-fixture");
        // Epoch 0 (before any 6975) must not produce tty replies.
        assert!(recovery
            .tty_replies(b"\x1b]6974;pty-fixture;1;0; ; ;0\x07")
            .is_empty());

        let _ = recovery.apply(b"\x1b]6975;pty-fixture;1; \x07\x1b]6974;pty-fixture;1;0; ; ;1\x07");
        assert!(recovery.boundary.tty_replies.is_empty());

        // Duplicate ticket in same epoch is ignored, and replies per epoch are capped.
        let mut flood = Vec::new();
        flood.extend_from_slice(b"\x1b]6975;pty-fixture;2; \x07");
        flood.extend_from_slice(b"\x1b]6974;pty-fixture;10;0; ; ;2\x07");
        flood.extend_from_slice(b"\x1b]6974;pty-fixture;10;0; ; ;2\x07");
        for ticket in 11..40 {
            flood.extend_from_slice(
                format!("\x1b]6974;pty-fixture;{ticket};0; ; ;2\x07").as_bytes(),
            );
        }
        let replies = recovery.tty_replies(&flood);
        assert_eq!(replies.len(), MAX_TTY_REPLIES_PER_EPOCH);
        assert_eq!(replies[0].ticket, 10);
        assert_eq!(replies[1].ticket, 11);
    }
}
