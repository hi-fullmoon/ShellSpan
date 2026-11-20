use std::path::Path;
use std::sync::Arc;

use crate::agent_runtime::native::TerminalInputSource;
use crate::models::SessionManager;
use crate::terminal_broker::{
    TerminalBrokerAttachment, TerminalBrokerSnapshot, TerminalGenerationCloseReason,
    TerminalGeometry, TerminalIntegrationState, TerminalRawOutputFrame, TerminalSessionBroker,
    TerminalTransportKind, TerminalVisibleCommandRoute,
};
use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};

use super::NativeToolEngine;

impl NativeToolEngine {
    pub(crate) fn terminal_broker(&self) -> &TerminalSessionBroker {
        &self.terminal_broker
    }

    pub(crate) fn attach_native_terminal_transport(
        &self,
        transport: &str,
        predecessor: Option<&str>,
        kind: TerminalTransportKind,
        geometry: TerminalGeometry,
        mode: crate::terminal_command::protocol::InputMode,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        self.terminal_broker.attach_transport_with_mode(
            transport,
            predecessor,
            kind,
            geometry,
            mode,
        )
    }

    pub(crate) fn register_native_terminal(
        &self,
        transport: &str,
        profile: crate::terminal_command::registration::VerifiedNativeProfile,
    ) -> Result<crate::terminal_command::protocol::ConnectionEnvelope, String> {
        self.terminal_broker
            .register_native_channel(transport, profile)
    }

    #[cfg(unix)]
    pub(crate) fn wait_native_initialization(
        &self,
        transport: &str,
        timeout: std::time::Duration,
    ) -> Result<Option<crate::terminal_command::protocol::DisplayBinding>, String> {
        self.terminal_broker
            .wait_native_initialization(transport, timeout)
    }

    pub(crate) fn accept_native_terminal_message(
        &self,
        transport: &str,
        message: crate::terminal_command::protocol::Message,
    ) -> Result<(), String> {
        use crate::terminal_command::protocol::{ConnectionPayload, Message};
        let result = match message {
            Message::Connection(message) => match &message.payload {
                ConnectionPayload::Capabilities { .. } => self
                    .terminal_broker
                    .accept_native_capabilities(transport, &message),
                ConnectionPayload::EditorReady { .. } => self
                    .terminal_broker
                    .accept_native_readiness(transport, &message)
                    .and_then(|()| self.terminal_execute.retire_foreground_handoff(transport)),
                ConnectionPayload::Directory { .. }
                | ConnectionPayload::JobObservation { .. }
                | ConnectionPayload::EditorOptions { .. } => self
                    .terminal_broker
                    .accept_native_observation(transport, &message),
                _ => Err("TERMINAL_NATIVE_UNEXPECTED_MESSAGE".into()),
            },
            Message::Operation(message) => self.terminal_execute.receive_native(transport, message),
        };
        match result {
            Err(error)
                if error == "TERMINAL_NATIVE_IDENTITY_MISMATCH"
                    || error.contains("STALE_GENERATION")
                    || error.contains("STALE_TRANSPORT") =>
            {
                Ok(())
            }
            result => result,
        }
    }

    pub(crate) fn native_terminal_control_closed(&self, transport: &str) -> Result<(), String> {
        self.terminal_execute.native_control_closed(transport)?;
        let shell = self
            .terminal_broker
            .snapshot(Some(transport))?
            .session
            .and_then(|session| session.integration_shell)
            .unwrap_or(TerminalShellKind::Unsupported);
        self.terminal_broker
            .mark_integration_unavailable(transport, shell, "nativeControlClosed")
    }

    pub(crate) fn configure_terminal_submission_root(&self, root: &Path) -> Result<(), String> {
        self.terminal_broker.configure_submission_journal(root)
    }

    pub(crate) fn configure_terminal_broker_rollout(&self) -> Result<(), String> {
        self.terminal_broker.configure_from_trusted_environment()?;
        if !self.terminal_broker.interactive_tools_enabled()? {
            self.terminal_interactive.shutdown_all()?;
        }
        Ok(())
    }

    pub(crate) fn is_replacement_transport(
        &self,
        previous: &str,
        current: &str,
    ) -> Result<bool, String> {
        self.terminal_broker
            .is_replacement_transport(previous, current)
    }

