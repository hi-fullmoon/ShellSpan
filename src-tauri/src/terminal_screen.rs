use serde::Serialize;
use std::borrow::Cow;

use crate::terminal_broker::{TerminalGeometry, TerminalRawOutputFrame};
use crate::terminal_display_recovery::DisplayRecovery;

const MAX_TITLE_BYTES: usize = 4_096;
const PRIVATE_KEY_BOUNDARY_BYTES: usize = 64;
// Allow for the UTF-8 size of xterm's 10,000,000 UTF-16 unit string limit.
const DISPLAY_TAIL_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Default)]
struct DisplayVtActions {
    executed_c0: bool,
}

impl vtparse::VTActor for DisplayVtActions {
    fn print(&mut self, _: char) {}
    fn execute_c0_or_c1(&mut self, control: u8) {
        self.executed_c0 = control < 0x20;
    }
    fn dcs_hook(&mut self, _: u8, _: &[i64], _: &[u8], _: bool) {}
    fn dcs_put(&mut self, _: u8) {}
    fn dcs_unhook(&mut self) {}
    fn esc_dispatch(&mut self, _: &[i64], _: &[u8], _: bool, _: u8) {}
    fn csi_dispatch(&mut self, _: &[vtparse::CsiParam], _: bool, _: u8) {}
    fn osc_dispatch(&mut self, _: &[&[u8]]) {}
}

struct DisplayTail {
    parser: vtparse::VTParser,
    pending: Vec<u8>,
    overflowed: bool,
}

impl DisplayTail {
    fn new() -> Self {
        Self {
            parser: vtparse::VTParser::new(),
            pending: Vec::new(),
            overflowed: false,
        }
    }

    fn observe(&mut self, display: &str) {
        let bytes = display.as_bytes();
        let first_control = if self.parser.is_ground() {
            bytes
                .iter()
                .position(|&byte| byte == 0x1b || !byte.is_ascii())
                .unwrap_or(bytes.len())
        } else {
            0
        };
        let mut fragment_start = first_control;
        for (index, character) in display[first_control..].char_indices() {
            let start = first_control + index;
            let end = start + character.len_utf8();
            let mut actions = DisplayVtActions::default();
            // The webview parses Unicode code points. Only actual C1 controls
            // may change state, even when a UTF-8 continuation has a C1 value.
            self.parser
                .parse_byte(character.min('\u{a0}') as u8, &mut actions);
            if self.parser.is_ground() {
                if !self.pending.is_empty() {
                    self.pending = Vec::new();
                }
                self.overflowed = false;
                fragment_start = end;
            } else if actions.executed_c0 {
                // A C0 executed inside a CSI or escape is already reflected
                // in the screen. Retain the surrounding parser state only.
                self.append(&bytes[fragment_start..start]);
                fragment_start = end;
            }
        }
        self.append(&bytes[fragment_start..]);
    }

    fn append(&mut self, bytes: &[u8]) {
        if self.overflowed {
            return;
        }
        if self.pending.len() + bytes.len() > DISPLAY_TAIL_LIMIT {
            self.pending = Vec::new();
            self.overflowed = true;
        } else {
            self.pending.extend_from_slice(bytes);
        }
    }
}

#[derive(Default)]
struct PrivateKeyScreenFilter {
    parser: vte::Parser,
    state: PrivateKeyScreenState,
}

#[derive(Default)]
struct PrivateKeyScreenState {
    boundary: String,
    inside_private_key: bool,
    mask_ascii: bool,
}

