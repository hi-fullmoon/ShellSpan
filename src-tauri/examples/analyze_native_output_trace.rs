//! Offline diagnostics only: parses a saved real stream, never emits terminal input.
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};
struct Controls(BTreeMap<String, usize>);
impl vte::Perform for Controls {
    fn csi_dispatch(&mut self, params: &vte::Params, intermediates: &[u8], _: bool, action: char) {
        if matches!(action, 'J' | 'K' | 'S' | 'T' | 'L' | 'M' | 'r')
            || intermediates.contains(&b'?') && matches!(action, 'h' | 'l')
        {
            *self
                .0
                .entry(format!("{intermediates:?}{params:?}{action}"))
                .or_default() += 1;
        }
    }
}
fn present(parser: &mut vt100::Parser, marker: &str, rows: u16, columns: u16) -> bool {
    parser.screen_mut().set_scrollback(usize::MAX);
    let history = parser.screen().scrollback();
    for offset in 0..=history {
        parser.screen_mut().set_scrollback(offset);
        let mut text = String::new();
        for row in 0..rows {
            for column in 0..columns {
                let cell = parser.screen().cell(row, column).unwrap().contents();
                if cell.is_empty() {
                    text.push(' ')
                } else {
                    text.push_str(&cell)
                }
            }
        }
        if text
            .match_indices(marker)
            .any(|(i, _)| !text[i + marker.len()..].starts_with(|c: char| c.is_ascii_digit()))
        {
            parser.screen_mut().set_scrollback(0);
            return true;
        }
    }
    parser.screen_mut().set_scrollback(0);
    false
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    let raw = std::fs::read(args.get(1).ok_or("missing raw")?)?;
    let metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(args.get(2).ok_or("missing metadata")?)?)?;
    let prefix = args
        .get(3)
        .ok_or("missing marker prefix")?
        .to_string_lossy();
    let rows = metadata["geometry"]["rows"]
        .as_u64()
        .ok_or("missing rows")? as u16;
    let cols = metadata["geometry"]["columns"]
        .as_u64()
        .ok_or("missing columns")? as u16;
    let count = metadata["emitted"].as_u64().ok_or("missing count")? as usize;
    let mut points = Vec::new();
    for index in 1..=count {
        let marker = format!("{prefix}{index}");
        if let Some(i) = raw.windows(marker.len()).enumerate().find_map(|(i, w)| {
            (w == marker.as_bytes()
                && raw
                    .get(i + marker.len())
                    .is_none_or(|byte| !byte.is_ascii_digit()))
            .then_some(i)
        }) {
            points.push((i + marker.len(), index));
        }
    }
    points.sort();
    let mut parser = vt100::Parser::new(rows, cols, 20_000);
    let mut cursor = 0;
    let tracked = args
        .get(5)
        .map(|value| value.to_string_lossy().parse::<usize>())
        .transpose()?
        .unwrap_or(1);
    let first = format!("{prefix}{tracked}");
    let mut snapshots = Vec::new();
    for (end, index) in points {
        parser.process(&raw[cursor..end]);
        cursor = end;
        snapshots.push(json!({"afterProducerLine":index,"offset":end,"firstRetained":present(&mut parser,&first,rows,cols)}));
    }
    parser.process(&raw[cursor..]);
    let mut controls = Controls(BTreeMap::new());
    let mut vt = vte::Parser::new();
    vt.advance(&mut controls, &raw);
    let destination = PathBuf::from(args.get(4).ok_or("missing diagnostic output")?);
    std::fs::write(
        destination,
        serde_json::to_vec_pretty(
            &json!({"kind":"offline-real-vt-trace-analysis","trackedMarker":tracked,"firstFinallyRetained":present(&mut parser,&first,rows,cols),"controls":controls.0,"snapshots":snapshots}),
        )?,
    )?;
    Ok(())
}
