//! One ordered input owner, independent of the worker draining PTY output.
use crate::models::SessionCommand;
use crate::terminal_command::local::NativeControlHandle;
use crossbeam_channel::{unbounded, Receiver, Sender};
use portable_pty::{MasterPty, PtySize};
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;

pub(crate) struct LocalInputPump {
    sender: Option<Sender<SessionCommand>>,
    stopped: Arc<AtomicBool>,
    finished: Receiver<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl LocalInputPump {
    pub(crate) fn spawn(
        mut writer: Box<dyn Write + Send>,
        master: Box<dyn MasterPty + Send>,
        control: Option<NativeControlHandle>,
        session_id: String,
        on_control_failure: impl Fn() + Send + 'static,
    ) -> Self {
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_arch = "aarch64"
        ))]
        if crate::terminal_command::acceptance_trace::enabled() {
            writer = Box::new(crate::terminal_command::acceptance_trace::PtyWriter::wrap(
                writer,
                session_id.clone(),
            ));
        }
        // SessionCommand already enters an unbounded FIFO at SessionManager.
        // Preserve that order, including NativeControlFrame's inflight guard,
        // without blocking the sole consumer of the bounded output queue.
        let (sender, receiver) = unbounded();
        let (finished_sender, finished) = crossbeam_channel::bounded(1);
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let thread = thread::spawn(move || {
            while let Ok(command) = receiver.recv() {
                if worker_stopped.load(Ordering::Acquire) {
                    break;
                }
                let result = match command {
                    SessionCommand::Write(data) => writer
                        .write_all(data.as_bytes())
                        .and_then(|()| writer.flush())
                        .map_err(|error| format!("local shell input failed: {error}")),
                    SessionCommand::WriteBytes(bytes) => writer
                        .write_all(&bytes)
                        .and_then(|()| writer.flush())
                        .map_err(|error| format!("local shell binary input failed: {error}")),
                    SessionCommand::NativeControl(frame) => {
                        let result = control
                            .as_ref()
                            .ok_or_else(|| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE".to_string())
                            .and_then(|control| control.write(&frame.bytes));
                        if result.is_err() {
                            // A private capability failure does not own or
                            // close the ordinary PTY input path.
                            on_control_failure();
                            continue;
                        }
                        result.and_then(|()| {
                            if frame.wake_editor {
                                writer
                                    .write_all(b"\x18\x1e")
                                    .and_then(|()| writer.flush())
                                    .map_err(|error| format!("native editor wake failed: {error}"))
                            } else {
                                Ok(())
                            }
                        })
                    }
                    SessionCommand::Resize { cols, rows } => {
                        if let Err(error) = master.resize(PtySize {
                            rows: rows.max(1) as u16,
                            cols: cols.max(1) as u16,
                            pixel_width: 0,
                            pixel_height: 0,
                        }) {
                            log::warn!(
                                "Local terminal resize failed session_id={session_id}: {error}"
                            );
                        }
                        Ok(())
                    }
                    SessionCommand::Close => break,
                    #[cfg(test)]
                    SessionCommand::StartupReady => Ok(()),
                };
                // Keep ordinary input and PTY lifetime under the output
                // worker's shutdown authority, as before this split.
                match result {
                    Err(error) if !worker_stopped.load(Ordering::Acquire) => {
                        log::warn!("Local terminal input failed session_id={session_id}: {error}");
                    }
                    _ => {}
                }
            }
            // Release queued frames before reporting completion. A stopped
            // pump never writes a queued suffix or an old editor wake later.
            drop(receiver);
            drop(control);
            drop(writer);
            drop(master);
            let _ = finished_sender.send(());
        });
        Self {
            sender: Some(sender),
            stopped,
            finished,
            thread: Some(thread),
        }
    }

    pub(crate) fn send(&self, command: SessionCommand) -> Result<(), String> {
        self.sender
            .as_ref()
            .filter(|_| !self.stopped.load(Ordering::Acquire))
            .ok_or_else(|| "local terminal input is closed".to_string())?
            .send(command)
            .map_err(|_| "local terminal input is closed".to_string())
    }

    pub(crate) fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        drop(self.sender.take());
    }

    pub(crate) fn finished(&self) -> &Receiver<()> {
        &self.finished
    }

    /// Call only after the completion channel confirms resources were released.
    pub(crate) fn join_finished(&mut self) -> Result<(), String> {
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| "local terminal input worker panicked".to_string())?;
        }
        Ok(())
    }
}

impl Drop for LocalInputPump {
    fn drop(&mut self) {
        self.stop();
        // A host which ignores shutdown must not block the output worker's
        // existing bounded teardown. Its outstanding transport stays owned by
        // the input thread until the actual I/O and control channel terminate.
    }
}

#[cfg(test)]
#[path = "pump_tests.rs"]
mod tests;
