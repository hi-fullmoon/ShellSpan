use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use serde::{Deserialize, Serialize};
use vte::{Params, Parser, Perform};

use crate::redaction::{
    redact_model_output_text, terminal_private_key_boundary, PrivateKeyBoundary,
};

const FRAME_CAPACITY: usize = 64;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;
const OMITTED_LINE: &str = "[terminal output omitted]";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RecordingFormat {
    PlainLog,
    AsciinemaV2,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ExportFormat {
    Text,
    Ansi,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingStatus {
    path: String,
    active: bool,
    dropped_frames: u64,
}

enum Frame {
    Output(Vec<u8>),
    Resize(u32, u32),
}

struct Recording {
    path: String,
    tx: Sender<(f64, u64, Frame)>,
    started: Instant,
    dropped: Arc<AtomicU64>,
    failed: Arc<AtomicBool>,
    worker: JoinHandle<io::Result<()>>,
}

impl Recording {
    fn status(&self) -> RecordingStatus {
        RecordingStatus {
            path: self.path.clone(),
            active: !self.failed.load(Ordering::Relaxed),
            dropped_frames: self.dropped.load(Ordering::Relaxed),
        }
    }

    fn offer(&self, frame: Frame) {
        if let Err(TrySendError::Full(_)) = self.tx.try_send((
            self.started.elapsed().as_secs_f64(),
            self.dropped.load(Ordering::Relaxed),
            frame,
        )) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn stop(self) -> Result<RecordingStatus, String> {
        let mut status = self.status();
        drop(self.tx);
        self.worker
            .join()
            .map_err(|_| "terminal recorder worker stopped unexpectedly")?
            .map_err(|error| format!("terminal recording write failed: {error}"))?;
        status.active = false;
        Ok(status)
    }
}

#[derive(Clone, Default)]
pub(crate) struct TerminalRecorder {
    sessions: Arc<Mutex<HashMap<String, Recording>>>,
}

impl TerminalRecorder {
    fn start(
        &self,
        id: String,
        path: &Path,
        format: RecordingFormat,
        cols: u32,
        rows: u32,
    ) -> Result<RecordingStatus, String> {
        let path = if path.exists() {
            path.canonicalize()
        } else {
            path.parent()
                .ok_or("recording folder is unavailable")?
                .canonicalize()
                .map(|parent| parent.join(path.file_name().unwrap_or_default()))
        }
        .map_err(|error| error.to_string())?;
        let portable_path = crate::portable_local_path(&path);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal recorder unavailable")?;
        if sessions.contains_key(&id) {
            return Err("a recording already exists for this session".into());
        }
        if sessions
            .values()
            .any(|recording| recording.path == portable_path)
        {
            return Err("the selected file is already recording a terminal".into());
        }
        let mut file = BufWriter::new(open_output_file(&path).map_err(|error| error.to_string())?);
        if matches!(format, RecordingFormat::AsciinemaV2) {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "version": 2, "width": cols, "height": rows, "timestamp": timestamp
                })
            )
            .and_then(|()| file.flush())
            .map_err(|error| error.to_string())?;
        }
        let (tx, rx) = bounded(FRAME_CAPACITY);
        let dropped = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(AtomicBool::new(false));
        let worker_dropped = dropped.clone();
        let worker_failed = failed.clone();
        let worker = std::thread::Builder::new()
            .name("terminal-recorder".into())
            .spawn(move || {
                let result = record(file, rx, format, &worker_dropped);
                if let Err(error) = &result {
                    worker_failed.store(true, Ordering::Relaxed);
                    log::warn!("Terminal recording write failed: {error}");
                }
                result
            })
            .map_err(|error| error.to_string())?;
        let recording = Recording {
            path: portable_path,
            tx,
            started: Instant::now(),
            dropped,
            failed,
            worker,
        };
        let status = recording.status();
        sessions.insert(id, recording);
        Ok(status)
    }

    pub(crate) fn output(&self, id: &str, bytes: &[u8]) {
        if let Ok(sessions) = self.sessions.try_lock() {
            if let Some(recording) = sessions.get(id) {
                recording.offer(Frame::Output(bytes.to_vec()));
            }
        }
    }

    pub(crate) fn resize(&self, id: &str, cols: u32, rows: u32) {
        if let Ok(sessions) = self.sessions.try_lock() {
            if let Some(recording) = sessions.get(id) {
                recording.offer(Frame::Resize(cols, rows));
            }
        }
    }

    fn take(&self, id: &str) -> Option<Recording> {
        self.sessions.lock().ok()?.remove(id)
    }

    pub(crate) fn close(&self, id: &str) {
        // Dropping the sender lets the worker flush and close without a PTY wait.
        self.take(id);
    }
}

fn open_output_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[derive(Default)]
struct SanitizedOutput {
    text: String,
    styled: String,
    ready: String,
    ansi: bool,
    inside_private_key: bool,
    omit_line: bool,
}

