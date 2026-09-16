use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use uuid::Uuid;

use crate::agent_runtime::{TerminalInteractiveInputKindNative, TerminalKeyNative};
use crate::models::{SessionManager, SessionStatus};
use crate::terminal_broker::{
    TerminalInputKind, TerminalInputReceipt, TerminalIntegrationState, TerminalSessionBroker,
    TerminalWaitRequest, TerminalWaitResult,
};
use crate::terminal_screen::TerminalScreenSnapshot;

use super::{TerminalInputSource, TerminalLeaseManager, TerminalLeaseReleaseReason};

const FRONTEND_READY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
struct TerminalInteractiveRegistration {
    agent_session_id: String,
    task_id: String,
    operation_id: String,
}

#[derive(Debug, Default)]
struct TerminalInteractiveState {
    active: HashMap<String, TerminalInteractiveRegistration>,
    taken_over: HashSet<(String, String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalInteractiveWriteResult {
    pub(crate) operation_id: String,
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) input_sequence: u64,
    pub(crate) input_kind: &'static str,
    pub(crate) accepted_bytes: usize,
}

#[derive(Clone)]
pub(crate) struct TerminalInteractiveRegistry {
    state: Arc<Mutex<TerminalInteractiveState>>,
    leases: TerminalLeaseManager,
    broker: TerminalSessionBroker,
}

impl TerminalInteractiveRegistry {
    pub(crate) fn new(leases: TerminalLeaseManager, broker: TerminalSessionBroker) -> Self {
        Self {
            state: Arc::new(Mutex::new(TerminalInteractiveState::default())),
            leases,
            broker,
        }
    }

    pub(crate) fn has_operation(&self, session_id: &str) -> Result<bool, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?
            .active
            .contains_key(session_id))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn write(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        input_kind: TerminalInteractiveInputKindNative,
        text: Option<&str>,
        key: Option<TerminalKeyNative>,
    ) -> Result<TerminalInteractiveWriteResult, String> {
        let registration =
            self.ensure_operation(sessions, session_id, agent_session_id, task_id)?;
        let snapshot = self.broker.screen_snapshot(session_id)?;
        if screen_looks_credential_like(&snapshot) {
            let _ = self.leases.release(
                session_id,
                &registration.agent_session_id,
                &registration.task_id,
                &registration.operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            self.state
                .lock()
                .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?
                .active
                .remove(session_id);
            return Err("TERMINAL_CREDENTIAL_INPUT_FORBIDDEN".into());
        }
        let (data, broker_kind, wire_kind) = match input_kind {
            TerminalInteractiveInputKindNative::Text => (
                text.ok_or_else(|| "TERMINAL_INTERACTIVE_TEXT_REQUIRED".to_string())?
                    .to_string(),
                TerminalInputKind::Text,
                "text",
            ),
            TerminalInteractiveInputKindNative::Key => (
                key_sequence(key.ok_or_else(|| "TERMINAL_INTERACTIVE_KEY_REQUIRED".to_string())?)
                    .to_string(),
                TerminalInputKind::Key,
                "key",
            ),
            TerminalInteractiveInputKindNative::Paste => {
                let text = text.ok_or_else(|| "TERMINAL_INTERACTIVE_PASTE_REQUIRED".to_string())?;
                let data = if self.broker.bracketed_paste_enabled(session_id)? {
                    format!("\u{1b}[200~{text}\u{1b}[201~")
                } else {
                    text.to_string()
                };
                (data, TerminalInputKind::Paste, "paste")
            }
            TerminalInteractiveInputKindNative::Interrupt => (
                "\u{3}".to_string(),
                TerminalInputKind::Interrupt,
                "interrupt",
            ),
        };
        let receipt = self
            .leases
            .write_with_kind(
                sessions,
                session_id,
                data,
                TerminalInputSource::Agent {
                    agent_session_id,
                    task_id,
                    operation_id: &registration.operation_id,
                },
                broker_kind,
            )?
            .ok_or_else(|| "TERMINAL_INTERACTIVE_BROKER_REQUIRED".to_string())?;
        Ok(write_result(&registration, receipt, wire_kind))
    }

    pub(crate) fn read(&self, session_id: &str) -> Result<TerminalScreenSnapshot, String> {
        self.broker.screen_snapshot(session_id)
    }

    pub(crate) fn wait(
        &self,
        session_id: &str,
        request: TerminalWaitRequest,
    ) -> Result<TerminalWaitResult, String> {
        self.broker.wait_terminal(session_id, request)
    }

    pub(crate) fn takeover(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        let registration = {
            let state = self
                .state
                .lock()
                .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?;
            let Some(registration) = state.active.get(session_id) else {
                return Ok(false);
            };
            if registration.agent_session_id != agent_session_id
                || registration.operation_id != operation_id
            {
                return Err("TERMINAL_INTERACTIVE_OPERATION_MISMATCH".into());
            }
            registration.clone()
        };
        self.leases
            .validate_control_owner(session_id, agent_session_id, operation_id)?;
        let _ = self.leases.write(
            sessions,
            session_id,
            "\u{3}".to_string(),
            TerminalInputSource::System {
                operation_id: Some(operation_id),
            },
        );
        self.leases.release(
            session_id,
            &registration.agent_session_id,
            &registration.task_id,
            &registration.operation_id,
            TerminalLeaseReleaseReason::TakenOver,
        )?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?;
        state.active.remove(session_id);
        state.taken_over.insert((
            registration.agent_session_id,
            registration.task_id,
            session_id.to_string(),
        ));
        Ok(true)
    }

    pub(crate) fn cancel_task(
        &self,
        sessions: &SessionManager,
        task_id: &str,
    ) -> Result<usize, String> {
        self.release_where(
            Some(sessions),
            TerminalLeaseReleaseReason::Cancelled,
            |registration| registration.task_id == task_id,
            true,
        )
    }

    pub(crate) fn release_turn(&self, agent_session_id: &str) -> Result<usize, String> {
        let released = self.release_where(
            None,
            TerminalLeaseReleaseReason::Completed,
            |registration| registration.agent_session_id == agent_session_id,
            false,
        )?;
        self.state
            .lock()
            .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?
            .taken_over
            .retain(|(agent, _, _)| agent != agent_session_id);
        Ok(released)
    }

    pub(crate) fn terminal_closed(&self, session_id: &str) -> Result<bool, String> {
        let removed = self
            .state
            .lock()
            .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?
            .active
            .remove(session_id)
            .is_some();
        if removed {
            let _ = self
                .leases
                .release_terminal(session_id, TerminalLeaseReleaseReason::TerminalClosed);
        }
        Ok(removed)
    }

    pub(crate) fn shutdown_all(&self) -> Result<usize, String> {
        let registrations = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?;
            state.taken_over.clear();
            state.active.drain().collect::<Vec<_>>()
        };
        for (session_id, registration) in &registrations {
            let _ = self.leases.release(
                session_id,
                &registration.agent_session_id,
                &registration.task_id,
                &registration.operation_id,
                TerminalLeaseReleaseReason::Shutdown,
            );
        }
        Ok(registrations.len())
    }