impl vte::Perform for PrivateKeyScreenState {
    fn print(&mut self, character: char) {
        // PEM/OpenSSH delimiters and encoded key material are ASCII. VTE
        // identifies printable characters so escape sequences stay untouched.
        self.mask_ascii = self.inside_private_key && character.is_ascii();
        if character.is_ascii_whitespace() {
            return;
        }
        if !character.is_ascii() {
            self.boundary.clear();
            return;
        }
        self.boundary.push(character);
        if self.boundary.len() >= PRIVATE_KEY_BOUNDARY_BYTES * 2 {
            let drain_to = self.boundary.len() - PRIVATE_KEY_BOUNDARY_BYTES;
            self.boundary.drain(..drain_to);
        }
        if character != '-' {
            return;
        }
        let window_start = self
            .boundary
            .len()
            .saturating_sub(PRIVATE_KEY_BOUNDARY_BYTES);
        match crate::redaction::terminal_private_key_boundary(&self.boundary[window_start..]) {
            Some(crate::redaction::PrivateKeyBoundary::Begin) => {
                self.inside_private_key = true;
                // Also break the opening delimiter in the safe screen, so a
                // later snapshot sanitizer cannot hide ordinary output after END.
                self.mask_ascii = true;
                self.boundary.clear();
            }
            Some(crate::redaction::PrivateKeyBoundary::End) => {
                self.inside_private_key = false;
                self.boundary.clear();
            }
            None => {}
        }
    }
}

impl PrivateKeyScreenFilter {
    fn filter<'a>(&mut self, bytes: &'a [u8]) -> Cow<'a, [u8]> {
        if !self.state.inside_private_key && !bytes.contains(&b'-') {
            self.state.mask_ascii = false;
            self.parser.advance(&mut self.state, bytes);
            return Cow::Borrowed(bytes);
        }
        let mut owned: Option<Vec<u8>> = None;
        for (index, &byte) in bytes.iter().enumerate() {
            self.state.mask_ascii = false;
            self.parser
                .advance(&mut self.state, std::slice::from_ref(&byte));
            if self.state.mask_ascii {
                let buf = owned.get_or_insert_with(|| {
                    let mut v = Vec::with_capacity(bytes.len());
                    v.extend_from_slice(&bytes[..index]);
                    v
                });
                buf.push(b'*');
            } else if let Some(buf) = owned.as_mut() {
                buf.push(byte);
            }
        }
        match owned {
            Some(buf) => Cow::Owned(buf),
            None => Cow::Borrowed(bytes),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalScreenCursor {
    pub(crate) row: u16,
    pub(crate) column: u16,
    pub(crate) visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalScreenBuffer {
    Primary,
    Alternate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalScreenSnapshot {
    pub(crate) protocol_version: u8,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    #[serde(rename = "type")]
    pub(crate) frame_type: &'static str,
    pub(crate) screen_version: u64,
    pub(crate) through_output_sequence: u64,
    pub(crate) rows: u16,
    pub(crate) columns: u16,
    pub(crate) cursor: TerminalScreenCursor,
    pub(crate) active_buffer: TerminalScreenBuffer,
    pub(crate) title: String,
    pub(crate) content: Vec<String>,
}

#[derive(Default)]
struct TerminalScreenCallbacks {
    title: String,
}

impl vt100::Callbacks for TerminalScreenCallbacks {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.title = truncate_utf8(&String::from_utf8_lossy(title), MAX_TITLE_BYTES);
    }
}

pub(crate) struct TerminalScreenModel {
    parser: vt100::Parser<TerminalScreenCallbacks>,
    display_tail: Option<Box<DisplayTail>>,
    private_key_filter: PrivateKeyScreenFilter,
    recovery: Option<DisplayRecovery>,
    version: u64,
    through_output_sequence: u64,
}

impl std::fmt::Debug for TerminalScreenModel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TerminalScreenModel")
            .field("version", &self.version)
            .field("through_output_sequence", &self.through_output_sequence)
            .finish_non_exhaustive()
    }
}

