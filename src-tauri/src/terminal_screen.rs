use serde::Serialize;

use crate::terminal_broker::{TerminalGeometry, TerminalRawOutputFrame};

const MAX_TITLE_BYTES: usize = 4_096;
const PRIVATE_KEY_BOUNDARY_BYTES: usize = 64;

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
        if self.boundary.len() > PRIVATE_KEY_BOUNDARY_BYTES {
            self.boundary.remove(0);
        }
        if character != '-' {
            return;
        }
        match crate::redaction::terminal_private_key_boundary(&self.boundary) {
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
    fn filter(&mut self, bytes: &[u8]) -> Vec<u8> {
        bytes
            .iter()
            .map(|byte| {
                self.state.mask_ascii = false;
                self.parser
                    .advance(&mut self.state, std::slice::from_ref(byte));
                if self.state.mask_ascii {
                    b'*'
                } else {
                    *byte
                }
            })
            .collect()
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
    pub(crate) private_key_block_open: bool,
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
    private_key_filter: PrivateKeyScreenFilter,
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
            private_key_filter: PrivateKeyScreenFilter::default(),
            version: 1,
            through_output_sequence: 0,
        }
    }

    pub(crate) fn observe(&mut self, frame: &TerminalRawOutputFrame) -> Result<(), String> {
        let next = self
            .version
            .checked_add(1)
            .ok_or_else(|| "TERMINAL_SCREEN_COUNTER_EXHAUSTED".to_string())?;
        // Only the headless Agent screen is filtered; raw transport frames and
        // the user's terminal display retain their original bytes.
        self.parser
            .process(&self.private_key_filter.filter(&frame.bytes));
        self.version = next;
        self.through_output_sequence = frame.sequence;
        Ok(())
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
            private_key_block_open: self.private_key_filter.state.inside_private_key,
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