impl SanitizedOutput {
    fn finish_line(&mut self, newline: bool) {
        let private_key = terminal_private_key_boundary(&self.text.replace(' ', ""));
        let was_private_key = self.inside_private_key;
        self.inside_private_key = match private_key {
            Some(PrivateKeyBoundary::Begin) => true,
            Some(PrivateKeyBoundary::End) => false,
            None => was_private_key,
        };
        if self.omit_line {
            self.ready.push_str(OMITTED_LINE);
        } else if was_private_key || private_key.is_some() {
            if !was_private_key {
                self.ready.push_str("[REDACTED PRIVATE KEY]");
            }
        } else {
            let redacted = redact_model_output_text(&self.text);
            if self.ansi && redacted == self.text {
                self.ready.push_str(&self.styled);
            } else {
                self.ready.push_str(&redacted);
            }
        }
        if newline {
            if self.ansi {
                self.ready.push('\r');
            }
            self.ready.push('\n');
        }
        self.text.clear();
        self.styled.clear();
        self.omit_line = false;
    }

    fn mark_gap(&mut self) {
        self.text.clear();
        self.styled.clear();
        self.omit_line = true;
    }

    fn limited(&mut self) -> bool {
        if self.text.len().max(self.styled.len()) >= MAX_LINE_BYTES {
            self.omit_line = true;
        }
        self.omit_line
    }
}

impl Perform for SanitizedOutput {
    fn print(&mut self, character: char) {
        if self.limited() {
            return;
        }
        self.text.push(character);
        if self.ansi {
            self.styled.push(character);
        }
    }