    fn ensure_operation(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
    ) -> Result<TerminalInteractiveRegistration, String> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?;
            if state.taken_over.contains(&(
                agent_session_id.to_string(),
                task_id.to_string(),
                session_id.to_string(),
            )) {
                return Err("TERMINAL_INTERACTIVE_TAKEN_OVER".into());
            }
            if let Some(existing) = state.active.get(session_id) {
                return if existing.agent_session_id == agent_session_id
                    && existing.task_id == task_id
                {
                    Ok(existing.clone())
                } else {
                    Err("TERMINAL_INTERACTIVE_BUSY".into())
                };
            }
        }
        if !self.broker.interactive_tools_enabled()? {
            return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
        }
        let broker_snapshot = self
            .broker
            .snapshot(Some(session_id))?
            .session
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        if !broker_snapshot.open
            || broker_snapshot.integration_state != TerminalIntegrationState::Ready
            || !broker_snapshot.prompt_ready
            || broker_snapshot.active_command_id.is_some()
        {
            return Err("TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY".into());
        }
        if sessions.target_state(session_id)?.status != SessionStatus::Connected {
            return Err("TERMINAL_INTERACTIVE_NOT_CONNECTED".into());
        }
        let registration = TerminalInteractiveRegistration {
            agent_session_id: agent_session_id.to_string(),
            task_id: task_id.to_string(),
            operation_id: format!("interactive-{}", Uuid::new_v4().simple()),
        };
        self.leases.acquire(
            session_id,
            agent_session_id,
            task_id,
            &registration.operation_id,
            None,
        )?;
        if let Err(error) = self.leases.wait_frontend_ready(
            session_id,
            agent_session_id,
            task_id,
            &registration.operation_id,
            FRONTEND_READY_TIMEOUT,
        ) {
            let _ = self.leases.release(
                session_id,
                agent_session_id,
                task_id,
                &registration.operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err(error);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?;
        if state.active.contains_key(session_id) {
            drop(state);
            let _ = self.leases.release(
                session_id,
                agent_session_id,
                task_id,
                &registration.operation_id,
                TerminalLeaseReleaseReason::Failed,
            );
            return Err("TERMINAL_INTERACTIVE_BUSY".into());
        }
        state
            .active
            .insert(session_id.to_string(), registration.clone());
        Ok(registration)
    }

    fn release_where(
        &self,
        sessions: Option<&SessionManager>,
        reason: TerminalLeaseReleaseReason,
        predicate: impl Fn(&TerminalInteractiveRegistration) -> bool,
        interrupt: bool,
    ) -> Result<usize, String> {
        let registrations = self
            .state
            .lock()
            .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?
            .active
            .iter()
            .filter(|(_, registration)| predicate(registration))
            .map(|(session_id, registration)| (session_id.clone(), registration.clone()))
            .collect::<Vec<_>>();
        for (session_id, registration) in &registrations {
            if interrupt {
                let sessions =
                    sessions.ok_or_else(|| "TERMINAL_INTERACTIVE_SESSIONS_REQUIRED".to_string())?;
                let _ = self.leases.write(
                    sessions,
                    session_id,
                    "\u{3}".to_string(),
                    TerminalInputSource::System {
                        operation_id: Some(&registration.operation_id),
                    },
                );
            }
            let _ = self.leases.release(
                session_id,
                &registration.agent_session_id,
                &registration.task_id,
                &registration.operation_id,
                reason,
            );
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "TERMINAL_INTERACTIVE_REGISTRY_UNAVAILABLE".to_string())?;
        for (session_id, _) in &registrations {
            state.active.remove(session_id);
        }
        Ok(registrations.len())
    }
}

