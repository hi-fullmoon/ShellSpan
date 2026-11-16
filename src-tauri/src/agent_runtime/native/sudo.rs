use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

pub(crate) const AGENT_SUDO_PROMPT_EVENT: &str = "agent-sudo-prompt";

type Password = Zeroizing<String>;
type Response = mpsc::SyncSender<Option<Password>>;
type Publisher = Arc<dyn Fn(SudoPromptEvent) -> Result<(), String> + Send + Sync>;

#[derive(Serialize, Clone)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SudoPromptEvent {
    Requested {
        prompt_id: Uuid,
        host: String,
        port: u16,
        username: String,
        command: String,
    },
    Closed {
        prompt_id: Uuid,
    },
}

#[derive(Default)]
pub(crate) struct SudoPrompts {
    publisher: Mutex<Option<Publisher>>,
    pending: Mutex<HashMap<Uuid, Response>>,
}

impl SudoPrompts {
    pub(crate) fn set_publisher(&self, publisher: Publisher) -> Result<(), String> {
        *self
            .publisher
            .lock()
            .map_err(|_| "sudo prompt publisher is unavailable")? = Some(publisher);
        Ok(())
    }

    pub(crate) fn respond(
        &self,
        prompt_id: Uuid,
        password: Option<Password>,
    ) -> Result<(), String> {
        if password.as_ref().is_some_and(|password| {
            password.is_empty() || password.len() > 4096 || password.contains(['\0', '\r', '\n'])
        }) {
            return Err("invalid sudo password input".into());
        }
        let sender = self
            .pending
            .lock()
            .map_err(|_| "sudo prompt registry is unavailable")?
            .remove(&prompt_id)
            .ok_or("sudo password prompt has expired")?;
        sender
            .try_send(password)
            .map_err(|_| "sudo password prompt has expired".into())
    }

    pub(super) fn request(
        &self,
        host: &str,
        runner: &crate::sudo_policy::SudoRunner,
        command: &str,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Option<Password>, String> {
        if cancellation.is_cancelled() || Instant::now() >= deadline {
            return Ok(None);
        }
        let publish = self
            .publisher
            .lock()
            .map_err(|_| "sudo prompt publisher is unavailable")?
            .clone()
            .ok_or("sudo password input is unavailable")?;
        let prompt_id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|_| "sudo prompt registry is unavailable")?
            .insert(prompt_id, sender);
        let result = publish(SudoPromptEvent::Requested {
            prompt_id,
            host: host.into(),
            port: runner.port,
            username: runner.username.clone(),
            command: command.into(),
        })
        .map(|()| loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if cancellation.is_cancelled() || remaining.is_zero() {
                break None;
            }
            match receiver.recv_timeout(remaining.min(Duration::from_millis(50))) {
                Ok(password) => break password,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break None,
            }
        });
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&prompt_id);
        }
        let _ = publish(SudoPromptEvent::Closed { prompt_id });
        result
    }
}
