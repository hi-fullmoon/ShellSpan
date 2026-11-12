//! Acceptance-only transport between the real ConPTY and the xterm observer.
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(super) enum Event<'a> {
    Data { offset: usize, bytes: &'a [u8] },
    Resize { offset: usize, cols: u16, rows: u16 },
}

pub(super) fn timeline(directory: &Path) -> File {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("live-events.jsonl"))
        .expect("Create fresh terminal timeline")
}

pub(super) fn record(timeline: &Mutex<File>, event: Event<'_>) {
    let mut timeline = timeline.lock().unwrap();
    let mut line = serde_json::to_vec(&event).unwrap();
    line.push(b'\n');
    timeline.write_all(&line).expect("Write terminal timeline");
}

#[derive(Default)]
struct CursorReport(Option<(u16, u16)>);

impl vte::Perform for CursorReport {
    fn csi_dispatch(&mut self, params: &vte::Params, middle: &[u8], ignore: bool, action: char) {
        if !ignore && middle.is_empty() && action == 'R' {
            let mut params = params.iter();
            if let (Some([row]), Some([column]), None) =
                (params.next(), params.next(), params.next())
            {
                self.0 = Some((*row, *column));
            }
        }
    }
}

fn assert_cursor_report(bytes: &[u8]) {
    let mut report = CursorReport::default();
    vte::Parser::new().advance(&mut report, bytes);
    let (row, column) = report.0.expect("Expected numeric xterm cursor report");
    assert!(row > 0 && column > 0);
    assert_eq!(bytes, format!("\x1b[{row};{column}R").as_bytes());
}

pub(super) struct Replies {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Replies {
    pub(super) fn start(directory: PathBuf, writer: Arc<Mutex<Box<dyn Write + Send>>>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::spawn(move || {
            let mut index = 0;
            while !stopping.load(Ordering::Acquire) {
                let path = directory.join(format!("reply-{index}.txt"));
                match fs::metadata(&path) {
                    Ok(metadata) => {
                        assert!(metadata.len() <= 16, "xterm cursor report exceeds bound")
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("Read xterm cursor report: {error}"),
                }
                let bytes = fs::read(path).expect("Read xterm cursor report");
                assert_cursor_report(&bytes);
                if stopping.load(Ordering::Acquire) {
                    return;
                }
                super::write(&writer, &bytes);
                index += 1;
            }
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for Replies {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.thread
            .take()
            .unwrap()
            .join()
            .expect("xterm replies worker failed");
    }
}