    pub(crate) fn verify_reconnect_transport(
        &self,
        previous: &str,
        current: &str,
        bound_terminal: bool,
    ) -> Result<bool, String> {
        let snapshot = self.terminal_broker.snapshot(Some(current))?;
        let Some(session) = snapshot.session else {
            return if bound_terminal || snapshot.rollout.enabled {
                Err("TERMINAL_RECONNECT_UNVERIFIED: current transport is unavailable".into())
            } else {
                Ok(false)
            };
        };
        if !session.open || session.transport_session_id != current {
            return Err("TERMINAL_RECONNECT_UNVERIFIED: current transport is closed".into());
        }
        if session.active_command_id.is_some()
            || session.input_observation.native_recovery_required
            || session.input_observation.native_clear_pending
        {
            return Err("TERMINAL_RECONNECT_BUSY: current terminal execution must settle".into());
        }
        if bound_terminal && !session.prompt_ready {
            return Err(match session.integration_state {
                TerminalIntegrationState::Initializing | TerminalIntegrationState::Ready => {
                    "TERMINAL_RECONNECT_BUSY: current terminal execution must settle"
                }
                _ if session.integration_reason.as_deref()
                    == Some(crate::session::SSH_NATIVE_RESOURCES_UNAVAILABLE) =>
                {
                    "TERMINAL_RECONNECT_NATIVE_RESOURCES_UNAVAILABLE"
                }
                _ => "TERMINAL_RECONNECT_INTEGRATION_UNAVAILABLE",
            }
            .into());
        }
        self.is_replacement_transport(previous, current)
    }

    pub(crate) fn terminal_broker_attachment(
        &self,
        transport_session_id: &str,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        self.terminal_broker
            .attachment_for_transport(transport_session_id)
    }

    pub(crate) fn observe_terminal_raw_output(
        &self,
        transport_session_id: &str,
        bytes: &[u8],
    ) -> Result<Option<TerminalRawOutputFrame>, String> {
        self.terminal_broker
            .observe_raw_output(transport_session_id, bytes)
    }

    pub(crate) fn close_terminal_broker_transport(
        &self,
        transport_session_id: &str,
        reason: TerminalGenerationCloseReason,
    ) -> Result<bool, String> {
        self.terminal_broker
            .close_transport(transport_session_id, reason)
    }

    pub(crate) fn resize_terminal_broker(
        &self,
        transport_session_id: &str,
        geometry: TerminalGeometry,
    ) -> Result<(), String> {
        self.terminal_broker.resize(transport_session_id, geometry)
    }

    pub(crate) fn mark_terminal_broker_output_ready(
        &self,
        transport_session_id: &str,
    ) -> Result<(), String> {
        self.terminal_broker.mark_output_ready(transport_session_id)
    }

    pub(crate) fn set_terminal_broker_output_paused(
        &self,
        transport_session_id: &str,
        paused: bool,
    ) -> Result<(), String> {
        self.terminal_broker
            .set_output_paused(transport_session_id, paused)
    }

    pub(crate) fn terminal_broker_snapshot(
        &self,
        transport_session_id: Option<&str>,
    ) -> Result<TerminalBrokerSnapshot, String> {
        self.terminal_broker.snapshot(transport_session_id)
    }

    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    pub(crate) fn terminal_acceptance_raw_output(
        &self,
        transport_session_id: &str,
    ) -> Result<crate::terminal_broker::TerminalAcceptanceRawOutput, String> {
        self.terminal_broker
            .acceptance_raw_output(transport_session_id)
    }

    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    pub(crate) fn terminal_acceptance_input_lease(
        &self,
        transport: &str,
        agent: &str,
        task: &str,
        release: bool,
    ) -> Result<serde_json::Value, String> {
        let operation = format!("phase2-toast-{agent}");
        let before = self.terminal_broker.snapshot(Some(transport))?;
        let terminal = before
            .session
            .as_ref()
            .ok_or("ACCEPTANCE_TARGET_REQUIRED")?;
        if !terminal.open || terminal.native_peer_profile.is_none() {
            return Err("ACCEPTANCE_ACTUAL_NATIVE_TRANSPORT_REQUIRED".into());
        }
        if release {
            if !self.terminal_leases.release(
                transport,
                agent,
                task,
                &operation,
                crate::agent_runtime::native::TerminalLeaseReleaseReason::Completed,
            )? {
                return Err("ACCEPTANCE_OWNED_LEASE_REQUIRED".into());
            }
            self.terminal_leases.release_turn(agent)?;
        } else {
            self.terminal_leases
                .acquire_command(transport, agent, task, &operation, None, None)?;
        }
        Ok(serde_json::json!({
            "operationId": operation,
            "stage": if release { "production TerminalLeaseManager.release and release_turn" } else { "production TerminalLeaseManager.acquire_command" },
            "released": release,
            "brokerBefore": before,
            "brokerAfter": self.terminal_broker.snapshot(Some(transport))?,
            "modelCalls": 0,
            "agentSourceWrites": 0
        }))
    }