    fn execute(&mut self, byte: u8) {
        if byte == b'\n' {
            self.finish_line(true);
        } else if !self.limited() {
            if byte == b'\t' {
                self.text.push('\t');
            }
            if self.ansi && matches!(byte, b'\r' | b'\t' | 8) {
                self.styled.push(char::from(byte));
            }
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if !self.ansi
            || ignore
            || self.limited()
            || !(intermediates.is_empty() || intermediates == b"?")
            || !matches!(
                action,
                'A'..='H'
                    | 'J'
                    | 'K'
                    | 'L'
                    | 'M'
                    | 'P'
                    | 'S'
                    | 'T'
                    | 'X'
                    | 'd'
                    | 'f'
                    | 'h'
                    | 'l'
                    | 'm'
                    | 'r'
                    | 's'
                    | 'u'
            )
        {
            return;
        }
        self.styled.push_str("\x1b[");
        if !intermediates.is_empty() {
            self.styled.push('?');
        }
        for (index, group) in params.iter().enumerate() {
            if index > 0 {
                self.styled.push(';');
            }
            for (part, value) in group.iter().enumerate() {
                if part > 0 {
                    self.styled.push(':');
                }
                let _ = write!(self.styled, "{value}");
            }
        }
        self.styled.push(action);
    }
}

fn record(
    mut file: impl Write,
    rx: Receiver<(f64, u64, Frame)>,
    format: RecordingFormat,
    dropped: &AtomicU64,
) -> io::Result<()> {
    let ansi = matches!(format, RecordingFormat::AsciinemaV2);
    let mut clean = SanitizedOutput {
        ansi,
        ..Default::default()
    };
    let mut parser = Parser::new();
    let mut last_time = 0.0;
    let mut last_loss = 0;
    for (time, loss, frame) in rx {
        last_time = time;
        if loss != last_loss {
            clean.mark_gap();
            parser = Parser::new();
            last_loss = loss;
        }
        match frame {
            Frame::Output(bytes) => {
                parser.advance(&mut clean, &bytes);
                write_output(&mut file, ansi, time, &std::mem::take(&mut clean.ready))?;
            }
            Frame::Resize(cols, rows) if ansi => {
                writeln!(
                    file,
                    "{}",
                    serde_json::json!([time, "r", format!("{cols}x{rows}")])
                )?;
            }
            Frame::Resize(..) => {}
        }
        file.flush()?;
    }
    if dropped.load(Ordering::Relaxed) != last_loss {
        clean.mark_gap();
    }
    clean.finish_line(false);
    write_output(&mut file, ansi, last_time, &clean.ready)?;
    file.flush()
}

fn write_output(file: &mut impl Write, ansi: bool, time: f64, output: &str) -> io::Result<()> {
    if output.is_empty() {
        return Ok(());
    }
    if ansi {
        writeln!(file, "{}", serde_json::json!([time, "o", output]))
    } else {
        file.write_all(output.as_bytes())
    }
}

#[tauri::command]
pub(crate) async fn export_terminal_buffer(
    format: ExportFormat,
    content: String,
) -> Result<Option<String>, String> {
    if content.len() > MAX_EXPORT_BYTES {
        return Err("terminal export exceeds the size limit".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let ansi = matches!(format, ExportFormat::Ansi);
        let extension = if ansi { "ansi" } else { "txt" };
        let Some(path) = rfd::FileDialog::new()
            .add_filter(extension, &[extension])
            .set_file_name(format!("shellspan-terminal.{extension}"))
            .save_file()
        else {
            return Ok(None);
        };
        let mut clean = SanitizedOutput {
            ansi,
            ..Default::default()
        };
        Parser::new().advance(&mut clean, content.as_bytes());
        clean.finish_line(false);
        let mut file = open_output_file(&path).map_err(|error| error.to_string())?;
        file.write_all(clean.ready.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(Some(crate::portable_local_path(&path)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn start_terminal_recording(
    app: tauri::AppHandle,
    recorder: tauri::State<'_, TerminalRecorder>,
    session_id: String,
    format: RecordingFormat,
    cols: u32,
    rows: u32,
) -> Result<Option<RecordingStatus>, String> {
    use tauri::Manager;
    let recorder = recorder.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let extension = match format {
            RecordingFormat::PlainLog => "txt",
            RecordingFormat::AsciinemaV2 => "cast",
        };
        let Some(path) = rfd::FileDialog::new()
            .add_filter(extension, &[extension])
            .set_file_name(format!("shellspan-recording.{extension}"))
            .save_file()
        else {
            return Ok(None);
        };
        let sessions = app.state::<crate::SessionManager>();
        if sessions.status(&session_id)?.status != crate::SessionStatus::Connected {
            return Err("terminal session is not connected".into());
        }
        let recording = recorder.start(
            session_id.clone(),
            &path,
            format,
            cols.clamp(1, 4096),
            rows.clamp(1, 4096),
        )?;
        // Close can race with the native save dialog or with recording creation.
        if !sessions
            .status(&session_id)
            .is_ok_and(|status| status.status == crate::SessionStatus::Connected)
        {
            recorder.close(&session_id);
            return Err("terminal session closed".into());
        }
        Ok(Some(recording))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn stop_terminal_recording(
    recorder: tauri::State<'_, TerminalRecorder>,
    session_id: String,
) -> Result<Option<RecordingStatus>, String> {
    let recording = recorder.take(&session_id);
    tauri::async_runtime::spawn_blocking(move || recording.map(Recording::stop).transpose())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn get_terminal_recording_status(
    recorder: tauri::State<'_, TerminalRecorder>,
    session_id: String,
) -> Option<RecordingStatus> {
    recorder
        .sessions
        .lock()
        .ok()?
        .get(&session_id)
        .map(Recording::status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_records_resize_and_redacts_terminal_output_across_transport_chunks() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("terminal.cast");
        let recorder = TerminalRecorder::default();
        recorder
            .start("pty".into(), &file, RecordingFormat::AsciinemaV2, 80, 24)
            .unwrap();
        recorder.output("pty", b"\x1b[31merror\x1b[0m\r\npass");
        recorder.output("pty", b"\x1b[1mword=");
        recorder.output(
            "pty",
            b"terminal-sensitive\r\n-----BEGIN OPENSSH PRIVATE KEY-----\r\n",
        );
        recorder.output(
            "pty",
            b"key-material\r\n-----END OPENSSH PRIVATE KEY-----\r\n",
        );
        recorder.output("pty", b"\x1b]52;c;Y2xpcGJvYXJkLW1hdGVyaWFs\x07tail");
        recorder.resize("pty", 96, 30);
        let stopped = recorder.take("pty").unwrap().stop().unwrap();
        assert!(!stopped.active);
        assert_eq!(stopped.dropped_frames, 0);
        let contents = std::fs::read_to_string(file).unwrap();
        let frames = contents
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(frames[0]["version"], 2);
        assert_eq!(frames[0]["width"], 80);
        assert!(frames
            .iter()
            .skip(1)
            .any(|frame| frame[1] == "r" && frame[2] == "96x30"));
        assert!(
            contents.contains("\\u001b[31merror")
                && contents.contains("[REDACTED]")
                && contents.contains("tail")
        );
        for secret in ["terminal-sensitive", "key-material", "Y2xpcGJvYXJk"] {
            assert!(!contents.contains(secret));
        }
    }

    #[test]
    fn bounded_queue_counts_frames_that_do_not_fit() {
        let folder = tempfile::tempdir().unwrap();
        let file = File::create(folder.path().join("terminal.log")).unwrap();
        let (tx, rx) = bounded(1);
        let dropped = Arc::new(AtomicU64::new(0));
        let worker_dropped = dropped.clone();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let start = barrier.clone();
        let worker = std::thread::spawn(move || {
            start.wait();
            record(file, rx, RecordingFormat::PlainLog, &worker_dropped)
        });
        let recording = Recording {
            path: String::new(),
            tx,
            started: Instant::now(),
            dropped,
            failed: Arc::new(AtomicBool::new(false)),
            worker,
        };
        recording.offer(Frame::Output(b"first\n".to_vec()));
        recording.offer(Frame::Output(b"second\n".to_vec()));
        let frames = recording.status().dropped_frames;
        barrier.wait();
        recording.stop().unwrap();
        assert_eq!(frames, 1);
    }
}