impl TerminalScreenModel {
    pub(crate) fn new(geometry: TerminalGeometry) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(
                geometry.rows.min(u16::MAX as u32) as u16,
                geometry.columns.min(u16::MAX as u32) as u16,
                0,
                TerminalScreenCallbacks::default(),
            ),
            display_tail: None,
            private_key_filter: PrivateKeyScreenFilter::default(),
            recovery: None,
            version: 1,
            through_output_sequence: 0,
        }
    }

    pub(crate) fn arm_display_recovery(&mut self, token: &str) {
        self.recovery = Some(DisplayRecovery::new(token));
    }

    pub(crate) fn observe(&mut self, frame: &TerminalRawOutputFrame) -> Result<(), String> {
        self.observe_bytes(frame.sequence, &frame.bytes)
    }

    pub(crate) fn observe_bytes(&mut self, sequence: u64, bytes: &[u8]) -> Result<(), String> {
        let next = self
            .version
            .checked_add(1)
            .ok_or_else(|| "TERMINAL_SCREEN_COUNTER_EXHAUSTED".to_string())?;
        // Private-key masking stays in the headless Agent screen. Both screen
        // models apply the ordered display recovery without changing raw frames.
        let safe = self.private_key_filter.filter(bytes);
        let display = self
            .recovery
            .as_mut()
            .map_or(Cow::Borrowed(safe.as_ref()), |recovery| {
                recovery.apply(safe.as_ref())
            });
        self.parser.process(&display);
        self.version = next;
        self.through_output_sequence = sequence;
        Ok(())
    }

    pub(crate) fn is_alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    pub(crate) fn observe_display(&mut self, sequence: u64, text: &str) -> String {
        let input = text.as_bytes();
        let display = match self
            .recovery
            .as_mut()
            .map_or(Cow::Borrowed(input), |recovery| recovery.apply(input))
        {
            Cow::Borrowed(_) => text.into(),
            Cow::Owned(bytes) => {
                String::from_utf8(bytes).expect("recovery inserts ASCII at a parsed OSC boundary")
            }
        };
        self.parser.process(display.as_bytes());
        self.display_tail
            .get_or_insert_with(|| Box::new(DisplayTail::new()))
            .observe(&display);
        self.through_output_sequence = sequence;
        display
    }

    pub(crate) fn format_display(&self) -> Result<(u64, String), String> {
        let tail = self.display_tail.as_deref();
        if tail.is_some_and(|tail| tail.overflowed) {
            return Err("TERMINAL_DISPLAY_SEQUENCE_TOO_LARGE".into());
        }
        let screen = self.parser.screen();
        let mut bytes = Vec::new();
        if screen.alternate_screen() {
            // Seed the primary grid before entering the alternate grid in xterm.
            let (rows, columns) = screen.size();
            let mut primary = vt100::Parser::new(rows, columns, 0);
            *primary.screen_mut() = screen.clone();
            primary.process(b"\x1b[?47l");
            bytes.extend(primary.screen().contents_formatted());
            bytes.extend_from_slice(b"\x1b[?1049h");
        }
        bytes.extend(screen.state_formatted());
        if let Some(tail) = tail {
            // Seed the renderer's parser after drawing the checkpoint. The
            // next live frame can then complete the sequence naturally.
            bytes.extend_from_slice(&tail.pending);
        }
        Ok((
            self.through_output_sequence,
            String::from_utf8_lossy(&bytes).into_owned(),
        ))
    }

    pub(crate) fn resize(&mut self, geometry: TerminalGeometry) -> Result<bool, String> {
        let rows = geometry.rows.min(u16::MAX as u32) as u16;
        let columns = geometry.columns.min(u16::MAX as u32) as u16;
        if self.parser.screen().size() == (rows, columns) {
            return Ok(false);
        }
        let next = self
            .version
            .checked_add(1)
            .ok_or_else(|| "TERMINAL_SCREEN_COUNTER_EXHAUSTED".to_string())?;
        self.parser.screen_mut().set_size(rows, columns);
        self.version = next;
        Ok(true)
    }

    pub(crate) fn version(&self) -> u64 {
        self.version
    }

    pub(crate) fn snapshot(
        &self,
        terminal_session_id: &str,
        terminal_generation: u64,
    ) -> TerminalScreenSnapshot {
        let screen = self.parser.screen();
        let (rows, columns) = screen.size();
        let (row, column) = screen.cursor_position();
        TerminalScreenSnapshot {
            protocol_version: 1,
            terminal_session_id: terminal_session_id.to_string(),
            terminal_generation,
            frame_type: "screenSnapshot",
            screen_version: self.version,
            through_output_sequence: self.through_output_sequence,
            rows,
            columns,
            cursor: TerminalScreenCursor {
                row,
                column,
                visible: !screen.hide_cursor(),
            },
            active_buffer: if screen.alternate_screen() {
                TerminalScreenBuffer::Alternate
            } else {
                TerminalScreenBuffer::Primary
            },
            title: self.parser.callbacks().title.clone(),
            content: screen.rows(0, columns).collect(),
        }
    }

    pub(crate) fn bracketed_paste(&self) -> bool {
        self.parser.screen().bracketed_paste()
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(sequence: u64, bytes: &[u8]) -> TerminalRawOutputFrame {
        TerminalRawOutputFrame {
            protocol_version: 1,
            terminal_session_id: "terminal-1".into(),
            terminal_generation: 1,
            frame_type: "rawOutput",
            sequence,
            byte_offset: 0,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn display_snapshot_replays_an_incomplete_csi_with_embedded_line_feed_once() {
        let geometry = TerminalGeometry::new(40, 8);
        let mut model = TerminalScreenModel::new(geometry);
        let name = env!("CARGO_PKG_NAME");
        let prefix = format!("{name}\r\n{name}\x1b[\r");
        let live_prefix = model.observe_display(1, &prefix);
        let live_middle = model.observe_display(2, "\n");
        let (sequence, snapshot) = model.format_display().unwrap();
        let live_tail = model.observe_display(3, &format!("2A{name}"));

        let mut continuous = vt100::Parser::new(8, 40, 0);
        for part in [&live_prefix, &live_middle, &live_tail] {
            continuous.process(part.as_bytes());
        }
        let mut restored = vt100::Parser::new(8, 40, 0);
        restored.process(snapshot.as_bytes());
        restored.process(live_tail.as_bytes());
        assert_eq!(sequence, 2);
        assert_eq!(live_prefix, prefix);
        assert_eq!(live_middle, "\n");
        assert_eq!(restored.screen().cursor_position(), (0, name.len() as u16));
        assert_eq!(
            restored.screen().state_formatted(),
            continuous.screen().state_formatted()
        );
        assert_eq!(
            model.format_display().unwrap().1.as_bytes(),
            continuous.screen().state_formatted()
        );
    }

    #[test]
    fn display_snapshot_keeps_unicode_in_an_unterminated_control_string() {
        let mut model = TerminalScreenModel::new(TerminalGeometry::new(40, 8));
        let prefix = "\x1b_终端界";
        model.observe_display(1, prefix);
        let (sequence, snapshot) = model.format_display().unwrap();
        assert_eq!(sequence, 1);
        assert!(snapshot.ends_with(prefix));
        model.observe_display(2, "\x1b\\");
        assert!(!model.format_display().unwrap().1.contains(prefix));
    }

    #[test]
    fn renders_cursor_title_and_alternate_buffer_from_raw_bytes() {
        let mut model = TerminalScreenModel::new(TerminalGeometry::new(8, 3));
        model
            .observe(&frame(
                1,
                b"hello\x1b]0;fixture-title\x07\x1b[?1049hmenu\x1b[2;3H",
            ))
            .unwrap();
        let snapshot = model.snapshot("terminal-1", 1);
        assert_eq!(snapshot.screen_version, 2);
        assert_eq!(snapshot.through_output_sequence, 1);
        assert_eq!(snapshot.active_buffer, TerminalScreenBuffer::Alternate);
        assert_eq!(snapshot.title, "fixture-title");
        assert_eq!((snapshot.cursor.row, snapshot.cursor.column), (1, 2));
        assert_eq!(snapshot.content.len(), 3);
        assert!(snapshot.content.iter().any(|row| row.contains("menu")));
    }

    #[test]
    fn private_keys_stay_masked_after_scrolling_chunking_resize_and_buffer_switch() {
        let directory = tempfile::tempdir().unwrap();
        for (kind, format) in [("ed25519", "RFC4716"), ("rsa", "PEM")] {
            let path = directory.path().join(kind);
            assert!(std::process::Command::new("ssh-keygen")
                .args(["-q", "-t", kind, "-m", format, "-N", "", "-f"])
                .arg(&path)
                .status()
                .expect("ssh-keygen is required for real private key screen tests")
                .success());
            let key = std::fs::read_to_string(path).unwrap();
            let body = key
                .lines()
                .filter(|line| !line.starts_with("-----"))
                .collect::<String>();
            for columns in [12, 80] {
                for chunk_size in [1, 37, usize::MAX] {
                    let mut model = TerminalScreenModel::new(TerminalGeometry::new(columns, 24));
                    let mut raw = vt100::Parser::new(24, columns as u16, 0);
                    let output = key.replace('\n', "\r\n\x1b[32m");
                    let end_marker = output.rfind("-----END ").unwrap();
                    let mut sequence = 0;
                    for chunk in output.as_bytes()[..end_marker].chunks(chunk_size) {
                        sequence += 1;
                        model.observe(&frame(sequence, chunk)).unwrap();
                        raw.process(chunk);
                        if chunk_size != 1 || sequence % 61 == 0 {
                            assert_private_key_screen_masked(&model, &raw, &body);
                        }
                    }
                    assert_private_key_screen_masked(&model, &raw, &body);
                    if kind == "rsa" {
                        assert!(!raw.screen().contents().contains("BEGIN"));
                        assert!(raw
                            .screen()
                            .rows(0, columns as u16)
                            .any(|row| row.len() >= 8 && body.contains(&row)));
                    }

                    model.resize(TerminalGeometry::new(100, 30)).unwrap();
                    raw.screen_mut().set_size(30, 100);
                    assert_private_key_screen_masked(&model, &raw, &body);
                    for bytes in [
                        b"\x1b[?1049hALTERNATE".as_slice(),
                        b"\x1b[?1049l",
                        &output.as_bytes()[end_marker..],
                        b"\r\nSAFE_OUTPUT\r\n",
                    ] {
                        sequence += 1;
                        model.observe(&frame(sequence, bytes)).unwrap();
                        raw.process(bytes);
                        assert_private_key_screen_masked(&model, &raw, &body);
                    }
                    assert!(model
                        .snapshot("terminal-1", 1)
                        .content
                        .iter()
                        .any(|row| row == "SAFE_OUTPUT"));
                }
            }
        }
    }

    fn assert_private_key_screen_masked(
        model: &TerminalScreenModel,
        raw: &vt100::Parser,
        body: &str,
    ) {
        let snapshot = model.snapshot("terminal-1", 1);
        let (rows, columns) = raw.screen().size();
        assert_eq!((snapshot.rows, snapshot.columns), (rows, columns));
        assert_eq!(
            (snapshot.cursor.row, snapshot.cursor.column),
            raw.screen().cursor_position()
        );
        assert_eq!(snapshot.content.len(), usize::from(rows));
        for (original, safe) in raw.screen().rows(0, columns).zip(&snapshot.content) {
            if original.len() >= 8 && body.contains(&original) {
                assert!(
                    safe.chars().all(|character| character == '*'),
                    "private key body survived screen filtering"
                );
            }
        }
    }

    #[test]
    fn resize_changes_geometry_and_version_once() {
        let mut model = TerminalScreenModel::new(TerminalGeometry::new(80, 24));
        assert!(model.resize(TerminalGeometry::new(120, 40)).unwrap());
        assert!(!model.resize(TerminalGeometry::new(120, 40)).unwrap());
        let snapshot = model.snapshot("terminal-1", 1);
        assert_eq!((snapshot.rows, snapshot.columns), (40, 120));
        assert_eq!(snapshot.screen_version, 2);
    }
}