pub(crate) fn sanitize_terminal_screen(
    mut snapshot: TerminalScreenSnapshot,
) -> (TerminalScreenSnapshot, bool) {
    let credential_like = screen_looks_credential_like(&snapshot);
    snapshot.title = crate::redaction::redact_sensitive_text(&snapshot.title);
    if credential_like {
        snapshot.content.fill(String::new());
        if let Some(first) = snapshot.content.first_mut() {
            *first = "[credential-like terminal screen redacted]".into();
        }
    } else {
        for row in &mut snapshot.content {
            *row = crate::redaction::redact_sensitive_text(row);
        }
    }
    (snapshot, credential_like)
}

fn screen_looks_credential_like(snapshot: &TerminalScreenSnapshot) -> bool {
    let mut recent_nonempty = snapshot
        .content
        .iter()
        .filter(|row| !row.trim().is_empty())
        .rev()
        .take(8)
        .cloned()
        .collect::<Vec<_>>();
    recent_nonempty.push(snapshot.title.clone());
    let visible = recent_nonempty.join(" ").to_ascii_lowercase();
    [
        "password",
        "passphrase",
        "one-time code",
        "verification code",
        "authentication code",
        "otp",
        "secret:",
        "pin:",
    ]
    .iter()
    .any(|marker| visible.contains(marker))
}

fn key_sequence(key: TerminalKeyNative) -> &'static str {
    match key {
        TerminalKeyNative::Enter => "\r",
        TerminalKeyNative::Escape => "\u{1b}",
        TerminalKeyNative::Tab => "\t",
        TerminalKeyNative::Backspace => "\u{7f}",
        TerminalKeyNative::Delete => "\u{1b}[3~",
        TerminalKeyNative::ArrowUp => "\u{1b}[A",
        TerminalKeyNative::ArrowDown => "\u{1b}[B",
        TerminalKeyNative::ArrowRight => "\u{1b}[C",
        TerminalKeyNative::ArrowLeft => "\u{1b}[D",
        TerminalKeyNative::Home => "\u{1b}[H",
        TerminalKeyNative::End => "\u{1b}[F",
        TerminalKeyNative::PageUp => "\u{1b}[5~",
        TerminalKeyNative::PageDown => "\u{1b}[6~",
    }
}

