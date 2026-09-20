use std::sync::{mpsc, Arc, Mutex};

use super::{AgentScopedPayload, AgentSessionStore};

enum Command {
    Append(Vec<AgentScopedPayload>),
    Fence(mpsc::SyncSender<Result<(), String>>),
}

/// A single ordered disk writer per request. Producers run on blocking workers;
/// bounded sends never occupy Tokio's async scheduler threads.
pub(super) struct StreamWriter {
    sender: mpsc::SyncSender<Command>,
    error: Arc<Mutex<Option<String>>>,
}

impl StreamWriter {
    pub(super) fn new(sessions: AgentSessionStore, session_id: String) -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel(2);
        let error = Arc::new(Mutex::new(None));
        let failure = Arc::clone(&error);
        std::thread::Builder::new()
            .name("agent-stream-writer".into())
            .spawn(move || {
                while let Ok(command) = receiver.recv() {
                    match command {
                        Command::Append(payloads) => {
                            if failure.lock().expect("stream writer error lock").is_some() {
                                continue;
                            }
                            if let Err(error) = sessions.append_batch(&session_id, payloads) {
                                *failure.lock().expect("stream writer error lock") =
                                    Some(format!("failed to commit model stream batch: {error}"));
                            }
                        }
                        Command::Fence(reply) => {
                            let result = failure
                                .lock()
                                .expect("stream writer error lock")
                                .clone()
                                .map_or(Ok(()), Err);
                            let _ = reply.send(result);
                        }
                    }
                }
            })
            .map_err(|error| format!("failed to start stream writer: {error}"))?;
        Ok(Self { sender, error })
    }

    pub(super) fn check(&self) -> Result<(), String> {
        self.error
            .lock()
            .map_err(|_| "stream writer error lock unavailable")?
            .clone()
            .map_or(Ok(()), Err)
    }

    pub(super) fn append(&self, payloads: Vec<AgentScopedPayload>) -> Result<(), String> {
        self.check()?;
        self.sender
            .send(Command::Append(payloads))
            .map_err(|_| "model stream writer stopped".to_string())?;
        self.check()
    }

    pub(super) fn fence(&self) -> Result<(), String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Command::Fence(sender))
            .map_err(|_| "model stream writer stopped".to_string())?;
        receiver
            .recv()
            .map_err(|_| "model stream writer stopped".to_string())?
    }
}