    pub(crate) fn terminal_submission_recovery(
        &self,
        agent_session_id: &str,
    ) -> Result<Vec<crate::terminal_command::journal::SubmissionIntent>, String> {
        if !crate::terminal_command::protocol::valid_identifier(agent_session_id) {
            return Err("invalid Agent Session id".into());
        }
        self.terminal_broker
            .submission_recovery_for_agent(agent_session_id)
    }

    pub(crate) fn terminal_execution_capabilities(
        &self,
        transport_session_id: &str,
    ) -> Result<crate::terminal_broker::TerminalExecutionCapabilities, String> {
        self.terminal_broker
            .execution_capabilities(transport_session_id)
    }

    pub(crate) fn terminal_shell_integration_enabled(&self) -> Result<bool, String> {
        self.terminal_broker.shell_integration_enabled()
    }

    pub(crate) fn terminal_visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.terminal_broker
            .visible_command_route(transport_session_id)
    }

    pub(crate) fn terminal_remote_visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.terminal_broker
            .remote_visible_command_route(transport_session_id)
    }

    pub(crate) fn register_terminal_integration_channel(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        shell: TerminalShellKind,
    ) -> Result<(), String> {
        self.terminal_broker.register_integration_channel(
            transport_session_id,
            integration_id,
            shell,
        )
    }

    pub(crate) fn accept_terminal_integration_event(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        event: TerminalIntegrationControlEvent,
    ) -> Result<(), String> {
        self.terminal_broker
            .accept_integration_event(transport_session_id, integration_id, event)
    }

    pub(crate) fn terminal_integration_channel_closed(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.terminal_broker.integration_channel_closed(
            transport_session_id,
            integration_id,
            reason,
        )
    }

    pub(crate) fn mark_terminal_integration_degraded(
        &self,
        transport_session_id: &str,
        shell: TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.terminal_broker
            .mark_integration_degraded(transport_session_id, shell, reason)
    }

    pub(crate) fn mark_terminal_integration_unavailable(
        &self,
        transport_session_id: &str,
        shell: TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.terminal_broker
            .mark_integration_unavailable(transport_session_id, shell, reason)
    }

    pub(crate) fn has_terminal_lease(&self, session_id: &str) -> Result<bool, String> {
        self.terminal_leases.has_lease(session_id)
    }

    pub(crate) fn release_terminal_turn(&self, agent_session_id: &str) -> Result<(), String> {
        self.terminal_interactive.release_turn(agent_session_id)?;
        self.terminal_leases.release_turn(agent_session_id)
    }

    pub(crate) fn terminal_turn_owner(&self, session_id: &str) -> Result<Option<String>, String> {
        self.terminal_leases.turn_owner(session_id)
    }

    pub(crate) fn with_terminal_manual_input<T>(
        &self,
        session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        waiting: bool,
        commit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let busy = || crate::agent_runtime::native::TERMINAL_MANUAL_HANDOFF_BUSY.to_string();
        if waiting {
            self.terminal_interactive
                .release_at_prompt(session_id, agent_session_id, task_id, true)
                .map_err(|error| match error.as_str() {
                    "TERMINAL_INTERACTIVE_BUSY" | "TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY" => {
                        busy()
                    }
                    _ => error,
                })?;
        }
        self.terminal_leases
            .with_manual_input(session_id, agent_session_id, waiting, commit)
            .map_err(|error| {
                if error.starts_with("TERMINAL_LEASE_BUSY:") {
                    busy()
                } else {
                    error
                }
            })
    }

    pub(crate) fn terminal_turn_was_taken_over(
        &self,
        session_id: &str,
        agent_session_id: &str,
    ) -> Result<bool, String> {
        self.terminal_leases
            .was_taken_over(session_id, agent_session_id)
    }

    pub(crate) fn begin_terminal_turn(
        &self,
        terminal_session_id: &str,
        agent_session_id: &str,
    ) -> Result<(), String> {
        self.begin_delegated_terminal_turn(terminal_session_id, agent_session_id, &[])
    }

    pub(crate) fn begin_delegated_terminal_turn(
        &self,
        terminal_session_id: &str,
        agent_session_id: &str,
        ancestors: &[String],
    ) -> Result<(), String> {
        let snapshot = self.terminal_broker.snapshot(Some(terminal_session_id))?;
        if snapshot.session.as_ref().is_some_and(|session| {
            session.transport_kind == TerminalTransportKind::SshPty
                && !snapshot.remote_bound_terminal_rollout.enabled
        }) {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        if ancestors.is_empty() {
            self.terminal_leases
                .begin_turn(terminal_session_id, agent_session_id)
        } else {
            self.terminal_leases.begin_delegated_turn(
                terminal_session_id,
                agent_session_id,
                ancestors,
            )
        }
    }

    pub(crate) fn set_terminal_lease_publisher(
        &self,
        publisher: Arc<
            dyn Fn(&crate::agent_runtime::native::AgentTerminalLeaseEvent) + Send + Sync,
        >,
    ) -> Result<(), String> {
        self.terminal_leases.set_publisher(publisher)
    }

    pub(crate) fn write_user_terminal_input(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        data: String,
    ) -> Result<(), String> {
        self.terminal_leases
            .write(sessions, session_id, data, TerminalInputSource::User)
    }

    pub(crate) fn write_user_terminal_binary_input(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        self.terminal_leases
            .write_binary(sessions, session_id, bytes, TerminalInputSource::User)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn acknowledge_terminal_lease_ready(
        &self,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
        terminal_connected: bool,
        output_listener_ready: bool,
        has_pending_user_input: bool,
        has_unverified_user_submission: bool,
        has_credential_prompt: bool,
        reduced_motion: bool,
    ) -> Result<bool, String> {
        self.terminal_leases.set_reduced_motion(
            session_id,
            agent_session_id,
            operation_id,
            reduced_motion,
        )?;
        self.terminal_leases.acknowledge_frontend_ready(
            session_id,
            agent_session_id,
            operation_id,
            terminal_connected,
            output_listener_ready,
            has_pending_user_input,
            has_unverified_user_submission,
            has_credential_prompt,
        )
    }

    pub(crate) fn takeover_terminal(
        &self,
        sessions: &SessionManager,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        if self.terminal_interactive.has_operation(session_id)? {
            self.terminal_interactive
                .takeover(sessions, session_id, agent_session_id, operation_id)
        } else if self.terminal_execute.has_operation(session_id)? {
            self.terminal_execute
                .takeover(sessions, session_id, agent_session_id, operation_id)
        } else {
            Ok(false)
        }
    }

    pub(crate) fn terminal_closed(&self, session_id: &str) -> Result<bool, String> {
        let interactive = self.terminal_interactive.terminal_closed(session_id)?;
        let visible = self.terminal_execute.terminal_closed(session_id)?;
        Ok(interactive || visible)
    }

    pub(crate) fn reconcile_remote_visible_rollout(&self) -> Result<usize, String> {
        if self
            .terminal_broker
            .snapshot(None)?
            .remote_bound_terminal_rollout
            .enabled
        {
            return Ok(0);
        }
        let mut released = 0;
        let mut errors = Vec::new();
        for session_id in self.terminal_leases.protected_session_ids()? {
            let is_remote_transport = self
                .terminal_broker
                .snapshot(Some(&session_id))
                .ok()
                .and_then(|snapshot| snapshot.session)
                .is_some_and(|session| {
                    session.open && session.transport_kind == TerminalTransportKind::SshPty
                });
            if !is_remote_transport {
                continue;
            }
            if let Err(error) = self.terminal_interactive.terminal_closed(&session_id) {
                errors.push(error);
            }
            if let Err(error) = self.terminal_execute.terminal_closed(&session_id) {
                errors.push(error);
            }
            match self.terminal_leases.release_terminal(
                &session_id,
                crate::agent_runtime::native::TerminalLeaseReleaseReason::Failed,
            ) {
                Ok(did_release) => released += usize::from(did_release),
                Err(error) => errors.push(error),
            }
        }
        if errors.is_empty() {
            Ok(released)
        } else {
            Err(errors.join("; "))
        }
    }
}