fn write_result(
    registration: &TerminalInteractiveRegistration,
    receipt: TerminalInputReceipt,
    input_kind: &'static str,
) -> TerminalInteractiveWriteResult {
    TerminalInteractiveWriteResult {
        operation_id: registration.operation_id.clone(),
        terminal_session_id: receipt.terminal_session_id,
        terminal_generation: receipt.terminal_generation,
        input_sequence: receipt.input_sequence,
        input_kind,
        accepted_bytes: receipt.accepted_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crate::terminal_broker::{TerminalGeometry, TerminalTransportKind, TerminalWaitReason};
    use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};
    use crossbeam_channel::{unbounded, Receiver};
    use std::sync::atomic::AtomicBool;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    use base64::Engine;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    use std::io::Write;

    fn interactive_harness() -> (
        TerminalInteractiveRegistry,
        SessionManager,
        Receiver<SessionCommand>,
    ) {
        let broker = TerminalSessionBroker::phase5_enabled_for_test(4_096);
        broker
            .attach_transport(
                "transport-1",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        broker
            .register_integration_channel("transport-1", "integration-1", TerminalShellKind::Bash)
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Bash,
            },
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("transport-1", "integration-1", event)
                .unwrap();
        }
        let leases = TerminalLeaseManager::new(broker.clone());
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let registry = TerminalInteractiveRegistry::new(leases, broker);
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                "transport-1".into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: "transport-1".into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "bash".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        (registry, sessions, receiver)
    }

    #[cfg(target_os = "windows")]
    fn powershell_encoded_command(script: &str) -> String {
        let mut bytes = Vec::with_capacity(script.len() * 2);
        for unit in script.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        format!(
            "Invoke-Expression ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{encoded}')))"
        )
    }

    #[cfg(target_os = "macos")]
    fn posix_encoded_command(script: &str) -> String {
        let encoded = base64::engine::general_purpose::STANDARD.encode(script);
        format!("eval \"$(printf '%s' '{encoded}' | base64 -D)\"")
    }

    #[cfg(target_os = "macos")]
    #[allow(clippy::too_many_arguments)]
    fn deliver_macos_agent_input(
        registry: &TerminalInteractiveRegistry,
        sessions: &SessionManager,
        receiver: &Receiver<SessionCommand>,
        writer: &mut dyn Write,
        input_kind: TerminalInteractiveInputKindNative,
        text: Option<&str>,
        key: Option<TerminalKeyNative>,
    ) -> TerminalInteractiveWriteResult {
        let receipt = registry
            .write(
                sessions,
                "phase5-macos-pty",
                "phase5-agent",
                "phase5-task",
                input_kind,
                text,
                key,
            )
            .unwrap();
        let SessionCommand::Write(data) = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("interactive input was not enqueued")
        else {
            panic!("expected an interactive terminal write")
        };
        assert_eq!(receipt.accepted_bytes, data.len());
        writer.write_all(data.as_bytes()).unwrap();
        writer.flush().unwrap();
        receipt
    }

    #[cfg(target_os = "macos")]
    fn run_macos_posix_interactive_acceptance(
        shell: &str,
        shell_kind: TerminalShellKind,
        label: &str,
    ) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::thread;
        use std::time::{Duration, Instant};

        const SESSION_ID: &str = "phase5-macos-pty";
        const AGENT_SESSION_ID: &str = "phase5-agent";
        const TASK_ID: &str = "phase5-task";

        let broker = TerminalSessionBroker::phase5_enabled_for_test(1_048_576);
        broker
            .attach_transport(
                SESSION_ID,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        broker
            .register_integration_channel(SESSION_ID, "phase5-integration", shell_kind)
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready { shell: shell_kind },
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event(SESSION_ID, "phase5-integration", event)
                .unwrap();
        }

        let leases = TerminalLeaseManager::new(broker.clone());
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let registry = TerminalInteractiveRegistry::new(leases, broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                SESSION_ID.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: SESSION_ID.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: shell.into(),
                        host: "local".into(),
                        port: 0,
                        username: "phase5".into(),
                    },
                },
            )
            .unwrap();

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new(shell);
        match shell_kind {
            TerminalShellKind::Bash => command.args(["--noprofile", "--norc"]),
            TerminalShellKind::Zsh => command.args(["-f"]),
            _ => unreachable!("macOS Phase 5 accepts only bash and zsh"),
        }
        command.env("TERM", "xterm-256color");
        command.env("PS1", "");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let reader_broker = broker.clone();
        let reader_shell = shell.to_string();
        let reader_thread = thread::spawn(move || -> Result<Vec<u8>, String> {
            let mut raw = Vec::new();
            let mut buffer = [0_u8; 97];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let bytes = &buffer[..count];
                        reader_broker.observe_raw_output(SESSION_ID, bytes)?;
                        raw.extend_from_slice(bytes);
                    }
                    Err(_) if !raw.is_empty() => break,
                    Err(error) => return Err(format!("read {reader_shell} PTY: {error}")),
                }
            }
            Ok(raw)
        });

        let wait_for_text = |text: &str| {
            let result = registry
                .wait(
                    SESSION_ID,
                    TerminalWaitRequest {
                        after_screen_version: None,
                        after_output_sequence: None,
                        after_lifecycle_sequence: None,
                        text: Some(text.into()),
                        case_sensitive: true,
                        idle: None,
                        timeout: Duration::from_secs(10),
                    },
                )
                .unwrap();
            assert_eq!(
                result.reason,
                TerminalWaitReason::TextFound,
                "{shell} screen did not render {text:?}"
            );
            result.snapshot.unwrap()
        };
        let send_script = |script: &str, writer: &mut Box<dyn Write + Send>| {
            let command = posix_encoded_command(script);
            assert!(
                !command.contains("PHASE5_") && !command.to_ascii_lowercase().contains("password"),
                "encoded command leaked a screen marker into the echoed input"
            );
            deliver_macos_agent_input(
                &registry,
                &sessions,
                &receiver,
                writer,
                TerminalInteractiveInputKindNative::Text,
                Some(&command),
                None,
            );
            deliver_macos_agent_input(
                &registry,
                &sessions,
                &receiver,
                writer,
                TerminalInteractiveInputKindNative::Key,
                None,
                Some(TerminalKeyNative::Enter),
            );
        };

        let repl_ready = format!("PHASE5_{label}_REPL_READY");
        let repl_echo = format!("PHASE5_{label}_REPL_ECHO=macos-value");
        send_script(
            &format!(
                "printf '{repl_ready}> '; IFS= read -r value; printf '\\r\\nPHASE5_{label}_REPL_ECHO=%s\\r\\n' \"$value\""
            ),
            &mut writer,
        );
        wait_for_text(&repl_ready);
        deliver_macos_agent_input(
            &registry,
            &sessions,
            &receiver,
            &mut writer,
            TerminalInteractiveInputKindNative::Text,
            Some("macos-value"),
            None,
        );
        deliver_macos_agent_input(
            &registry,
            &sessions,
            &receiver,
            &mut writer,
            TerminalInteractiveInputKindNative::Key,
            None,
            Some(TerminalKeyNative::Enter),
        );
        wait_for_text(&repl_echo);

        let confirm_prompt = format!("PHASE5_{label}_CONFIRM");
        let confirm_result = format!("PHASE5_{label}_CONFIRMED=y");
        let read_one = match shell_kind {
            TerminalShellKind::Bash => "IFS= read -r -n 1 answer",
            TerminalShellKind::Zsh => "IFS= read -r -k 1 answer",
            _ => unreachable!(),
        };
        send_script(
            &format!(
                "printf '{confirm_prompt} [y/N] '; {read_one}; printf '\\r\\nPHASE5_{label}_CONFIRMED=%s\\r\\n' \"$answer\""
            ),
            &mut writer,
        );
        wait_for_text(&confirm_prompt);
        deliver_macos_agent_input(
            &registry,
            &sessions,
            &receiver,
            &mut writer,
            TerminalInteractiveInputKindNative::Text,
            Some("y"),
            None,
        );
        wait_for_text(&confirm_result);

        pair.master
            .resize(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        broker
            .resize(SESSION_ID, TerminalGeometry::new(100, 30))
            .unwrap();
        let resized = registry.read(SESSION_ID).unwrap();
        assert_eq!((resized.columns, resized.rows), (100, 30));

        let alternate_marker = format!("PHASE5_{label}_ALT_SCREEN");
        let primary_marker = format!("PHASE5_{label}_ALT_DONE");
        send_script(
            &format!(
                "printf '\\033[?1049h{alternate_marker}\\033[2;4H'; sleep 1; printf '\\033[?1049l{primary_marker}'"
            ),
            &mut writer,
        );
        let alternate = wait_for_text(&alternate_marker);
        assert_eq!(
            alternate.active_buffer,
            crate::terminal_screen::TerminalScreenBuffer::Alternate
        );
        let primary = wait_for_text(&primary_marker);
        assert_eq!(
            primary.active_buffer,
            crate::terminal_screen::TerminalScreenBuffer::Primary
        );

        let credential_marker = format!("Password: PHASE5_{label}_CREDENTIAL");
        send_script(&format!("printf '{credential_marker}'"), &mut writer);
        let credential_screen = wait_for_text(&credential_marker);
        assert_eq!(
            registry
                .write(
                    &sessions,
                    SESSION_ID,
                    AGENT_SESSION_ID,
                    TASK_ID,
                    TerminalInteractiveInputKindNative::Text,
                    Some("MUST_NOT_REACH_PTY"),
                    None,
                )
                .unwrap_err(),
            "TERMINAL_CREDENTIAL_INPUT_FORBIDDEN"
        );
        assert!(receiver.try_recv().is_err());
        let (redacted, credential_like) = sanitize_terminal_screen(credential_screen);
        assert!(credential_like);
        assert!(!redacted.content.join("\n").contains(&credential_marker));
        assert!(redacted
            .content
            .iter()
            .any(|row| row == "[credential-like terminal screen redacted]"));

        let exit_input = "exit\r";
        broker
            .admit_compatibility_input(
                SESSION_ID,
                crate::terminal_broker::TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                exit_input.as_bytes(),
                || {
                    writer
                        .write_all(exit_input.as_bytes())
                        .map_err(|error| format!("write {shell} PTY exit: {error}"))?;
                    writer
                        .flush()
                        .map_err(|error| format!("flush {shell} PTY exit: {error}"))
                },
            )
            .unwrap()
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            match child.try_wait().unwrap() {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    child.kill().unwrap();
                    panic!("{shell} interactive PTY did not exit before acceptance deadline");
                }
            }
        };
        drop(writer);
        drop(pair.master);
        let raw = reader_thread.join().unwrap().unwrap();

        assert!(status.success(), "{shell} exited unsuccessfully");
        for marker in [
            repl_echo.as_str(),
            confirm_result.as_str(),
            alternate_marker.as_str(),
            credential_marker.as_str(),
        ] {
            assert!(
                raw.windows(marker.len())
                    .any(|window| window == marker.as_bytes()),
                "{shell} raw PTY output omitted {marker}"
            );
        }
        assert!(!raw
            .windows("MUST_NOT_REACH_PTY".len())
            .any(|window| window == "MUST_NOT_REACH_PTY".as_bytes()));
    }

    #[cfg(target_os = "windows")]
    #[allow(clippy::too_many_arguments)]
    fn deliver_windows_agent_input(
        registry: &TerminalInteractiveRegistry,
        sessions: &SessionManager,
        receiver: &Receiver<SessionCommand>,
        writer: &mut dyn Write,
        input_kind: TerminalInteractiveInputKindNative,
        text: Option<&str>,
        key: Option<TerminalKeyNative>,
    ) -> TerminalInteractiveWriteResult {
        let receipt = registry
            .write(
                sessions,
                "phase5-windows-conpty",
                "phase5-agent",
                "phase5-task",
                input_kind,
                text,
                key,
            )
            .unwrap();
        let SessionCommand::Write(data) = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("interactive input was not enqueued")
        else {
            panic!("expected an interactive terminal write")
        };
        assert_eq!(receipt.accepted_bytes, data.len());
        writer.write_all(data.as_bytes()).unwrap();
        writer.flush().unwrap();
        receipt
    }

    #[cfg(target_os = "windows")]
    fn run_windows_powershell_interactive_acceptance(
        shell: &str,
        shell_kind: TerminalShellKind,
        label: &str,
    ) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{ErrorKind, Read};
        use std::thread;
        use std::time::{Duration, Instant};

        const SESSION_ID: &str = "phase5-windows-conpty";
        const AGENT_SESSION_ID: &str = "phase5-agent";
        const TASK_ID: &str = "phase5-task";

        let broker = TerminalSessionBroker::phase5_enabled_for_test(1_048_576);
        broker
            .attach_transport(
                SESSION_ID,
                None,
                TerminalTransportKind::WindowsConPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap()
            .unwrap();
        broker
            .register_integration_channel(SESSION_ID, "phase5-integration", shell_kind)
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready { shell: shell_kind },
            TerminalIntegrationControlEvent::PromptStart { cwd: "C:\\".into() },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event(SESSION_ID, "phase5-integration", event)
                .unwrap();
        }

        let leases = TerminalLeaseManager::new(broker.clone());
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let registry = TerminalInteractiveRegistry::new(leases, broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                SESSION_ID.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: SESSION_ID.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: shell.into(),
                        host: "local".into(),
                        port: 0,
                        username: "phase5".into(),
                    },
                },
            )
            .unwrap();

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new(shell);
        command.args(["-NoLogo", "-NoProfile"]);
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let reader_broker = broker.clone();
        let reader_shell = shell.to_string();
        let reader_thread = thread::spawn(move || -> Result<Vec<u8>, String> {
            let mut raw = Vec::new();
            let mut buffer = [0_u8; 97];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let bytes = &buffer[..count];
                        reader_broker.observe_raw_output(SESSION_ID, bytes)?;
                        raw.extend_from_slice(bytes);
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            ErrorKind::BrokenPipe | ErrorKind::UnexpectedEof
                        ) && !raw.is_empty() =>
                    {
                        break;
                    }
                    Err(error) => return Err(format!("read {reader_shell} ConPTY: {error}")),
                }
            }
            Ok(raw)
        });

        let wait_for_text = |text: &str| {
            let result = registry
                .wait(
                    SESSION_ID,
                    TerminalWaitRequest {
                        after_screen_version: None,
                        after_output_sequence: None,
                        after_lifecycle_sequence: None,
                        text: Some(text.into()),
                        case_sensitive: true,
                        idle: None,
                        timeout: Duration::from_secs(10),
                    },
                )
                .unwrap();
            assert_eq!(
                result.reason,
                TerminalWaitReason::TextFound,
                "{shell} screen did not render {text:?}"
            );
            result.snapshot.unwrap()
        };
        let send_script = |script: &str, writer: &mut Box<dyn Write + Send>| {
            let command = powershell_encoded_command(script);
            assert!(
                !command.contains("PHASE5_") && !command.to_ascii_lowercase().contains("password"),
                "encoded command leaked a screen marker into the echoed input"
            );
            deliver_windows_agent_input(
                &registry,
                &sessions,
                &receiver,
                writer,
                TerminalInteractiveInputKindNative::Text,
                Some(&command),
                None,
            );
            deliver_windows_agent_input(
                &registry,
                &sessions,
                &receiver,
                writer,
                TerminalInteractiveInputKindNative::Key,
                None,
                Some(TerminalKeyNative::Enter),
            );
        };

        let repl_ready = format!("PHASE5_{label}_REPL_READY");
        let repl_echo = format!("PHASE5_{label}_REPL_ECHO=windows-value");
        send_script(
            &format!(
                "[Console]::Write('{repl_ready}> '); $value=[Console]::ReadLine(); [Console]::Write(\"`r`nPHASE5_{label}_REPL_ECHO=$value`r`n\")"
            ),
            &mut writer,
        );
        wait_for_text(&repl_ready);
        deliver_windows_agent_input(
            &registry,
            &sessions,
            &receiver,
            &mut writer,
            TerminalInteractiveInputKindNative::Text,
            Some("windows-value"),
            None,
        );
        deliver_windows_agent_input(
            &registry,
            &sessions,
            &receiver,
            &mut writer,
            TerminalInteractiveInputKindNative::Key,
            None,
            Some(TerminalKeyNative::Enter),
        );
        wait_for_text(&repl_echo);

        let confirm_prompt = format!("PHASE5_{label}_CONFIRM");
        let confirm_result = format!("PHASE5_{label}_CONFIRMED=y");
        send_script(
            &format!(
                "[Console]::Write('{confirm_prompt} [y/N] '); $answer=[Console]::ReadKey($true).KeyChar; [Console]::Write(\"`r`nPHASE5_{label}_CONFIRMED=$answer`r`n\")"
            ),
            &mut writer,
        );
        wait_for_text(&confirm_prompt);
        deliver_windows_agent_input(
            &registry,
            &sessions,
            &receiver,
            &mut writer,
            TerminalInteractiveInputKindNative::Text,
            Some("y"),
            None,
        );
        wait_for_text(&confirm_result);

        pair.master
            .resize(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        broker
            .resize(SESSION_ID, TerminalGeometry::new(100, 30))
            .unwrap();
        let resized = registry.read(SESSION_ID).unwrap();
        assert_eq!((resized.columns, resized.rows), (100, 30));

        let alternate_marker = format!("PHASE5_{label}_ALT_SCREEN");
        let primary_marker = format!("PHASE5_{label}_ALT_DONE");
        send_script(
            &format!(
                "$e=[char]27; [Console]::Write($e+'[?1049h{alternate_marker}'+$e+'[2;4H'); Start-Sleep -Milliseconds 750; [Console]::Write($e+'[?1049l{primary_marker}')"
            ),
            &mut writer,
        );
        let alternate = wait_for_text(&alternate_marker);
        assert_eq!(
            alternate.active_buffer,
            crate::terminal_screen::TerminalScreenBuffer::Alternate
        );
        let primary = wait_for_text(&primary_marker);
        assert_eq!(
            primary.active_buffer,
            crate::terminal_screen::TerminalScreenBuffer::Primary
        );

        let credential_marker = format!("Password: PHASE5_{label}_CREDENTIAL");
        send_script(
            &format!("[Console]::Write('{credential_marker}')"),
            &mut writer,
        );
        let credential_screen = wait_for_text(&credential_marker);
        assert_eq!(
            registry
                .write(
                    &sessions,
                    SESSION_ID,
                    AGENT_SESSION_ID,
                    TASK_ID,
                    TerminalInteractiveInputKindNative::Text,
                    Some("MUST_NOT_REACH_CONPTY"),
                    None,
                )
                .unwrap_err(),
            "TERMINAL_CREDENTIAL_INPUT_FORBIDDEN"
        );
        assert!(receiver.try_recv().is_err());
        let (redacted, credential_like) = sanitize_terminal_screen(credential_screen);
        assert!(credential_like);
        assert!(!redacted.content.join("\n").contains(&credential_marker));
        assert!(redacted
            .content
            .iter()
            .any(|row| row == "[credential-like terminal screen redacted]"));

        let exit_input = "exit\r";
        broker
            .admit_compatibility_input(
                SESSION_ID,
                crate::terminal_broker::TerminalBrokerInputSource::User,
                TerminalInputKind::Text,
                exit_input.as_bytes(),
                || {
                    writer
                        .write_all(exit_input.as_bytes())
                        .map_err(|error| format!("write {shell} ConPTY exit: {error}"))?;
                    writer
                        .flush()
                        .map_err(|error| format!("flush {shell} ConPTY exit: {error}"))
                },
            )
            .unwrap()
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            match child.try_wait().unwrap() {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    child.kill().unwrap();
                    panic!("{shell} interactive ConPTY did not exit before acceptance deadline");
                }
            }
        };
        drop(writer);
        drop(pair.master);
        let raw = reader_thread.join().unwrap().unwrap();

        assert!(status.success(), "{shell} exited unsuccessfully");
        assert!(raw
            .windows(repl_echo.len())
            .any(|window| window == repl_echo.as_bytes()));
        assert!(raw
            .windows(confirm_result.len())
            .any(|window| window == confirm_result.as_bytes()));
        assert!(raw
            .windows(alternate_marker.len())
            .any(|window| window == alternate_marker.as_bytes()));
        assert!(raw
            .windows(credential_marker.len())
            .any(|window| window == credential_marker.as_bytes()));
        assert!(!raw
            .windows("MUST_NOT_REACH_CONPTY".len())
            .any(|window| { window == "MUST_NOT_REACH_CONPTY".as_bytes() }));
    }

    #[test]
    fn credential_prompt_is_redacted_without_exposing_prompt_text() {
        let snapshot = TerminalScreenSnapshot {
            protocol_version: 1,
            terminal_session_id: "terminal-1".into(),
            terminal_generation: 1,
            frame_type: "screenSnapshot",
            screen_version: 1,
            through_output_sequence: 1,
            rows: 2,
            columns: 80,
            cursor: crate::terminal_screen::TerminalScreenCursor {
                row: 0,
                column: 9,
                visible: true,
            },
            active_buffer: crate::terminal_screen::TerminalScreenBuffer::Primary,
            title: "login".into(),
            content: vec!["Password:".into(), "".into()],
        };
        assert!(screen_looks_credential_like(&snapshot));
        let (redacted, credential_like) = sanitize_terminal_screen(snapshot);
        assert!(credential_like);
        assert_eq!(
            redacted.content[0],
            "[credential-like terminal screen redacted]"
        );
        assert!(!redacted.content.join("\n").contains("Password"));
        assert_eq!(key_sequence(TerminalKeyNative::Escape).as_bytes(), [27]);
    }

    #[test]
    fn interactive_takeover_interrupts_once_and_fences_later_agent_input() {
        let (registry, sessions, receiver) = interactive_harness();

        registry
            .broker
            .observe_raw_output("transport-1", b"\x1b[?2004hREPL> ")
            .unwrap();
        let receipt = registry
            .write(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                TerminalInteractiveInputKindNative::Paste,
                Some("one\ntwo"),
                None,
            )
            .unwrap();
        let SessionCommand::Write(paste) = receiver.recv().unwrap() else {
            panic!("expected interactive paste input")
        };
        assert_eq!(paste, "\u{1b}[200~one\ntwo\u{1b}[201~");
        assert_eq!(receipt.input_kind, "paste");

        let key_receipt = registry
            .write(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                TerminalInteractiveInputKindNative::Key,
                None,
                Some(TerminalKeyNative::ArrowDown),
            )
            .unwrap();
        let SessionCommand::Write(key) = receiver.recv().unwrap() else {
            panic!("expected interactive key input")
        };
        assert_eq!(key, "\u{1b}[B");
        assert_eq!(key_receipt.operation_id, receipt.operation_id);

        registry
            .write(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                TerminalInteractiveInputKindNative::Text,
                Some("y"),
                None,
            )
            .unwrap();
        let SessionCommand::Write(text) = receiver.recv().unwrap() else {
            panic!("expected interactive text input")
        };
        assert_eq!(text, "y");

        assert!(registry
            .takeover(&sessions, "transport-1", "agent-1", &receipt.operation_id,)
            .unwrap());
        let SessionCommand::Write(interrupt) = receiver.recv().unwrap() else {
            panic!("expected takeover interrupt")
        };
        assert_eq!(interrupt.as_bytes(), [3]);
        assert_eq!(
            registry
                .write(
                    &sessions,
                    "transport-1",
                    "agent-1",
                    "task-1",
                    TerminalInteractiveInputKindNative::Interrupt,
                    None,
                    None,
                )
                .unwrap_err(),
            "TERMINAL_INTERACTIVE_TAKEN_OVER"
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn interactive_credential_prompt_releases_lease_without_writing_input() {
        let (registry, sessions, receiver) = interactive_harness();
        registry
            .broker
            .observe_raw_output("transport-1", b"Password: ")
            .unwrap();
        assert_eq!(
            registry
                .write(
                    &sessions,
                    "transport-1",
                    "agent-1",
                    "task-1",
                    TerminalInteractiveInputKindNative::Text,
                    Some("must-not-be-written"),
                    None,
                )
                .unwrap_err(),
            "TERMINAL_CREDENTIAL_INPUT_FORBIDDEN"
        );
        assert!(!registry.has_operation("transport-1").unwrap());
        assert!(receiver.try_recv().is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "run explicitly in the native macOS bash Phase 5 acceptance lane"]
    fn macos_bash_interactive_terminal_operation() {
        run_macos_posix_interactive_acceptance("/bin/bash", TerminalShellKind::Bash, "MACOS_BASH");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "run explicitly in the native macOS zsh Phase 5 acceptance lane"]
    fn macos_zsh_interactive_terminal_operation() {
        run_macos_posix_interactive_acceptance("/bin/zsh", TerminalShellKind::Zsh, "MACOS_ZSH");
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "run explicitly in the native Windows PowerShell 5.1 Phase 5 acceptance lane"]
    fn windows_powershell_5_1_interactive_terminal_operation() {
        run_windows_powershell_interactive_acceptance(
            "powershell.exe",
            TerminalShellKind::WindowsPowerShell,
            "WINDOWS_POWERSHELL_5_1",
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "run explicitly in the native PowerShell 7 Phase 5 acceptance lane"]
    fn windows_powershell_7_interactive_terminal_operation() {
        run_windows_powershell_interactive_acceptance(
            "pwsh.exe",
            TerminalShellKind::PowerShell7,
            "POWERSHELL_7",
        );
    }
}
