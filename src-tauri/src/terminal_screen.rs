use serde::Serialize;

use crate::terminal_broker::{TerminalGeometry, TerminalRawOutputFrame};

const MAX_TITLE_BYTES: usize = 4_096;

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
            version: 1,
            through_output_sequence: 0,
        }
    }

    pub(crate) fn observe(&mut self, frame: &TerminalRawOutputFrame) -> Result<(), String> {
        let next = self
            .version
            .checked_add(1)
            .ok_or_else(|| "TERMINAL_SCREEN_COUNTER_EXHAUSTED".to_string())?;
        self.parser.process(&frame.bytes);
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
    fn resize_changes_geometry_and_version_once() {
        let mut model = TerminalScreenModel::new(TerminalGeometry::new(80, 24));
        assert!(model.resize(TerminalGeometry::new(120, 40)).unwrap());
        assert!(!model.resize(TerminalGeometry::new(120, 40)).unwrap());
        let snapshot = model.snapshot("terminal-1", 1);
        assert_eq!((snapshot.rows, snapshot.columns), (40, 120));
        assert_eq!(snapshot.screen_version, 2);
    }
}
